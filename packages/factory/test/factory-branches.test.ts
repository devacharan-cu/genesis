/**
 * The factory's failure and staleness paths, driven with a stub runtime.
 *
 * The end-to-end suite proves the real integration against real stores, a real
 * sandbox and a mock provider. It cannot reach every branch quickly, because
 * making a real agent fail in a specific way at a specific stage means
 * arranging the whole world for it.
 *
 * So these drive the factory through a runtime stub that fails whichever stage
 * the test names. The stub is cast into place, which is the one thing here that
 * is not the production wiring — everything it returns is a real `TaskOutcome`,
 * and every assertion is about the factory's own behaviour.
 */

import type { AgentRuntime, TaskOutcome } from '@genesis/core';
import {
  type AgentRole,
  FactoryRunId,
  newProjectId,
  newTaskId,
  projectScope,
  TaskId,
  type ProjectScope,
  type VerificationState,
} from '@genesis/core-types';
import { InMemoryGraphStore } from '@genesis/graph';
import { InMemoryEventLedger } from '@genesis/ledger';
import type { SandboxProvider, SandboxRequest, SandboxResult } from '@genesis/sandbox';
import { SandboxError } from '@genesis/sandbox';
import { beforeEach, describe, expect, it } from 'vitest';
import { FACTORY_EVENTS } from '../src/events.js';
import { approachFrom, defaultFactoryIds, failureFrom, SoftwareFactory, type FactoryIntent } from '../src/factory.js';

let ledger: InMemoryEventLedger;
let graph: InMemoryGraphStore;
let scope: ProjectScope;

beforeEach(() => {
  ledger = new InMemoryEventLedger();
  graph = new InMemoryGraphStore();
  scope = projectScope(newProjectId());
});

const ok = (over: Partial<TaskOutcome> = {}): TaskOutcome => ({
  taskId: newTaskId(),
  state: 'COMPLETED',
  attempts: 1,
  failure: null,
  proposals: [],
  verified: [],
  messages: [],
  rejected: [],
  produced: null,
  ...over,
});

const failed = (message: string): TaskOutcome =>
  ok({ state: 'FAILED', failure: { kind: 'AGENT_THREW', message, signature: 'agent:X:Y:AGENT_THREW' } });

type Answers = Partial<Record<AgentRole, () => TaskOutcome | Promise<TaskOutcome>>>;

/** A runtime that answers per role, and records what it was asked. */
class StubRuntime {
  readonly seen: { role: AgentRole; input: unknown }[] = [];
  constructor(private readonly answers: Answers) {}
  async assign(_scope: ProjectScope, request: { role: AgentRole; input?: unknown }): Promise<TaskOutcome> {
    this.seen.push({ role: request.role, input: request.input });
    const answer = this.answers[request.role];
    return answer === undefined ? ok() : answer();
  }
}

class StubSandbox implements SandboxProvider {
  readonly ran: SandboxRequest[] = [];
  constructor(private readonly result: SandboxResult | SandboxError = { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 }) {}
  run(request: SandboxRequest): Promise<SandboxResult> {
    this.ran.push(request);
    if (this.result instanceof SandboxError) return Promise.reject(this.result);
    return Promise.resolve(this.result);
  }
}

const ALWAYS_GENERATED = { evaluate: (): VerificationState => 'GENERATED' };
const ALWAYS_UNIT = { evaluate: (): VerificationState => 'UNIT_TESTED' };

const build = (
  answers: Answers,
  over: { sandbox?: SandboxProvider; verifier?: { evaluate: () => VerificationState }; maxStages?: number; maxRepairAttempts?: number } = {},
) => {
  const runtime = new StubRuntime(answers);
  let n = 0;
  const factory = new SoftwareFactory({
    ledger,
    // The stub stands in for the runtime; everything it returns is a real
    // TaskOutcome, and the factory is the thing under test.
    runtime: runtime as unknown as AgentRuntime,
    graph,
    verifier: over.verifier ?? ALWAYS_UNIT,
    sandbox: over.sandbox ?? new StubSandbox(),
    config: { maxRepairAttempts: over.maxRepairAttempts ?? 1 },
    ids: { run: () => FactoryRunId.parse(`run_${String((n += 1)).padStart(26, '0')}`) },
    now: () => '2026-09-20T00:00:00.000Z',
    ...(over.maxStages === undefined ? {} : { maxStages: over.maxStages }),
  });
  return { factory, runtime };
};

/** A BUILDER answer that lands one artifact, recorded the way the core records it. */
const landing = (artifactId: string, path: string, contents: string) => async (): Promise<TaskOutcome> => {
  await ledger.append(scope, {
    type: 'ARTIFACT_PROPOSED',
    actor: { kind: 'AGENT', id: 'agt_1', agentRole: 'BUILDER' },
    authority: 'AI_ASSUMPTION',
    payload: { artifactId, path, contentHash: 'h', bytes: contents.length, language: 'ts', contents, callId: 'rsn_1', verificationState: 'GENERATED' },
  });
  return ok({ produced: { artifacts: [{ artifactId, path, contentHash: 'h', bytes: contents.length }], limitations: [] } });
};

const intent = (over: Partial<FactoryIntent> = {}): FactoryIntent => ({
  goalId: 'goal-1',
  title: 'a change',
  specification: 'do the thing',
  testCommand: ['node', 'test.js'],
  ...over,
});

const stagesOf = (o: { stages: readonly { stage: string; result: string }[] }): string[] =>
  o.stages.map((s) => `${s.stage}:${s.result}`);

// -------------------------------------------------------- each stage failing

describe('a stage whose agent fails', () => {
  it('blocks the run when planning fails, because a plan has no repair path', async () => {
    const { factory } = build({ PLANNER: () => failed('the planner threw') });
    const outcome = await factory.build(scope, intent());
    expect(stagesOf(outcome)).toEqual(['PLAN:FAILED']);
    expect(outcome.outcome).toBe('BLOCKED');
    expect(outcome.summary).toContain('no repair path');
    expect(outcome.stages[0]?.detail).toContain('the planner threw');
  });

  it('blocks when architecture fails', async () => {
    const { factory } = build({ ARCHITECT: () => failed('the architect threw') });
    const outcome = await factory.build(scope, intent());
    expect(stagesOf(outcome)).toEqual(['PLAN:PASSED', 'ARCHITECT:FAILED']);
    expect(outcome.outcome).toBe('BLOCKED');
  });

  it('diagnoses when the builder fails', async () => {
    const { factory } = build({ BUILDER: () => failed('the builder threw') });
    const outcome = await factory.build(scope, intent());
    expect(stagesOf(outcome)).toContain('BUILD:FAILED');
    expect(stagesOf(outcome)).toContain('DIAGNOSE:PASSED');
    expect(outcome.stages.find((s) => s.stage === 'BUILD')?.detail).toContain('the builder threw');
  });

  it('diagnoses when QA fails', async () => {
    const { factory } = build({ BUILDER: landing('art_1', 'a.ts', 'x'), QA: () => failed('QA threw') });
    const outcome = await factory.build(scope, intent());
    expect(stagesOf(outcome)).toContain('TEST:FAILED');
    expect(outcome.stages.find((s) => s.stage === 'TEST')?.detail).toContain('QA failed: QA threw');
  });

  it('diagnoses when the security review fails', async () => {
    const { factory } = build({ BUILDER: landing('art_1', 'a.ts', 'x'), SECURITY: () => failed('security threw') });
    const outcome = await factory.build(scope, intent());
    expect(outcome.stages.find((s) => s.stage === 'SECURITY_REVIEW')?.detail).toContain('security threw');
  });

  it('blocks when the diagnosis itself fails', async () => {
    const { factory } = build({ BUILDER: () => failed('the builder threw'), REPAIR: () => failed('diagnosis threw') });
    const outcome = await factory.build(scope, intent());
    expect(stagesOf(outcome)).toContain('DIAGNOSE:FAILED');
    expect(outcome.outcome).toBe('BLOCKED');
    expect(outcome.summary).toContain('no repair path');
  });
});

// ------------------------------------------------------------------ verify

describe('verification', () => {
  it('does not advance when the engine says GENERATED', async () => {
    const { factory } = build({ BUILDER: landing('art_1', 'a.ts', 'x') }, { verifier: ALWAYS_GENERATED });
    const outcome = await factory.build(scope, intent());
    expect(stagesOf(outcome)).toContain('VERIFY:FAILED');
    expect(outcome.stages.find((s) => s.stage === 'VERIFY')?.detail).toContain('generated, not verified');
  });

  it('records the engine’s ruling, whatever it is', async () => {
    const { factory } = build({ BUILDER: landing('art_1', 'a.ts', 'x') });
    await factory.build(scope, intent());
    const ruled = (await ledger.read(scope)).filter((e) => e.type === FACTORY_EVENTS.FACTORY_ARTIFACT_VERIFIED);
    expect(ruled).toHaveLength(1);
    expect(ruled[0]?.payload).toMatchObject({ artifactId: 'art_1', state: 'UNIT_TESTED' });
  });

  it('names the run that verified it', async () => {
    const { factory } = build({ BUILDER: landing('art_1', 'a.ts', 'x') });
    const outcome = await factory.build(scope, intent());
    const ruled = (await ledger.read(scope)).find((e) => e.type === FACTORY_EVENTS.FACTORY_ARTIFACT_VERIFIED);
    expect(ruled?.payload).toMatchObject({ runId: outcome.runId });
  });
});

// ----------------------------------------------------------------- staleness

describe('a stale lease', () => {
  /** A builder that also disturbs a leased node, so the lease goes stale. */
  const disturbing = (nodeId: string) => async (): Promise<TaskOutcome> => {
    await ledger.append(scope, {
      type: 'COMPONENT_CHANGED',
      actor: { kind: 'SYSTEM', id: 'someone-else' },
      authority: 'VERIFIED_SYSTEM_STATE',
      subject: { nodeType: 'COMPONENT', nodeId },
      payload: null,
    });
    return ok();
  };

  it('re-runs the stage once, and the rerun succeeds when the world settles', async () => {
    const node = await graph.addNode(scope, { type: 'COMPONENT', label: 'a' });
    let calls = 0;
    const { factory } = build({
      // Only the first pass disturbs the world; the second leaves it alone.
      PLANNER: async () => {
        calls += 1;
        return calls === 1 ? disturbing(node.id)() : ok();
      },
      BUILDER: landing('art_1', 'a.ts', 'x'),
    });
    const outcome = await factory.build(scope, intent({ originNodes: [node.id] }));
    const stale = (await ledger.read(scope)).filter((e) => e.type === FACTORY_EVENTS.FACTORY_LEASE_STALE);
    expect(stale).toHaveLength(1);
    expect(stale[0]?.payload).toMatchObject({ stage: 'PLAN', pass: 1, willRerun: true });
    expect(calls).toBe(2);
    // The rerun is a second pass of the same stage, and the run carries on.
    expect(outcome.stages.filter((s) => s.stage === 'PLAN')).toHaveLength(1);
    expect(outcome.stages[0]).toMatchObject({ stage: 'PLAN', pass: 2, result: 'PASSED' });
    expect(outcome.outcome).toBe('VERIFIED');
  });

  it('blocks on a second staleness rather than looping', async () => {
    const node = await graph.addNode(scope, { type: 'COMPONENT', label: 'a' });
    const { factory } = build({ PLANNER: disturbing(node.id) });
    const outcome = await factory.build(scope, intent({ originNodes: [node.id] }));
    expect(outcome.outcome).toBe('BLOCKED');
    expect(outcome.summary).toContain('against a stable state');
    const stale = (await ledger.read(scope)).filter((e) => e.type === FACTORY_EVENTS.FACTORY_LEASE_STALE);
    expect(stale.map((e) => (e.payload as { willRerun: boolean }).willRerun)).toEqual([true, false]);
  });

  it('records the lease it took for every stage', async () => {
    const node = await graph.addNode(scope, { type: 'COMPONENT', label: 'a' });
    const { factory } = build({ BUILDER: landing('art_1', 'a.ts', 'x') });
    await factory.build(scope, intent({ originNodes: [node.id] }));
    const entered = (await ledger.read(scope)).filter((e) => e.type === FACTORY_EVENTS.FACTORY_STAGE_ENTERED);
    expect(entered.length).toBeGreaterThan(0);
    for (const event of entered) {
      expect(event.payload).toMatchObject({ lease: { nodes: [node.id], origins: [node.id] } });
    }
  });
});

// --------------------------------------------------------------- the sandbox

describe('the sandbox', () => {
  it('stages every built artifact before running the command', async () => {
    const sandbox = new StubSandbox();
    const { factory } = build({ BUILDER: landing('art_1', 'src/a.ts', 'export const a = 1;') }, { sandbox });
    await factory.build(scope, intent());
    expect(sandbox.ran).toHaveLength(1);
    expect(sandbox.ran[0]?.files).toEqual({ 'src/a.ts': 'export const a = 1;' });
    expect(sandbox.ran[0]?.command).toEqual(['node', 'test.js']);
  });

  it('reports a sandbox refusal as a failure, not as a pass', async () => {
    const sandbox = new StubSandbox(new SandboxError('TIMEOUT', 'timed out after 100ms'));
    const { factory } = build({ BUILDER: landing('art_1', 'a.ts', 'x') }, { sandbox });
    const outcome = await factory.build(scope, intent());
    expect(stagesOf(outcome)).toContain('TEST:FAILED');
    expect(outcome.stages.find((s) => s.stage === 'TEST')?.detail).toContain('TIMEOUT');
  });

  it('reports a non-zero exit as a failure', async () => {
    const sandbox = new StubSandbox({ exitCode: 3, stdout: '', stderr: 'boom', durationMs: 2 });
    const { factory } = build({ BUILDER: landing('art_1', 'a.ts', 'x') }, { sandbox });
    const outcome = await factory.build(scope, intent());
    expect(outcome.stages.find((s) => s.stage === 'TEST')?.detail).toContain('exited 3');
  });

  it('honours the requested timeout', async () => {
    const sandbox = new StubSandbox();
    const { factory } = build({ BUILDER: landing('art_1', 'a.ts', 'x') }, { sandbox });
    await factory.build(scope, intent({ testTimeoutMs: 1234 }));
    expect(sandbox.ran[0]?.timeoutMs).toBe(1234);
  });

  it('defaults the timeout when none is given', async () => {
    const sandbox = new StubSandbox();
    const { factory } = build({ BUILDER: landing('art_1', 'a.ts', 'x') }, { sandbox });
    await factory.build(scope, intent());
    expect(sandbox.ran[0]?.timeoutMs).toBe(60_000);
  });
});

// ------------------------------------------------------------ what is passed

describe('what each role is handed', () => {
  it('gives the builder the specification and the files it may change', async () => {
    const { runtime, factory } = build({ BUILDER: landing('art_1', 'a.ts', 'x') });
    await factory.build(scope, intent());
    const asked = runtime.seen.find((s) => s.role === 'BUILDER');
    expect(asked?.input).toMatchObject({ specification: 'do the thing', existing: [] });
  });

  it('gives QA the command, the kind and what the sandbox observed', async () => {
    const { runtime, factory } = build({ BUILDER: landing('art_1', 'a.ts', 'x') });
    await factory.build(scope, intent({ testKind: 'INTEGRATION' }));
    const asked = runtime.seen.find((s) => s.role === 'QA');
    expect(asked?.input).toMatchObject({
      command: ['node', 'test.js'],
      kind: 'INTEGRATION',
      execution: { exitCode: 0, raw: 'ok' },
    });
  });

  it('gives security the configured thresholds', async () => {
    const { runtime, factory } = build({ BUILDER: landing('art_1', 'a.ts', 'x') });
    await factory.build(scope, intent());
    expect(runtime.seen.find((s) => s.role === 'SECURITY')?.input).toMatchObject({ blockAt: 'HIGH', severityFloor: 'INFO' });
  });

  it('gives repair the failure, the attempt and the bound', async () => {
    const { runtime, factory } = build({ BUILDER: () => failed('nope') }, { maxRepairAttempts: 2 });
    await factory.build(scope, intent());
    expect(runtime.seen.find((s) => s.role === 'REPAIR')?.input).toMatchObject({
      attempt: 1,
      maxAttempts: 2,
      failure: { source: 'BUILD', stage: 'BUILD' },
    });
  });

  it('defaults the test kind to UNIT', async () => {
    const { runtime, factory } = build({ BUILDER: landing('art_1', 'a.ts', 'x') });
    await factory.build(scope, intent());
    expect(runtime.seen.find((s) => s.role === 'QA')?.input).toMatchObject({ kind: 'UNIT' });
  });
});

// ------------------------------------------------------------- bounds, misc

describe('bounds', () => {
  it('stops at the configured stage ceiling and says so', async () => {
    const { factory } = build({ BUILDER: landing('art_1', 'a.ts', 'x') }, { maxStages: 2 });
    const outcome = await factory.build(scope, intent());
    expect(outcome.outcome).toBe('FAILED');
    expect(outcome.summary).toContain('2 stages without terminating');
    expect(outcome.stages).toHaveLength(2);
  });

  it('reports the artifacts it had even when it stopped short', async () => {
    const { factory } = build({ BUILDER: landing('art_1', 'a.ts', 'x') }, { maxStages: 3 });
    const outcome = await factory.build(scope, intent());
    expect(outcome.artifacts).toHaveLength(1);
    expect(outcome.highestState).toBe('GENERATED');
  });

  it('finishes the run on the ledger whatever the outcome', async () => {
    const { factory } = build({ PLANNER: () => failed('nope') });
    await factory.build(scope, intent());
    const finished = (await ledger.read(scope)).filter((e) => e.type === FACTORY_EVENTS.FACTORY_RUN_FINISHED);
    expect(finished).toHaveLength(1);
    expect(finished[0]?.payload).toMatchObject({ outcome: 'BLOCKED', highestState: 'GENERATED' });
  });
});

describe('reading a build back', () => {
  it('returns nothing when the run produced nothing', async () => {
    const { factory } = build({ BUILDER: () => ok({ produced: null }) });
    const outcome = await factory.build(scope, intent());
    expect(stagesOf(outcome)).toContain('BUILD:FAILED');
  });

  it('returns nothing when the produced ids name no recorded artifact', async () => {
    const { factory } = build({
      BUILDER: () => ok({ produced: { artifacts: [{ artifactId: 'art_ghost' }], limitations: [] } }),
    });
    const outcome = await factory.build(scope, intent());
    expect(stagesOf(outcome)).toContain('BUILD:FAILED');
    expect(outcome.stages.find((s) => s.stage === 'BUILD')?.detail).toContain('no artifacts');
  });

  it('ignores a recorded artifact whose payload it cannot read', async () => {
    // An ARTIFACT_PROPOSED an older version of the core might have written:
    // the id matches, the bytes do not read. It is skipped rather than staged.
    const { factory } = build({
      BUILDER: async () => {
        await ledger.append(scope, {
          type: 'ARTIFACT_PROPOSED',
          actor: { kind: 'AGENT', id: 'agt_1', agentRole: 'BUILDER' },
          authority: 'AI_ASSUMPTION',
          payload: { artifactId: 'art_odd', path: 42, contents: null },
        });
        return ok({ produced: { artifacts: [{ artifactId: 'art_odd' }], limitations: [] } });
      },
    });
    const outcome = await factory.build(scope, intent());
    expect(stagesOf(outcome)).toContain('BUILD:FAILED');
    expect(outcome.stages.find((s) => s.stage === 'BUILD')?.detail).toContain('no artifacts');
  });

  it('ignores a produced entry that names no id', async () => {
    const { factory } = build({ BUILDER: () => ok({ produced: { artifacts: [{ path: 'a.ts' }], limitations: [] } }) });
    const outcome = await factory.build(scope, intent());
    expect(stagesOf(outcome)).toContain('BUILD:FAILED');
  });
});

describe('evidence without a test kind', () => {
  /** QA that submits evidence the fold will carry with no kind attached. */
  const submitting = (testKind: string | null) => async (): Promise<TaskOutcome> => {
    const body: Record<string, unknown> = {
      taskId: 'task_1',
      environment: 'SANDBOX',
      exitCode: 0,
      raw: 'ok',
      claimedArtifacts: ['art_1'],
    };
    if (testKind !== null) body['testKind'] = testKind;
    await ledger.append(scope, {
      type: 'AGENT_MESSAGE_RECEIVED',
      actor: { kind: 'SYSTEM', id: 'agent-runtime' },
      authority: 'VERIFIED_SYSTEM_STATE',
      payload: {
        taskId: 'task_1',
        messageId: 'msg_1',
        messageKind: 'EVIDENCE_SUBMISSION',
        envelope: { kind: 'EVIDENCE_SUBMISSION', body },
      },
    });
    return ok();
  };

  it('reaches the engine with no kind, which is a static check and no more', async () => {
    const seen: unknown[] = [];
    const { factory } = build(
      { BUILDER: landing('art_1', 'a.ts', 'x'), QA: submitting(null) },
      {
        verifier: {
          evaluate: ((_id: string, evidence: readonly { testKind?: string }[]) => {
            seen.push(evidence.map((e) => e.testKind));
            return 'STATIC_CHECKED' as VerificationState;
          }) as never,
        },
      },
    );
    await factory.build(scope, intent());
    expect(seen[0]).toEqual([undefined]);
  });

  it('reaches the engine with the kind when one was submitted', async () => {
    const seen: unknown[] = [];
    const { factory } = build(
      { BUILDER: landing('art_1', 'a.ts', 'x'), QA: submitting('UNIT') },
      {
        verifier: {
          evaluate: ((_id: string, evidence: readonly { testKind?: string }[]) => {
            seen.push(evidence.map((e) => e.testKind));
            return 'UNIT_TESTED' as VerificationState;
          }) as never,
        },
      },
    );
    await factory.build(scope, intent());
    expect(seen[0]).toEqual(['UNIT']);
  });
});

describe('a sandbox that fails in an unexpected way', () => {
  class ThrowingSandbox implements SandboxProvider {
    constructor(private readonly thrown: unknown) {}
    run(): Promise<SandboxResult> {
      return Promise.reject(this.thrown);
    }
  }

  it('reports a plain Error as UNKNOWN, with its message', async () => {
    const { factory } = build(
      { BUILDER: landing('art_1', 'a.ts', 'x') },
      { sandbox: new ThrowingSandbox(new Error('the runner died')) },
    );
    const outcome = await factory.build(scope, intent());
    const test = outcome.stages.find((s) => s.stage === 'TEST');
    expect(test?.result).toBe('FAILED');
    expect(test?.detail).toContain('UNKNOWN');
  });

  it('reports something that is not an Error at all', async () => {
    const { factory } = build(
      { BUILDER: landing('art_1', 'a.ts', 'x') },
      { sandbox: new ThrowingSandbox('just a string') },
    );
    const outcome = await factory.build(scope, intent());
    expect(outcome.stages.find((s) => s.stage === 'TEST')?.detail).toContain('UNKNOWN');
  });
});

describe('a blocking finding that cites nothing', () => {
  const finding = (contextRefs: string[]) =>
    ok({
      messages: [
        {
          id: 'msg_00000000000000000000000001',
          schemaVersion: '1',
          kind: 'FINDING',
          from: { kind: 'AGENT', id: 'agt_1', role: 'SECURITY' },
          to: { kind: 'SYSTEM', id: 'agent-runtime' },
          cycleId: null,
          correlationId: null,
          causationId: null,
          issuedAt: '2026-09-20T00:00:00.000Z',
          expiresAt: null,
          body: {
            taskId: TaskId.parse(`task_${'0'.repeat(25)}1`),
            subject: 'dynamic-eval in a.ts:1',
            detail: 'eval',
            risk: 'CRITICAL',
            contextRefs,
          },
        },
      ] as never,
    });

  it('falls back to the artifact under review', async () => {
    const { factory } = build({ BUILDER: landing('art_1', 'a.ts', 'x'), SECURITY: () => finding([]) });
    const outcome = await factory.build(scope, intent());
    expect(outcome.blocked[0]?.artifactId).toBe('art_1');
  });

  it('uses the finding\u2019s own reference when it has one', async () => {
    const { factory } = build({ BUILDER: landing('art_1', 'a.ts', 'x'), SECURITY: () => finding(['art_cited']) });
    const outcome = await factory.build(scope, intent());
    expect(outcome.blocked[0]?.artifactId).toBe('art_cited');
  });

  it('ignores a finding below the blocking severity', async () => {
    const { factory } = build({
      BUILDER: landing('art_1', 'a.ts', 'x'),
      SECURITY: () => {
        const low = finding([]);
        (low.messages[0] as { body: { risk: string } }).body.risk = 'LOW';
        return low;
      },
    });
    const outcome = await factory.build(scope, intent());
    expect(outcome.blocked).toEqual([]);
    expect(stagesOf(outcome)).toContain('SECURITY_REVIEW:PASSED');
  });
});

describe('the defaults', () => {
  it('mints ids, reads the clock and names itself when told none of them', async () => {
    const factory = new SoftwareFactory({
      ledger,
      runtime: new StubRuntime({}) as unknown as AgentRuntime,
      graph,
      verifier: ALWAYS_GENERATED,
      sandbox: new StubSandbox(),
    });
    const outcome = await factory.build(scope, intent());
    expect(FactoryRunId.safeParse(outcome.runId).success).toBe(true);
    const started = (await ledger.read(scope)).find((e) => e.type === FACTORY_EVENTS.FACTORY_RUN_STARTED);
    expect(started?.actor).toEqual({ kind: 'SYSTEM', id: 'software-factory' });
    expect(Date.parse(started?.timestamp ?? '')).not.toBeNaN();
  });
});

describe('the small pure parts', () => {
  it('mints a real run id by default', () => {
    expect(FactoryRunId.safeParse(defaultFactoryIds.run()).success).toBe(true);
  });

  it('classifies each stage’s failure by source', () => {
    expect(failureFrom('BUILD', 'x').source).toBe('BUILD');
    expect(failureFrom('REPAIR', 'x').source).toBe('BUILD');
    expect(failureFrom('TEST', 'x').source).toBe('TEST');
    expect(failureFrom('SECURITY_REVIEW', 'x').source).toBe('SECURITY');
    expect(failureFrom('VERIFY', 'x').source).toBe('VERIFICATION');
    expect(failureFrom('PLAN', 'x').source).toBe('VERIFICATION');
  });

  it('gives a failure a signature that groups its occurrences', () => {
    expect(failureFrom('TEST', 'a').signature).toBe(failureFrom('TEST', 'b').signature);
    expect(failureFrom('TEST', 'a').signature).not.toBe(failureFrom('BUILD', 'a').signature);
  });

  it('reads the approach off a diagnosis, and says so when there is none', () => {
    expect(approachFrom(ok())).toBe('no approach recorded');
    const withFinding = ok({
      messages: [
        {
          id: 'msg_00000000000000000000000001',
          schemaVersion: '1',
          kind: 'FINDING',
          from: { kind: 'AGENT', id: 'agt_1', role: 'REPAIR' },
          to: { kind: 'SYSTEM', id: 'agent-runtime' },
          cycleId: null,
          correlationId: null,
          causationId: null,
          issuedAt: '2026-09-20T00:00:00.000Z',
          expiresAt: null,
          body: { taskId: TaskId.parse(`task_${'0'.repeat(25)}1`), subject: 'diagnosis of x', detail: 'use +', risk: 'MEDIUM', contextRefs: [] },
        },
      ] as never,
    });
    expect(approachFrom(withFinding)).toBe('use +');
  });
});
