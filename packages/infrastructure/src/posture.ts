/**
 * What the deployment may not do (ADR-0026 §3).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). These are the security posture rules as
 * executable checks over an emitted template, rather than as a list in a
 * document that someone is supposed to have read.
 *
 * Each rule exists because a specific thing would otherwise be silently
 * possible. A wildcard action in one role is not a style problem: it is the
 * authority hierarchy (ADR-0005) and the proposal-only mutation rule
 * (ADR-0006) both becoming unenforced at the same moment, while every test in
 * the repository still passes.
 *
 * The checks run over the template the stack emits, so they hold for whatever
 * the emitter produces — including changes made to it later by someone who
 * never read this file.
 */

import type { CloudFormationTemplate, TemplateResource } from './template.js';
import { resourcesOfType } from './template.js';

export interface PostureViolation {
  readonly rule: string;
  readonly resource: string;
  readonly detail: string;
}

/** Actions no role in this stack may hold, whatever the resource. */
export const FORBIDDEN_ACTIONS: readonly string[] = ['*', 'iam:*', 'sts:AssumeRole', 'kms:*', 'dynamodb:*', 's3:*'];

/** Resources that must never appear on an `Allow`. */
const WILDCARD_RESOURCES: readonly string[] = ['*'];

/** Actions that would let a holder rewrite history (ADR-0004). */
export const HISTORY_MUTATIONS: readonly string[] = ['dynamodb:DeleteItem', 'dynamodb:UpdateItem', 'dynamodb:BatchWriteItem'];

/** Handlers that may append to the ledger. Anything else appending is a finding. */
export const LEDGER_WRITERS: readonly string[] = ['ApiHandler', 'CyclePhaseHandler', 'FactoryStageHandler', 'ApprovalHandler'];

/**
 * Handlers that may write the table at all.
 *
 * The projection updater is here and is deliberately not a ledger writer: it
 * writes derived items into the same table and must be unable to write history
 * into it. IAM can express exactly that, because DynamoDB's fine-grained access
 * control matches on the partition key and every ledger item's key is
 * distinguishable (ADR-0024 §1) — so the separation is enforced rather than
 * merely intended.
 */
export const TABLE_WRITERS: readonly string[] = [...LEDGER_WRITERS, 'ProjectionUpdater'];

/** The condition key that makes a key-scoped deny possible. */
const LEADING_KEYS = 'dynamodb:LeadingKeys';

interface Statement {
  readonly Sid?: string;
  readonly Effect?: string;
  readonly Action?: unknown;
  readonly Resource?: unknown;
  readonly Condition?: unknown;
}

const asList = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : value === undefined ? [] : [value]);

/** Every `(policyName, statement)` on a role, including inline policies. */
export function statementsOf(resource: TemplateResource): readonly (readonly [string, Statement])[] {
  const found: (readonly [string, Statement])[] = [];
  for (const entry of asList(resource.Properties['Policies'])) {
    const policy = entry as { PolicyName?: string; PolicyDocument?: { Statement?: unknown } };
    for (const statement of asList(policy.PolicyDocument?.Statement)) {
      found.push([policy.PolicyName ?? 'inline', statement as Statement]);
    }
  }
  return found;
}

const actionsOf = (statement: Statement): readonly string[] =>
  asList(statement.Action).filter((a): a is string => typeof a === 'string');

/** True when a resource entry is a literal `"*"`. Intrinsics are not wildcards. */
const isWildcardResource = (value: unknown): boolean => typeof value === 'string' && WILDCARD_RESOURCES.includes(value);

/**
 * Runs every rule over a template.
 *
 * Returns findings rather than throwing, so a test can assert the whole list is
 * empty and a report can show all of them at once. A rule that threw would hide
 * the second problem behind the first.
 */
export function checkPosture(template: CloudFormationTemplate): readonly PostureViolation[] {
  return [
    ...checkTables(template),
    ...checkBuckets(template),
    ...checkRoles(template),
    ...checkLedgerWriteBoundary(template),
    ...checkLogs(template),
    ...checkNoPlaintextSecrets(template),
    ...checkStatefulRetention(template),
  ].sort((a, b) => `${a.rule}${a.resource}`.localeCompare(`${b.rule}${b.resource}`));
}

function checkTables(template: CloudFormationTemplate): readonly PostureViolation[] {
  const found: PostureViolation[] = [];
  for (const [id, table] of resourcesOfType(template, 'AWS::DynamoDB::Table')) {
    const pitr = table.Properties['PointInTimeRecoverySpecification'] as { PointInTimeRecoveryEnabled?: boolean } | undefined;
    if (pitr?.PointInTimeRecoveryEnabled !== true) {
      found.push({ rule: 'TABLE_PITR', resource: id, detail: 'point-in-time recovery is not enabled on the system of record' });
    }
    const sse = table.Properties['SSESpecification'] as { SSEEnabled?: boolean; SSEType?: string; KMSMasterKeyId?: unknown } | undefined;
    if (sse?.SSEEnabled !== true || sse.SSEType !== 'KMS' || sse.KMSMasterKeyId === undefined) {
      found.push({ rule: 'TABLE_CMK', resource: id, detail: 'the table is not encrypted with a customer-managed key' });
    }
    if (table.Properties['DeletionProtectionEnabled'] !== true) {
      found.push({ rule: 'TABLE_DELETION_PROTECTION', resource: id, detail: 'the table can be deleted by an API call' });
    }
    const stream = table.Properties['StreamSpecification'] as { StreamViewType?: string } | undefined;
    if (stream?.StreamViewType !== 'NEW_AND_OLD_IMAGES') {
      found.push({ rule: 'TABLE_STREAM_IMAGES', resource: id, detail: 'projections need both images to fold correctly' });
    }
  }
  return found;
}

function checkBuckets(template: CloudFormationTemplate): readonly PostureViolation[] {
  const found: PostureViolation[] = [];
  const policied = new Set(
    resourcesOfType(template, 'AWS::S3::BucketPolicy').map(([, resource]) => {
      const bucket = resource.Properties['Bucket'] as { Ref?: string } | undefined;
      return bucket?.Ref ?? '';
    }),
  );

  for (const [id, bucket] of resourcesOfType(template, 'AWS::S3::Bucket')) {
    const block = bucket.Properties['PublicAccessBlockConfiguration'] as Record<string, unknown> | undefined;
    const allBlocked =
      block !== undefined &&
      ['BlockPublicAcls', 'BlockPublicPolicy', 'IgnorePublicAcls', 'RestrictPublicBuckets'].every((k) => block[k] === true);
    if (!allBlocked) found.push({ rule: 'BUCKET_NOT_PUBLIC', resource: id, detail: 'public access is not fully blocked' });

    const encryption = bucket.Properties['BucketEncryption'] as
      | { ServerSideEncryptionConfiguration?: readonly { ServerSideEncryptionByDefault?: { SSEAlgorithm?: string } }[] }
      | undefined;
    const kms = encryption?.ServerSideEncryptionConfiguration?.every(
      (rule) => rule.ServerSideEncryptionByDefault?.SSEAlgorithm === 'aws:kms',
    );
    if (kms !== true) found.push({ rule: 'BUCKET_CMK', resource: id, detail: 'the bucket is not encrypted with KMS by default' });

    const versioning = bucket.Properties['VersioningConfiguration'] as { Status?: string } | undefined;
    if (versioning?.Status !== 'Enabled') {
      found.push({ rule: 'BUCKET_VERSIONED', resource: id, detail: 'evidence must survive an overwrite' });
    }
    if (!policied.has(id)) {
      found.push({ rule: 'BUCKET_TLS_ONLY', resource: id, detail: 'no bucket policy denies insecure transport' });
    }
  }
  return found;
}

function checkRoles(template: CloudFormationTemplate): readonly PostureViolation[] {
  const found: PostureViolation[] = [];
  for (const [id, role] of resourcesOfType(template, 'AWS::IAM::Role')) {
    if (asList(role.Properties['ManagedPolicyArns']).length > 0) {
      // A managed policy is a grant defined outside this template, so the rules
      // below cannot see what it allows.
      found.push({ rule: 'NO_MANAGED_POLICIES', resource: id, detail: 'a managed policy grants what this template cannot check' });
    }

    const trust = role.Properties['AssumeRolePolicyDocument'] as { Statement?: unknown } | undefined;
    for (const statement of asList(trust?.Statement)) {
      const principal = (statement as { Principal?: unknown }).Principal;
      if (principal === '*' || (typeof principal === 'object' && principal !== null && (principal as Record<string, unknown>)['AWS'] === '*')) {
        found.push({ rule: 'NO_WILDCARD_PRINCIPAL', resource: id, detail: 'anyone may assume this role' });
      }
    }

    for (const [policyName, statement] of statementsOf(role)) {
      if (statement.Effect !== 'Allow') continue;
      const where = `${id}/${policyName}/${statement.Sid ?? 'unnamed'}`;

      for (const action of actionsOf(statement)) {
        if (FORBIDDEN_ACTIONS.includes(action) || action.endsWith(':*')) {
          found.push({ rule: 'NO_WILDCARD_ACTION', resource: where, detail: `${action} is broader than any handler needs` });
        }
      }
      for (const resource of asList(statement.Resource)) {
        if (isWildcardResource(resource)) {
          found.push({ rule: 'NO_WILDCARD_RESOURCE', resource: where, detail: 'the statement applies to every resource in the account' });
        }
      }
      if (actionsOf(statement).length === 0) {
        found.push({ rule: 'STATEMENT_HAS_ACTIONS', resource: where, detail: 'a statement with no action grants nothing and hides intent' });
      }
      if (asList(statement.Resource).length === 0) {
        found.push({ rule: 'STATEMENT_HAS_RESOURCES', resource: where, detail: 'a statement with no resource is rejected at deploy time' });
      }
      if (actionsOf(statement).includes('s3:ListBucket') && statement.Condition === undefined) {
        // ListBucket is an action on the bucket, so it cannot be narrowed by
        // ARN. Without a prefix condition it enumerates every project.
        found.push({ rule: 'LIST_SCOPED_BY_PREFIX', resource: where, detail: 's3:ListBucket is not limited to one prefix' });
      }
    }
  }
  return found;
}

/**
 * The boundary that matters most: who may write history, and who may rewrite it.
 *
 * Nobody may rewrite it. `LEDGER_WRITERS` may append. Everything else — the
 * agent worker above all — may read and may not write, which is ADR-0006 as a
 * property of the deployment rather than of the runtime's own checks.
 */
function checkLedgerWriteBoundary(template: CloudFormationTemplate): readonly PostureViolation[] {
  const found: PostureViolation[] = [];
  const READS: readonly string[] = ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:BatchGetItem'];

  for (const [id, role] of resourcesOfType(template, 'AWS::IAM::Role')) {
    const handler = id.endsWith('Role') ? id.slice(0, -'Role'.length) : id;
    const allowed = new Set<string>();
    const denied = new Set<string>();
    let keyScopedDeny = false;

    for (const [, statement] of statementsOf(role)) {
      const actions = actionsOf(statement);
      if (statement.Effect === 'Deny') {
        for (const action of actions) denied.add(action);
        // A deny that is not scoped to the ledger's keys would either be
        // table-wide, which stops the projection updater working, or so broad
        // it would have been written differently. Either way it is not the
        // boundary this rule is checking for.
        if (JSON.stringify(statement.Condition ?? {}).includes(LEADING_KEYS)) keyScopedDeny = true;
        continue;
      }
      if (statement.Effect !== 'Allow') continue;
      for (const action of actions) allowed.add(action);
    }

    const writesTable = [...allowed].some((a) => a.startsWith('dynamodb:') && !READS.includes(a) && !a.startsWith('dynamodb:Describe') && !a.startsWith('dynamodb:Get') && !a.startsWith('dynamodb:List'));

    if (writesTable && !TABLE_WRITERS.includes(handler)) {
      found.push({ rule: 'ONLY_NAMED_WRITERS_APPEND', resource: id, detail: `${handler} may write the table but is not a named writer` });
    }
    if (handler === 'AgentWorker' && writesTable) {
      // The single most important line in this file. ADR-0006 says agents
      // propose and the core mutates; this is that, as a property of IAM.
      found.push({ rule: 'AGENTS_DO_NOT_MUTATE', resource: id, detail: 'an agent may read canonical state and may not change it (ADR-0006)' });
    }
    if (LEDGER_WRITERS.includes(handler) && HISTORY_MUTATIONS.some((a) => allowed.has(a))) {
      found.push({ rule: 'APPEND_ONLY', resource: id, detail: `${handler} may modify or delete items it should only append` });
    }
    if (writesTable && !(HISTORY_MUTATIONS.every((a) => denied.has(a)) && keyScopedDeny)) {
      found.push({
        rule: 'EXPLICIT_HISTORY_DENY',
        resource: id,
        detail: 'a writer must carry a key-scoped deny on rewriting history, not merely lack the grant',
      });
    }
    // A derived writer holds `PutItem` for its own items, so omission is not
    // enough: without this it could put an item into the ledger's partition.
    if (writesTable && !LEDGER_WRITERS.includes(handler) && !denied.has('dynamodb:PutItem')) {
      found.push({
        rule: 'DERIVED_WRITERS_CANNOT_APPEND',
        resource: id,
        detail: `${handler} writes the table without a deny on putting ledger items (ADR-0013)`,
      });
    }
  }
  return found;
}

function checkLogs(template: CloudFormationTemplate): readonly PostureViolation[] {
  const found: PostureViolation[] = [];
  for (const [id, group] of resourcesOfType(template, 'AWS::Logs::LogGroup')) {
    if (typeof group.Properties['RetentionInDays'] !== 'number') {
      found.push({ rule: 'LOG_RETENTION', resource: id, detail: 'logs are kept forever, which SPEC-07 §5 bounds' });
    }
    if (group.Properties['KmsKeyId'] === undefined) {
      found.push({ rule: 'LOG_ENCRYPTION', resource: id, detail: 'the log group is not encrypted with the stack key' });
    }
  }

  // A function with no log group declared writes to one created implicitly,
  // with no retention and no key.
  const groups = new Set(resourcesOfType(template, 'AWS::Logs::LogGroup').map(([id]) => id));
  for (const [id] of resourcesOfType(template, 'AWS::Lambda::Function')) {
    if (!groups.has(`${id}Logs`)) {
      found.push({ rule: 'FUNCTION_HAS_LOG_GROUP', resource: id, detail: 'no declared log group, so retention and encryption are unset' });
    }
  }
  return found;
}

/** Anything in the template that looks like a credential rather than a reference. */
const SECRET_SHAPED = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /"(password|secret|apiKey|api_key|token)"\s*:\s*"[^"$]{8,}"/i,
];

function checkNoPlaintextSecrets(template: CloudFormationTemplate): readonly PostureViolation[] {
  const found: PostureViolation[] = [];
  for (const [id, resource] of Object.entries(template.Resources)) {
    const serialised = JSON.stringify(resource);
    for (const pattern of SECRET_SHAPED) {
      if (pattern.test(serialised)) {
        found.push({ rule: 'NO_PLAINTEXT_SECRETS', resource: id, detail: 'a credential appears to be embedded in the template' });
      }
    }
  }
  return found;
}

/** Everything holding state the system cannot rebuild must outlive its stack. */
const STATEFUL_TYPES: readonly string[] = [
  'AWS::DynamoDB::Table',
  'AWS::S3::Bucket',
  'AWS::KMS::Key',
  'AWS::Cognito::UserPool',
  'AWS::Logs::LogGroup',
];

function checkStatefulRetention(template: CloudFormationTemplate): readonly PostureViolation[] {
  const found: PostureViolation[] = [];
  for (const [id, resource] of Object.entries(template.Resources)) {
    if (!STATEFUL_TYPES.includes(resource.Type)) continue;
    if (resource.DeletionPolicy !== 'Retain') {
      found.push({ rule: 'RETAIN_STATE', resource: id, detail: `${resource.Type} would be destroyed with the stack` });
    }
  }
  return found;
}
