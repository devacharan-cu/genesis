/**
 * The orchestrator's own guards, beyond the shared suite: who may record a
 * run, what a task must look like, and a provider that misbehaves in ways a
 * well-behaved adapter never would.
 */

import { CognitiveEngine } from '@genesis/cognition';
import { defaultOrchestratorIds, Orchestrator, type OrchestratorOptions } from '@genesis/core';
import {
  CycleId,
  newProjectId,
  projectScope,
  type ProjectScope,
  ReasoningCallId,
  ValidationError,
} from '@genesis/core-types';
import { InMemoryGraphStore } from '@genesis/graph';
import { InMemoryEventLedger } from '@genesis/ledger';
import { InMemoryMemoryStore } from '@genesis/memory';
import { MockReasoningProvider, type ReasoningProvider } from '@genesis/reasoning';
import { countingIdSource, countingOrchestratorIds, fixedClock, seedGoal, TASK } from '@genesis/testkit';
import { beforeEach, describe, expect, it } from 'vitest';

let ledger: InMemoryEventLedger;
let engine: CognitiveEngine;
let scope: ProjectScope;

beforeEach(() => {
  ledger = new InMemoryEventLedger();
  engine = new CognitiveEngine(ledger, { ids: countingIdSource(), now: fixedClock() });
  scope = projectScope(newProjectId());
});

const orchestrator = (provider: ReasoningProvider, over: Partial<OrchestratorOptions> = {}) =>
  new Orchestrator({
    ledger,
    engine,
    provider,
    memory: new InMemoryMemoryStore(),
    graph: new InMemoryGraphStore(),
    ids: countingOrchestratorIds(),
    now: fixedClock(Date.UTC(2026, 5, 1)),
    ...over,
  });

const failureOf = async (provider: ReasoningProvider, over: Partial<OrchestratorOptions> = {}) => {
  await seedGoal(engine, scope);
  const result = await orchestrator(provider, over).run(scope, TASK);
  return result.failure;
};

describe('construction and input', () => {
  it('records runs only as the system', () => {
    expect(() => orchestrator(new MockReasoningProvider([]), { actor: { kind: 'AGENT', id: 'a', agentRole: 'X' } })).toThrow(
      /as the system, not as AGENT/,
    );
    expect(() => orchestrator(new MockReasoningProvider([]), { actor: { kind: 'HUMAN', id: 'dev' } })).toThrow(ValidationError);
  });

  it('refuses to propose as a person: an agent cannot become one', async () => {
    await seedGoal(engine, scope);
    const run = orchestrator(new MockReasoningProvider([])).run(scope, TASK, { actor: { kind: 'HUMAN', id: 'dev' } });
    await expect(run).rejects.toThrow(/never as a person/);
    await expect(run).rejects.toThrow(ValidationError);
  });

  it('refuses an invalid task before writing anything', async () => {
    await expect(orchestrator(new MockReasoningProvider([])).run(scope, { ...TASK, budgetTokens: 0 })).rejects.toThrow(/invalid task/);
    await expect(orchestrator(new MockReasoningProvider([])).run(scope, { ...TASK, extra: 1 } as never)).rejects.toThrow(ValidationError);
    expect(await ledger.count(scope)).toBe(0);
  });

  it('mints real cycle and call ids, and reads the wall clock, by default', async () => {
    expect(CycleId.safeParse(defaultOrchestratorIds.cycle()).success).toBe(true);
    expect(ReasoningCallId.safeParse(defaultOrchestratorIds.call()).success).toBe(true);
    await seedGoal(engine, scope);
    const plain = new Orchestrator({
      ledger,
      engine,
      provider: new MockReasoningProvider([{ output: { proposals: [] } }]),
      memory: new InMemoryMemoryStore(),
      graph: new InMemoryGraphStore(),
    });
    const result = await plain.run(scope, TASK);
    expect(result.status).toBe('COMPLETED');
    expect(CycleId.safeParse(result.cycleId).success).toBe(true);
    const [started] = (await ledger.read(scope)).filter((e) => e.cycleId === result.cycleId);
    expect(started?.actor).toEqual({ kind: 'SYSTEM', id: 'orchestrator' });
  });
});

describe('a provider that misbehaves', () => {
  it('is stopped by the outer guard when it ignores its own timeout', async () => {
    const stuck: ReasoningProvider = { id: 'stuck', complete: () => new Promise(() => undefined) };
    expect(await failureOf(stuck, { reasoning: { timeoutMs: 5, guardMs: 5 } })).toMatchObject({
      kind: 'TIMEOUT',
      message: 'provider stuck did not settle within 10ms',
    });
  });

  it('has a result that is not a result refused', async () => {
    const liar: ReasoningProvider = { id: 'liar', complete: () => Promise.resolve({ output: 1 } as never) };
    expect(await failureOf(liar)).toMatchObject({ kind: 'INVALID_RESPONSE', message: 'provider liar returned a malformed result' });
  });

  it('has a synchronous throw handled as a failure, not a crash', async () => {
    const thrower: ReasoningProvider = {
      id: 'thrower',
      complete: () => {
        throw new Error('boom');
      },
    };
    expect(await failureOf(thrower)).toMatchObject({ kind: 'UNKNOWN', message: 'unexpected provider failure: boom' });
  });
});

describe('proposal evaluation', () => {
  it('rejects a proposal for a goal that exists but is not ACTIVE, naming no unknown goal', async () => {
    await engine.execute(scope, { kind: 'HUMAN', id: 'dev' }, { kind: 'PROPOSE_GOAL', description: 'idle', priority: 1 });
    const provider = new MockReasoningProvider([
      { output: { proposals: [{ kind: 'RECORD_BELIEF', rationale: 'r', contributesTo: ['goal-1'], statement: 's' }] } },
    ]);
    const result = await orchestrator(provider).run(scope, { ...TASK, activeGoalId: null });
    expect(result.proposals[0]).toMatchObject({ outcome: 'REJECTED', reason: 'GOAL_DRIFT', detail: 'NO_ACTIVE_GOAL' });
  });

  it('lets a store failure surface rather than record it as a rejection', async () => {
    class BrokenEngine extends CognitiveEngine {
      override execute(): never {
        throw new Error('ledger unavailable');
      }
    }
    engine = new BrokenEngine(ledger, { ids: countingIdSource(), now: fixedClock() });
    const setup = new CognitiveEngine(ledger, { ids: countingIdSource(), now: fixedClock() });
    await seedGoal(setup, scope);
    const provider = new MockReasoningProvider([
      { output: { proposals: [{ kind: 'RECORD_BELIEF', rationale: 'r', contributesTo: ['goal-1'], statement: 's' }] } },
    ]);
    await expect(orchestrator(provider).run(scope, TASK)).rejects.toThrow('ledger unavailable');
    // The run is visible as interrupted: started, never finished.
    const runs = await orchestrator(provider).runs(scope);
    expect(Object.values(runs.runs).map((r) => [r.status, r.finishedSeq])).toEqual([['RUNNING', null]]);
  });

  it('keeps serving a project after a run failed on a store error', async () => {
    const setup = new CognitiveEngine(ledger, { ids: countingIdSource(), now: fixedClock() });
    await seedGoal(setup, scope);
    const o = orchestrator(new MockReasoningProvider([{ output: { proposals: [] } }]));
    await expect(o.run(scope, { ...TASK, nodeIds: ['node_01ARZ3NDEKTSV4RRFFQ69G5FZZ'] })).rejects.toThrow(/holds no node/);
    expect((await o.run(scope, TASK)).status).toBe('COMPLETED');
  });
});
