/**
 * Shared fixtures for the projections tests.
 *
 * The two histories below are the ones the conformance suite folds, splits and
 * replays. They are deliberately not clean: each contains a contradiction, a
 * supersession or a mismatch, and an event type the projection does not
 * handle — a history in which nothing goes wrong would not exercise the paths
 * that matter.
 */

import { type EventActor, type GenesisEvent, newNodeId, type ProjectScope } from '@genesis/core-types';
import { type EventLedger, InMemoryEventLedger } from '@genesis/ledger';

export const createLedger = (): Promise<EventLedger> => Promise.resolve(new InMemoryEventLedger());

export const SYSTEM: EventActor = { kind: 'SYSTEM', id: 'test-runner' };
export const HUMAN: EventActor = { kind: 'HUMAN', id: 'dev' };
export const AGENT: EventActor = { kind: 'AGENT', id: 'agt-1', agentRole: 'IMPLEMENTER' };

export async function seedWorldModel(
  ledger: EventLedger,
  scope: ProjectScope,
): Promise<GenesisEvent[]> {
  const gateway = newNodeId();
  const database = newNodeId();

  const deployed = await ledger.append(scope, {
    type: 'WORLD_FACT_OBSERVED',
    actor: SYSTEM,
    authority: 'EVIDENCE',
    subject: { nodeType: 'COMPONENT', nodeId: gateway },
    after: { statement: 'the api gateway is deployed', sourceRefs: ['run-1'] },
  });

  const schema = await ledger.append(scope, {
    type: 'WORLD_FACT_OBSERVED',
    actor: SYSTEM,
    authority: 'EVIDENCE',
    subject: { nodeType: 'DATABASE', nodeId: database },
    after: { statement: 'the schema is at revision 4', beliefId: 'bel-1' },
  });

  const notDeployed = await ledger.append(scope, {
    type: 'WORLD_FACT_OBSERVED',
    actor: AGENT,
    authority: 'AI_ASSUMPTION',
    subject: { nodeType: 'COMPONENT', nodeId: gateway },
    after: { statement: 'the api gateway is not deployed' },
  });

  const newerSchema = await ledger.append(scope, {
    type: 'WORLD_FACT_OBSERVED',
    actor: SYSTEM,
    authority: 'EVIDENCE',
    subject: { nodeType: 'DATABASE', nodeId: database },
    after: { statement: 'the schema is at revision 5', sourceRefs: ['run-2'] },
  });

  const contradiction = await ledger.append(scope, {
    type: 'WORLD_FACT_CONTRADICTED',
    actor: SYSTEM,
    authority: 'EVIDENCE',
    payload: { factIds: [deployed.id, notDeployed.id] },
  });

  const supersession = await ledger.append(scope, {
    type: 'WORLD_FACT_SUPERSEDED',
    actor: SYSTEM,
    authority: 'EVIDENCE',
    payload: { factId: schema.id, supersededBy: newerSchema.id },
  });

  const unrelated = await ledger.append(scope, {
    type: 'CYCLE_STARTED',
    actor: SYSTEM,
    authority: 'EVIDENCE',
    payload: { phase: 'OBSERVE' },
  });

  return [deployed, schema, notDeployed, newerSchema, contradiction, supersession, unrelated];
}

export async function seedSelfModel(
  ledger: EventLedger,
  scope: ProjectScope,
): Promise<GenesisEvent[]> {
  return ledger.appendMany(scope, [
    {
      type: 'CAPABILITY_OBSERVED',
      actor: SYSTEM,
      authority: 'VERIFIED_SYSTEM_STATE',
      payload: {
        id: 'run-tests',
        description: 'runs the project test suite',
        status: 'AVAILABLE',
        evidenceRef: 'run-1',
      },
    },
    {
      type: 'CAPABILITY_OBSERVED',
      actor: AGENT,
      authority: 'AI_ASSUMPTION',
      // No evidence, not a human: SPEC-01 section 4 rule 1 says this cannot be
      // AVAILABLE, and the projection records it as UNAVAILABLE with an anomaly.
      payload: { id: 'deploy', description: 'deploys to AWS', status: 'AVAILABLE' },
    },
    {
      type: 'LIMITATION_DECLARED',
      actor: HUMAN,
      authority: 'HUMAN_DECISION',
      payload: {
        id: 'no-prod-writes',
        description: 'may not write to production',
        source: 'DECLARED',
      },
    },
    {
      type: 'GOAL_FOCUSED',
      actor: HUMAN,
      authority: 'HUMAN_DECISION',
      payload: { goalId: 'goal-ship-p1' },
    },
    { type: 'TASK_STARTED', actor: SYSTEM, authority: 'EVIDENCE', payload: { taskId: 'task-1' } },
    // Cognition events the self model reads (ADR-0014 rule 6). Only the id
    // and state/status matter to it; the cognition projection owns the rest.
    {
      type: 'UNCERTAINTY_RECORDED',
      actor: SYSTEM,
      authority: 'EVIDENCE',
      payload: { uncertainty: { id: 'unc-1', status: 'OPEN' } },
    },
    {
      type: 'BELIEF_RECORDED',
      actor: AGENT,
      authority: 'AI_ASSUMPTION',
      payload: { belief: { id: 'bel-1', state: 'ASSUMED' } },
    },
    {
      type: 'EXECUTION_FAILED',
      actor: SYSTEM,
      authority: 'EVIDENCE',
      payload: { signature: 'ETIMEDOUT:deploy', mitigation: 'retry with a longer timeout' },
    },
    {
      type: 'EXECUTION_FAILED',
      actor: SYSTEM,
      authority: 'EVIDENCE',
      payload: { signature: 'ETIMEDOUT:deploy' },
    },
    { type: 'TASK_FINISHED', actor: SYSTEM, authority: 'EVIDENCE', payload: { taskId: 'task-1' } },
    { type: 'CYCLE_STARTED', actor: SYSTEM, authority: 'EVIDENCE', payload: { phase: 'OBSERVE' } },
  ]);
}
