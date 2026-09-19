/**
 * The agent runtime, end to end against real stores and a mock provider.
 *
 * The claims under test are ADR-0020's, in order: an agent's work reaches state
 * only through the core's own door, a failure is typed and recorded, a silent
 * agent is failed rather than waited for, verification is the engine's, tasks
 * for one project do not interleave, and the whole thing replays.
 */

import {
  AgentRegistry,
  BaseAgent,
  PlannerAgent,
  type Agent,
  type AgentOutcome,
  type AgentServices,
  type Emit,
  type RegistryPolicy,
  VerifierAgent,
} from '@genesis/agents';
import { CognitiveEngine } from '@genesis/cognition';
import {
  AgentRuntime,
  agentTasksProjector,
  AGENT_EVENTS,
  defaultAgentRuntimeIds,
  isInterruptedTask,
  messageCount,
  Orchestrator,
  PROPOSAL_KINDS,
  summarise,
  type AgentRuntimeOptions,
  type TaskRequest,
} from '@genesis/core';
import {
  type AgentTaskState,
  MessageId,
  newAgentId,
  newProjectId,
  projectScope,
  TaskId,
  ValidationError,
  type ProjectScope,
} from '@genesis/core-types';
import { InMemoryGraphStore } from '@genesis/graph';
import { InMemoryEventLedger } from '@genesis/ledger';
import { InMemoryMemoryStore } from '@genesis/memory';
import { emptyProjection, resumeProjection } from '@genesis/projections';
import { AgentManifest, canTransition, type Envelope, type TaskAssignmentBody, type TaskFraming } from '@genesis/protocol';
import { MockReasoningProvider } from '@genesis/reasoning';
import { countingIdSource, countingOrchestratorIds, fixedClock, seedGoal } from '@genesis/testkit';
import { VerificationEngine } from '@genesis/verification';
import { beforeEach, describe, expect, it } from 'vitest';

const POLICY: RegistryPolicy = {
  proposalKinds: [...PROPOSAL_KINDS],
  permissions: [],
  tools: [],
  reasoningProviders: ['mock'],
};

const served = { rationale: 'the task needs it', contributesTo: ['goal-1'] };
const A_BELIEF = { kind: 'RECORD_BELIEF', statement: 'refunds are pro-rata', ...served };

let ledger: InMemoryEventLedger;
let engine: CognitiveEngine;
let scope: ProjectScope;

beforeEach(async () => {
  ledger = new InMemoryEventLedger();
  engine = new CognitiveEngine(ledger, { ids: countingIdSource(), now: fixedClock() });
  scope = projectScope(newProjectId());
  await seedGoal(engine, scope);
});

const manifest = (over: Record<string, unknown> = {}): AgentManifest =>
  AgentManifest.parse({
    id: newAgentId(),
    role: 'PLANNER',
    version: '1.0.0',
    capabilities: ['decompose-goal'],
    maxContextTokens: 4000,
    timeoutMs: 5000,
    proposalKinds: ['RECORD_BELIEF'],
    reasoningProvider: 'mock',
    ...over,
  });

/** Deterministic ids, so two runs of the same task look identical on the ledger. */
const countingRuntimeIds = () => {
  let task = 0;
  let message = 0;
  return {
    task: () => TaskId.parse(`task_${String((task += 1)).padStart(26, '0')}`),
    message: () => MessageId.parse(`msg_${String((message += 1)).padStart(26, '0')}`),
  };
};

const build = (
  agents: readonly Agent[],
  script: { output: unknown }[],
  over: Partial<AgentRuntimeOptions> = {},
): AgentRuntime => {
  const registry = new AgentRegistry(POLICY);
  for (const agent of agents) registry.register(agent);
  const orchestrator = new Orchestrator({
    ledger,
    engine,
    provider: new MockReasoningProvider(script as never),
    memory: new InMemoryMemoryStore(),
    graph: new InMemoryGraphStore(),
    ids: countingOrchestratorIds(),
    now: fixedClock(Date.UTC(2026, 5, 1)),
    reasoning: { timeoutMs: 5_000, maxOutputTokens: 1024 },
  });
  return new AgentRuntime({
    ledger,
    engine,
    registry,
    orchestrator,
    ids: countingRuntimeIds(),
    now: fixedClock(Date.UTC(2026, 5, 1)),
    ...over,
  });
};

const REQUEST: TaskRequest = {
  role: 'PLANNER',
  instruction: 'decompose the active goal into an ordered plan',
  contributesTo: ['goal-1'],
};

const typesOf = async (): Promise<string[]> => (await ledger.read(scope)).map((e) => e.type);

const tasksOf = async () => {
  const { projection } = await resumeProjection(agentTasksProjector, emptyProjection(agentTasksProjector, scope), ledger);
  return projection.state;
};

// ---------------------------------------------------------------- assignment

describe('assignment', () => {
  it('refuses a role nobody fills, before writing anything', async () => {
    const before = await ledger.count(scope);
    await expect(build([], []).assign(scope, { ...REQUEST, role: 'BUILDER' })).rejects.toThrow(/no agent fills the role/);
    expect(await ledger.count(scope)).toBe(before);
  });

  it('refuses work that serves no goal: that is drift, not a task', async () => {
    const runtime = build([new PlannerAgent(manifest())], []);
    await expect(runtime.assign(scope, { ...REQUEST, contributesTo: [] })).rejects.toThrow(ValidationError);
  });

  it('records tasks only as the system', () => {
    expect(() => build([], [], { actor: { kind: 'AGENT', id: 'a', agentRole: 'PLANNER' } })).toThrow(
      /as the system, not as AGENT/,
    );
  });

  it('mints real task and message ids by default', () => {
    expect(TaskId.safeParse(defaultAgentRuntimeIds.task()).success).toBe(true);
    expect(MessageId.safeParse(defaultAgentRuntimeIds.message()).success).toBe(true);
  });

  it('records the assignment with what the agent was actually granted', async () => {
    const m = manifest({ proposalKinds: ['RECORD_BELIEF'] });
    await build([new PlannerAgent(m)], [{ output: { proposals: [] } }]).assign(scope, REQUEST);
    const assigned = (await ledger.read(scope)).find((e) => e.type === AGENT_EVENTS.AGENT_TASK_ASSIGNED);
    expect(assigned?.payload).toMatchObject({ agentId: m.id, role: 'PLANNER', attempt: 1, proposalKinds: ['RECORD_BELIEF'] });
  });
});

// ------------------------------------------------------------- the happy path

describe('a task that works', () => {
  it('reaches canonical state only through the core, and records every step', async () => {
    const runtime = build([new PlannerAgent(manifest())], [{ output: { proposals: [A_BELIEF] } }]);
    const outcome = await runtime.assign(scope, REQUEST);

    expect(outcome.state).toBe('COMPLETED');
    expect(outcome.failure).toBeNull();
    expect(outcome.attempts).toBe(1);

    const types = await typesOf();
    // The orchestrator's own record is there, unchanged, under the same cycle.
    expect(types).toContain('REASONING_REQUESTED');
    expect(types).toContain('PROPOSAL_EVALUATED');
    // And the runtime's, around it.
    expect(types).toContain(AGENT_EVENTS.AGENT_TASK_ASSIGNED);
    expect(types).toContain(AGENT_EVENTS.AGENT_MESSAGE_RECEIVED);
    expect(types).toContain(AGENT_EVENTS.AGENT_TASK_FINISHED);
  });

  it('records the agent, not the runtime, as the actor behind a belief', async () => {
    const m = manifest();
    await build([new PlannerAgent(m)], [{ output: { proposals: [A_BELIEF] } }]).assign(scope, REQUEST);
    const recorded = (await ledger.read(scope)).find((e) => e.type === 'BELIEF_RECORDED');
    expect(recorded?.actor).toEqual({ kind: 'AGENT', id: m.id, agentRole: 'PLANNER' });
  });

  it('caps an agent belief at AI_ASSUMPTION, however the agent framed it', async () => {
    await build([new PlannerAgent(manifest())], [{ output: { proposals: [A_BELIEF] } }]).assign(scope, REQUEST);
    const recorded = (await ledger.read(scope)).find((e) => e.type === 'BELIEF_RECORDED');
    expect(recorded?.authority).toBe('AI_ASSUMPTION');
  });

  it('refuses a proposal of a kind the agent did not declare', async () => {
    const question = { kind: 'DRAFT_QUESTION', uncertaintyId: 'unc-1', text: 'is it refundable?', ...served };
    const runtime = build([new PlannerAgent(manifest({ proposalKinds: ['RECORD_BELIEF'] }))], [
      { output: { proposals: [question] } },
    ]);
    await runtime.assign(scope, REQUEST);
    const evaluated = (await ledger.read(scope)).filter((e) => e.type === 'PROPOSAL_EVALUATED');
    expect(evaluated[0]?.payload).toMatchObject({ outcome: 'REJECTED', reason: 'NOT_PERMITTED' });
    expect((evaluated[0]?.payload as { detail: string }).detail).toContain('RECORD_BELIEF');
  });

  it('refuses everything from an agent that declared no proposal kinds', async () => {
    const runtime = build([new PlannerAgent(manifest({ proposalKinds: [] }))], [{ output: { proposals: [A_BELIEF] } }]);
    await runtime.assign(scope, REQUEST);
    const evaluated = (await ledger.read(scope)).filter((e) => e.type === 'PROPOSAL_EVALUATED');
    expect(evaluated[0]?.payload).toMatchObject({ reason: 'NOT_PERMITTED' });
    expect((evaluated[0]?.payload as { detail: string }).detail).toContain('nothing');
  });

  it('refuses a proposal that serves a goal that does not exist', async () => {
    const drift = { ...A_BELIEF, contributesTo: ['goal-nonexistent'] };
    await build([new PlannerAgent(manifest())], [{ output: { proposals: [drift] } }]).assign(scope, REQUEST);
    const evaluated = (await ledger.read(scope)).filter((e) => e.type === 'PROPOSAL_EVALUATED');
    expect(evaluated[0]?.payload).toMatchObject({ reason: 'GOAL_DRIFT' });
  });
});

// ------------------------------------------------------------------- failures

/** An agent that does whatever the test needs it to do wrong. */
class Rogue extends BaseAgent {
  constructor(
    m: AgentManifest,
    private readonly behaviour: (a: TaskAssignmentBody, s: AgentServices) => Promise<unknown>,
    private readonly framing: TaskFraming | null | (() => never) = null,
  ) {
    super(m);
  }
  frame(): TaskFraming | null {
    if (typeof this.framing === 'function') return this.framing();
    return this.framing;
  }
  override handle(a: TaskAssignmentBody, s: AgentServices): Promise<AgentOutcome> {
    return this.behaviour(a, s) as Promise<AgentOutcome>;
  }
}

describe('failure is typed, recorded, and never silent', () => {
  const rogue = (behaviour: (a: TaskAssignmentBody, s: AgentServices) => Promise<unknown>, framing?: TaskFraming | (() => never)) =>
    build([new Rogue(manifest({ maxAttempts: 1 }), behaviour, framing ?? null)], []);

  it('fails a task whose agent throws, and names the failure AGENT_THREW', async () => {
    const outcome = await rogue(() => Promise.reject(new Error('boom'))).assign(scope, REQUEST);
    expect(outcome.state).toBe('FAILED');
    expect(outcome.failure).toMatchObject({ kind: 'AGENT_THREW', message: 'boom' });
  });

  it('fails a task whose agent returns nonsense', async () => {
    const outcome = await rogue(() => Promise.resolve('done')).assign(scope, REQUEST);
    expect(outcome.failure?.kind).toBe('MALFORMED_OUTPUT');
  });

  it('fails a task whose agent claims a state it may not claim', async () => {
    const outcome = await rogue(() => Promise.resolve({ messages: [], reached: 'COMPLETED_REALLY' })).assign(scope, REQUEST);
    expect(outcome.failure?.kind).toBe('MALFORMED_OUTPUT');
  });

  it('fails a task whose agent reports on somebody else', async () => {
    const elsewhere = TaskId.parse(`task_${'9'.repeat(26)}`);
    const outcome = await rogue((a, s) =>
      Promise.resolve({
        messages: [
          {
            id: s.newMessageId(),
            schemaVersion: '1',
            kind: 'RESULT',
            from: { kind: 'AGENT', id: a.role, role: 'PLANNER' },
            to: { kind: 'SYSTEM', id: 'agent-runtime' },
            cycleId: null,
            correlationId: null,
            causationId: null,
            issuedAt: s.now(),
            expiresAt: null,
            body: { taskId: elsewhere, summary: 'done', proposalsSubmitted: 0, findingsRaised: 0, questionsRaised: 0 },
          },
        ],
        reached: 'COMPLETED',
      }),
    ).assign(scope, REQUEST);
    expect(outcome.failure?.kind).toBe('CAPABILITY_REFUSED');
    expect(outcome.failure?.message).toContain(elsewhere);
  });

  it('fails a task whose agent frames something invalid, before any model call', async () => {
    const outcome = await rogue(
      () => Promise.resolve({ messages: [], reached: 'COMPLETED' }),
      { kind: '', text: '', nodeIds: [], activeGoalId: null, budgetTokens: -1 } as never,
    ).assign(scope, REQUEST);
    expect(outcome.failure?.kind).toBe('MALFORMED_OUTPUT');
    expect(outcome.failure?.message).toContain('framed an invalid task');
    expect(await typesOf()).not.toContain('REASONING_REQUESTED');
  });

  it('fails a task whose agent throws while framing', async () => {
    const outcome = await rogue(
      () => Promise.resolve({ messages: [], reached: 'COMPLETED' }),
      () => {
        throw new Error('cannot frame this');
      },
    ).assign(scope, REQUEST);
    expect(outcome.failure).toMatchObject({ kind: 'AGENT_THREW', message: 'cannot frame this' });
  });

  it('fails an agent that never settles, rather than waiting for it', async () => {
    const runtime = build(
      [new Rogue(manifest({ maxAttempts: 1, timeoutMs: 50 }), () => new Promise(() => undefined))],
      [],
      { guardMs: 10 },
    );
    const outcome = await runtime.assign(scope, REQUEST);
    expect(outcome.failure?.kind).toBe('TIMEOUT');
    expect(outcome.state).toBe('FAILED');
  });

  it('records a failure signature that groups repetitions', async () => {
    const outcome = await rogue(() => Promise.reject(new Error('boom'))).assign(scope, REQUEST);
    expect(outcome.failure?.signature).toBe('agent:PLANNER:PLANNER_TASK:AGENT_THREW');
    // In the self model's own vocabulary, so a repeated failure is learned.
    const failures = (await ledger.read(scope)).filter((e) => e.type === 'EXECUTION_FAILED');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.payload).toMatchObject({ signature: outcome.failure?.signature });
  });

  it('cancels rather than fails when the caller withdrew the task', async () => {
    const controller = new AbortController();
    const runtime = build(
      [new Rogue(manifest({ maxAttempts: 3 }), () => new Promise(() => undefined))],
      [],
      { guardMs: 10 },
    );
    const running = runtime.assign(scope, { ...REQUEST, budget: { timeoutMs: 5_000 } }, controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 20);
    const outcome = await running;
    // Cancellation is not retried: the caller has already said to stop.
    expect(outcome.attempts).toBe(1);
    expect(['CANCELLED', 'FAILED']).toContain(outcome.state);
  });
});

describe('retry', () => {
  let attempts: number;

  beforeEach(() => {
    attempts = 0;
  });

  it('retries up to the manifest bound, keeping one task id', async () => {
    const runtime = build(
      [
        new Rogue(manifest({ maxAttempts: 3 }), () => {
          attempts += 1;
          return Promise.reject(new Error('flaky'));
        }),
      ],
      [],
    );
    const outcome = await runtime.assign(scope, REQUEST);
    expect(attempts).toBe(3);
    expect(outcome.attempts).toBe(3);
    expect(outcome.state).toBe('FAILED');
    const tasks = await tasksOf();
    expect(Object.keys(tasks.tasks)).toHaveLength(1);
    expect(tasks.tasks[outcome.taskId]?.failures).toBe(3);
  });

  it('stops retrying the moment an attempt succeeds', async () => {
    const runtime = build(
      [
        new Rogue(manifest({ maxAttempts: 3 }), (a) => {
          attempts += 1;
          return attempts === 1
            ? Promise.reject(new Error('flaky'))
            : Promise.resolve({ messages: [], reached: 'COMPLETED', taskId: a.taskId });
        }),
      ],
      [],
    );
    const outcome = await runtime.assign(scope, REQUEST);
    expect(attempts).toBe(2);
    expect(outcome.state).toBe('COMPLETED');
    expect(outcome.failure).toBeNull();
  });

  it('records each retry as a real pair of moves, not an implied one', async () => {
    const runtime = build(
      [
        new Rogue(manifest({ maxAttempts: 2 }), () => {
          attempts += 1;
          return Promise.reject(new Error('flaky'));
        }),
      ],
      [],
    );
    await runtime.assign(scope, REQUEST);
    const moves = (await ledger.read(scope))
      .filter((e) => e.type === AGENT_EVENTS.AGENT_TASK_STATE_CHANGED)
      .map((e) => (e.payload as { from: string; to: string }));
    expect(moves).toEqual([
      { from: 'ASSIGNED', to: 'RUNNING' },
      { from: 'RUNNING', to: 'BLOCKED' },
      { from: 'BLOCKED', to: 'RUNNING' },
      { from: 'RUNNING', to: 'FAILED' },
    ].map((m) => expect.objectContaining(m)));
  });
});

// --------------------------------------------------------------- verification

describe('verification stays the engine’s', () => {
  class Submitter extends BaseAgent {
    constructor(
      m: AgentManifest,
      private readonly raw: string,
    ) {
      super(m);
    }
    frame(): null {
      return null;
    }
    protected override extraMessages(a: TaskAssignmentBody, _s: AgentServices, emit: Emit): readonly Envelope[] {
      return [
        emit('EVIDENCE_SUBMISSION', {
          taskId: a.taskId,
          experimentId: null,
          environment: 'LOCAL',
          exitCode: 0,
          raw: this.raw,
          testKind: 'UNIT',
          claimedArtifacts: ['file_1'],
        }),
      ];
    }
  }

  const submitting = (raw: string, verifier = new VerificationEngine()) =>
    build([new Submitter(manifest({ role: 'QA', proposalKinds: [] }), raw)], [], { verifier });

  it('advances only as far as the evidence attributes itself', async () => {
    const outcome = await submitting('coverage: file_1 100%').assign(scope, { ...REQUEST, role: 'QA' });
    expect(outcome.verified).toEqual([{ artifactId: 'file_1', state: 'UNIT_TESTED' }]);
  });

  it('completes the task once the engine has ruled, and not before', async () => {
    const outcome = await submitting('coverage: file_1 100%').assign(scope, { ...REQUEST, role: 'QA' });
    expect(outcome.state).toBe('COMPLETED');
    const moves = (await ledger.read(scope))
      .filter((e) => e.type === AGENT_EVENTS.AGENT_TASK_STATE_CHANGED)
      .map((e) => (e.payload as { to: string }).to);
    // Through the waiting state, not around it: the ledger shows the wait.
    expect(moves).toEqual(['RUNNING', 'AWAITING_VERIFICATION', 'COMPLETED']);
  });

  it('does not advance on an unattributed claim, however confident', async () => {
    const outcome = await submitting('ALL TESTS PASSED').assign(scope, { ...REQUEST, role: 'QA' });
    expect(outcome.verified).toEqual([{ artifactId: 'file_1', state: 'GENERATED' }]);
  });

  it('claims nothing at all when no verifier is configured', async () => {
    const runtime = build([new Submitter(manifest({ role: 'QA', proposalKinds: [] }), 'coverage: file_1')], []);
    const outcome = await runtime.assign(scope, { ...REQUEST, role: 'QA' });
    expect(outcome.verified).toEqual([]);
    // The evidence is still recorded; only the ruling is absent. The task stays
    // waiting rather than completing on a question nobody answered.
    expect(outcome.state).toBe('AWAITING_VERIFICATION');
    expect(await typesOf()).toContain(AGENT_EVENTS.AGENT_MESSAGE_RECEIVED);
  });

  it('records the submission itself, so the ruling can be recomputed', async () => {
    await submitting('coverage: file_1 100%').assign(scope, { ...REQUEST, role: 'QA' });
    const received = (await ledger.read(scope)).filter((e) => e.type === AGENT_EVENTS.AGENT_MESSAGE_RECEIVED);
    const kinds = received.map((e) => (e.payload as { messageKind: string }).messageKind);
    expect(kinds).toContain('EVIDENCE_SUBMISSION');
  });
});

// ------------------------------------------------------- isolation and replay

describe('project isolation', () => {
  it('writes nothing into another project', async () => {
    const other = projectScope(newProjectId());
    await build([new PlannerAgent(manifest())], [{ output: { proposals: [A_BELIEF] } }]).assign(scope, REQUEST);
    expect(await ledger.count(other)).toBe(0);
  });

  it('gives two projects independent task records', async () => {
    const other = projectScope(newProjectId());
    // Its own id source, so the second project's goal is also `goal-1`: ids are
    // per project, which is the isolation being tested.
    await seedGoal(new CognitiveEngine(ledger, { ids: countingIdSource(), now: fixedClock() }), other);
    const runtime = build([new PlannerAgent(manifest())], [{ output: { proposals: [] } }, { output: { proposals: [] } }]);
    const first = await runtime.assign(scope, REQUEST);
    const second = await runtime.assign(other, REQUEST);
    expect(first.taskId).not.toBe(second.taskId);
    const here = await tasksOf();
    expect(Object.keys(here.tasks)).toEqual([first.taskId]);
  });
});

describe('one project runs one task at a time', () => {
  it('serialises tasks rather than interleaving them', async () => {
    const order: string[] = [];
    const slow = new Rogue(manifest({ maxAttempts: 1 }), async (a) => {
      order.push(`start:${a.taskId}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`end:${a.taskId}`);
      return { messages: [], reached: 'COMPLETED' };
    });
    const runtime = build([slow], []);
    const [first, second] = await Promise.all([runtime.assign(scope, REQUEST), runtime.assign(scope, REQUEST)]);
    expect(order).toEqual([`start:${first.taskId}`, `end:${first.taskId}`, `start:${second.taskId}`, `end:${second.taskId}`]);
  });

  it('one failed task does not poison the next', async () => {
    let first = true;
    const flaky = new Rogue(manifest({ maxAttempts: 1 }), () => {
      if (first) {
        first = false;
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve({ messages: [], reached: 'COMPLETED' });
    });
    const runtime = build([flaky], []);
    const a = await runtime.assign(scope, REQUEST);
    const b = await runtime.assign(scope, REQUEST);
    expect(a.state).toBe('FAILED');
    expect(b.state).toBe('COMPLETED');
  });
});

describe('the task projection', () => {
  it('rebuilds what each task did from the ledger alone', async () => {
    const outcome = await build([new PlannerAgent(manifest())], [{ output: { proposals: [A_BELIEF] } }]).assign(scope, REQUEST);
    const state = await tasksOf();
    const task = state.tasks[outcome.taskId];
    expect(task).toMatchObject({ role: 'PLANNER', state: 'COMPLETED', attempts: 1, failures: 0 });
    expect(isInterruptedTask(task as never)).toBe(false);
    expect(messageCount(task as never)).toBeGreaterThan(0);
    expect(state.observations.anomalies).toEqual([]);
  });

  it('shows a task that started and never finished as interrupted', async () => {
    // Only the assignment is on the ledger: the process stopped mid-task.
    await ledger.append(scope, {
      type: AGENT_EVENTS.AGENT_TASK_ASSIGNED,
      actor: { kind: 'SYSTEM', id: 'agent-runtime' },
      authority: 'VERIFIED_SYSTEM_STATE',
      payload: {
        taskId: 'task_orphan',
        attempt: 1,
        agentId: 'agt_x',
        role: 'PLANNER',
        kind: 'PLANNER_TASK',
        contributesTo: ['goal-1'],
        deadline: '2026-06-01T00:00:00.000Z',
        proposalKinds: [],
      },
    });
    const state = await tasksOf();
    expect(isInterruptedTask(state.tasks['task_orphan'] as never)).toBe(true);
  });

  it('records a transition the machine forbids as an anomaly, not a state', async () => {
    await ledger.append(scope, {
      type: AGENT_EVENTS.AGENT_TASK_ASSIGNED,
      actor: { kind: 'SYSTEM', id: 'agent-runtime' },
      authority: 'VERIFIED_SYSTEM_STATE',
      payload: {
        taskId: 'task_bad',
        attempt: 1,
        agentId: 'agt_x',
        role: 'PLANNER',
        kind: 'PLANNER_TASK',
        contributesTo: ['goal-1'],
        deadline: '2026-06-01T00:00:00.000Z',
        proposalKinds: [],
      },
    });
    await ledger.append(scope, {
      type: AGENT_EVENTS.AGENT_TASK_STATE_CHANGED,
      actor: { kind: 'SYSTEM', id: 'agent-runtime' },
      authority: 'VERIFIED_SYSTEM_STATE',
      payload: { taskId: 'task_bad', from: 'ASSIGNED', to: 'COMPLETED', reason: 'skipping ahead' },
    });
    const state = await tasksOf();
    expect(state.tasks['task_bad']?.state).toBe('ASSIGNED');
    expect(state.observations.anomalies).toHaveLength(1);
  });
});

describe('determinism', () => {
  it('two identical tasks append identical events, ids and all', async () => {
    const eventsFor = async (): Promise<unknown[]> => {
      ledger = new InMemoryEventLedger();
      engine = new CognitiveEngine(ledger, { ids: countingIdSource(), now: fixedClock() });
      const project = projectScope(newProjectId());
      await seedGoal(engine, project);
      await build([new PlannerAgent(manifest({ id: newAgentId() }))], [{ output: { proposals: [A_BELIEF] } }]).assign(
        project,
        REQUEST,
      );
      return (await ledger.read(project)).map((e) => ({ seq: e.seq, type: e.type, cycleId: e.cycleId }));
    };
    expect(await eventsFor()).toEqual(await eventsFor());
  });

  it('summarises a run without handing the agent the model output', () => {
    const summary = summarise({
      cycleId: 'cyc_1',
      taskId: 'task-1',
      status: 'COMPLETED',
      callId: 'rsn_1',
      failure: null,
      proposals: [{ callId: 'rsn_1', index: 0, kind: 'RECORD_BELIEF', outcome: 'ACCEPTED', reason: null, rule: null, detail: null, eventSeqs: [1] }],
      mirror: null,
      manifest: {
        status: 'ASSEMBLED',
        usedTokens: 10,
        budgetTokens: 4000,
        entries: [{ id: 'mem_1', kind: 'BELIEF', mandatory: null, included: true }],
      } as never,
    });
    expect(JSON.stringify(summary)).not.toContain('outputText');
    expect(summary.proposals).toEqual([{ kind: 'RECORD_BELIEF', accepted: true, reason: null, detail: null }]);
    expect(summary.context.shown).toEqual([{ id: 'mem_1', kind: 'BELIEF', mandatory: null }]);
  });
});

describe('what an agent says is checked before it is acted on', () => {
  /** Emits whatever envelope the test hands it, well-formed or not. */
  class Speaker extends BaseAgent {
    constructor(
      m: AgentManifest,
      private readonly bodies: readonly { kind: string; body: unknown }[],
    ) {
      super(m);
    }
    frame(): null {
      return null;
    }
    protected override extraMessages(_a: TaskAssignmentBody, s: AgentServices): readonly Envelope[] {
      return this.bodies.map(
        ({ kind, body }) =>
          ({
            id: s.newMessageId(),
            schemaVersion: '1',
            kind,
            from: { kind: 'AGENT', id: this.manifest.id, role: this.manifest.role },
            to: { kind: 'SYSTEM', id: 'agent-runtime' },
            cycleId: null,
            correlationId: null,
            causationId: null,
            issuedAt: s.now(),
            expiresAt: null,
            body,
          }) as Envelope,
      );
    }
  }

  const speaking = (bodies: readonly { kind: string; body: unknown }[], over: Record<string, unknown> = {}) =>
    build([new Speaker(manifest({ role: 'REPAIR', ...over }), bodies)], []);

  it('refuses a message whose body is malformed, and records the refusal', async () => {
    const outcome = await speaking([
      { kind: 'FINDING', body: { taskId: 'task_00000000000000000000000001', subject: 'x' } },
    ]).assign(scope, { ...REQUEST, role: 'REPAIR' });
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0]?.kind).toBe('FINDING');
    const rejected = (await ledger.read(scope)).filter((e) => e.type === AGENT_EVENTS.AGENT_MESSAGE_REJECTED);
    expect(rejected).toHaveLength(1);
    // The task still completes: a refused message is the agent's mistake, not
    // a reason to lose the rest of its work.
    expect(outcome.state).toBe('COMPLETED');
  });

  it('keeps the good messages from a task that also sent a bad one', async () => {
    const taskId = 'task_00000000000000000000000001';
    const outcome = await speaking([
      { kind: 'FINDING', body: { taskId, subject: 'no risk given' } },
      { kind: 'FINDING', body: { taskId, subject: 'a real one', detail: 'with a detail', risk: 'LOW' } },
    ]).assign(scope, { ...REQUEST, role: 'REPAIR' });
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.messages.filter((m) => m.kind === 'FINDING')).toHaveLength(1);
  });

  it('puts a deterministic agent’s own proposal through the core’s door', async () => {
    const taskId = 'task_00000000000000000000000001';
    const outcome = await speaking(
      [
        {
          kind: 'PROPOSAL',
          body: {
            taskId,
            proposalKind: 'RECORD_BELIEF',
            rationale: 'the repair needs this recorded',
            contributesTo: ['goal-1'],
            changes: A_BELIEF,
          },
        },
      ],
      { proposalKinds: ['RECORD_BELIEF'] },
    ).assign(scope, { ...REQUEST, role: 'REPAIR' });

    expect(outcome.proposals).toHaveLength(1);
    expect(outcome.proposals[0]?.outcome).toBe('ACCEPTED');
    // Through the same door, so the same rules applied: the belief is the
    // agent's, capped at AI_ASSUMPTION, with no reasoning call anywhere.
    const recorded = (await ledger.read(scope)).find((e) => e.type === 'BELIEF_RECORDED');
    expect(recorded?.authority).toBe('AI_ASSUMPTION');
    expect(await typesOf()).not.toContain('REASONING_REQUESTED');
  });

  it('refuses a deterministic agent’s proposal of a kind it never declared', async () => {
    const taskId = 'task_00000000000000000000000001';
    const outcome = await speaking(
      [
        {
          kind: 'PROPOSAL',
          body: {
            taskId,
            proposalKind: 'RECORD_BELIEF',
            rationale: 'sneaking one in',
            contributesTo: ['goal-1'],
            changes: A_BELIEF,
          },
        },
      ],
      { proposalKinds: [] },
    ).assign(scope, { ...REQUEST, role: 'REPAIR' });
    expect(outcome.proposals[0]).toMatchObject({ outcome: 'REJECTED', reason: 'NOT_PERMITTED' });
  });
});

describe('an agent that both reasons and proposes on its own', () => {
  /** Frames a run, then also submits a proposal of its own from the summary. */
  class Both extends BaseAgent {
    frame(a: TaskAssignmentBody): TaskFraming {
      return { kind: 'REPAIR_TASK', text: a.instruction, nodeIds: [], activeGoalId: 'goal-1', budgetTokens: 4000 };
    }
    protected override extraMessages(a: TaskAssignmentBody, _s: AgentServices, emit: Emit): readonly Envelope[] {
      return [
        emit('PROPOSAL', {
          taskId: a.taskId,
          proposalKind: 'RECORD_BELIEF',
          rationale: 'the run found this worth recording separately',
          contributesTo: ['goal-1'],
          changes: A_BELIEF,
          expectedImpact: [],
          evidenceRefs: [],
          reversible: true,
        }),
      ];
    }
  }

  it('records its own proposal against the run it framed', async () => {
    const runtime = build([new Both(manifest({ role: 'REPAIR' }))], [{ output: { proposals: [] } }]);
    const outcome = await runtime.assign(scope, { ...REQUEST, role: 'REPAIR' });
    expect(outcome.proposals).toHaveLength(1);
    expect(outcome.proposals[0]?.outcome).toBe('ACCEPTED');
    // Against the run's own cycle, so the belief sits with the call that led to it.
    const recorded = (await ledger.read(scope)).find((e) => e.type === 'BELIEF_RECORDED');
    expect(recorded?.cycleId).not.toBeNull();
    expect(outcome.proposals[0]?.callId).not.toBeNull();
  });
});

describe('failures that are not Errors', () => {
  it('reports what a thrown string said, rather than losing it', async () => {
    const runtime = build(
      // The point of this case is a throw that is not an Error at all.
      [new Rogue(manifest({ maxAttempts: 1 }), () => Promise.reject('just a string'))],
      [],
    );
    const outcome = await runtime.assign(scope, REQUEST);
    expect(outcome.failure).toMatchObject({ kind: 'AGENT_THREW', message: 'just a string' });
  });

  it('names the root when an invalid framing is invalid at the top level', async () => {
    const runtime = build(
      [new Rogue(manifest({ maxAttempts: 1 }), () => Promise.resolve({ messages: [], reached: 'COMPLETED' }), 7 as never)],
      [],
    );
    const outcome = await runtime.assign(scope, REQUEST);
    expect(outcome.failure?.kind).toBe('MALFORMED_OUTPUT');
    expect(outcome.failure?.message).toContain('<root>');
  });
});

describe('defaults', () => {
  it('reads the wall clock and mints real ids when none are injected', async () => {
    const registry = new AgentRegistry(POLICY);
    registry.register(new PlannerAgent(manifest()));
    const runtime = new AgentRuntime({
      ledger,
      engine,
      registry,
      orchestrator: new Orchestrator({
        ledger,
        engine,
        provider: new MockReasoningProvider([{ output: { proposals: [] } }] as never),
        memory: new InMemoryMemoryStore(),
        graph: new InMemoryGraphStore(),
      }),
    });
    const outcome = await runtime.assign(scope, REQUEST);
    expect(TaskId.safeParse(outcome.taskId).success).toBe(true);
    expect(outcome.state).toBe('COMPLETED');
  });
});

describe('every transition the runtime records is one the machine permits', () => {
  it('holds across a task that succeeds, one that retries, and one that is refused', async () => {
    let first = true;
    const flaky = new Rogue(manifest({ maxAttempts: 2 }), () => {
      if (first) {
        first = false;
        return Promise.reject(new Error('flaky'));
      }
      return Promise.resolve({ messages: [], reached: 'COMPLETED' });
    });
    await build([flaky], []).assign(scope, REQUEST);
    await build([new Rogue(manifest({ maxAttempts: 1 }), () => Promise.reject(new Error('always')))], []).assign(
      scope,
      REQUEST,
    );

    const moves = (await ledger.read(scope))
      .filter((e) => e.type === AGENT_EVENTS.AGENT_TASK_STATE_CHANGED)
      .map((e) => e.payload as { from: AgentTaskState; to: AgentTaskState });
    expect(moves.length).toBeGreaterThan(4);
    for (const { from, to } of moves) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
  });
});

describe('a deterministic agent needs no provider', () => {
  it('runs a Verifier with no reasoning call at all', async () => {
    const runtime = build(
      [
        new VerifierAgent(manifest({ role: 'VERIFIER', reasoningProvider: null, proposalKinds: [] }), {
          exitCode: 0,
          raw: 'all tests passed',
          testKind: 'UNIT',
          claimedArtifacts: ['file_1'],
          environment: 'SANDBOX',
        }),
      ],
      [],
    );
    const outcome = await runtime.assign(scope, { ...REQUEST, role: 'VERIFIER' });
    expect(outcome.state).toBe('COMPLETED');
    expect(await typesOf()).not.toContain('REASONING_REQUESTED');
    expect(outcome.messages.some((m) => m.kind === 'FINDING')).toBe(true);
  });
});
