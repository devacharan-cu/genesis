/**
 * The four factory roles, each against what it must and must not claim.
 *
 * The recurring assertion is a negative one: no role has a way to say that
 * something works. A Builder reports artifacts, QA reports an execution,
 * Security reports matches, Repair reports a reading. None of them has a field
 * that means "verified", and these tests check that by looking.
 */

import { newAgentId, newMessageId, newTaskId } from '@genesis/core-types';
import { AgentManifest, defaultRoleConfig, type Envelope, type RunSummary, type TaskAssignmentBody } from '@genesis/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import { AgentError, type AgentServices } from '../src/contract.js';
import { BuilderAgent, FACTORY_TASK_KINDS, QaAgent, RepairAgent, riskOf, SecurityAgent, ALL_SEVERITIES } from '../src/factory-roles.js';

const taskId = newTaskId();
const CONFIG = defaultRoleConfig();

const manifest = (role: string): AgentManifest =>
  AgentManifest.parse({
    id: newAgentId(),
    role,
    version: '1.0.0',
    capabilities: ['factory'],
    maxContextTokens: 4000,
    timeoutMs: 5000,
    proposalKinds: [],
    reasoningProvider: role === 'QA' || role === 'SECURITY' ? null : 'mock',
  });

const assignment = (role: string, input: unknown): TaskAssignmentBody => ({
  taskId,
  attempt: 1,
  role: role as TaskAssignmentBody['role'],
  kind: `${role}_TASK`,
  instruction: 'do the work',
  contributesTo: ['goal-1'],
  context: [],
  budget: { maxOutputTokens: 512, timeoutMs: 1000 },
  deadline: '2026-09-20T10:05:00.000Z',
  input: input as TaskAssignmentBody['input'],
});

const run = (produced: unknown): RunSummary => ({
  outcome: 'COMPLETED',
  cycleId: 'cyc_1',
  callId: 'rsn_1',
  failure: null,
  produced: produced as RunSummary['produced'],
  proposals: [],
  context: { status: 'ASSEMBLED', usedTokens: 10, budgetTokens: 4000, shown: [] },
});

let services: AgentServices;

beforeEach(() => {
  services = {
    run: null,
    now: () => '2026-09-20T10:00:00.000Z',
    newMessageId: () => newMessageId(),
    signal: new AbortController().signal,
  };
});

const bodies = (messages: readonly Envelope[], kind: string): Record<string, unknown>[] =>
  messages.filter((m) => m.kind === kind).map((m) => m.body as unknown as Record<string, unknown>);

const ARTIFACT = { artifactId: 'art_1', path: 'src/add.ts', contents: 'export const add = (a, b) => a + b;' };

// --------------------------------------------------------------- the builder

describe('the builder', () => {
  const input = { specification: 'Export an add function.' };

  test('frames a PRODUCE_ARTIFACT run, and supplies no wording of its own', () => {
    const framing = new BuilderAgent(manifest('BUILDER'), CONFIG).frame(assignment('BUILDER', input));
    expect(framing.purpose).toBe('PRODUCE_ARTIFACT');
    expect(framing.kind).toBe(FACTORY_TASK_KINDS.BUILDER);
    expect(framing.text).toBe('Export an add function.');
    for (const banned of ['prompt', 'system', 'model', 'temperature']) {
      expect(Object.keys(framing)).not.toContain(banned);
    }
  });

  test('includes the files it may modify, so a repair sees what it is changing', () => {
    const framing = new BuilderAgent(manifest('BUILDER'), CONFIG).frame(
      assignment('BUILDER', { specification: 'Fix it.', existing: [ARTIFACT] }),
    );
    expect(framing.text).toContain('src/add.ts');
    expect(framing.text).toContain('export const add');
  });

  test('frames no active goal when the task names none, rather than inventing one', () => {
    const framing = new BuilderAgent(manifest('BUILDER'), CONFIG).frame({
      ...assignment('BUILDER', input),
      contributesTo: [] as never,
    });
    expect(framing.activeGoalId).toBeNull();
  });

  test('frames the same way twice: framing is pure', () => {
    const agent = new BuilderAgent(manifest('BUILDER'), CONFIG);
    expect(agent.frame(assignment('BUILDER', input))).toEqual(agent.frame(assignment('BUILDER', input)));
  });

  test('fails the task when handed an input it cannot read', () => {
    expect(() => new BuilderAgent(manifest('BUILDER'), CONFIG).frame(assignment('BUILDER', { nope: 1 }))).toThrow(AgentError);
    expect(() => new BuilderAgent(manifest('BUILDER'), CONFIG).frame(assignment('BUILDER', null))).toThrow(
      /cannot read/,
    );
  });

  test('reports the limitations the build stated', async () => {
    const outcome = await new BuilderAgent(manifest('BUILDER'), CONFIG).handle(assignment('BUILDER', input), {
      ...services,
      run: run({ artifacts: [{ path: 'src/add.ts' }], limitations: ['could not infer the return type'] }),
    });
    const findings = bodies(outcome.messages, 'FINDING');
    expect(findings.some((f) => String(f['detail']).includes('return type'))).toBe(true);
  });

  test('says so when the build produced nothing, rather than reporting success', async () => {
    const outcome = await new BuilderAgent(manifest('BUILDER'), CONFIG).handle(assignment('BUILDER', input), {
      ...services,
      run: run({ artifacts: [], limitations: [] }),
    });
    const findings = bodies(outcome.messages, 'FINDING');
    expect(findings.some((f) => f['subject'] === 'the build produced no artifacts')).toBe(true);
    expect(findings.some((f) => f['risk'] === 'HIGH')).toBe(true);
  });

  test('has no way to say that what it built works', async () => {
    const outcome = await new BuilderAgent(manifest('BUILDER'), CONFIG).handle(assignment('BUILDER', input), {
      ...services,
      run: run({ artifacts: [{ path: 'src/add.ts' }], limitations: [] }),
    });
    const text = JSON.stringify(outcome.messages);
    expect(text).not.toContain('UNIT_TESTED');
    expect(text).not.toContain('verificationState');
    expect(outcome.messages.some((m) => m.kind === 'EVIDENCE_SUBMISSION')).toBe(false);
  });
});

// -------------------------------------------------------------------- the qa

describe('QA', () => {
  const input = (over: Record<string, unknown> = {}) => ({
    artifacts: [ARTIFACT],
    command: ['node', 'test.js'],
    kind: 'UNIT',
    execution: { exitCode: 0, raw: 'src/add.ts ok', durationMs: 12 },
    ...over,
  });

  test('frames no run: it needs no model', () => {
    expect(new QaAgent(manifest('QA'), CONFIG).frame()).toBeNull();
  });

  test('submits the runner output as evidence, unaltered', async () => {
    const outcome = await new QaAgent(manifest('QA'), CONFIG).handle(assignment('QA', input()), services);
    const [evidence] = bodies(outcome.messages, 'EVIDENCE_SUBMISSION');
    expect(evidence?.['exitCode']).toBe(0);
    expect(evidence?.['raw']).toBe('src/add.ts ok');
    expect(evidence?.['claimedArtifacts']).toEqual(['art_1']);
    expect(evidence?.['environment']).toBe('SANDBOX');
  });

  test('awaits verification rather than declaring the artifact tested', async () => {
    const outcome = await new QaAgent(manifest('QA'), CONFIG).handle(assignment('QA', input()), services);
    expect(outcome.reached).toBe('AWAITING_VERIFICATION');
    expect(JSON.stringify(outcome.messages)).not.toContain('UNIT_TESTED');
  });

  test('says when a suite passed without touching the subject', async () => {
    const outcome = await new QaAgent(manifest('QA'), CONFIG).handle(
      assignment('QA', input({ execution: { exitCode: 0, raw: 'all tests passed', durationMs: 5 } })),
      services,
    );
    const findings = bodies(outcome.messages, 'FINDING');
    expect(findings.some((f) => String(f['subject']).includes('without touching'))).toBe(true);
    expect(findings.some((f) => f['risk'] === 'HIGH')).toBe(true);
  });

  test('raises no attribution finding when the output names the artifact', async () => {
    const outcome = await new QaAgent(manifest('QA'), CONFIG).handle(assignment('QA', input()), services);
    const findings = bodies(outcome.messages, 'FINDING');
    expect(findings.some((f) => String(f['subject']).includes('without touching'))).toBe(false);
  });

  test('attributes by artifact id as well as by path', async () => {
    const outcome = await new QaAgent(manifest('QA'), CONFIG).handle(
      assignment('QA', input({ execution: { exitCode: 0, raw: 'covered art_1', durationMs: 5 } })),
      services,
    );
    expect(bodies(outcome.messages, 'FINDING').some((f) => String(f['subject']).includes('without touching'))).toBe(false);
  });

  test('reports a non-zero exit as critical, and still submits the evidence', async () => {
    const outcome = await new QaAgent(manifest('QA'), CONFIG).handle(
      assignment('QA', input({ execution: { exitCode: 1, raw: 'assertion failed', durationMs: 5 } })),
      services,
    );
    const findings = bodies(outcome.messages, 'FINDING');
    expect(findings.some((f) => f['risk'] === 'CRITICAL')).toBe(true);
    expect(bodies(outcome.messages, 'EVIDENCE_SUBMISSION')).toHaveLength(1);
  });

  test('handles a failing run that said nothing at all', async () => {
    const outcome = await new QaAgent(manifest('QA'), CONFIG).handle(
      assignment('QA', input({ execution: { exitCode: 1, raw: '   ', durationMs: 5 } })),
      services,
    );
    expect(bodies(outcome.messages, 'FINDING').some((f) => f['detail'] === 'the run produced no output')).toBe(true);
  });

  test('reports nothing observed when there was no run', async () => {
    const outcome = await new QaAgent(manifest('QA'), CONFIG).handle(assignment('QA', input({ execution: null })), services);
    expect(bodies(outcome.messages, 'FINDING')[0]?.['subject']).toBe('no test run to report');
    expect(bodies(outcome.messages, 'EVIDENCE_SUBMISSION')).toHaveLength(0);
  });

  test('submits one piece of evidence per artifact', async () => {
    const outcome = await new QaAgent(manifest('QA'), CONFIG).handle(
      assignment('QA', input({ artifacts: [ARTIFACT, { artifactId: 'art_2', path: 'src/sub.ts', contents: 'x' }] })),
      services,
    );
    expect(bodies(outcome.messages, 'EVIDENCE_SUBMISSION')).toHaveLength(2);
  });

  test('fails the task when handed an input it cannot read', async () => {
    await expect(new QaAgent(manifest('QA'), CONFIG).handle(assignment('QA', { artifacts: [] }), services)).rejects.toThrow(
      AgentError,
    );
  });
});

// -------------------------------------------------------------- the security

describe('security', () => {
  const input = (contents: string, over: Record<string, unknown> = {}) => ({
    artifacts: [{ artifactId: 'art_1', path: 'src/a.ts', contents }],
    blockAt: 'HIGH',
    severityFloor: 'INFO',
    ...over,
  });

  test('frames no run: the checks are deterministic', () => {
    expect(new SecurityAgent(manifest('SECURITY'), CONFIG).frame()).toBeNull();
  });

  test('reports a finding with the rule, the line and the matched text', async () => {
    const outcome = await new SecurityAgent(manifest('SECURITY'), CONFIG).handle(
      assignment('SECURITY', input('const x = eval(y);')),
      services,
    );
    const [finding] = bodies(outcome.messages, 'FINDING');
    expect(finding?.['subject']).toBe('dynamic-eval in src/a.ts:1');
    expect(String(finding?.['detail'])).toContain('matched: eval(');
    expect(finding?.['risk']).toBe('CRITICAL');
  });

  test('says plainly what a clean result does and does not mean', async () => {
    const outcome = await new SecurityAgent(manifest('SECURITY'), CONFIG).handle(
      assignment('SECURITY', input('export const add = (a: number, b: number): number => a + b;')),
      services,
    );
    const [finding] = bodies(outcome.messages, 'FINDING');
    expect(finding?.['subject']).toBe('no security rule matched');
    expect(String(finding?.['detail'])).toContain('not a statement that the change is safe');
    expect(String(finding?.['detail'])).toContain('no dataflow analysis');
  });

  test('honours the severity floor', async () => {
    const withTodo = '// TODO: later';
    const reported = await new SecurityAgent(manifest('SECURITY'), CONFIG).handle(
      assignment('SECURITY', input(withTodo)),
      services,
    );
    expect(bodies(reported.messages, 'FINDING')[0]?.['subject']).toContain('todo-marker');

    const filtered = await new SecurityAgent(manifest('SECURITY'), CONFIG).handle(
      assignment('SECURITY', input(withTodo, { severityFloor: 'HIGH' })),
      services,
    );
    expect(bodies(filtered.messages, 'FINDING')[0]?.['subject']).toBe('no security rule matched');
  });

  test('reviews every artifact it was given', async () => {
    const outcome = await new SecurityAgent(manifest('SECURITY'), CONFIG).handle(
      assignment('SECURITY', {
        artifacts: [
          { artifactId: 'art_1', path: 'a.ts', contents: 'const x = eval(y);' },
          { artifactId: 'art_2', path: 'b.ts', contents: 'const z = eval(w);' },
        ],
        blockAt: 'HIGH',
        severityFloor: 'INFO',
      }),
      services,
    );
    const subjects = bodies(outcome.messages, 'FINDING').map((f) => String(f['subject']));
    expect(subjects.some((s) => s.includes('a.ts'))).toBe(true);
    expect(subjects.some((s) => s.includes('b.ts'))).toBe(true);
  });

  test('never approves: it can only report or find nothing', async () => {
    const outcome = await new SecurityAgent(manifest('SECURITY'), CONFIG).handle(
      assignment('SECURITY', input('export const x = 1;')),
      services,
    );
    const text = JSON.stringify(outcome.messages);
    expect(text).not.toContain('approved');
    expect(text).not.toContain('"safe"');
    expect(outcome.messages.some((m) => m.kind === 'PROPOSAL')).toBe(false);
  });

  test('fails the task when handed an input it cannot read', async () => {
    await expect(
      new SecurityAgent(manifest('SECURITY'), CONFIG).handle(assignment('SECURITY', { artifacts: [] }), services),
    ).rejects.toThrow(AgentError);
  });
});

describe('riskOf', () => {
  test('maps every severity to a risk', () => {
    for (const severity of ALL_SEVERITIES) {
      expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(riskOf(severity));
    }
  });

  test('keeps the ordering that matters, and folds INFO into LOW', () => {
    expect(riskOf('CRITICAL')).toBe('CRITICAL');
    expect(riskOf('HIGH')).toBe('HIGH');
    expect(riskOf('MEDIUM')).toBe('MEDIUM');
    expect(riskOf('LOW')).toBe('LOW');
    expect(riskOf('INFO')).toBe('LOW');
  });
});

// ---------------------------------------------------------------- the repair

describe('repair', () => {
  const failure = {
    source: 'TEST',
    stage: 'TEST',
    signature: 'factory:TEST:TEST',
    summary: 'the test run exited 1',
    artifactIds: ['art_1'],
    raw: 'expected 3, got -1',
  };
  const input = (over: Record<string, unknown> = {}) => ({
    failure,
    attempt: 1,
    maxAttempts: 3,
    history: [],
    artifacts: [ARTIFACT],
    ...over,
  });

  test('frames a DIAGNOSE_FAILURE run over the recorded failure', () => {
    const framing = new RepairAgent(manifest('REPAIR'), CONFIG).frame(assignment('REPAIR', input()));
    expect(framing.purpose).toBe('DIAGNOSE_FAILURE');
    expect(framing.text).toContain('the test run exited 1');
    expect(framing.text).toContain('expected 3, got -1');
  });

  test('shows what has already been tried for this failure', () => {
    const framing = new RepairAgent(manifest('REPAIR'), CONFIG).frame(
      assignment(
        'REPAIR',
        input({ attempt: 2, history: [{ attempt: 1, signature: 'factory:TEST:TEST', approach: 'swap the operator' }] }),
      ),
    );
    expect(framing.text).toContain('Already tried');
    expect(framing.text).toContain('swap the operator');
  });

  test('does not show attempts made against a different failure', () => {
    const framing = new RepairAgent(manifest('REPAIR'), CONFIG).frame(
      assignment('REPAIR', input({ attempt: 2, history: [{ attempt: 1, signature: 'other', approach: 'unrelated' }] })),
    );
    expect(framing.text).not.toContain('unrelated');
  });

  test('refuses an attempt past its bound rather than trying again', () => {
    expect(() =>
      new RepairAgent(manifest('REPAIR'), { ...CONFIG, maxRepairAttempts: 2 }).frame(assignment('REPAIR', input({ attempt: 3 }))),
    ).toThrow(/past the bound of 2/);
  });

  test('reports the diagnosis as a finding, not as a fact', async () => {
    const outcome = await new RepairAgent(manifest('REPAIR'), CONFIG).handle(assignment('REPAIR', input()), {
      ...services,
      run: run({ rootCause: 'the operator is wrong', approach: 'use +', targetArtifacts: ['art_1'] }),
    });
    const [finding] = bodies(outcome.messages, 'FINDING');
    expect(finding?.['subject']).toBe('diagnosis of factory:TEST:TEST');
    expect(String(finding?.['detail'])).toContain('the operator is wrong');
    expect(outcome.messages.some((m) => m.kind === 'PROPOSAL')).toBe(false);
  });

  test('says so when the failure was not diagnosed', async () => {
    const outcome = await new RepairAgent(manifest('REPAIR'), CONFIG).handle(assignment('REPAIR', input()), {
      ...services,
      run: run(null),
    });
    expect(bodies(outcome.messages, 'FINDING')[0]?.['subject']).toBe('the failure was not diagnosed');
  });

  test('flags a diagnosis that repeats an approach which already failed', async () => {
    const outcome = await new RepairAgent(manifest('REPAIR'), CONFIG).handle(
      assignment(
        'REPAIR',
        input({ attempt: 2, history: [{ attempt: 1, signature: 'factory:TEST:TEST', approach: 'use +' }] }),
      ),
      { ...services, run: run({ rootCause: 'still wrong', approach: 'use +', targetArtifacts: ['art_1'] }) },
    );
    const subjects = bodies(outcome.messages, 'FINDING').map((f) => String(f['subject']));
    expect(subjects.some((s) => s.includes('repeats an approach'))).toBe(true);
  });

  test('does not flag a genuinely new approach', async () => {
    const outcome = await new RepairAgent(manifest('REPAIR'), CONFIG).handle(
      assignment(
        'REPAIR',
        input({ attempt: 2, history: [{ attempt: 1, signature: 'factory:TEST:TEST', approach: 'use +' }] }),
      ),
      { ...services, run: run({ rootCause: 'off by one', approach: 'widen the bound', targetArtifacts: ['art_1'] }) },
    );
    const subjects = bodies(outcome.messages, 'FINDING').map((f) => String(f['subject']));
    expect(subjects.some((s) => s.includes('repeats an approach'))).toBe(false);
  });

  test('frames no active goal when the task names none', () => {
    const framing = new RepairAgent(manifest('REPAIR'), CONFIG).frame({
      ...assignment('REPAIR', input()),
      contributesTo: [] as never,
    });
    expect(framing.activeGoalId).toBeNull();
  });

  test('reports a diagnosis that named no approach or targets, without inventing either', async () => {
    const outcome = await new RepairAgent(manifest('REPAIR'), CONFIG).handle(assignment('REPAIR', input()), {
      ...services,
      run: run({ rootCause: 'something went wrong' }),
    });
    const [finding] = bodies(outcome.messages, 'FINDING');
    expect(String(finding?.['detail'])).toContain('approach: none given');
    expect(finding?.['contextRefs']).toEqual([]);
  });

  test('handles a failure with no recorded output', () => {
    const framing = new RepairAgent(manifest('REPAIR'), CONFIG).frame(
      assignment('REPAIR', input({ failure: { ...failure, raw: null } })),
    );
    expect(framing.text).not.toContain('Observed output');
  });

  test('fails the task when handed an input it cannot read', () => {
    expect(() => new RepairAgent(manifest('REPAIR'), CONFIG).frame(assignment('REPAIR', { attempt: 1 }))).toThrow(AgentError);
  });
});
