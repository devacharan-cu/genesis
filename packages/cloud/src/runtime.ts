/**
 * The composition root (ADR-0003, ADR-0026 §4).
 *
 * This is the only package allowed to name both a port and a cloud adapter, and
 * this is the file where that happens. Everything above it — the core, the
 * cognitive primitives, the agents, the factory — sees ports, which is what
 * makes the whole system runnable locally against SQLite and in a deployment
 * against DynamoDB without a line of domain code knowing which.
 *
 * The AWS SDK is not imported here either. The adapters depend on small
 * operation interfaces (`DynamoDbClient`, `ObjectStoreClient`, `SecretsClient`
 * and so on), and a deployment passes SDK-backed implementations while a test
 * passes the in-process models. That is what lets the wiring itself be tested:
 * this file is exercised by the suite, not merely compiled by it.
 */

import {
  CognitoIdentityProvider,
  type DynamoDbClient,
  DynamoEventLedger,
  DynamoGraphStorage,
  DynamoMemoryStore,
  DynamoProjectionSnapshotStore,
  type EventBusClient,
  LedgerEventPublisher,
  type ObjectStoreClient,
  S3BlobStore,
  AwsSecretResolver,
  type SecretsClient,
  type TokenVerifier,
} from '@genesis/adapters-aws';
import type { BlobStore } from '@genesis/blob';
import type { IdentityProvider } from '@genesis/identity';
import type { SecretResolver } from '@genesis/secrets';
import type { EventLedger } from '@genesis/ledger';
import type { MemoryStore } from '@genesis/memory';
import { GraphEngine, type GraphStore } from '@genesis/graph';
import type { ProjectionSnapshotStore } from '@genesis/projections';
import type { CloudConfig } from './config.js';

/**
 * The service clients a deployment supplies.
 *
 * Each is the narrow set of operations one adapter issues, never an SDK client.
 * A deployment builds these from `@aws-sdk/*`; the suite builds them from the
 * in-process models that pass the same conformance tests.
 */
export interface CloudClients {
  readonly dynamo: DynamoDbClient;
  readonly objects: ObjectStoreClient;
  readonly bus: EventBusClient;
  readonly secrets: SecretsClient;
  /** Verifies a Cognito token's signature. `aws-jwt-verify` in a deployment. */
  readonly tokens: TokenVerifier;
}

/** Everything a handler needs, behind ports. */
export interface CloudRuntime {
  readonly config: CloudConfig;
  readonly ledger: EventLedger;
  readonly memory: MemoryStore;
  readonly graph: GraphStore;
  readonly snapshots: ProjectionSnapshotStore;
  readonly evidence: BlobStore;
  readonly artifacts: BlobStore;
  readonly identity: IdentityProvider;
  readonly secrets: SecretResolver;
  readonly publisher: LedgerEventPublisher;
  close(): Promise<void>;
}

export interface RuntimeOptions {
  /** Injectable clock, so a test can pin timestamps end to end. */
  readonly now?: (() => Date) | undefined;
}

/**
 * Wires the ports to the AWS adapters.
 *
 * Evidence and artifacts are two `BlobStore`s over two buckets rather than one
 * store with a kind, because they have different lifecycles: SPEC-07 §5 keeps
 * evidence indefinitely and artifacts under a per-project policy, and a single
 * bucket would make that a tagging convention instead of a boundary.
 */
export function buildCloudRuntime(config: CloudConfig, clients: CloudClients, options: RuntimeOptions = {}): CloudRuntime {
  const now = options.now;

  const ledger = new DynamoEventLedger({ client: clients.dynamo, table: config.table, ...(now === undefined ? {} : { now }) });
  const memory = new DynamoMemoryStore({ client: clients.dynamo, table: config.table, ...(now === undefined ? {} : { now }) });
  const graph = new GraphEngine(new DynamoGraphStorage({ client: clients.dynamo, table: config.table }));
  const snapshots = new DynamoProjectionSnapshotStore({
    client: clients.dynamo,
    table: config.table,
    ...(now === undefined ? {} : { now: () => now().toISOString() }),
  });

  const evidence = new S3BlobStore({ client: clients.objects, bucket: config.evidenceBucket });
  const artifacts = new S3BlobStore({ client: clients.objects, bucket: config.artifactBucket });

  const identity = new CognitoIdentityProvider({
    verifier: clients.tokens,
    issuer: config.identityIssuer,
    audience: config.identityAudience,
    ...(now === undefined ? {} : { now }),
  });
  const secrets = new AwsSecretResolver({ client: clients.secrets });
  const publisher = new LedgerEventPublisher({ client: clients.bus, busName: config.eventBusName });

  return {
    config,
    ledger,
    memory,
    graph,
    snapshots,
    evidence,
    artifacts,
    identity,
    secrets,
    publisher,
    /**
     * Releases everything, and reports the first failure after trying them all.
     *
     * Stopping at the first failure would leak the rest — and a Lambda that
     * leaked a connection per invocation would degrade slowly enough that
     * nobody would connect it to this line.
     */
    async close(): Promise<void> {
      const failures: unknown[] = [];
      for (const closeable of [ledger, memory, graph, snapshots, evidence, artifacts, identity, secrets, publisher]) {
        try {
          await closeable.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw failures[0];
    },
  };
}
