/**
 * The console view, folded over the events a REAL factory run produces.
 *
 * The rig below is the factory's own test rig, not a set of hand-written
 * events. That distinction is the whole point: a console tested against
 * fixtures agrees with the fixtures, and the failure mode being guarded here is
 * precisely a view that has drifted from what the system actually records.
 *
 * What is under test is attribution and honesty. Every event reaches the lane
 * that produced it, a failure reads as a failure, the factory's own sentences
 * survive to the screen, and nothing is invented or dropped.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRegistry, BuilderAgent, PlannerAgent, QaAgent, RepairAgent, SecurityAgent } from '@genesis/agents';
import { CognitiveEngine } from '@genesis/cognition';
import { AgentRuntime, Orchestrator, PROPOSAL_KINDS } from '@genesis/core';
import { FactoryRunId, type GenesisEvent, newAgentId, newProjectId, projectScope, type ProjectScope } from '@genesis/core-types';
import { LocalSandboxProvider } from '@genesis/adapters-sandbox-local';
import { SoftwareFactory } from '@genesis/factory';
import { InMemoryGraphStore } from '@genesis/graph';
import { InMemoryEventLedger } from '@genesis/ledger';
import { InMemoryMemoryStore } from '@genesis/memory';
import { AgentManifest, defaultRoleConfig } from '@genesis/protocol';
import { MockReasoningProvider } from '@genesis/reasoning';
import { VerificationEngine } from '@genesis/verification';
import { beforeAll, describe, expect, it } from 'vitest';
import { AGENT_LANES, LANE_LABELS, LANES, laneOfRole, STAGE_LABELS, STAGE_LANES } from '../src/lanes.js';
import { describeOne, emptyConsole, foldConsole, foldMore, shortId } from '../src/view.js';

const PASSING = ['node', '-e', 'const a=require("./src/add.js");if(a.add(1,2)!==3)process.exit(1);console.log("src/add.js ok")'];
const GOOD = 'exports.add = (a, b) => a + b;\n';
const BROKEN = 'exports.add = (a, b) => a - b;\n';

const manifest = (role: string): AgentManifest =>
  AgentManifest.parse({
    id: newAgentId(),
    role,
    version: '1.0.0',
    capabilities: ['factory'],
    maxContextTokens: 4000,
    timeoutMs: 20_000,
    proposalKinds: role === 'PLANNER' || role === 'ARCHITECT' ? ['RECORD_BELIEF'] : [],
    reasoningProvider: role === 'QA' || role === 'SECURITY' ? null : 'mock',
  });

const noProposals = { output: { proposals: [] } };
const artifact = (contents: string) => ({ output: { artifacts: [{ path: 'src/add.js', contents }] } });
const diagnosis = {
  output: { rootCause: 'the operator is wrong', targetArtifacts: ['src/add.js'], approach: 'use +', confidence: 0.8 },
};

/** Runs a real factory build and returns every event it recorded. */
async function runFactory(script: readonly { output: unknown }[]): Promise<readonly GenesisEvent[]> {
  const ledger = new InMemoryEventLedger();
  const engine = new CognitiveEngine(ledger);
  const scope: ProjectScope = projectScope(newProjectId());

  await engine.execute(scope, { kind: 'HUMAN', id: 'dev' }, {
    kind: 'PROPOSE_GOAL',
    description: 'build a tutoring centre management app',
    priority: 80,
    successCriteria: [{ statement: 'the suite passes', checkKind: 'TEST', checkRef: 'test:all' }],
  });
  const seeded = await engine.state(scope);
  const goalId = Object.keys((seeded.state as { goals: Record<string, unknown> }).goals)[0] as string;
  await engine.execute(scope, { kind: 'HUMAN', id: 'dev' }, { kind: 'ACTIVATE_GOAL', goalId });

  const registry = new AgentRegistry({
    proposalKinds: [...PROPOSAL_KINDS],
    permissions: [],
    tools: [],
    reasoningProviders: ['mock'],
  });
  const config = defaultRoleConfig();
  registry.register(new PlannerAgent(manifest('PLANNER')));
  registry.register(new PlannerAgent(manifest('ARCHITECT')));
  registry.register(new BuilderAgent(manifest('BUILDER'), config));
  registry.register(new QaAgent(manifest('QA'), config));
  registry.register(new SecurityAgent(manifest('SECURITY'), config));
  registry.register(new RepairAgent(manifest('REPAIR'), config));

  const graph = new InMemoryGraphStore();
  const orchestrator = new Orchestrator({
    ledger,
    engine,
    provider: new MockReasoningProvider(script as never),
    memory: new InMemoryMemoryStore(),
    graph,
    reasoning: { timeoutMs: 20_000, maxOutputTokens: 4096 },
  });
  const runtime = new AgentRuntime({ ledger, engine, registry, orchestrator });
  let n = 0;
  const factory = new SoftwareFactory({
    ledger,
    runtime,
    graph,
    verifier: new VerificationEngine(),
    sandbox: new LocalSandboxProvider(),
    config,
    ids: { run: () => FactoryRunId.parse(`run_${String((n += 1)).padStart(26, '0')}`) },
  });

  await factory.build(scope, {
    goalId,
    title: 'add two numbers',
    specification: 'Export an add function that returns the sum of its two arguments.',
    testCommand: PASSING,
    testKind: 'UNIT',
    testTimeoutMs: 20_000,
  });
  return ledger.read(scope);
}

let verified: readonly GenesisEvent[];
let repaired: readonly GenesisEvent[];

beforeAll(async () => {
  verified = await runFactory([noProposals, noProposals, artifact(GOOD)]);
  repaired = await runFactory([noProposals, noProposals, artifact(BROKEN), diagnosis, artifact(GOOD)]);
}, 180_000);

// ------------------------------------------------------------- the contract

describe('the fold is a fold', () => {
  it('shows nothing for no history', () => {
    const state = emptyConsole();
    expect(state.events).toEqual([]);
    expect(state.run).toBeNull();
    expect(state.goals).toEqual([]);
    expect(state.activeLane).toBeNull();
    expect(state.lastSeq).toBe(0);
    expect(state.anomalies).toEqual([]);
  });

  it('is deterministic: the same events give the same view', () => {
    expect(foldConsole(verified)).toEqual(foldConsole(verified));
  });

  it('reaches the same view whether folded at once or in pieces', () => {
    const half = Math.floor(verified.length / 2);
    const whole = foldConsole(verified);
    const pieced = foldMore(verified.slice(0, half), verified.slice(half));
    expect(pieced).toEqual(whole);
  });

  it('keeps every event, in ledger order', () => {
    const state = foldConsole(verified);
    expect(state.events).toHaveLength(verified.length);
    expect(state.events.map((e) => e.seq)).toEqual(verified.map((e) => e.seq));
    expect(state.lastSeq).toBe(verified[verified.length - 1]?.seq);
  });

  it('never duplicates an event', () => {
    const seqs = foldConsole(verified).events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe('every event is attributed to something real', () => {
  it('understands every event a real run produces', () => {
    // The strongest statement this suite makes: nothing the system records is
    // shown to a person as an unread event type.
    expect(foldConsole(verified).anomalies).toEqual([]);
    expect(foldConsole(repaired).anomalies).toEqual([]);
  });

  it('puts every event in a declared lane', () => {
    for (const event of foldConsole(repaired).events) {
      expect(LANES).toContain(event.lane);
    }
  });

  it('attributes an agent task to the role it was assigned to', () => {
    const state = foldConsole(verified);
    const assignments = verified.filter((e) => e.type === 'AGENT_TASK_ASSIGNED');
    expect(assignments.length).toBeGreaterThan(4);

    for (const assignment of assignments) {
      const payload = assignment.payload as { taskId: string; role: string };
      const forTask = state.events.filter((e) => e.taskId === payload.taskId);
      expect(forTask.length, payload.role).toBeGreaterThan(1);
      // Every later event on the task lands in the assigned role's lane, not
      // in a generic one: this is what the taskId → role memory buys.
      for (const event of forTask) {
        expect(event.lane, `${event.type} on ${payload.role}`).toBe(laneOfRole(payload.role));
      }
    }
  });

  it('routes a model response back to the agent that asked', () => {
    const state = foldConsole(verified);
    const responses = state.events.filter((e) => e.type === 'REASONING_RESPONDED');
    expect(responses.length).toBeGreaterThan(0);
    for (const response of responses) {
      // Not SYSTEM: the response has only a callId, and the fold remembers
      // which task the call belonged to.
      expect(response.lane).not.toBe('SYSTEM');
      expect(response.taskId).not.toBeNull();
    }
  });

  it('attributes each agent lane only its own events', () => {
    const state = foldConsole(repaired);
    const planner = state.events.filter((e) => e.lane === 'PLANNER');
    const builder = state.events.filter((e) => e.lane === 'BUILDER');
    const qa = state.events.filter((e) => e.lane === 'QA');
    const security = state.events.filter((e) => e.lane === 'SECURITY');

    expect(planner.length).toBeGreaterThan(0);
    expect(builder.length).toBeGreaterThan(0);
    expect(qa.length).toBeGreaterThan(0);
    expect(security.length).toBeGreaterThan(0);

    // The Planner never shows the Builder's artifact, and the Builder never
    // shows the security review.
    expect(planner.some((e) => e.type === 'ARTIFACT_PROPOSED')).toBe(false);
    expect(builder.some((e) => e.stage === 'SECURITY_REVIEW')).toBe(false);
    expect(security.every((e) => e.stage === 'SECURITY_REVIEW')).toBe(true);
  });

  it('gives the artifact to the Builder and the ruling to the Verifier', () => {
    const state = foldConsole(verified);
    const proposed = state.events.find((e) => e.type === 'ARTIFACT_PROPOSED');
    expect(proposed?.lane).toBe('BUILDER');
    // An artifact is a model's output until evidence says otherwise.
    expect(proposed?.authority).toBe('AI_ASSUMPTION');

    const ruling = state.events.find((e) => e.type === 'FACTORY_ARTIFACT_VERIFIED');
    expect(ruling?.lane).toBe('VERIFIER');
    expect(ruling?.authority).toBe('VERIFIED_SYSTEM_STATE');
  });

  it('gives the human the goal, and nothing the system did', () => {
    const state = foldConsole(verified);
    const human = state.events.filter((e) => e.lane === 'HUMAN');
    expect(human.map((e) => e.type)).toEqual(['GOAL_PROPOSED', 'GOAL_STATUS_CHANGED']);
    expect(human.every((e) => e.authority === 'HUMAN_DECISION')).toBe(true);
  });

  it('gives a diagnosis to the Repair lane', () => {
    const diagnosed = foldConsole(repaired).events.find((e) => e.type === 'FAILURE_DIAGNOSED');
    expect(diagnosed?.lane).toBe('REPAIR');
    expect(diagnosed?.headline).toContain('the operator is wrong');
    expect(diagnosed?.detail).toContain('use +');
  });
});

describe('what a reader is told', () => {
  it('carries the factory’s own sentence, not a paraphrase', () => {
    const state = foldConsole(repaired);
    const settled = state.events.filter((e) => e.type === 'FACTORY_STAGE_SETTLED');
    const details = settled.map((e) => e.detail);
    // These strings come from the factory. If the console rewrote them, a
    // reader would lose the only specific thing it was told.
    expect(details).toContain('the test run exited 1');
    expect(details).toContain('the test run exited 0');
    expect(details).toContain('1 artifact(s) recorded at GENERATED');
    expect(details).toContain('no finding reached the blocking severity');
  });

  it('never shows a bare "entered stage" where the ledger said more', () => {
    for (const event of foldConsole(repaired).events) {
      if (event.type !== 'FACTORY_STAGE_SETTLED') continue;
      expect(event.detail, event.headline).not.toBeNull();
      expect((event.detail as string).length).toBeGreaterThan(3);
    }
  });

  it('marks a failed stage as a failure and a passed one as a success', () => {
    const state = foldConsole(repaired);
    const failed = state.events.find((e) => e.type === 'FACTORY_STAGE_SETTLED' && e.detail === 'the test run exited 1');
    expect(failed?.severity).toBe('FAILURE');
    expect(failed?.headline).toBe('Test failed');

    const passed = state.events.find((e) => e.type === 'FACTORY_STAGE_SETTLED' && e.detail === 'the test run exited 0');
    expect(passed?.severity).toBe('SUCCESS');
    expect(passed?.headline).toBe('Test passed');
  });

  it('numbers a repeated stage by its pass, so two test runs are distinguishable', () => {
    const state = foldConsole(repaired);
    const tests = state.stages.filter((s) => s.stage === 'TEST');
    expect(tests.map((s) => s.pass)).toEqual([1, 2]);
    expect(tests.map((s) => s.result)).toEqual(['FAILED', 'PASSED']);
    expect(state.events.some((e) => e.headline === 'Test started (pass 2)')).toBe(true);
  });

  it('says what the model was asked for, in words', () => {
    const state = foldConsole(verified);
    const asks = state.events.filter((e) => e.type === 'REASONING_REQUESTED').map((e) => e.headline);
    expect(asks).toContain('Asked the model to produce an artifact');
    expect(asks).toContain('Asked the model to propose updates');
  });

  it('gives every event a timestamp and an order', () => {
    for (const event of foldConsole(verified).events) {
      expect(Number.isFinite(Date.parse(event.timestamp)), event.type).toBe(true);
      expect(event.seq).toBeGreaterThan(0);
    }
  });
});

describe('the run, the stages and the artifact', () => {
  it('reports the run the ledger recorded', () => {
    const state = foldConsole(verified);
    expect(state.run?.title).toBe('add two numbers');
    expect(state.run?.outcome).toBe('VERIFIED');
    expect(state.run?.repairAttempts).toBe(0);
    expect(state.run?.highestState).toBe('UNIT_TESTED');
    expect(state.run?.summary).not.toBeNull();
  });

  it('walks the whole pipeline, in order, on the happy path', () => {
    const state = foldConsole(verified);
    expect(state.stages.map((s) => `${s.stage}:${s.result}`)).toEqual([
      'PLAN:PASSED',
      'ARCHITECT:PASSED',
      'BUILD:PASSED',
      'TEST:PASSED',
      'SECURITY_REVIEW:PASSED',
      'VERIFY:PASSED',
    ]);
  });

  it('shows the failure, the diagnosis, the repair and then the checks again', () => {
    const state = foldConsole(repaired);
    expect(state.stages.map((s) => `${s.stage}:${s.result}`)).toEqual([
      'PLAN:PASSED',
      'ARCHITECT:PASSED',
      'BUILD:PASSED',
      'TEST:FAILED',
      'DIAGNOSE:PASSED',
      'REPAIR:PASSED',
      'TEST:PASSED',
      'SECURITY_REVIEW:PASSED',
      'VERIFY:PASSED',
    ]);
    expect(state.run?.outcome).toBe('VERIFIED');
    expect(state.run?.repairAttempts).toBe(1);
    // The property ADR-0023 §2 exists for: a repair does not reach VERIFY
    // without passing the checks again.
    const order = state.stages.map((s) => s.stage);
    expect(order.indexOf('VERIFY')).toBeGreaterThan(order.lastIndexOf('SECURITY_REVIEW') - 1);
  });

  it('reports the artifact, its hash and how far the evidence took it', () => {
    const state = foldConsole(verified);
    expect(state.artifacts).toHaveLength(1);
    const [art] = state.artifacts;
    expect(art?.path).toBe('src/add.js');
    expect(art?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(art?.contents).toBe(GOOD);
    expect(art?.proposedBy).toBe('BUILDER');
    expect(art?.state).toBe('UNIT_TESTED');
    expect(art?.evidenceCount).toBeGreaterThan(0);
    expect(art?.verifiedSeq).not.toBeNull();
  });

  it('keeps an artifact at GENERATED until something verifies it', () => {
    // Folded only as far as the build: no evidence exists yet, so the console
    // must not show it as verified.
    const throughBuild = verified.filter((e) => e.seq <= (verified.find((x) => x.type === 'ARTIFACT_PROPOSED')?.seq ?? 0));
    const state = foldConsole(throughBuild);
    expect(state.artifacts[0]?.state).toBe('GENERATED');
    expect(state.artifacts[0]?.verifiedSeq).toBeNull();
    expect(state.run?.outcome).toBeNull();
  });

  it('records the repaired artifact as a second artifact, not an overwrite', () => {
    const state = foldConsole(repaired);
    expect(state.artifacts.length).toBe(2);
    const states = state.artifacts.map((a) => a.state);
    // The broken one stays at GENERATED; only the repaired one is verified.
    expect(states).toContain('GENERATED');
    expect(states).toContain('UNIT_TESTED');
    expect(state.artifacts.find((a) => a.contents === BROKEN)?.state).toBe('GENERATED');
  });

  it('reports the goal the run serves', () => {
    const state = foldConsole(verified);
    expect(state.goals).toHaveLength(1);
    expect(state.goals[0]?.description).toBe('build a tutoring centre management app');
    expect(state.goals[0]?.status).toBe('ACTIVE');
    expect(state.run?.goalId).toBe(state.goals[0]?.goalId);
  });

  it('counts work per lane, so an agent panel is never empty when it acted', () => {
    const state = foldConsole(repaired);
    for (const lane of ['PLANNER', 'ARCHITECT', 'BUILDER', 'QA', 'SECURITY', 'REPAIR', 'VERIFIER'] as const) {
      expect(state.lanes[lane]?.events, lane).toBeGreaterThan(0);
      expect(state.lanes[lane]?.lastHeadline, lane).not.toBeNull();
    }
    expect(state.lanes['QA']?.failures).toBeGreaterThan(0);
    expect(state.lanes['PLANNER']?.tasks).toBe(1);
  });

  it('highlights the lane that last did something, never the core', () => {
    const state = foldConsole(repaired);
    expect(state.activeLane).not.toBe('SYSTEM');
    expect(AGENT_LANES).toContain(state.activeLane);
  });
});

describe('a security review that finds something', () => {
  it('records findings from the security agent’s own message', async () => {
    const CHILD = ['node:child', 'process'].join('_');
    const unsafe = `const { execSync } = require('${CHILD}');\nexports.add = (a, b) => a + b;\n`;
    const events = await runFactory([noProposals, noProposals, artifact(unsafe)]);
    const state = foldConsole(events);

    expect(state.findings.length).toBeGreaterThan(0);
    expect(state.findings.some((f) => f.rule.length > 0)).toBe(true);
    // A blocked change says so, and says why.
    const blocked = state.events.find((e) => e.type === 'FACTORY_CHANGE_BLOCKED');
    if (blocked !== undefined) {
      expect(blocked.severity).toBe('FAILURE');
      expect(blocked.detail).not.toBeNull();
      expect(state.run?.blockedReason).not.toBeNull();
    }
    expect(state.anomalies).toEqual([]);
  }, 180_000);
});

describe('an event the fold has never seen', () => {
  const odd = (type: string): GenesisEvent =>
    ({
      id: 'evt_01M2ZHGT8R30TRRW6FF0444GWM',
      projectId: 'prj_01M2ZHGT8BFNQ4Q9BFGWHX26BV',
      seq: 1,
      schemaVersion: 1,
      type,
      actor: { kind: 'SYSTEM', id: 'core' },
      subject: null,
      before: null,
      after: null,
      cause: null,
      cycleId: null,
      authority: 'VERIFIED_SYSTEM_STATE',
      payload: null,
      timestamp: '2026-09-20T12:00:00.000Z',
      payloadHash: 'a'.repeat(64),
      prevHash: null,
    }) as unknown as GenesisEvent;

  it('still shows it, under its real type', () => {
    const state = foldConsole([odd('SOMETHING_NEW_HAPPENED')]);
    expect(state.events).toHaveLength(1);
    expect(state.events[0]?.type).toBe('SOMETHING_NEW_HAPPENED');
    expect(state.events[0]?.headline).toBe('something new happened');
    expect(state.events[0]?.unrecognised).toBe(true);
  });

  it('reports it as an anomaly rather than hiding it', () => {
    // A console that dropped what it could not parse would be most misleading
    // exactly when something unusual had happened.
    expect(foldConsole([odd('SOMETHING_NEW_HAPPENED')]).anomalies).toEqual(['SOMETHING_NEW_HAPPENED']);
  });

  it('does not throw on a payload of the wrong shape', () => {
    const wrong = { ...odd('FACTORY_STAGE_SETTLED'), payload: 'not an object' } as unknown as GenesisEvent;
    expect(() => foldConsole([wrong])).not.toThrow();
    const nested = { ...odd('ARTIFACT_PROPOSED'), payload: { artifactId: 42 } } as unknown as GenesisEvent;
    expect(() => foldConsole([nested])).not.toThrow();
    expect(foldConsole([nested]).artifacts).toEqual([]);
  });

  it('describes one event against a history without re-reading everything twice', () => {
    const history = verified.slice(0, 5);
    const next = verified[5] as GenesisEvent;
    expect(describeOne(history, next)).toEqual(foldConsole(verified.slice(0, 6)).events[5]);
  });
});

describe('the lane vocabulary', () => {
  it('names every lane it can produce', () => {
    for (const lane of LANES) expect(LANE_LABELS[lane].length).toBeGreaterThan(0);
  });

  it('names every stage', () => {
    for (const stage of Object.keys(STAGE_LANES)) {
      expect(STAGE_LABELS[stage as keyof typeof STAGE_LABELS].length).toBeGreaterThan(0);
    }
  });

  it('maps a diagnosis to Repair and a repair to the Builder, as the factory does', () => {
    // Not the tidy mapping: diagnosing is reasoning about a failure, repairing
    // is producing an artifact, and this is what the factory actually assigns.
    expect(STAGE_LANES.DIAGNOSE).toBe('REPAIR');
    expect(STAGE_LANES.REPAIR).toBe('BUILDER');
  });

  it('sends a role it does not know to the core rather than inventing a lane', () => {
    expect(laneOfRole('DEPLOYMENT')).toBe('SYSTEM');
    expect(laneOfRole('QA')).toBe('QA');
  });

  it('shortens an identifier without losing its ends', () => {
    expect(shortId('task_01M2ZHH6JJNSZA7SMYR02RG63F')).toBe('01M2…G63F');
    expect(shortId('short')).toBe('short');
    expect(shortId('a_bc')).toBe('bc');
  });
});

describe('what this package is allowed to import', () => {
  it('uses only the canonical types in production code', () => {
    // The console is derived state. Production code here imports nothing that
    // decides, stores or calls — so it cannot become a second source of truth
    // however the view grows.
    const src = join(import.meta.dirname, '..', 'src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.ts')) files.push(full);
      }
    };
    walk(src);
    expect(files.length).toBeGreaterThan(2);

    const imported = new Set<string>();
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/from\s+'(@genesis\/[^']+)'/g)) {
        imported.add(match[1] as string);
      }
    }
    expect([...imported].sort()).toEqual(['@genesis/core-types']);
  });
});
