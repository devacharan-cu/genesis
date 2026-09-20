/**
 * IAM as typed data (ADR-0026 §3).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). The architecture's trust boundaries are only
 * as real as the policies that enforce them. "Agents may not mutate canonical
 * state" (ADR-0006) is a sentence in a document until the agent role has no
 * `PutItem` on the ledger — at which point it is a property of the deployment
 * that holds even if every line of application code is wrong.
 *
 * So the statements are built here, from named helpers, and `posture.ts`
 * asserts over the result. A policy written as a free-form object would be
 * checkable only by reading it.
 */

import { AWS_ACCOUNT, AWS_PARTITION, AWS_REGION, type TemplateValue } from './template.js';

export interface PolicyStatement {
  readonly Sid?: string;
  readonly Effect: 'Allow' | 'Deny';
  readonly Action: readonly string[];
  readonly Resource: readonly TemplateValue[];
  readonly Condition?: Readonly<Record<string, Readonly<Record<string, TemplateValue>>>>;
}

export interface PolicyDocument {
  readonly Version: '2012-10-17';
  readonly Statement: readonly PolicyStatement[];
}

export const policy = (statements: readonly PolicyStatement[]): PolicyDocument => ({
  Version: '2012-10-17',
  Statement: statements,
});

/** A trust policy for one AWS service. One service, never a wildcard principal. */
export const assumedBy = (service: string): Readonly<Record<string, TemplateValue>> => ({
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { Service: service },
      Action: 'sts:AssumeRole',
      // Confused-deputy protection: the role is assumable only on behalf of
      // this account, not by the service acting for someone else's.
      Condition: { StringEquals: { 'aws:SourceAccount': AWS_ACCOUNT } },
    },
  ],
});

// ------------------------------------------------------------------- DynamoDB

/**
 * Reading history, and nothing else.
 *
 * Deliberately no `Scan`: every access pattern in ADR-0024 is a `Query` against
 * a known partition, so a role that could `Scan` could read across projects by
 * accident. The absence is the isolation.
 */
export const dynamoRead = (tableArn: TemplateValue, sid: string): PolicyStatement => ({
  Sid: sid,
  Effect: 'Allow',
  Action: ['dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:Query'],
  Resource: [tableArn, { 'Fn::Sub': ['${arn}/index/*', { arn: tableArn }] }],
});

/**
 * Appending to the ledger.
 *
 * `PutItem` and `TransactWriteItems`, and pointedly not `DeleteItem` or
 * `UpdateItem`: an append-only ledger (ADR-0004) whose writer can update an item
 * is append-only by convention, which is to say not at all. ADR-0024 §2 relies
 * on this, because the conditional put that makes an append atomic is a put.
 */
export const ledgerAppend = (tableArn: TemplateValue): PolicyStatement => ({
  Sid: 'LedgerAppendOnly',
  Effect: 'Allow',
  Action: ['dynamodb:PutItem', 'dynamodb:TransactWriteItems'],
  Resource: [tableArn],
});

/** Writing derived state: projections and snapshots may be rebuilt, so they may be replaced. */
export const derivedWrite = (tableArn: TemplateValue): PolicyStatement => ({
  Sid: 'DerivedStateWrite',
  Effect: 'Allow',
  Action: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem'],
  Resource: [tableArn],
});

/** The partition key prefix every ledger item shares (ADR-0024 §1). */
export const LEDGER_KEY_PATTERN = 'PRJ#*#LEDGER';

/**
 * An explicit refusal, so the boundary survives a later policy being widened.
 *
 * The condition is what makes this precise rather than blunt. DynamoDB's
 * fine-grained access control can match on the partition key, and every ledger
 * item's key ends `#LEDGER` — so a role can be allowed to put derived items in
 * the same table while being unable to touch history at all. Without the
 * condition the deny would be table-wide and the projection updater could not
 * do its job.
 */
export const denyLedgerMutation = (tableArn: TemplateValue): PolicyStatement => ({
  Sid: 'NeverRewriteHistory',
  Effect: 'Deny',
  // `BatchWriteItem` is here because it can delete. A deny that listed only the
  // single-item operations would leave the batch form as a way around it.
  Action: ['dynamodb:DeleteItem', 'dynamodb:UpdateItem', 'dynamodb:BatchWriteItem'],
  Resource: [tableArn],
  Condition: { 'ForAnyValue:StringLike': { 'dynamodb:LeadingKeys': [LEDGER_KEY_PATTERN] } },
});

/**
 * The stronger refusal, for a role that writes the same table but must never
 * append to the ledger.
 *
 * A projection that could write an event could manufacture the history it then
 * reports (ADR-0013), and the resulting item would be indistinguishable from a
 * real one — it would even be inside the hash chain's partition. So the
 * projection updater is denied `PutItem` on exactly those keys.
 */
export const denyLedgerWrites = (tableArn: TemplateValue): PolicyStatement => ({
  Sid: 'NeverWriteHistory',
  Effect: 'Deny',
  Action: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem', 'dynamodb:TransactWriteItems'],
  Resource: [tableArn],
  Condition: { 'ForAnyValue:StringLike': { 'dynamodb:LeadingKeys': [LEDGER_KEY_PATTERN] } },
});

export const streamRead = (streamArn: TemplateValue): PolicyStatement => ({
  Sid: 'ReadTableStream',
  Effect: 'Allow',
  Action: [
    'dynamodb:DescribeStream',
    'dynamodb:GetRecords',
    'dynamodb:GetShardIterator',
    'dynamodb:ListStreams',
  ],
  Resource: [streamArn],
});

// ------------------------------------------------------------------------- S3

/** Read and write under exactly one prefix. The prefix is the project boundary. */
export const objectsUnder = (bucketArn: TemplateValue, prefix: string, sid: string, write: boolean): PolicyStatement => ({
  Sid: sid,
  Effect: 'Allow',
  Action: write ? ['s3:GetObject', 's3:PutObject'] : ['s3:GetObject'],
  Resource: [{ 'Fn::Sub': [`\${arn}/${prefix}`, { arn: bucketArn }] }],
});

/**
 * Listing a bucket, limited to one prefix by condition.
 *
 * `s3:ListBucket` is an action on the bucket, not on the objects, so it cannot
 * be scoped by resource ARN. Without the condition a role that may list its own
 * prefix may enumerate every project's, which is the isolation rule (ADR-0008)
 * failing silently at the storage layer.
 */
export const listUnder = (bucketArn: TemplateValue, prefix: string, sid: string): PolicyStatement => ({
  Sid: sid,
  Effect: 'Allow',
  Action: ['s3:ListBucket'],
  Resource: [bucketArn],
  Condition: { StringLike: { 's3:prefix': [prefix] } },
});

// ------------------------------------------------------------------ the rest

export const kmsUse = (keyArn: TemplateValue, sid: string): PolicyStatement => ({
  Sid: sid,
  Effect: 'Allow',
  Action: ['kms:Decrypt', 'kms:GenerateDataKey'],
  Resource: [keyArn],
});

export const invokeModels = (modelIds: readonly string[]): PolicyStatement => ({
  Sid: 'InvokeNamedModelsOnly',
  Effect: 'Allow',
  Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
  // Named models, not `foundation-model/*`: which model produced a claim is
  // part of its provenance (ADR-0007), and a role that may call any model can
  // produce provenance the deployment never authorised.
  Resource: modelIds.map((id) => ({
    'Fn::Sub': `arn:\${AWS::Partition}:bedrock:\${AWS::Region}::foundation-model/${id}`,
  })),
});

export const publishToBus = (busArn: TemplateValue): PolicyStatement => ({
  Sid: 'PublishLedgerNotifications',
  Effect: 'Allow',
  Action: ['events:PutEvents'],
  Resource: [busArn],
});

export const invokeFunctions = (functionArns: readonly TemplateValue[]): PolicyStatement => ({
  Sid: 'InvokeNamedHandlers',
  Effect: 'Allow',
  Action: ['lambda:InvokeFunction'],
  Resource: functionArns,
});

export const resolveSecrets = (pathPrefix: string): PolicyStatement => ({
  Sid: 'ResolveOwnSecrets',
  Effect: 'Allow',
  Action: ['secretsmanager:GetSecretValue', 'ssm:GetParameter'],
  Resource: [
    { 'Fn::Sub': `arn:\${AWS::Partition}:secretsmanager:\${AWS::Region}:\${AWS::AccountId}:secret:${pathPrefix}*` },
    { 'Fn::Sub': `arn:\${AWS::Partition}:ssm:\${AWS::Region}:\${AWS::AccountId}:parameter/${pathPrefix}*` },
  ],
});

/**
 * Log delivery, scoped to the function's own log group.
 *
 * The managed `AWSLambdaBasicExecutionRole` grants `logs:*` on `*`, which is a
 * wildcard resource in a role the posture rules forbid. Writing it out costs
 * three lines and keeps the rule absolute rather than nearly absolute.
 */
export const writeOwnLogs = (functionName: TemplateValue): PolicyStatement => ({
  Sid: 'WriteOwnLogs',
  Effect: 'Allow',
  Action: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:CreateLogGroup'],
  Resource: [
    {
      'Fn::Sub': [
        'arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/${name}:*',
        { name: functionName },
      ],
    },
  ],
});

export const runSandboxTasks = (taskDefinitionArn: TemplateValue, clusterArn: TemplateValue): PolicyStatement => ({
  Sid: 'RunSandboxTasks',
  Effect: 'Allow',
  Action: ['ecs:RunTask', 'ecs:DescribeTasks', 'ecs:StopTask'],
  Resource: [taskDefinitionArn],
  Condition: { ArnEquals: { 'ecs:cluster': clusterArn } },
});

export const REGION_CONDITION = {
  StringEquals: { 'aws:RequestedRegion': AWS_REGION },
} as const;

export { AWS_ACCOUNT, AWS_PARTITION, AWS_REGION };
