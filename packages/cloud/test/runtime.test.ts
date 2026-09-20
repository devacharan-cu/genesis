/**
 * The composition root.
 *
 * What is being checked is the wiring itself: that every port is bound, that
 * they are bound to the resources the configuration names, and that closing the
 * runtime releases all of them rather than the first few.
 */

import { DynamoDbModel, EventBusModel, GENESIS_TABLE_SCHEMA, ObjectStoreModel, SecretsClientModel, UnverifiedClaimsVerifier } from '@genesis/adapters-aws';
import { newProjectId, projectScope } from '@genesis/core-types';
import { worldModelProjector } from '@genesis/projections';
import { SecretRef } from '@genesis/secrets';
import { describe, expect, it } from 'vitest';
import { advanceProjection } from '../src/handlers.js';
import { buildCloudRuntime, type CloudClients } from '../src/runtime.js';
import { claimsFor, configFor, deployment, TOKEN } from './harness.js';

const clients = (overrides: Partial<CloudClients> = {}): CloudClients => ({
  dynamo: new DynamoDbModel(GENESIS_TABLE_SCHEMA),
  objects: new ObjectStoreModel(),
  bus: new EventBusModel(),
  secrets: new SecretsClientModel({ 'genesis/test/db': 'the-value' }),
  tokens: new UnverifiedClaimsVerifier({ [TOKEN]: claimsFor() }),
  ...overrides,
});

describe('what the root builds', () => {
  it('binds every port a handler can reach', () => {
    const { runtime } = deployment();
    for (const port of ['ledger', 'memory', 'graph', 'snapshots', 'evidence', 'artifacts', 'identity', 'secrets', 'publisher']) {
      expect(runtime[port as keyof typeof runtime], port).toBeDefined();
    }
  });

  it('keeps the configuration it was given', () => {
    const projectId = newProjectId();
    const config = configFor(projectId);
    expect(buildCloudRuntime(config, clients()).config).toBe(config);
  });

  it('puts evidence and artifacts in different buckets, because they have different lifecycles', async () => {
    const { runtime, projectId } = deployment();
    const scope = projectScope(projectId);
    const bytes = new TextEncoder().encode('identical content');

    const evidence = await runtime.evidence.put(scope, 'EVIDENCE', bytes);
    expect(await runtime.artifacts.get(scope, evidence)).toBeNull();
    await runtime.artifacts.put(scope, 'EVIDENCE', bytes);
    expect(await runtime.artifacts.get(scope, evidence)).not.toBeNull();
  });

  it('resolves a secret through the port rather than holding one', async () => {
    const { runtime } = deployment();
    const value = await runtime.secrets.resolve(SecretRef.parse({ provider: 'SECRETS_MANAGER', name: 'genesis/test/db' }));
    expect(value.reveal()).toBe('the-value');
    expect(JSON.stringify(runtime.config)).not.toContain('the-value');
  });

  it('authenticates through the verifier it was handed', async () => {
    const { runtime } = deployment();
    expect((await runtime.identity.authenticate(TOKEN)).subject).toBe('cognito-subject-1');
  });

  it('writes every store into the one table the configuration names', async () => {
    const dynamo = new DynamoDbModel(GENESIS_TABLE_SCHEMA);
    const projectId = newProjectId();
    const runtime = buildCloudRuntime(configFor(projectId), clients({ dynamo }));
    const scope = projectScope(projectId);

    await runtime.ledger.append(scope, { type: 'REQUIREMENT_CHANGED', actor: { kind: 'HUMAN', id: 'dev' }, authority: 'HUMAN_DECISION' });
    // The graph and the ledger are different stores over the same table
    // (ADR-0024 §1). Both answering means both were pointed at it.
    expect(await runtime.ledger.count(scope)).toBe(1);
    expect(await runtime.graph.findOrphans(scope)).toEqual([]);
  });

  it('uses an injected clock throughout, so a test can pin time end to end', async () => {
    const at = new Date('2026-09-20T12:00:00.000Z');
    const projectId = newProjectId();
    const runtime = buildCloudRuntime(configFor(projectId), clients(), { now: () => at });
    const event = await runtime.ledger.append(projectScope(projectId), {
      type: 'REQUIREMENT_CHANGED',
      actor: { kind: 'HUMAN', id: 'dev' },
      authority: 'HUMAN_DECISION',
    });
    expect(event.timestamp).toBe(at.toISOString());
  });
});

describe('the injected clock', () => {
  it('reaches the snapshot store, so a stored snapshot is timestamped by it', async () => {
    const at = new Date('2026-09-20T12:00:00.000Z');
    const projectId = newProjectId();
    const runtime = buildCloudRuntime(configFor(projectId), clients(), { now: () => at });
    const scope = projectScope(projectId);

    await runtime.ledger.append(scope, {
      type: 'REQUIREMENT_CHANGED',
      actor: { kind: 'HUMAN', id: 'dev' },
      authority: 'HUMAN_DECISION',
    });
    await advanceProjection(worldModelProjector, scope, runtime.ledger, runtime.snapshots);

    const snapshot = await runtime.snapshots.load(scope, worldModelProjector.name, worldModelProjector.version);
    expect(snapshot?.updatedAt).toBe(at.toISOString());
  });
});

describe('closing', () => {
  it('releases everything', async () => {
    const { runtime } = deployment();
    await runtime.close();
    await expect(runtime.ledger.count(projectScope(newProjectId()))).rejects.toThrow();
  });

  it('closes the rest even when one of them fails', async () => {
    // The secret resolver closes before the publisher. A `close` that stopped
    // at the first failure would leak the bus connection, which in a Lambda
    // degrades slowly enough that nobody would trace it back to this line.
    let publisherClosed = false;
    const failing = buildCloudRuntime(configFor(newProjectId()), {
      ...clients(),
      secrets: {
        getSecretValue: async () => null,
        getParameter: async () => null,
        close: async () => {
          throw new Error('the secret resolver would not close');
        },
      },
      bus: {
        putEvents: async () => 0,
        close: async () => {
          publisherClosed = true;
        },
      },
    });

    await expect(failing.close()).rejects.toThrow(/would not close/);
    expect(publisherClosed).toBe(true);
  });

  it('reports the first failure rather than swallowing it', async () => {
    const { runtime } = deployment();
    const failing = buildCloudRuntime(runtime.config, {
      ...clients(),
      bus: {
        putEvents: async () => 0,
        close: async () => {
          throw new Error('the bus would not close');
        },
      },
    });
    await expect(failing.close()).rejects.toThrow(/the bus would not close/);
  });

  it('is safe to close a runtime that closed cleanly', async () => {
    const { runtime } = deployment();
    await runtime.close();
    await expect(runtime.close()).resolves.toBeUndefined();
  });
});
