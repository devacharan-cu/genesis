/**
 * The factory, end to end, against real stores, a real sandbox and a mock
 * provider.
 *
 * The claims under test are ADR-0023's: intent reaches a verified artifact only
 * on evidence, a failure routes to diagnosis and comes back through the checks,
 * a blocking finding stops the change, repair is bounded, and the whole run
 * replays from the ledger.
 */

import { AgentRegistry, BuilderAgent, PlannerAgent, QaAgent, RepairAgent, SecurityAgent, type RegistryPolicy } from '@genesis/agents';
import { CognitiveEngine } from '@genesis/cognition';
import { AgentRuntime, Orchestrator, PROPOSAL_KINDS } from '@genesis/core';
import { FactoryRunId, newAgentId, newProjectId, projectScope, ValidationError, type ProjectScope } from '@genesis/core-types';
import { LocalSandboxProvider } from '@genesis/adapters-sandbox-local';
import { InMemoryGraphStore } from '@genesis/graph';
import { InMemoryEventLedger } from '@genesis/ledger';
import { InMemoryMemoryStore } from '@genesis/memory';
import { emptyProjection, resumeProjection } from '@genesis/projections';
import { AgentManifest, defaultRoleConfig, type RoleConfig } from '@genesis/protocol';
import { MockReasoningProvider } from '@genesis/reasoning';
import { countingIdSource, countingOrchestratorIds, fixedClock, seedGoal } from '@genesis/testkit';
import { VerificationEngine } from '@genesis/verification';
import { beforeEach, describe, expect, it } from 'vitest';
import { FACTORY_EVENTS } from '../src/events.js';
import { SoftwareFactory, type FactoryIntent } from '../src/factory.js';
import { describeState, isVerified, verifiedArtifactsProjector } from '../src/verified-artifacts.js';

const POLICY: RegistryPolicy = {
  proposalKinds: [...PROPOSAL_KINDS],
  permissions: [],
  tools: [],
  reasoningProviders: ['mock'],
};

let ledger: InMemoryEventLedger;
let engine: CognitiveEngine;
let scope: ProjectScope;

beforeEach(async () => {
  ledger = new InMemoryEventLedger();
  engine = new CognitiveEngine(ledger, { ids: countingIdSource(), now: fixedClock() });
  scope = projectScope(newProjectId());
  await seedGoal(engine, scope);
});

const manifest = (role: string, over: Record<string, unknown> = {}): AgentManifest =>
  AgentManifest.parse({
    id: newAgentId(),
    role,
    version: '1.0.0',
    capabilities: ['factory'],
    maxContextTokens: 4000,
    timeoutMs: 20_000,
    proposalKinds: role === 'PLANNER' || role === 'ARCHITECT' ? ['RECORD_BELIEF'] : [],
    reasoningProvider: role === 'QA' || role === 'SECURITY' ? null : 'mock',
    ...over,
  });

/** The node script the sandbox runs. It names the artifact, so the run is attributed. */
const PASSING_TEST = ['node', '-e', 'const a=require("./src/add.js");if(a.add(1,2)!==3)process.exit(1);console.log("src/add.js ok")'];
const SILENT_TEST = ['node', '-e', 'process.exit(0)'];
const FAILING_TEST = ['node', '-e', 'console.log("src/add.js failed");process.exit(1)'];

const GOOD_SOURCE = 'exports.add = (a, b) => a + b;\n';
const BROKEN_SOURCE = 'exports.add = (a, b) => a - b;\n';
/**
 * Assembled rather than written out: `check-boundaries.mjs` scans source text
 * and deliberately over-matches, so a literal restricted module name in a
 * fixture would read as this package importing it.
 */
const CHILD_PROCESS = ['node:child', 'process'].join('_');
const UNSAFE_SOURCE = `const { execSync } = require('${CHILD_PROCESS}');\nexports.add = (a, b) => a + b;\n`;

const artifactOutput = (contents: string) => ({ output: { artifacts: [{ path: 'src/add.js', contents }] } });
const diagnosisOutput = (approach: string) => ({
  output: { rootCause: 'the operator is wrong', targetArtifacts: ['src/add.js'], approach, confidence: 0.8 },
});
const noProposals = { output: { proposals: [] } };

interface Rig {
  readonly factory: SoftwareFactory;
  readonly runtime: AgentRuntime;
}

const rig = (script: { output: unknown }[], config: Partial<RoleConfig> = {}): Rig => {
  const registry = new AgentRegistry(POLICY);
  const roleConfig = { ...defaultRoleConfig(), ...config };
  registry.register(new PlannerAgent(manifest('PLANNER')));
  registry.register(new PlannerAgent(manifest('ARCHITECT')));
  registry.register(new BuilderAgent(manifest('BUILDER'), roleConfig));
  registry.register(new QaAgent(manifest('QA'), roleConfig));
  registry.register(new SecurityAgent(manifest('SECURITY'), roleConfig));
  registry.register(new RepairAgent(manifest('REPAIR'), roleConfig));

  const graph = new InMemoryGraphStore();
  const orchestrator = new Orchestrator({
    ledger,
    engine,
    provider: new MockReasoningProvider(script as never),
    memory: new InMemoryMemoryStore(),
    graph,
    ids: countingOrchestratorIds(),
    now: fixedClock(Date.UTC(2026, 5, 1)),
    reasoning: { timeoutMs: 20_000, maxOutputTokens: 4096 },
  });
  const runtime = new AgentRuntime({
    ledger,
    engine,
    registry,
    orchestrator,
    now: fixedClock(Date.UTC(2026, 5, 1)),
  });
  let run = 0;
  const factory = new SoftwareFactory({
    ledger,
    runtime,
    graph,
    verifier: new VerificationEngine(),
    sandbox: new LocalSandboxProvider(),
    config: roleConfig,
    ids: { run: () => FactoryRunId.parse(`run_${String((run += 1)).padStart(26, '0')}`) },
    now: fixedClock(Date.UTC(2026, 5, 1)),
  });
  return { factory, runtime };
};

const intent = (over: Partial<FactoryIntent> = {}): FactoryIntent => ({
  goalId: 'goal-1',
  title: 'add two numbers',
  specification: 'Export an add function that returns the sum of its two arguments.',
  testCommand: PASSING_TEST,
  testKind: 'UNIT',
  testTimeoutMs: 20_000,
  ...over,
});

const stagesOf = (outcome: { stages: readonly { stage: string; result: string }[] }): string[] =>
  outcome.stages.map((s) => `${s.stage}:${s.result}`);

const artifactsOf = async () => {
  const { projection } = await resumeProjection(
    verifiedArtifactsProjector,
    emptyProjection(verifiedArtifactsProjector, scope),
    ledger,
  );
  return projection.state;
};

// ------------------------------------------------------------- the happy run

describe('intent to verified artifact', () => {
  it('walks every stage and verifies on real evidence', async () => {
    const { factory } = rig([noProposals, noProposals, artifactOutput(GOOD_SOURCE)]);
    const outcome = await factory.build(scope, intent());

    expect(stagesOf(outcome)).toEqual([
      'PLAN:PASSED',
      'ARCHITECT:PASSED',
      'BUILD:PASSED',
      'TEST:PASSED',
      'SECURITY_REVIEW:PASSED',
      'VERIFY:PASSED',
    ]);
    expect(outcome.outcome).toBe('VERIFIED');
    expect(outcome.repairAttempts).toBe(0);
  }, 60_000);

  it('advances the artifact only as far as the evidence attributes itself', async () => {
    const { factory } = rig([noProposals, noProposals, artifactOutput(GOOD_SOURCE)]);
    const outcome = await factory.build(scope, intent());
    const [artifact] = outcome.artifacts;
    expect(artifact?.state).toBe('UNIT_TESTED');
    expect(isVerified(artifact as never)).toBe(true);
    expect(artifact?.verifiedAt).not.toBeNull();
    expect(artifact?.evidence.length).toBeGreaterThan(0);
  }, 60_000);

  it('records the whole run on the ledger, in order', async () => {
    const { factory } = rig([noProposals, noProposals, artifactOutput(GOOD_SOURCE)]);
    await factory.build(scope, intent());
    const types = (await ledger.read(scope)).map((e) => e.type);
    expect(types).toContain(FACTORY_EVENTS.FACTORY_RUN_STARTED);
    expect(types).toContain(FACTORY_EVENTS.FACTORY_STAGE_ENTERED);
    expect(types).toContain(FACTORY_EVENTS.FACTORY_STAGE_SETTLED);
    expect(types).toContain(FACTORY_EVENTS.FACTORY_ARTIFACT_VERIFIED);
    expect(types).toContain(FACTORY_EVENTS.FACTORY_RUN_FINISHED);
    // And the runtime's and orchestrator's own records, unchanged.
    expect(types).toContain('ARTIFACT_PROPOSED');
    expect(types).toContain('AGENT_TASK_ASSIGNED');
    expect(types).toContain('REASONING_REQUESTED');
    expect(types.indexOf(FACTORY_EVENTS.FACTORY_RUN_STARTED)).toBeLessThan(types.indexOf('ARTIFACT_PROPOSED'));
  }, 60_000);

  it('records the artifact at GENERATED when it is proposed, before any evidence', async () => {
    const { factory } = rig([noProposals, noProposals, artifactOutput(GOOD_SOURCE)]);
    await factory.build(scope, intent());
    const proposed = (await ledger.read(scope)).find((e) => e.type === 'ARTIFACT_PROPOSED');
    expect(proposed?.payload).toMatchObject({ verificationState: 'GENERATED' });
    // An agent's ceiling. The artifact is a model's output and is recorded as one.
    expect(proposed?.authority).toBe('AI_ASSUMPTION');
  }, 60_000);

  it('rebuilds the verified artifact from the ledger alone', async () => {
    const { factory } = rig([noProposals, noProposals, artifactOutput(GOOD_SOURCE)]);
    const outcome = await factory.build(scope, intent());
    const state = await artifactsOf();
    const [artifact] = outcome.artifacts;
    expect(state.artifacts[artifact?.artifactId ?? '']).toEqual(artifact);
    expect(state.observations.anomalies).toEqual([]);
  }, 60_000);
});

// ------------------------------------------------------------------ failures

describe('a test failure routes to repair and comes back through the checks', () => {
  it('diagnoses, repairs, re-tests, re-reviews and then verifies', async () => {
    const { factory } = rig([
      noProposals,
      noProposals,
      artifactOutput(BROKEN_SOURCE),
      diagnosisOutput('use + rather than -'),
      artifactOutput(GOOD_SOURCE),
    ]);
    const outcome = await factory.build(scope, intent());

    expect(stagesOf(outcome)).toEqual([
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
    expect(outcome.outcome).toBe('VERIFIED');
    expect(outcome.repairAttempts).toBe(1);
  }, 90_000);

  it('never reaches VERIFY without re-testing and re-reviewing the repair', async () => {
    const { factory } = rig([
      noProposals,
      noProposals,
      artifactOutput(BROKEN_SOURCE),
      diagnosisOutput('use + rather than -'),
      artifactOutput(GOOD_SOURCE),
    ]);
    const outcome = await factory.build(scope, intent());
    const order = outcome.stages.map((s) => s.stage);
    const repairAt = order.indexOf('REPAIR');
    const verifyAt = order.indexOf('VERIFY');
    expect(order.slice(repairAt, verifyAt)).toEqual(['REPAIR', 'TEST', 'SECURITY_REVIEW']);
  }, 90_000);

  it('keeps the failed artifact as history rather than replacing it', async () => {
    const { factory } = rig([
      noProposals,
      noProposals,
      artifactOutput(BROKEN_SOURCE),
      diagnosisOutput('use + rather than -'),
      artifactOutput(GOOD_SOURCE),
    ]);
    const outcome = await factory.build(scope, intent());
    // Two versions of the same path: different bytes are a different artifact.
    expect(outcome.artifacts).toHaveLength(2);
    expect(new Set(outcome.artifacts.map((a) => a.path))).toEqual(new Set(['src/add.js']));
    const broken = outcome.artifacts.find((a) => a.state === 'GENERATED');
    expect(broken, 'the failed version is still recorded').toBeDefined();
    expect(describeState(broken as never)).toContain('generated, not verified');
  }, 90_000);
});

describe('bounded repair', () => {
  it('stops after the configured attempts rather than looping', async () => {
    const { factory } = rig(
      [
        noProposals,
        noProposals,
        artifactOutput(BROKEN_SOURCE),
        diagnosisOutput('first idea'),
        artifactOutput(BROKEN_SOURCE),
        diagnosisOutput('second idea'),
        artifactOutput(BROKEN_SOURCE),
        diagnosisOutput('third idea'),
        artifactOutput(BROKEN_SOURCE),
      ],
      { maxRepairAttempts: 2 },
    );
    const outcome = await factory.build(scope, intent({ testCommand: FAILING_TEST }));
    expect(outcome.outcome).toBe('BLOCKED');
    expect(outcome.repairAttempts).toBe(2);
    expect(outcome.summary).toContain('repair bound of 2 is exhausted');
    // And it says so on the ledger rather than only in the return value.
    const blocked = (await ledger.read(scope)).filter((e) => e.type === FACTORY_EVENTS.FACTORY_CHANGE_BLOCKED);
    expect(blocked.length).toBeGreaterThan(0);
  }, 120_000);

  it('preserves every attempt, so a repair that made things worse is visible', async () => {
    const { factory } = rig(
      [
        noProposals,
        noProposals,
        artifactOutput(BROKEN_SOURCE),
        diagnosisOutput('first idea'),
        artifactOutput('exports.add = (a, b) => a * b;\n'),
        diagnosisOutput('second idea'),
        artifactOutput(BROKEN_SOURCE),
      ],
      { maxRepairAttempts: 1 },
    );
    const outcome = await factory.build(scope, intent({ testCommand: FAILING_TEST }));
    expect(outcome.outcome).toBe('BLOCKED');
    expect(outcome.artifacts.length).toBeGreaterThanOrEqual(2);
    for (const artifact of outcome.artifacts) expect(artifact.state).toBe('GENERATED');
  }, 120_000);
});

describe('a security finding blocks the change', () => {
  it('stops before VERIFY when a critical rule matches', async () => {
    const { factory } = rig([noProposals, noProposals, artifactOutput(UNSAFE_SOURCE), diagnosisOutput('drop the import')], {
      maxRepairAttempts: 0 + 1,
    });
    const outcome = await factory.build(scope, intent());
    const order = outcome.stages.map((s) => s.stage);
    expect(order).toContain('SECURITY_REVIEW');
    const reviewAt = order.indexOf('SECURITY_REVIEW');
    expect(outcome.stages[reviewAt]?.result).toBe('FAILED');
    expect(outcome.blocked.length).toBeGreaterThan(0);
    expect(outcome.blocked[0]?.severity).toBe('CRITICAL');
  }, 90_000);

  it('leaves the artifact generated, not verified', async () => {
    const { factory } = rig([noProposals, noProposals, artifactOutput(UNSAFE_SOURCE)], { maxRepairAttempts: 1 });
    const outcome = await factory.build(scope, intent());
    expect(outcome.outcome).toBe('BLOCKED');
    expect(outcome.highestState).toBe('GENERATED');
    for (const artifact of outcome.artifacts) expect(isVerified(artifact)).toBe(false);
  }, 90_000);
});

describe('what stops a run short', () => {
  it('refuses an intent that serves no goal, before writing anything', async () => {
    const { factory } = rig([]);
    const before = await ledger.count(scope);
    await expect(factory.build(scope, intent({ goalId: '  ' }))).rejects.toThrow(ValidationError);
    expect(await ledger.count(scope)).toBe(before);
  });

  it('refuses an intent with no way to test it', async () => {
    const { factory } = rig([]);
    await expect(factory.build(scope, intent({ testCommand: [] }))).rejects.toThrow(/cannot be verified/);
  });

  it('blocks when the build produces nothing', async () => {
    const { factory } = rig([noProposals, noProposals, { output: { artifacts: [] } }], { maxRepairAttempts: 1 });
    const outcome = await factory.build(scope, intent());
    expect(outcome.outcome).toBe('BLOCKED');
    expect(stagesOf(outcome)).toContain('BUILD:FAILED');
    expect(outcome.artifacts).toEqual([]);
  }, 60_000);

  it('blocks when the builder returns output the core refuses', async () => {
    const { factory } = rig([noProposals, noProposals, { output: { artifacts: [{ path: '../escape.js', contents: 'x' }] } }], {
      maxRepairAttempts: 1,
    });
    const outcome = await factory.build(scope, intent());
    expect(outcome.outcome).toBe('BLOCKED');
    expect(outcome.artifacts).toEqual([]);
  }, 60_000);

  it('does not verify a suite that passed without touching the artifact', async () => {
    const { factory } = rig([noProposals, noProposals, artifactOutput(GOOD_SOURCE)], { maxRepairAttempts: 1 });
    const outcome = await factory.build(scope, intent({ testCommand: SILENT_TEST }));
    // The run exited 0, so TEST and SECURITY pass — and VERIFY refuses,
    // because the evidence never names the subject (SPEC-05 §2.1).
    expect(stagesOf(outcome)).toContain('TEST:PASSED');
    expect(stagesOf(outcome)).toContain('VERIFY:FAILED');
    expect(outcome.outcome).toBe('BLOCKED');
    expect(outcome.highestState).toBe('GENERATED');
  }, 90_000);

  it('treats a test that never finishes as a failure, not a pass', async () => {
    const { factory } = rig([noProposals, noProposals, artifactOutput(GOOD_SOURCE)], { maxRepairAttempts: 1 });
    const outcome = await factory.build(
      scope,
      intent({ testCommand: ['node', '-e', 'setTimeout(() => {}, 60000)'], testTimeoutMs: 300 }),
    );
    expect(stagesOf(outcome)).toContain('TEST:FAILED');
    expect(outcome.stages.find((s) => s.stage === 'TEST')?.detail).toContain('TIMEOUT');
  }, 90_000);

  it('blocks when the reasoning provider has nothing left to say', async () => {
    // The script runs out, so the BUILD call fails as a provider failure.
    const { factory } = rig([noProposals, noProposals], { maxRepairAttempts: 1 });
    const outcome = await factory.build(scope, intent());
    expect(outcome.outcome).toBe('BLOCKED');
    expect(stagesOf(outcome)).toContain('BUILD:FAILED');
  }, 60_000);
});

// ---------------------------------------------------- isolation and ordering

describe('project isolation', () => {
  it('writes nothing into another project', async () => {
    const other = projectScope(newProjectId());
    const { factory } = rig([noProposals, noProposals, artifactOutput(GOOD_SOURCE)]);
    await factory.build(scope, intent());
    expect(await ledger.count(other)).toBe(0);
  }, 60_000);

  it('keeps two projects’ artifacts apart', async () => {
    const other = projectScope(newProjectId());
    await seedGoal(new CognitiveEngine(ledger, { ids: countingIdSource(), now: fixedClock() }), other);
    const { factory } = rig([
      noProposals,
      noProposals,
      artifactOutput(GOOD_SOURCE),
      noProposals,
      noProposals,
      artifactOutput(GOOD_SOURCE),
    ]);
    await factory.build(scope, intent());
    await factory.build(other, intent());

    const here = await artifactsOf();
    const { projection } = await resumeProjection(
      verifiedArtifactsProjector,
      emptyProjection(verifiedArtifactsProjector, other),
      ledger,
    );
    // Same bytes at the same path, so the same artifact id in both. What
    // isolation means is that each project's fold sees only its own events:
    // the records are independent, with their own sequences and their own
    // evidence, and neither counts the other's.
    expect(Object.keys(here.artifacts)).toHaveLength(1);
    expect(Object.keys(projection.state.artifacts)).toHaveLength(1);
    expect(Object.keys(here.artifacts)).toEqual(Object.keys(projection.state.artifacts));

    const [mine] = Object.values(here.artifacts);
    const [theirs] = Object.values(projection.state.artifacts);
    expect(mine?.contentHash).toBe(theirs?.contentHash);

    // Sequences are per project and both runs did the same work, so the same
    // positions appear in both — which is determinism, not leakage. What
    // isolation means is that each record is built only from its own project's
    // events, so the counts match the events that project actually holds.
    const mineEvents = await ledger.read(scope);
    const theirEvents = await ledger.read(other);
    for (const seq of mine?.events ?? []) {
      expect(mineEvents.some((e) => e.seq === seq)).toBe(true);
    }
    expect(mine?.evidence).toHaveLength(1);
    expect(theirs?.evidence).toHaveLength(1);
    // Neither fold counted the other's evidence, though both exist.
    expect(mineEvents.length).toBe(theirEvents.length);
  }, 120_000);
});

describe('determinism', () => {
  it('two identical runs append the same events, in the same order', async () => {
    const eventsFor = async (): Promise<unknown[]> => {
      ledger = new InMemoryEventLedger();
      engine = new CognitiveEngine(ledger, { ids: countingIdSource(), now: fixedClock() });
      const project = projectScope(newProjectId());
      await seedGoal(engine, project);
      const { factory } = rig([noProposals, noProposals, artifactOutput(GOOD_SOURCE)]);
      await factory.build(project, intent());
      return (await ledger.read(project)).map((e) => ({ seq: e.seq, type: e.type }));
    };
    expect(await eventsFor()).toEqual(await eventsFor());
  }, 120_000);

  it('gives the same artifact id to the same bytes at the same path', async () => {
    const idFor = async (): Promise<string | undefined> => {
      ledger = new InMemoryEventLedger();
      engine = new CognitiveEngine(ledger, { ids: countingIdSource(), now: fixedClock() });
      const project = projectScope(newProjectId());
      await seedGoal(engine, project);
      const { factory } = rig([noProposals, noProposals, artifactOutput(GOOD_SOURCE)]);
      const outcome = await factory.build(project, intent());
      return outcome.artifacts[0]?.artifactId;
    };
    expect(await idFor()).toBe(await idFor());
  }, 120_000);
});

describe('one project runs one stage at a time', () => {
  it('serialises two builds rather than interleaving them', async () => {
    const { factory } = rig([
      noProposals,
      noProposals,
      artifactOutput(GOOD_SOURCE),
      noProposals,
      noProposals,
      artifactOutput(GOOD_SOURCE),
    ]);
    const [first, second] = await Promise.all([factory.build(scope, intent()), factory.build(scope, intent())]);
    const events = (await ledger.read(scope)).filter(
      (e) => e.type === FACTORY_EVENTS.FACTORY_RUN_STARTED || e.type === FACTORY_EVENTS.FACTORY_RUN_FINISHED,
    );
    // Started, finished, started, finished — never two runs open at once.
    expect(events.map((e) => e.type)).toEqual([
      FACTORY_EVENTS.FACTORY_RUN_STARTED,
      FACTORY_EVENTS.FACTORY_RUN_FINISHED,
      FACTORY_EVENTS.FACTORY_RUN_STARTED,
      FACTORY_EVENTS.FACTORY_RUN_FINISHED,
    ]);
    expect(first.runId).not.toBe(second.runId);
  }, 120_000);
});
