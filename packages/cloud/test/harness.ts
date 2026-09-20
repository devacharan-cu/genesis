/**
 * A whole deployment, in process.
 *
 * Every client is the in-process model that passes the same conformance suite
 * its SDK-backed counterpart would (ADR-0024 §3), so these tests exercise the
 * real composition root, the real adapters and the real handlers — everything
 * except the network.
 */

import { DynamoDbModel, EventBusModel, GENESIS_TABLE_SCHEMA, ObjectStoreModel, SecretsClientModel, UnverifiedClaimsVerifier } from '@genesis/adapters-aws';
import { newProjectId, type ProjectId } from '@genesis/core-types';
import type { EventLedger } from '@genesis/ledger';
import type { ProjectionSnapshotStore } from '@genesis/projections';
import { buildCloudRuntime, type CloudConfig, type CloudRuntime } from '../src/index.js';

export const ISSUER = 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_TEST';
export const AUDIENCE = 'genesis-console';
export const SUBJECT = 'cognito-subject-1';
export const TOKEN = 'a-valid-token';

export const claimsFor = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  sub: SUBJECT,
  iss: ISSUER,
  aud: AUDIENCE,
  exp: Math.floor(Date.now() / 1_000) + 3_600,
  iat: Math.floor(Date.now() / 1_000) - 60,
  name: 'Dev',
  ...overrides,
});

export const configFor = (projectId: ProjectId): CloudConfig => ({
  projectId,
  environment: 'dev',
  region: 'eu-west-1',
  table: 'genesis-state',
  evidenceBucket: 'genesis-evidence',
  artifactBucket: 'genesis-artifacts',
  eventBusName: 'genesis-ledger',
  eventBusArn: 'arn:aws:events:eu-west-1:123456789012:event-bus/genesis-ledger',
  modelIds: ['anthropic.claude-sonnet-4-5-v1:0'],
  identityIssuer: ISSUER,
  identityAudience: AUDIENCE,
  secretPrefix: 'genesis/test/',
});

export interface Deployment {
  readonly runtime: CloudRuntime;
  readonly projectId: ProjectId;
  readonly bus: EventBusModel;
  readonly dynamo: DynamoDbModel;
}

export function deployment(options: { readonly claims?: Record<string, unknown> } = {}): Deployment {
  const projectId = newProjectId();
  const dynamo = new DynamoDbModel(GENESIS_TABLE_SCHEMA);
  const bus = new EventBusModel();

  const runtime = buildCloudRuntime(configFor(projectId), {
    dynamo,
    objects: new ObjectStoreModel(),
    bus,
    secrets: new SecretsClientModel({ 'genesis/test/db': 'the-value' }),
    tokens: new UnverifiedClaimsVerifier({ [TOKEN]: options.claims ?? claimsFor() }),
  });

  return { runtime, projectId, bus, dynamo };
}

/** A stream record for a ledger event, as Lambda would deliver it. */
export const ledgerRecord = (projectId: string, seq: number, eventID = `rec-${seq}`): Record<string, unknown> => ({
  eventID,
  eventName: 'INSERT',
  dynamodb: { Keys: { pk: { S: `PRJ#${projectId}#LEDGER` }, sk: { S: `EVT#${String(seq).padStart(20, '0')}` } } },
});

export const humanEvent = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'REQUIREMENT_CHANGED',
  actor: { kind: 'HUMAN', id: 'dev' },
  authority: 'HUMAN_DECISION',
  ...overrides,
});

/**
 * A snapshot store that delegates to a real one, with named methods replaced.
 *
 * Spreading a class instance is not enough: the methods live on the prototype,
 * so `{...store, load: ...}` would produce an object with no `save` at all and
 * a test would pass because the handler caught a TypeError.
 */
export const snapshotsWith = (
  store: ProjectionSnapshotStore,
  overrides: Partial<ProjectionSnapshotStore>,
): ProjectionSnapshotStore => ({
  load: (scope, projection, version) => store.load(scope, projection, version),
  save: (scope, projection) => store.save(scope, projection),
  list: (scope) => store.list(scope),
  drop: (scope, projection, version) => store.drop(scope, projection, version),
  close: () => store.close(),
  ...overrides,
});

/** The same, for a ledger. */
export const ledgerWith = (ledger: EventLedger, overrides: Partial<EventLedger>): EventLedger => ({
  append: (scope, input) => ledger.append(scope, input),
  appendMany: (scope, inputs, options) => ledger.appendMany(scope, inputs, options),
  get: (scope, id) => ledger.get(scope, id),
  at: (scope, seq) => ledger.at(scope, seq),
  read: (scope, options) => ledger.read(scope, options),
  head: (scope) => ledger.head(scope),
  count: (scope) => ledger.count(scope),
  verify: (scope, options) => ledger.verify(scope, options),
  replay: (scope, onEvent, options) => ledger.replay(scope, onEvent, options),
  close: () => ledger.close(),
  ...overrides,
});
