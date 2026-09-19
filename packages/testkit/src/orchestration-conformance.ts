/**
 * Orchestration conformance suite (ADR-0018).
 *
 * Written against the ledger, graph and memory PORTS, so the in-memory stores
 * and the SQLite stores run the identical end-to-end suite (ADR-0003). The
 * provider is always the deterministic mock: this suite verifies the core's
 * logic, never a model's.
 *
 * What it proves:
 *   - one run, end to end: context recorded, call recorded, response recorded,
 *     every proposal evaluated on its own, accepted ones clamped to what an
 *     agent may do, and the graph mirroring the committed state
 *   - SPLIT_REQUIRED stops a run before any model call, and is recorded
 *   - every provider failure is typed, recorded, and becomes a known failure
 *     that the next context for the same kind of task must include
 *   - the graph is rebuildable: mirroring a replayed state into an empty graph
 *     gives the same structure as mirroring run by run
 *   - replay equals live for the cognitive and run projections
 *   - projects stay apart; and the same inputs on fresh stores give the same
 *     ledger — every event identical but for the ids the ledger mints — and
 *     the same graph
 */

import { CognitiveEngine, cognitionProjector, type CognitionState } from '@genesis/cognition';
import {
  type Orchestrator as OrchestratorType,
  GraphMirror,
  mirrorOf,
  Orchestrator,
  type OrchestratorIds,
  runsProjector,
  type TaskInput,
} from '@genesis/core';
import { type EventActor, type GenesisEvent, newProjectId, type ProjectScope, projectScope } from '@genesis/core-types';
import type { GraphStore } from '@genesis/graph';
import type { EventLedger } from '@genesis/ledger';
import type { MemoryStore } from '@genesis/memory';
import { projectionDigest, replayProjection, selfModelProjector } from '@genesis/projections';
import { type MockScript, MockReasoningProvider, ReasoningError } from '@genesis/reasoning';
import { beforeEach, describe, expect, it } from 'vitest';
import { countingIdSource, fixedClock } from './cognition-conformance.js';

export interface OrchestrationStores {
  readonly ledger: EventLedger;
  readonly graph: GraphStore;
  readonly memory: MemoryStore;
}

export interface OrchestrationHarness {
  readonly name: string;
  /** Fresh, empty stores. */
  createStores(): Promise<OrchestrationStores>;
}

const HUMAN: EventActor = { kind: 'HUMAN', id: 'dev' };
const SYSTEM: EventActor = { kind: 'SYSTEM', id: 'runner' };

/** Cycle and call ids that count up, in the shape the ledger accepts. */
export function countingOrchestratorIds(): OrchestratorIds {
  let cycle = 0;
  let call = 0;
  return {
    cycle: () => `cyc_${String((cycle += 1)).padStart(26, '0')}`,
    call: () => `rsn_${String((call += 1)).padStart(26, '0')}`,
  };
}

export interface Rig {
  readonly engine: CognitiveEngine;
  readonly orchestrator: OrchestratorType;
  readonly provider: MockReasoningProvider;
}

/** An engine, a mock provider and an orchestrator over the given stores, all deterministic. */
export function rig(stores: OrchestrationStores, script: MockScript, options: { readonly maxRecordedOutputChars?: number; readonly timeoutMs?: number } = {}): Rig {
  const engine = new CognitiveEngine(stores.ledger, { ids: countingIdSource(), now: fixedClock() });
  const provider = new MockReasoningProvider(script);
  const orchestrator = new Orchestrator({
    ledger: stores.ledger,
    engine,
    provider,
    memory: stores.memory,
    graph: stores.graph,
    ids: countingOrchestratorIds(),
    now: fixedClock(Date.UTC(2026, 5, 1)),
    reasoning: { timeoutMs: options.timeoutMs ?? 5_000, maxOutputTokens: 1024 },
    ...(options.maxRecordedOutputChars === undefined ? {} : { maxRecordedOutputChars: options.maxRecordedOutputChars }),
  });
  return { engine, orchestrator, provider };
}

/** An active goal, `goal-1`, and an open uncertainty blocking it, `unc-1`. */
export async function seedGoal(engine: CognitiveEngine, scope: ProjectScope): Promise<void> {
  await engine.execute(scope, HUMAN, {
    kind: 'PROPOSE_GOAL',
    description: 'ship booking cancellation',
    priority: 80,
    successCriteria: [{ statement: 'the suite passes', checkKind: 'TEST', checkRef: 'test:all' }],
  });
  await engine.execute(scope, HUMAN, { kind: 'ACTIVATE_GOAL', goalId: 'goal-1' });
  await engine.execute(scope, SYSTEM, {
    kind: 'RECORD_UNCERTAINTY',
    statement: 'is cancellation refundable?',
    whatBreaksIfWrong: 'refunds are paid that should not be',
    risk: 'HIGH',
    resolution: 'ASK_HUMAN',
    blocksGoalIds: ['goal-1'],
  });
}

export const TASK: TaskInput = {
  id: 'task-1',
  kind: 'implement',
  text: 'implement booking cancellation refunds',
  activeGoalId: 'goal-1',
  budgetTokens: 4000,
};

const served = { rationale: 'the task needs it', contributesTo: ['goal-1'] };

/** One of each outcome: accepted, malformed, not permitted, goal drift, rule violation. */
export const MIXED_PROPOSALS = {
  proposals: [
    { kind: 'RECORD_BELIEF', ...served, statement: 'refunds go to the original card', state: 'ASSUMED' },
    { kind: 'RECORD_BELIEF', ...served, statement: 'I am certain', authority: 'HUMAN_DECISION' },
    { kind: 'RESOLVE_UNCERTAINTY', ...served, uncertaintyId: 'unc-1', evidence: ['trust me'] },
    { kind: 'RECORD_UNCERTAINTY', rationale: 'r', contributesTo: ['goal-404'], statement: 's', whatBreaksIfWrong: 'w', risk: 'LOW', resolution: 'SEARCH' },
    { kind: 'DRAFT_QUESTION', ...served, uncertaintyId: 'unc-1', text: 'Is a cancelled booking refundable?' },
    { kind: 'DRAFT_QUESTION', ...served, uncertaintyId: 'unc-404', text: 'about nothing?' },
    {
      kind: 'RECORD_CONTRADICTION',
      ...served,
      contradictionKind: 'DOCUMENTATION_IMPLEMENTATION',
      sides: [
        { kind: 'BELIEF', beliefId: 'bel-1' },
        { kind: 'EXTERNAL', id: 'doc:refunds', claim: 'refunds are store credit', authority: 'HUMAN_DECISION' },
      ],
    },
    42,
  ],
};

/** A comparable picture of the mirrored part of a graph: structure, not write times. */
export async function mirrorSnapshot(graph: GraphStore, scope: ProjectScope, state: CognitionState): Promise<unknown> {
  const plan = mirrorOf(scope.projectId, state);
  const nodes = [];
  const edges = new Map<string, unknown>();
  for (const wanted of plan.nodes) {
    const node = await graph.getNode(scope, wanted.id);
    if (node === null) {
      nodes.push({ id: wanted.id, missing: true });
      continue;
    }
    nodes.push({ id: node.id, type: node.type, label: node.label, status: node.status, attrs: node.attrs, version: node.version });
    for (const e of await graph.edgesOf(scope, node.id)) {
      edges.set(e.id, { id: e.id, type: e.type, from: e.from, to: e.to, authority: e.authority, status: e.status });
    }
  }
  return { nodes, edges: [...edges.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, e]) => e) };
}

const typesOf = (events: readonly GenesisEvent[]): string[] => events.map((e) => e.type);

export function describeOrchestrationConformance(harness: OrchestrationHarness): void {
  describe(`orchestration conformance: ${harness.name}`, () => {
    let stores: OrchestrationStores;
    let scope: ProjectScope;

    beforeEach(async () => {
      stores = await harness.createStores();
      scope = projectScope(newProjectId());
    });

    it('runs a task end to end, and lets model output in only as an agent’s proposals', async () => {
      const { engine, orchestrator, provider } = rig(stores, [{ output: MIXED_PROPOSALS, usage: { inputTokens: 900, outputTokens: 300 } }]);
      await seedGoal(engine, scope);
      const before = (await stores.ledger.read(scope)).length;

      const result = await orchestrator.run(scope, TASK);

      expect(result.status).toBe('COMPLETED');
      expect(result.proposals.map((p) => [p.index, p.outcome, p.reason, p.rule])).toEqual([
        [0, 'ACCEPTED', null, null],
        [1, 'REJECTED', 'MALFORMED', null],
        [2, 'REJECTED', 'NOT_PERMITTED', null],
        [3, 'REJECTED', 'GOAL_DRIFT', null],
        [4, 'ACCEPTED', null, null],
        [5, 'REJECTED', 'RULE_VIOLATION', 'UNCERTAINTY_NOT_FOUND'],
        [6, 'ACCEPTED', null, null],
        [7, 'REJECTED', 'MALFORMED', null],
      ]);

      // The call saw the context, and the blocking uncertainty was in it.
      const [request] = provider.requests;
      expect(request?.context.map((b) => b.id)).toContain('uncertainty:unc-1');

      // An assumption, clamped and traced to its call — never more.
      const { state } = await engine.state(scope);
      expect(state.beliefs['bel-1']).toMatchObject({
        state: 'ASSUMED',
        authority: 'AI_ASSUMPTION',
        reasoningCallId: result.callId,
        createdBy: { actorKind: 'AGENT', actorId: 'reasoner:mock' },
      });
      // An agent may draft a question; it stays a draft.
      expect(state.questions['qst-1']?.status).toBe('DRAFT');
      // An agent-asserted authority cannot win: the contradiction escalates to a human.
      expect(state.contradictions['ctr-1']).toMatchObject({ status: 'ESCALATED', determination: 'INDETERMINATE' });
      // Nothing the model named was resolved.
      expect(state.uncertainties['unc-1']?.status).toBe('OPEN');

      const run = (await stores.ledger.read(scope)).slice(before);
      expect(new Set(run.map((e) => e.cycleId))).toEqual(new Set([result.cycleId]));
      const orchestration = run.filter((e) => e.actor.kind === 'SYSTEM');
      expect(typesOf(orchestration)).toEqual([
        'TASK_STARTED',
        'CONTEXT_ASSEMBLED',
        'REASONING_REQUESTED',
        'REASONING_RESPONDED',
        ...Array<string>(8).fill('PROPOSAL_EVALUATED'),
        'TASK_FINISHED',
      ]);
      // Everything the model caused was written as the agent it is.
      expect(new Set(run.filter((e) => e.actor.kind !== 'SYSTEM').map((e) => e.actor.kind))).toEqual(new Set(['AGENT']));
      expect(run.filter((e) => e.actor.kind === 'AGENT').every((e) => e.authority === 'AI_ASSUMPTION')).toBe(true);

      const responded = orchestration[3];
      expect(responded?.payload).toMatchObject({ outputText: JSON.stringify(MIXED_PROPOSALS), usage: { inputTokens: 900, outputTokens: 300 } });

      // The graph mirrors what was committed.
      expect(result.mirror?.nodesAdded).toBeGreaterThan(0);
      const plan = mirrorOf(scope.projectId, state);
      for (const node of plan.nodes) expect(await stores.graph.getNode(scope, node.id)).not.toBeNull();

      // The run is readable from the ledger, and the self model saw it finish.
      const runs = await orchestrator.runs(scope);
      expect(runs.runs[result.cycleId]).toMatchObject({ status: 'COMPLETED', accepted: 3, rejected: 5, callId: result.callId, modelId: 'mock-model' });
      const self = await replayProjection(selfModelProjector, scope, stores.ledger);
      expect(self.projection.state.currentTask).toBeNull();
    });

    it('records SPLIT_REQUIRED and stops before any model call when mandatory context cannot fit', async () => {
      const { engine, orchestrator, provider } = rig(stores, []);
      await seedGoal(engine, scope);
      const result = await orchestrator.run(scope, {
        ...TASK,
        budgetTokens: 10,
        policies: [{ id: 'no-prod', text: 'never touch production systems from a task', authority: 'HUMAN_DECISION' }],
      });
      expect(result).toMatchObject({ status: 'SPLIT_REQUIRED', callId: null, proposals: [], mirror: null });
      expect(provider.requests).toHaveLength(0);
      const events = (await stores.ledger.read(scope)).filter((e) => e.cycleId === result.cycleId);
      expect(typesOf(events)).toEqual(['TASK_STARTED', 'CONTEXT_ASSEMBLED', 'TASK_SPLIT_REQUIRED', 'TASK_FINISHED']);
      expect(events[2]?.payload).toMatchObject({
        taskId: 'task-1',
        budgetTokens: 10,
        mandatory: expect.arrayContaining(['policy:no-prod', 'uncertainty:unc-1']) as unknown,
      });
      expect((await orchestrator.runs(scope)).runs[result.cycleId]?.status).toBe('SPLIT_REQUIRED');
    });

    it('records a provider failure as typed, and the next context for that kind of task must include it', async () => {
      const { engine, orchestrator } = rig(stores, [
        { error: new ReasoningError('THROTTLED', 'slow down') },
        { output: { proposals: [] } },
      ]);
      await seedGoal(engine, scope);
      const failed = await orchestrator.run(scope, TASK);
      expect(failed).toMatchObject({ status: 'FAILED', failure: { kind: 'THROTTLED', message: 'slow down' } });
      const events = (await stores.ledger.read(scope)).filter((e) => e.cycleId === failed.cycleId);
      expect(typesOf(events)).toEqual([
        'TASK_STARTED',
        'CONTEXT_ASSEMBLED',
        'REASONING_REQUESTED',
        'REASONING_FAILED',
        'EXECUTION_FAILED',
        'TASK_FINISHED',
      ]);
      expect(events[3]?.payload).toMatchObject({ kind: 'THROTTLED', retryable: true });

      const next = await orchestrator.run(scope, { ...TASK, id: 'task-2' });
      expect(next.status).toBe('COMPLETED');
      expect(next.manifest.entries.find((e) => e.id === 'failure:implement:reasoning:THROTTLED')).toMatchObject({
        mandatory: 'MATCHING_FAILURE',
        included: true,
      });
      const runs = await orchestrator.runs(scope);
      expect(runs.runs[failed.cycleId]).toMatchObject({ status: 'FAILED', failure: 'THROTTLED' });
    });

    it('rejects output that is JSON but not the proposal envelope, and acts on none of it', async () => {
      const { engine, orchestrator } = rig(stores, [{ output: { beliefs: ['everything is fine'] } }]);
      await seedGoal(engine, scope);
      const before = (await engine.state(scope)).state;
      const result = await orchestrator.run(scope, TASK);
      expect(result).toMatchObject({ status: 'FAILED', failure: { kind: 'OUTPUT_NOT_AN_ENVELOPE' } });
      const events = (await stores.ledger.read(scope)).filter((e) => e.cycleId === result.cycleId);
      expect(typesOf(events)).toContain('REASONING_OUTPUT_REJECTED');
      expect(events.find((e) => e.type === 'EXECUTION_FAILED')?.payload).toEqual({ signature: 'implement:reasoning:INVALID_OUTPUT' });
      expect((await engine.state(scope)).state.beliefs).toEqual(before.beliefs);
    });

    it('does not act on output it could not record', async () => {
      const { engine, orchestrator } = rig(stores, [{ output: MIXED_PROPOSALS }], { maxRecordedOutputChars: 50 });
      await seedGoal(engine, scope);
      const result = await orchestrator.run(scope, TASK);
      expect(result).toMatchObject({ status: 'FAILED', failure: { kind: 'OUTPUT_TOO_LARGE' }, proposals: [] });
      const responded = (await stores.ledger.read(scope)).find((e) => e.type === 'REASONING_RESPONDED');
      expect(responded?.payload).toMatchObject({ outputText: null, outputLength: JSON.stringify(MIXED_PROPOSALS).length });
      expect((await engine.state(scope)).state.beliefs).toEqual({});
    });

    it('ends a call that never answers with TIMEOUT, on the request’s own budget', async () => {
      const { engine, orchestrator } = rig(stores, [{ hang: true }], { timeoutMs: 30 });
      await seedGoal(engine, scope);
      const result = await orchestrator.run(scope, TASK);
      expect(result).toMatchObject({ status: 'FAILED', failure: { kind: 'TIMEOUT' } });
    });

    it('keeps the graph rebuildable: a replayed state mirrored into an empty graph is the same graph', async () => {
      const { engine, orchestrator } = rig(stores, [{ output: MIXED_PROPOSALS }]);
      await seedGoal(engine, scope);
      await orchestrator.run(scope, TASK);
      // Human decisions after the run change statuses the mirror must follow.
      await engine.execute(scope, SYSTEM, { kind: 'ASK_QUESTIONS', questionIds: ['qst-1'] });
      await engine.execute(scope, HUMAN, {
        kind: 'RESPOND_TO_QUESTION',
        questionId: 'qst-1',
        response: { kind: 'ANSWER', text: 'yes, to the original card' },
      });
      await engine.execute(scope, HUMAN, { kind: 'RESOLVE_CONTRADICTION', contradictionId: 'ctr-1', governingSide: 1, reason: 'the doc is right' });
      await orchestrator.syncGraph(scope);
      // Idempotent: a second pass changes nothing.
      expect(await orchestrator.syncGraph(scope)).toEqual({ nodesAdded: 0, nodesTransitioned: 0, edgesAdded: 0, edgesTransitioned: 0 });

      const replayed = (await replayProjection(cognitionProjector, scope, stores.ledger)).projection.state;
      const fresh = await harness.createStores();
      await new GraphMirror(fresh.graph).reconcile(scope, replayed);
      expect(await mirrorSnapshot(fresh.graph, scope, replayed)).toEqual(await mirrorSnapshot(stores.graph, scope, replayed));

      const live = await mirrorSnapshot(stores.graph, scope, replayed);
      expect(JSON.stringify(live)).not.toContain('"missing":true');
      await fresh.ledger.close();
    });

    it('keeps replay equal to live for the cognitive and run projections', async () => {
      const { engine, orchestrator } = rig(stores, [{ output: MIXED_PROPOSALS }, { error: new ReasoningError('UNAVAILABLE', 'down') }]);
      await seedGoal(engine, scope);
      await orchestrator.run(scope, TASK);
      await orchestrator.run(scope, { ...TASK, id: 'task-2' });
      const cognition = await replayProjection(cognitionProjector, scope, stores.ledger);
      expect(projectionDigest(cognition.projection)).toBe(projectionDigest(await engine.state(scope)));
      expect(cognition.projection.state.observations.anomalies).toEqual([]);
      const runs = await replayProjection(runsProjector, scope, stores.ledger);
      expect(runs.projection.state).toEqual(await orchestrator.runs(scope));
      expect(runs.projection.state.observations.anomalies).toEqual([]);
      expect((await replayProjection(selfModelProjector, scope, stores.ledger)).projection.state.observations.anomalies).toEqual([]);
    });

    it('keeps projects apart', async () => {
      const other = projectScope(newProjectId());
      const { engine, orchestrator } = rig(stores, [{ output: MIXED_PROPOSALS }]);
      await seedGoal(engine, scope);
      await orchestrator.run(scope, TASK);
      expect((await engine.state(other)).state.beliefs).toEqual({});
      expect((await orchestrator.runs(other)).runs).toEqual({});
      // The same record ids in another project name different graph elements.
      const state = (await engine.state(scope)).state;
      const here = mirrorOf(scope.projectId, state).nodes.map((n) => n.id);
      const there = mirrorOf(other.projectId, state).nodes.map((n) => n.id);
      expect(here.filter((id) => there.includes(id))).toEqual([]);
      for (const id of there) expect(await stores.graph.getNode(other, id)).toBeNull();
    });

    it('is deterministic: the same inputs on fresh stores give the same ledger and the same graph', async () => {
      const runOnce = async (s: OrchestrationStores) => {
        const r = rig(s, [{ output: MIXED_PROPOSALS }]);
        await seedGoal(r.engine, scope);
        await r.orchestrator.run(scope, TASK);
        // Everything but the event ids (and the hashes over them), which the
        // ledger mints at append time.
        const events = (await s.ledger.read(scope)).map(({ id: _id, payloadHash: _h, prevHash: _p, ...rest }) => rest);
        return { events, graph: await mirrorSnapshot(s.graph, scope, (await r.engine.state(scope)).state) };
      };
      const second = await harness.createStores();
      const [a, b] = [await runOnce(stores), await runOnce(second)];
      expect(a.events.length).toBeGreaterThan(15);
      expect(b).toEqual(a);
      await second.ledger.close();
    });
  });
}
