/**
 * The roles, and the reading of a run they share.
 *
 * Every role is driven through the same table of run outcomes, so the shared
 * behaviour is proven once for all of them rather than asserted for whichever
 * one happened to get a test. What differs per role is tested separately.
 */

import { newAgentId, newMessageId, newTaskId } from '@genesis/core-types';
import { AgentManifest, type Envelope, type RunSummary, type TaskAssignmentBody } from '@genesis/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import { BaseAgent, type Emit, readRun, summarise } from '../src/base.js';
import { AgentError, type Agent, type AgentServices } from '../src/contract.js';
import {
  ArchitectAgent,
  assessEvidence,
  PlannerAgent,
  ResearcherAgent,
  ROLE_TASK_KINDS,
  VerifierAgent,
} from '../src/roles.js';

const taskId = newTaskId();

const manifest = (role: string, over: Record<string, unknown> = {}): AgentManifest =>
  AgentManifest.parse({
    id: newAgentId(),
    role,
    version: '1.0.0',
    capabilities: ['work'],
    maxContextTokens: 4000,
    timeoutMs: 5000,
    proposalKinds: ['RECORD_BELIEF'],
    reasoningProvider: role === 'VERIFIER' ? null : 'mock',
    ...over,
  });

const assignment: TaskAssignmentBody = {
  taskId,
  attempt: 1,
  role: 'PLANNER',
  kind: 'PLANNER_TASK',
  instruction: 'decompose the active goal into an ordered plan',
  contributesTo: ['goal-1', 'goal-2'],
  context: [],
  budget: { maxOutputTokens: 512, timeoutMs: 1000 },
  deadline: '2026-09-19T10:05:00.000Z',
};

const run = (over: Partial<RunSummary> = {}): RunSummary => ({
  outcome: 'COMPLETED',
  cycleId: 'cyc_1',
  callId: 'rsn_1',
  failure: null,
  proposals: [{ kind: 'RECORD_BELIEF', accepted: true, reason: null, detail: null }],
  context: { status: 'ASSEMBLED', usedTokens: 100, budgetTokens: 4000, shown: [{ id: 'mem_1', kind: 'BELIEF', mandatory: null }] },
  ...over,
});

let services: AgentServices;
let controller: AbortController;

beforeEach(() => {
  controller = new AbortController();
  services = {
    run: run(),
    now: () => '2026-09-19T10:00:00.000Z',
    newMessageId: () => newMessageId(),
    signal: controller.signal,
  };
});

const ROLES: readonly [string, (m: AgentManifest) => Agent][] = [
  ['PLANNER', (m) => new PlannerAgent(m)],
  ['ARCHITECT', (m) => new ArchitectAgent(m)],
  ['RESEARCHER', (m) => new ResearcherAgent(m)],
];

describe('framing', () => {
  for (const [role, build] of ROLES) {
    test(`${role} frames the instruction it was given, and asks for no more than it declared`, () => {
      const agent = build(manifest(role));
      const framing = agent.frame(assignment);
      expect(framing).not.toBeNull();
      expect(framing?.text).toBe(assignment.instruction);
      expect(framing?.budgetTokens).toBe(4000);
      expect(framing?.activeGoalId).toBe('goal-1');
    });

    test(`${role} frames the same way twice: framing is pure`, () => {
      const agent = build(manifest(role));
      expect(agent.frame(assignment)).toEqual(agent.frame(assignment));
    });

    test(`${role} names no prompt, model or sampling parameter`, () => {
      const framing = build(manifest(role)).frame(assignment) ?? {};
      const keys = Object.keys(framing);
      for (const banned of ['prompt', 'system', 'model', 'modelId', 'temperature', 'provider']) {
        expect(keys, `${role} frames ${banned}`).not.toContain(banned);
      }
    });
  }

  test('a task with no goals frames no active goal rather than inventing one', () => {
    const framing = new PlannerAgent(manifest('PLANNER')).frame({ ...assignment, contributesTo: [] as never });
    expect(framing.activeGoalId).toBeNull();
  });

  test('each role frames its own task kind', () => {
    expect(new PlannerAgent(manifest('PLANNER')).frame(assignment).kind).toBe(ROLE_TASK_KINDS.PLANNER);
    expect(new ArchitectAgent(manifest('ARCHITECT')).frame(assignment).kind).toBe(ROLE_TASK_KINDS.ARCHITECT);
    expect(new ResearcherAgent(manifest('RESEARCHER')).frame(assignment).kind).toBe(ROLE_TASK_KINDS.RESEARCHER);
  });

  test('the Verifier frames nothing, because it needs no model', () => {
    expect(new VerifierAgent(manifest('VERIFIER')).frame()).toBeNull();
  });
});

describe('the shared reading of a run', () => {
  for (const [role, build] of ROLES) {
    test(`${role} completes and reports what was accepted`, async () => {
      const outcome = await build(manifest(role)).handle(assignment, services);
      expect(outcome.reached).toBe('COMPLETED');
      const result = outcome.messages.find((m) => m.kind === 'RESULT');
      expect(result?.body).toMatchObject({ taskId, proposalsSubmitted: 1 });
    });

    test(`${role} is blocked, not completed, when the run failed`, async () => {
      const failed = run({ outcome: 'FAILED', failure: { kind: 'TIMEOUT', message: 'no response' }, proposals: [] });
      const outcome = await build(manifest(role)).handle(assignment, { ...services, run: failed });
      expect(outcome.reached).toBe('BLOCKED');
      expect(outcome.messages.some((m) => m.kind === 'FINDING')).toBe(true);
    });

    test(`${role} is blocked when the context would not fit`, async () => {
      const split = run({ outcome: 'SPLIT_REQUIRED', proposals: [] });
      const outcome = await build(manifest(role)).handle(assignment, { ...services, run: split });
      expect(outcome.reached).toBe('BLOCKED');
    });

    test(`${role} reports a refused proposal as a finding, not as a retry`, async () => {
      const refused = run({
        proposals: [{ kind: 'RECORD_BELIEF', accepted: false, reason: 'GOAL_DRIFT', detail: 'goal-9 is unknown' }],
      });
      const outcome = await build(manifest(role)).handle(assignment, { ...services, run: refused });
      const finding = outcome.messages.find((m) => m.kind === 'FINDING');
      expect(finding?.body).toMatchObject({ risk: 'HIGH' });
      expect(outcome.reached).toBe('COMPLETED');
    });

    test(`${role} claims nothing when the core accepted nothing`, async () => {
      const nothing = run({ proposals: [] });
      const outcome = await build(manifest(role)).handle(assignment, { ...services, run: nothing });
      const result = outcome.messages.find((m) => m.kind === 'RESULT');
      expect(result?.body).toMatchObject({ proposalsSubmitted: 0 });
      expect((result?.body as { summary: string }).summary).toContain('nothing worth proposing');
    });

    test(`${role} stamps every message with itself as the sender`, async () => {
      const m = manifest(role);
      const outcome = await build(m).handle(assignment, services);
      for (const message of outcome.messages) {
        expect(message.from).toEqual({ kind: 'AGENT', id: m.id, role });
        expect(message.to).toEqual({ kind: 'SYSTEM', id: 'agent-runtime' });
        expect(message.body.taskId).toBe(taskId);
      }
    });

    test(`${role} stops when cancelled, rather than returning a result nobody wants`, async () => {
      controller.abort();
      await expect(build(manifest(role)).handle(assignment, services)).rejects.toThrow(AgentError);
      await expect(build(manifest(role)).handle(assignment, services)).rejects.toThrow(/cancelled/);
    });
  }

  test('an agent with no run at all completes, saying it made no call', async () => {
    const outcome = await new VerifierAgent(manifest('VERIFIER'), {
      exitCode: 0,
      raw: 'covered file_1',
      testKind: 'UNIT',
      claimedArtifacts: ['file_1'],
      environment: 'SANDBOX',
    }).handle(assignment, { ...services, run: null });
    expect(outcome.reached).toBe('COMPLETED');
    const result = outcome.messages.find((m) => m.kind === 'RESULT');
    expect((result?.body as { summary: string }).summary).toContain('without a reasoning call');
  });
});

describe('the Researcher', () => {
  test('says so when it had nothing to search', async () => {
    const empty = run({ context: { status: 'ASSEMBLED', usedTokens: 0, budgetTokens: 4000, shown: [] } });
    const outcome = await new ResearcherAgent(manifest('RESEARCHER')).handle(assignment, { ...services, run: empty });
    const finding = outcome.messages.find((m) => m.kind === 'FINDING');
    expect((finding?.body as { detail: string }).detail).toContain('absence of evidence');
  });

  test('says so when there was no run at all', async () => {
    const outcome = await new ResearcherAgent(manifest('RESEARCHER')).handle(assignment, { ...services, run: null });
    const finding = outcome.messages.find((m) => m.kind === 'FINDING');
    expect((finding?.body as { subject: string }).subject).toBe('the search had nothing to search');
  });

  test('adds no such finding when it was shown something', async () => {
    const outcome = await new ResearcherAgent(manifest('RESEARCHER')).handle(assignment, services);
    const subjects = outcome.messages.filter((m) => m.kind === 'FINDING').map((m) => (m.body as { subject: string }).subject);
    expect(subjects).not.toContain('the search had nothing to search');
  });
});

describe('the Verifier', () => {
  const base = {
    exitCode: 0,
    raw: 'coverage report: file_1 100%',
    testKind: 'UNIT' as string | undefined,
    claimedArtifacts: ['file_1'],
    environment: 'SANDBOX',
  };

  /** Narrows to the inadequate arm, which is the only one carrying a concern. */
  const concernOf = (evidence: Parameters<typeof assessEvidence>[0]): string | null => {
    const [only] = assessEvidence(evidence);
    return only !== undefined && !only.adequate ? only.concern : null;
  };

  test('accepts evidence that attributes itself to the artifact', () => {
    expect(assessEvidence(base)).toEqual([{ artifactId: 'file_1', adequate: true, note: null }]);
  });

  test('refuses a failing run: nothing passed', () => {
    expect(concernOf({ ...base, exitCode: 1 })).toContain('exited 1');
  });

  test('refuses silent output: nothing attributes it', () => {
    expect(concernOf({ ...base, raw: '   \n ' })).toContain('no output');
  });

  test('refuses an unattributed claim, which is the self-certification case', () => {
    expect(concernOf({ ...base, raw: 'all tests passed' })).toContain('never mentions file_1');
  });

  test('accepts a static check, and says that is all it is', () => {
    const [only] = assessEvidence({ ...base, testKind: undefined });
    expect(only?.adequate).toBe(true);
    expect(only?.adequate === true ? only.note : null).toContain('holds together and no more');
  });

  test('refuses a local end-to-end result, which describes no deployed system', () => {
    expect(concernOf({ ...base, testKind: 'E2E', environment: 'LOCAL' })).toContain('local environment');
  });

  test('judges each claimed artifact separately', () => {
    const assessed = assessEvidence({ ...base, claimedArtifacts: ['file_1', 'file_2'] });
    expect(assessed.map((a) => a.adequate)).toEqual([true, false]);
  });

  test('raises a finding for each inadequate claim, and never a verification state', async () => {
    const agent = new VerifierAgent(manifest('VERIFIER'), { ...base, raw: 'all tests passed' });
    const outcome = await agent.handle(assignment, { ...services, run: null });
    const findings = outcome.messages.filter((m) => m.kind === 'FINDING');
    expect(findings).toHaveLength(1);
    for (const message of outcome.messages) {
      expect(JSON.stringify(message)).not.toContain('UNIT_TESTED');
      expect(JSON.stringify(message)).not.toContain('verificationState');
    }
  });

  test('raises nothing but a result when the evidence is adequate', async () => {
    const agent = new VerifierAgent(manifest('VERIFIER'), base);
    const outcome = await agent.handle(assignment, { ...services, run: null });
    expect(outcome.messages.map((m) => m.kind)).toEqual(['RESULT']);
  });

  test('says so when it was handed nothing to verify', async () => {
    const outcome = await new VerifierAgent(manifest('VERIFIER')).handle(assignment, { ...services, run: null });
    const finding = outcome.messages.find((m) => m.kind === 'FINDING');
    expect((finding?.body as { subject: string }).subject).toBe('nothing to verify');
  });
});

describe('what a role reaches by what it emits', () => {
  /**
   * The base supports the whole agent-to-core half of the protocol, not only
   * the two kinds the P6 roles happen to use. This role exercises the rest, so
   * a Builder or QA added later inherits behaviour that is already proven.
   */
  class Chatty extends BaseAgent {
    constructor(
      m: AgentManifest,
      private readonly kinds: readonly ('QUESTION' | 'EVIDENCE_SUBMISSION' | 'STATUS')[],
    ) {
      super(m);
    }
    frame(): null {
      return null;
    }
    protected override extraMessages(a: TaskAssignmentBody, _s: AgentServices, emit: Emit): readonly Envelope[] {
      return this.kinds.map((kind) => {
        if (kind === 'QUESTION') {
          return emit('QUESTION', {
            taskId: a.taskId,
            text: 'which region is production in?',
            reason: 'no context item says',
            audience: 'HUMAN',
            whatBreaksIfWrong: 'the deployment targets the wrong account',
            risk: 'CRITICAL',
            resolution: 'ASK_HUMAN',
          });
        }
        if (kind === 'EVIDENCE_SUBMISSION') {
          return emit('EVIDENCE_SUBMISSION', {
            taskId: a.taskId,
            experimentId: null,
            environment: 'SANDBOX',
            exitCode: 0,
            raw: 'file_1 covered',
            testKind: 'UNIT',
            claimedArtifacts: ['file_1'],
          });
        }
        return emit('STATUS', { taskId: a.taskId, note: 'halfway' });
      });
    }
  }

  const services = (): AgentServices => ({
    run: null,
    now: () => '2026-09-19T10:00:00.000Z',
    newMessageId: () => newMessageId(),
    signal: new AbortController().signal,
  });

  test('an agent that raised a question is blocked, not complete', async () => {
    const outcome = await new Chatty(manifest('RESEARCHER'), ['QUESTION']).handle(assignment, services());
    expect(outcome.reached).toBe('BLOCKED');
    const result = outcome.messages.find((m) => m.kind === 'RESULT');
    expect(result?.body).toMatchObject({ questionsRaised: 1 });
  });

  test('an agent that submitted evidence awaits verification, and does not verify', async () => {
    const outcome = await new Chatty(manifest('QA'), ['EVIDENCE_SUBMISSION']).handle(assignment, services());
    expect(outcome.reached).toBe('AWAITING_VERIFICATION');
  });

  test('a question outranks evidence: an unanswered question blocks either way', async () => {
    const outcome = await new Chatty(manifest('QA'), ['EVIDENCE_SUBMISSION', 'QUESTION']).handle(assignment, services());
    expect(outcome.reached).toBe('BLOCKED');
  });

  test('a heartbeat finishes nothing', async () => {
    const outcome = await new Chatty(manifest('QA'), ['STATUS']).handle(assignment, services());
    expect(outcome.reached).toBe('COMPLETED');
    expect(outcome.messages.map((m) => m.kind)).toEqual(['STATUS', 'RESULT']);
  });

  test('a run that already blocked stays blocked whatever the role emits', async () => {
    const failed = run({ outcome: 'FAILED', failure: { kind: 'TIMEOUT', message: 'x' }, proposals: [] });
    const outcome = await new Chatty(manifest('QA'), ['EVIDENCE_SUBMISSION']).handle(assignment, {
      ...services(),
      run: failed,
    });
    expect(outcome.reached).toBe('BLOCKED');
  });
});

describe('readRun and summarise directly', () => {
  test('a split run explains the budget it needed', () => {
    const [only] = readRun(run({ outcome: 'SPLIT_REQUIRED', proposals: [] }), 'PLANNER', taskId);
    expect(only?.detail).toContain('4000');
    expect(only?.detail).toContain('PLANNER');
  });

  test('a refused proposal with no reason still reads as a sentence', () => {
    const [only] = readRun(
      run({ proposals: [{ kind: null, accepted: false, reason: null, detail: null }] }),
      'QA',
      taskId,
    );
    expect(only?.subject).toContain('malformed');
    expect(only?.subject).toContain('no reason given');
    expect(only?.detail).toContain('refused this proposal');
    expect(only?.risk).toBe('LOW');
  });

  test('a run with a failure and a split reports both', () => {
    const findings = readRun(
      run({ outcome: 'SPLIT_REQUIRED', failure: { kind: 'TIMEOUT', message: 'slow' }, proposals: [] }),
      'PLANNER',
      taskId,
    );
    expect(findings).toHaveLength(2);
  });

  test('summarise never reports success for nothing', () => {
    expect(summarise('PLANNER', null, 0)).toContain('without a reasoning call');
    expect(summarise('PLANNER', run({ outcome: 'SPLIT_REQUIRED' }), 0)).toContain('does not fit');
    expect(summarise('PLANNER', run({ outcome: 'FAILED', failure: null }), 0)).toContain('the run failed');
    expect(summarise('PLANNER', run({ outcome: 'FAILED', failure: { kind: 'TIMEOUT', message: 'x' } }), 0)).toContain('TIMEOUT');
    expect(summarise('PLANNER', run({ proposals: [] }), 0)).toContain('nothing worth proposing');
    expect(
      summarise('PLANNER', run({ proposals: [{ kind: 'RECORD_BELIEF', accepted: false, reason: 'MALFORMED', detail: null }] }), 0),
    ).toContain('accepted none');
    expect(summarise('PLANNER', run(), 1)).toContain('1 of 1');
  });
});
