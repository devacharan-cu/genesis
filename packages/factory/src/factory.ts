/**
 * The software factory: intent in, verified artifact out (ADR-0023).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). This decides what runs next and what a run
 * came to, so it is where a factory reports progress it has not earned if
 * anything here is loose.
 *
 * What it does: picks the stage, takes an impact lease, assigns a typed task
 * through the P6 runtime, reads the structured result, routes failures, bounds
 * repair, and records its own run.
 *
 * What it does not do, and structurally cannot: assemble context, call a
 * provider, append a cognitive event, write the graph, or decide a verification
 * state. Each has an owner and the factory calls that owner. There is no second
 * orchestrator here — a stage that reasons is one `AgentRuntime.assign`, which
 * is one `Orchestrator.run`, already recorded and already replayable.
 *
 * **Every value a stage carries forward is a local.** A run's artifacts, its
 * blocking findings and its diagnosis live in `#build`'s frame and are passed
 * in and out of `#runStage`. Nothing is held on the instance, because one
 * factory serves many projects and an instance field would be one project's
 * state visible to another's run.
 *
 * Three properties are held by construction:
 *
 *   - **A repair re-enters at TEST**, because the pipeline table says so.
 *   - **Blocking findings stop the change**, and Security can only block.
 *   - **Verification is the P5 engine's.** The factory collects and asks.
 */

import type { AgentRuntime, TaskOutcome } from '@genesis/core';
import {
  type AgentRole,
  type FactoryRunId,
  type FactoryStage,
  type JsonValue,
  newFactoryRunId,
  type ProjectScope,
  SEVERITIES,
  type Severity,
  ValidationError,
  type VerificationState,
} from '@genesis/core-types';
import type { GraphStore } from '@genesis/graph';
import type { EventLedger } from '@genesis/ledger';
import { emptyProjection, resumeProjection } from '@genesis/projections';
import { defaultRoleConfig, type Envelope, type RoleConfig, type TestKind } from '@genesis/protocol';
import type { SandboxProvider } from '@genesis/sandbox';
import { FACTORY_EVENTS, type FactoryEventType } from './events.js';
import { checkLease, leasePayload, takeLease } from './leases.js';
import { FIRST_STAGE, type FactoryOutcomeKind, ON_FAILURE, ON_SUCCESS } from './pipeline.js';
import { highestState, type VerifiedArtifact, verifiedArtifactsProjector } from './verified-artifacts.js';

/** Decides what evidence justifies. The P5 engine's shape, as a port (ADR-0003). */
export interface EvidenceVerifier {
  evaluate(artifactId: string, evidence: readonly VerifierEvidence[]): VerificationState;
}

export interface VerifierEvidence {
  readonly observationId: string;
  readonly raw: string;
  readonly hash: string;
  readonly environment: 'SANDBOX' | 'STAGING' | 'PRODUCTION' | 'LOCAL';
  readonly exitCode: number;
  readonly testKind?: string | undefined;
  readonly claimedArtifacts: string[];
}

export interface FactoryIds {
  run(): FactoryRunId;
}

export const defaultFactoryIds: FactoryIds = { run: () => newFactoryRunId() };

export interface FactoryOptions {
  readonly ledger: EventLedger;
  readonly runtime: AgentRuntime;
  /** Read for impact leases. The factory never writes the graph (ADR-0016). */
  readonly graph: Pick<GraphStore, 'impactSet'>;
  /** Applied to collected evidence. The state it returns is the engine's. */
  readonly verifier: EvidenceVerifier;
  /** Where tests actually run. Without one the TEST stage observes nothing. */
  readonly sandbox: SandboxProvider;
  readonly config?: Partial<RoleConfig>;
  readonly ids?: FactoryIds;
  readonly now?: () => string;
  readonly actorId?: string;
  /**
   * How many stages one run may execute before the factory stops.
   *
   * A real bound, not a formality: the stage table is acyclic on success and
   * repair is bounded, so a correct run cannot reach it — but a table edited
   * into a cycle would otherwise spin forever, and an operator who wants a
   * tighter ceiling can set one.
   */
  readonly maxStages?: number;
}

/** What a caller asks the factory to build. */
export interface FactoryIntent {
  /** The goal this serves. Required: work that serves no goal is drift. */
  readonly goalId: string;
  readonly title: string;
  readonly specification: string;
  /** The command that tests it, run in the sandbox against the built artifacts. */
  readonly testCommand: readonly string[];
  readonly testKind?: TestKind;
  readonly testTimeoutMs?: number;
  /** Graph nodes the change starts from, for the impact lease. */
  readonly originNodes?: readonly string[];
}

export interface StageRecord {
  readonly stage: FactoryStage;
  readonly pass: number;
  readonly result: 'PASSED' | 'FAILED' | 'SKIPPED';
  readonly taskId: string | null;
  readonly detail: string;
}

export interface BlockingFinding {
  readonly rule: string;
  readonly severity: Severity;
  readonly artifactId: string;
  readonly detail: string;
}

export interface FactoryOutcome {
  readonly runId: FactoryRunId;
  readonly outcome: FactoryOutcomeKind;
  readonly stages: readonly StageRecord[];
  readonly repairAttempts: number;
  readonly artifacts: readonly VerifiedArtifact[];
  readonly highestState: VerificationState;
  readonly blocked: readonly BlockingFinding[];
  readonly summary: string;
}

/** An artifact the core recorded, read back from the ledger with its bytes. */
export interface BuiltArtifact {
  readonly artifactId: string;
  readonly path: string;
  readonly contents: string;
}

/** A failure, shaped for the Repair role. */
interface RunFailure {
  readonly source: 'BUILD' | 'TEST' | 'SECURITY' | 'VERIFICATION';
  readonly stage: FactoryStage;
  readonly signature: string;
  readonly summary: string;
  readonly raw: string | null;
}

/** Everything a stage may read, and everything it may hand on. */
interface StageContext {
  readonly runId: FactoryRunId;
  readonly intent: FactoryIntent;
  readonly built: readonly BuiltArtifact[];
  /**
   * The failure a repair is working on. Never null: it starts as the sentinel
   * below, which names itself, so no stage needs a branch for a case the
   * pipeline table already rules out.
   */
  readonly failure: RunFailure;
  /** The diagnosis a repair is acting on, carried rather than re-derived. */
  readonly approach: string;
  readonly history: readonly { attempt: number; signature: string; approach: string }[];
  readonly attempt: number;
}

interface StageResult {
  readonly passed: boolean;
  readonly detail: string;
  readonly taskId: string | null;
  /** Replaces the carried artifacts when a stage produced any. */
  readonly built?: readonly BuiltArtifact[];
  readonly blocking?: readonly BlockingFinding[];
  readonly approach?: string;
}

const DEFAULTS = { testTimeoutMs: 60_000, maxStages: 40 };

export class SoftwareFactory {
  readonly #o: FactoryOptions;
  readonly #config: RoleConfig;
  readonly #ids: FactoryIds;
  readonly #now: () => string;
  readonly #actorId: string;
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: FactoryOptions) {
    this.#o = options;
    this.#config = { ...defaultRoleConfig(), ...options.config };
    this.#ids = options.ids ?? defaultFactoryIds;
    this.#now = options.now ?? ((): string => new Date().toISOString());
    this.#actorId = options.actorId ?? 'software-factory';
  }

  /**
   * Runs one intent through the pipeline. Resolves with what it came to;
   * rejects only when a store itself fails — a blocked change is an outcome.
   *
   * Serialised per project, on the same discipline as every other writer
   * (ADR-0021 §1).
   */
  build(scope: ProjectScope, intent: FactoryIntent): Promise<FactoryOutcome> {
    if (intent.goalId.trim().length === 0) {
      return Promise.reject(new ValidationError('a factory run must name the goal it serves', { title: intent.title }));
    }
    if (intent.testCommand.length === 0) {
      return Promise.reject(
        new ValidationError('a factory run must name the command that tests it: a change nobody can test cannot be verified', {
          title: intent.title,
        }),
      );
    }
    return this.#serialise(scope.projectId, () => this.#build(scope, intent));
  }

  async #build(scope: ProjectScope, intent: FactoryIntent): Promise<FactoryOutcome> {
    const runId = this.#ids.run();
    const stages: StageRecord[] = [];
    const blocked: BlockingFinding[] = [];
    const history: { attempt: number; signature: string; approach: string }[] = [];
    const passes = new Map<FactoryStage, number>();

    let built: readonly BuiltArtifact[] = [];
    let failure: RunFailure = UNDIAGNOSED;
    let approach = 'none recorded';
    let repairAttempts = 0;
    let outcome: FactoryOutcomeKind = 'BLOCKED';
    let summary = 'the run did not reach a conclusion';

    await this.#record(scope, FACTORY_EVENTS.FACTORY_RUN_STARTED, {
      runId,
      goalId: intent.goalId,
      title: intent.title,
      maxRepairAttempts: this.#config.maxRepairAttempts,
    });

    const maxStages = this.#o.maxStages ?? DEFAULTS.maxStages;
    let stage: FactoryStage | null = FIRST_STAGE;
    let guard = 0;

    while (stage !== null) {
      guard += 1;
      // A pipeline that cannot terminate is worse than one that stops early.
      if (guard > maxStages) {
        summary = `the pipeline ran ${maxStages} stages without terminating`;
        outcome = 'FAILED';
        break;
      }

      const pass = (passes.get(stage) ?? 0) + 1;
      passes.set(stage, pass);

      const lease = await takeLease({ graph: this.#o.graph, ledger: this.#o.ledger }, scope, intent.originNodes ?? []);
      await this.#record(scope, FACTORY_EVENTS.FACTORY_STAGE_ENTERED, {
        runId,
        stage,
        pass,
        lease: leasePayload(lease) as JsonValue,
      });

      const result = await this.#runStage(scope, stage, {
        runId,
        intent,
        built,
        failure,
        approach,
        history,
        attempt: repairAttempts + 1,
      });

      // Checked after the work, not before: what matters is whether the world
      // the stage concluded about still holds (ADR-0021 §2).
      const staleness = await checkLease(this.#o.ledger, scope, lease);
      if (staleness.stale) {
        const willRerun = pass === 1;
        await this.#record(scope, FACTORY_EVENTS.FACTORY_LEASE_STALE, {
          runId,
          stage,
          pass,
          reason: staleness.reason,
          touched: [...staleness.touched],
          willRerun,
        });
        if (willRerun) continue;
        stages.push({ stage, pass, result: 'FAILED', taskId: result.taskId, detail: staleness.reason });
        await this.#settle(scope, runId, stage, pass, 'FAILED', result.taskId, staleness.reason);
        summary = `${stage} could not be completed against a stable state: ${staleness.reason}`;
        outcome = 'BLOCKED';
        break;
      }

      stages.push({ stage, pass, result: result.passed ? 'PASSED' : 'FAILED', taskId: result.taskId, detail: result.detail });
      await this.#settle(scope, runId, stage, pass, result.passed ? 'PASSED' : 'FAILED', result.taskId, result.detail);

      if (result.built !== undefined) built = result.built;
      if (result.approach !== undefined) approach = result.approach;
      if (stage === 'DIAGNOSE' && result.passed) {
        repairAttempts += 1;
        history.push({ attempt: repairAttempts, signature: failure.signature, approach });
      }
      if (result.blocking !== undefined && result.blocking.length > 0) {
        for (const finding of result.blocking) blocked.push(finding);
        await this.#record(scope, FACTORY_EVENTS.FACTORY_CHANGE_BLOCKED, {
          runId,
          stage,
          reason: result.detail,
          blocking: result.blocking.map((f) => ({ ...f })) as JsonValue,
        });
      }

      if (result.passed) {
        if (stage === 'VERIFY') {
          outcome = 'VERIFIED';
          summary = result.detail;
          break;
        }
        stage = ON_SUCCESS[stage];
        continue;
      }

      failure = failureFrom(stage, result.detail);
      const next: FactoryStage | null = ON_FAILURE[stage];
      if (next === null || repairAttempts >= this.#config.maxRepairAttempts) {
        const why =
          next === null
            ? `${stage} failed and has no repair path: ${result.detail}`
            : `${stage} failed and the repair bound of ${this.#config.maxRepairAttempts} is exhausted: ${result.detail}`;
        await this.#record(scope, FACTORY_EVENTS.FACTORY_CHANGE_BLOCKED, { runId, stage, reason: why, blocking: [] });
        summary = why;
        outcome = 'BLOCKED';
        break;
      }
      stage = next;
    }

    const artifacts = await this.#artifacts(scope);
    const highest = highestState(artifacts);
    await this.#record(scope, FACTORY_EVENTS.FACTORY_RUN_FINISHED, {
      runId,
      outcome,
      stagesRun: stages.length,
      repairAttempts,
      highestState: highest,
      summary,
    });
    return { runId, outcome, stages, repairAttempts, artifacts, highestState: highest, blocked, summary };
  }

  // ------------------------------------------------------------- the stages

  async #runStage(scope: ProjectScope, stage: FactoryStage, ctx: StageContext): Promise<StageResult> {
    switch (stage) {
      case 'PLAN':
        return this.#cognitive(scope, 'PLANNER', `Plan the work for: ${ctx.intent.title}. ${ctx.intent.specification}`, ctx);
      case 'ARCHITECT':
        return this.#cognitive(scope, 'ARCHITECT', `Propose the structure for: ${ctx.intent.title}. ${ctx.intent.specification}`, ctx);
      case 'BUILD':
        return this.#buildStage(scope, ctx, ctx.intent.specification, `Implement: ${ctx.intent.title}`);
      case 'TEST':
        return this.#testStage(scope, ctx);
      case 'SECURITY_REVIEW':
        return this.#securityStage(scope, ctx);
      case 'DIAGNOSE':
        // Entered only through ON_FAILURE, which the loop reaches only after
        // recording the failure, so the context's failure is a real one.
        return this.#diagnoseStage(scope, ctx, ctx.failure);
      case 'REPAIR':
        return this.#buildStage(
          scope,
          ctx,
          `${ctx.intent.specification}\n\nThe previous attempt failed. Diagnosis: ${ctx.approach}`,
          `Repair: ${ctx.intent.title}`,
        );
      case 'VERIFY':
        return this.#verifyStage(scope, ctx);
    }
  }

  /** A stage whose role proposes: the core decides, the factory reads the count. */
  async #cognitive(scope: ProjectScope, role: AgentRole, instruction: string, ctx: StageContext): Promise<StageResult> {
    const outcome = await this.#assign(scope, role, instruction, ctx.intent, null);
    if (outcome.failure !== null) {
      return { passed: false, detail: `${role} failed: ${outcome.failure.message}`, taskId: outcome.taskId };
    }
    const accepted = outcome.proposals.filter((p) => p.outcome === 'ACCEPTED').length;
    // A stage that proposed nothing has still done its job. The core accepting
    // nothing is a real answer, and treating it as failure would block every
    // run whose plan was already recorded.
    return { passed: true, detail: `${accepted} proposal(s) accepted`, taskId: outcome.taskId };
  }

  /** BUILD and REPAIR are the same stage with a different specification. */
  async #buildStage(scope: ProjectScope, ctx: StageContext, specification: string, instruction: string): Promise<StageResult> {
    const outcome = await this.#assign(scope, 'BUILDER', instruction, ctx.intent, {
      specification,
      existing: ctx.built.map((a) => ({ artifactId: a.artifactId, path: a.path, contents: a.contents })),
    });
    if (outcome.failure !== null) {
      return { passed: false, detail: `the builder failed: ${outcome.failure.message}`, taskId: outcome.taskId };
    }
    const built = await this.#readArtifacts(scope, outcome);
    if (built.length === 0) {
      return { passed: false, detail: 'the build produced no artifacts', taskId: outcome.taskId, built: [] };
    }
    return { passed: true, detail: `${built.length} artifact(s) recorded at GENERATED`, taskId: outcome.taskId, built };
  }

  /**
   * The factory runs the sandbox; QA reports what it did.
   *
   * An agent cannot reach a sandbox — `packages/agents` has no such dependency
   * — which is what keeps execution out of the domain and makes the evidence
   * something the core observed rather than something an agent claimed.
   */
  async #testStage(scope: ProjectScope, ctx: StageContext): Promise<StageResult> {
    // `built` is never empty here: BUILD and REPAIR both fail on an empty set,
    // and the pipeline table admits no other way into TEST. A guard for it
    // would be unreachable code standing in for the invariant the table and its
    // test already give.
    const execution = await this.#execute(ctx.intent, ctx.built);
    const outcome = await this.#assign(scope, 'QA', `Report the test run for: ${ctx.intent.title}`, ctx.intent, {
      artifacts: ctx.built.map((a) => ({ artifactId: a.artifactId, path: a.path, contents: a.contents })),
      command: [...ctx.intent.testCommand],
      kind: ctx.intent.testKind ?? 'UNIT',
      execution,
    });
    if (outcome.failure !== null) {
      return { passed: false, detail: `QA failed: ${outcome.failure.message}`, taskId: outcome.taskId };
    }
    if (execution.failureKind !== null) {
      return { passed: false, detail: `the test run did not finish: ${execution.failureKind}`, taskId: outcome.taskId };
    }
    if (execution.exitCode !== 0) {
      return { passed: false, detail: `the test run exited ${execution.exitCode}`, taskId: outcome.taskId };
    }
    return { passed: true, detail: 'the test run exited 0', taskId: outcome.taskId };
  }

  async #securityStage(scope: ProjectScope, ctx: StageContext): Promise<StageResult> {
    // Reached only from TEST, so `built` is non-empty for the same reason.
    const outcome = await this.#assign(scope, 'SECURITY', `Review: ${ctx.intent.title}`, ctx.intent, {
      artifacts: ctx.built.map((a) => ({ artifactId: a.artifactId, path: a.path, contents: a.contents })),
      blockAt: this.#config.blockAt,
      severityFloor: this.#config.severityFloor,
    });
    if (outcome.failure !== null) {
      return { passed: false, detail: `the security review failed: ${outcome.failure.message}`, taskId: outcome.taskId };
    }
    const blocking = this.#blockingFrom(outcome, ctx.built);
    if (blocking.length > 0) {
      return {
        passed: false,
        detail: `${blocking.length} finding(s) at or above ${this.#config.blockAt} block this change`,
        taskId: outcome.taskId,
        blocking,
      };
    }
    return { passed: true, detail: 'no finding reached the blocking severity', taskId: outcome.taskId };
  }

  async #diagnoseStage(scope: ProjectScope, ctx: StageContext, failure: RunFailure): Promise<StageResult> {
    const outcome = await this.#assign(scope, 'REPAIR', `Diagnose: ${failure.summary}`, ctx.intent, {
      failure: {
        source: failure.source,
        stage: failure.stage,
        signature: failure.signature,
        summary: failure.summary,
        artifactIds: ctx.built.map((a) => a.artifactId),
        raw: failure.raw,
      },
      attempt: ctx.attempt,
      maxAttempts: this.#config.maxRepairAttempts,
      history: ctx.history.map((h) => ({ ...h })),
      artifacts: ctx.built.map((a) => ({ artifactId: a.artifactId, path: a.path, contents: a.contents })),
    });
    if (outcome.failure !== null) {
      return { passed: false, detail: `diagnosis failed: ${outcome.failure.message}`, taskId: outcome.taskId };
    }
    const approach = approachFrom(outcome);
    return { passed: true, detail: `diagnosed: ${approach}`, taskId: outcome.taskId, approach };
  }

  /**
   * Asks the P5 engine what the collected evidence justifies, per artifact, and
   * records the ruling. The factory decides nothing here (ADR-0023 §5).
   */
  async #verifyStage(scope: ProjectScope, ctx: StageContext): Promise<StageResult> {
    const state = await this.#artifactState(scope);
    let advanced = 0;
    for (const artifact of ctx.built) {
      // Present by construction: every built artifact was read back out of an
      // ARTIFACT_PROPOSED event, which is the same event this fold reads.
      const record = state.artifacts[artifact.artifactId] as (typeof state.artifacts)[string];
      // The engine attributes coverage by finding the artifact named in the
      // output (SPEC-05 §2.1), and a real runner prints paths, not synthetic
      // ids. So it is asked in the terms a coverage report actually uses, and
      // the ruling is recorded against the artifact version that earned it.
      const ruling = this.#o.verifier.evaluate(
        record.path,
        record.evidence.map((e) => ({
          observationId: e.observationId,
          raw: e.raw,
          hash: e.hash,
          environment: e.environment,
          exitCode: e.exitCode,
          testKind: e.testKind ?? undefined,
          claimedArtifacts: [record.path],
        })),
      );
      await this.#record(scope, FACTORY_EVENTS.FACTORY_ARTIFACT_VERIFIED, {
        runId: ctx.runId,
        artifactId: artifact.artifactId,
        path: record.path,
        contentHash: record.contentHash,
        state: ruling,
        evidenceCount: record.evidence.length,
      });
      if (ruling !== 'GENERATED') advanced += 1;
    }
    if (advanced === 0) {
      // The phrase SPEC-05 §6 requires. Not "failed", not "done".
      return { passed: false, detail: 'generated, not verified: the evidence does not support advancing any artifact', taskId: null };
    }
    return { passed: true, detail: `${advanced} artifact(s) advanced past GENERATED on evidence`, taskId: null };
  }

  // ------------------------------------------------------------ the plumbing

  #assign(
    scope: ProjectScope,
    role: AgentRole,
    instruction: string,
    intent: FactoryIntent,
    input: JsonValue,
  ): Promise<TaskOutcome> {
    return this.#o.runtime.assign(scope, { role, instruction, contributesTo: [intent.goalId], input });
  }

  /**
   * The artifacts this build landed, read from what the core recorded rather
   * than from what the agent said.
   *
   * The run summary names the ids; the bytes come from the `ARTIFACT_PROPOSED`
   * events. Reading the bytes back from the ledger, rather than keeping what
   * was sent, is what makes the next stage operate on the recorded artifact.
   */
  async #readArtifacts(scope: ProjectScope, outcome: TaskOutcome): Promise<readonly BuiltArtifact[]> {
    const produced = outcome.produced as { artifacts?: { artifactId?: unknown }[] } | null;
    const ids = new Set(
      (produced?.artifacts ?? [])
        .map((a) => a.artifactId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    );
    if (ids.size === 0) return [];

    const events = await this.#o.ledger.read(scope);
    const byId = new Map<string, BuiltArtifact>();
    for (const event of events) {
      if (event.type !== 'ARTIFACT_PROPOSED') continue;
      const payload = event.payload as { artifactId?: unknown; path?: unknown; contents?: unknown } | null;
      const artifactId = payload?.artifactId;
      if (typeof artifactId !== 'string' || !ids.has(artifactId)) continue;
      if (typeof payload?.path !== 'string' || typeof payload.contents !== 'string') continue;
      byId.set(artifactId, { artifactId, path: payload.path, contents: payload.contents });
    }
    // In the order the run produced them, so a replay stages the same files.
    return [...ids].flatMap((id) => {
      const artifact = byId.get(id);
      return artifact === undefined ? [] : [artifact];
    });
  }

  /** Runs the change's tests in the sandbox. Real execution, real exit code. */
  async #execute(
    intent: FactoryIntent,
    built: readonly BuiltArtifact[],
  ): Promise<{ exitCode: number; raw: string; durationMs: number; failureKind: string | null }> {
    const files: Record<string, string> = {};
    for (const artifact of built) files[artifact.path] = artifact.contents;
    try {
      const result = await this.#o.sandbox.run({
        command: [...intent.testCommand],
        files,
        timeoutMs: intent.testTimeoutMs ?? DEFAULTS.testTimeoutMs,
      });
      return {
        exitCode: result.exitCode,
        raw: `${result.stdout}\n${result.stderr}`.trim(),
        durationMs: result.durationMs,
        failureKind: null,
      };
    } catch (thrown) {
      // A timeout or a cancellation is a real observation about the change, not
      // an error to swallow. It becomes evidence that the run did not finish,
      // and QA reports it as such rather than as a passing suite.
      const kind = typeof (thrown as { kind?: unknown }).kind === 'string' ? (thrown as { kind: string }).kind : 'UNKNOWN';
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      return { exitCode: -1, raw: `${kind}: ${message}`, durationMs: 0, failureKind: kind };
    }
  }

  /** Findings at or above the configured blocking severity. */
  #blockingFrom(outcome: TaskOutcome, built: readonly BuiltArtifact[]): readonly BlockingFinding[] {
    const threshold = SEVERITIES.indexOf(this.#config.blockAt);
    // Non-empty by construction: SECURITY_REVIEW is reached only from TEST,
    // which is reached only from a BUILD or REPAIR that landed artifacts. The
    // assertion stands in for that invariant rather than for a branch nothing
    // could take.
    const [subject] = built as readonly [BuiltArtifact, ...BuiltArtifact[]];
    const blocking: BlockingFinding[] = [];
    for (const message of outcome.messages) {
      if (message.kind !== 'FINDING') continue;
      const severity: Severity = message.body.risk;
      if (SEVERITIES.indexOf(severity) > threshold) continue;
      blocking.push({
        rule: message.body.subject,
        severity,
        artifactId: message.body.contextRefs[0] ?? subject.artifactId,
        detail: message.body.detail,
      });
    }
    return blocking;
  }

  async #artifactState(scope: ProjectScope) {
    const { projection } = await resumeProjection(
      verifiedArtifactsProjector,
      emptyProjection(verifiedArtifactsProjector, scope),
      this.#o.ledger,
    );
    return projection.state;
  }

  async #artifacts(scope: ProjectScope): Promise<readonly VerifiedArtifact[]> {
    const state = await this.#artifactState(scope);
    return Object.values(state.artifacts).sort((a, b) => a.artifactId.localeCompare(b.artifactId));
  }

  #record(scope: ProjectScope, type: FactoryEventType, payload: JsonValue): Promise<unknown> {
    return this.#o.ledger.append(scope, {
      type,
      actor: { kind: 'SYSTEM', id: this.#actorId },
      authority: 'VERIFIED_SYSTEM_STATE',
      payload,
      timestamp: this.#now(),
    });
  }

  #settle(
    scope: ProjectScope,
    runId: string,
    stage: FactoryStage,
    pass: number,
    result: 'PASSED' | 'FAILED' | 'SKIPPED',
    taskId: string | null,
    detail: string,
  ): Promise<unknown> {
    return this.#record(scope, FACTORY_EVENTS.FACTORY_STAGE_SETTLED, { runId, stage, pass, result, taskId, detail });
  }

  async #serialise<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    // As everywhere else: the queue swallows every outcome, so one failed run
    // does not poison the next.
    const previous = this.#queues.get(projectId) ?? Promise.resolve();
    const run = previous.then(task);
    this.#queues.set(
      projectId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}

/**
 * What a run's failure is before anything has failed.
 *
 * A sentinel rather than null, so no stage carries a branch for a case the
 * pipeline table rules out — and one that names itself, so a table ever edited
 * to admit it would produce a diagnosis that says exactly what happened rather
 * than reading a blank.
 */
const UNDIAGNOSED: RunFailure = {
  source: 'BUILD',
  stage: 'DIAGNOSE',
  signature: 'factory:DIAGNOSE:UNRECORDED',
  summary: 'a diagnosis was requested with no recorded failure',
  raw: null,
};

/** Which kind of failure a stage produced, for the Repair role to read. */
export function failureFrom(stage: FactoryStage, detail: string): RunFailure {
  const source =
    stage === 'BUILD' || stage === 'REPAIR'
      ? ('BUILD' as const)
      : stage === 'TEST'
        ? ('TEST' as const)
        : stage === 'SECURITY_REVIEW'
          ? ('SECURITY' as const)
          : ('VERIFICATION' as const);
  return { source, stage, signature: `factory:${stage}:${source}`, summary: detail, raw: detail };
}

/** The approach a diagnosis proposed, read off the Repair role's finding. */
export function approachFrom(outcome: TaskOutcome): string {
  const finding = outcome.messages.find(
    (m): m is Extract<Envelope, { kind: 'FINDING' }> => m.kind === 'FINDING' && m.body.subject.startsWith('diagnosis of'),
  );
  return finding?.body.detail ?? 'no approach recorded';
}
