/**
 * The four factory roles (ADR-0023 §3).
 *
 * Each is a small difference from `BaseAgent`, and each is written around the
 * same discipline: report what was done, never what it means.
 *
 *   - **Builder** frames a `PRODUCE_ARTIFACT` run and reports the artifacts the
 *     core recorded. It has no field for "works" and no way to run anything.
 *   - **QA** submits the runner's real output as evidence. It does not decide
 *     what the evidence justifies, and it says plainly when a suite passed
 *     without touching the subject — which advances nothing (SPEC-05 §2.1).
 *   - **Security** applies deterministic checks and reports findings with the
 *     matched text. It can block; it cannot approve.
 *   - **Repair** frames a `DIAGNOSE_FAILURE` run, bounded by its attempt count,
 *     and refuses an approach it has already tried.
 *
 * None of the four can write canonical state, because `packages/agents` cannot
 * reach anything that writes (ADR-0020 §1). They return messages.
 */

import { atLeastAsSevere, type Severity, SEVERITIES } from '@genesis/core-types';
import {
  type AgentManifest,
  BuilderInput,
  checkInput,
  type Envelope,
  QaInput,
  RepairInput,
  type RoleConfig,
  SecurityInput,
  type TaskAssignmentBody,
  type TaskFraming,
} from '@genesis/protocol';
import { BaseAgent, type Emit } from './base.js';
import { AgentError, type AgentServices } from './contract.js';
import { reviewText, SECURITY_CHECK_IDS } from './security-checks.js';

/** The task kinds the factory roles answer to. */
export const FACTORY_TASK_KINDS = {
  BUILDER: 'IMPLEMENT_CHANGE',
  QA: 'RUN_TESTS',
  SECURITY: 'REVIEW_CHANGE',
  REPAIR: 'DIAGNOSE_AND_REPAIR',
} as const;

/** A role that carries typed configuration. Every field is a number or a closed choice. */
abstract class ConfiguredAgent extends BaseAgent {
  constructor(
    manifest: AgentManifest,
    protected readonly config: RoleConfig,
  ) {
    super(manifest);
  }

  /** Reads this task's input, or fails the task rather than working on a default. */
  protected read<T>(schema: { safeParse: (v: unknown) => { success: boolean } }, assignment: TaskAssignmentBody, role: string): T {
    const checked = checkInput(schema as never, assignment.input, role);
    if (!checked.ok) throw new AgentError('MALFORMED_OUTPUT', checked.reason);
    return checked.input as T;
  }
}

// ----------------------------------------------------------------- builder

/**
 * Produces source artifacts. It cannot test them, cannot verify them, and has
 * no field in which to claim they work.
 */
export class BuilderAgent extends ConfiguredAgent {
  frame(assignment: TaskAssignmentBody): TaskFraming {
    const input = this.read<typeof BuilderInput._output>(BuilderInput, assignment, 'BUILDER');
    const existing = input.existing.map((a) => `--- ${a.path} ---\n${a.contents}`).join('\n\n');
    return {
      purpose: 'PRODUCE_ARTIFACT',
      kind: FACTORY_TASK_KINDS.BUILDER,
      // The specification, plus the files it may modify. No wording of the
      // Builder's own: the prompt is the core's (ADR-0022 §1).
      text: existing.length === 0 ? input.specification : `${input.specification}\n\nExisting files:\n\n${existing}`,
      nodeIds: [],
      activeGoalId: assignment.contributesTo[0] ?? null,
      budgetTokens: this.manifest.maxContextTokens,
    };
  }

  protected override extraMessages(assignment: TaskAssignmentBody, services: AgentServices, emit: Emit): readonly Envelope[] {
    const produced = services.run?.produced as { artifacts?: { path: string }[]; limitations?: string[] } | null | undefined;
    const limitations = produced?.limitations ?? [];
    const built = produced?.artifacts ?? [];

    const messages: Envelope[] = limitations.map((limitation) =>
      emit('FINDING', {
        taskId: assignment.taskId,
        subject: 'the builder could not implement part of the specification',
        detail: limitation,
        risk: 'MEDIUM',
        contextRefs: [],
      }),
    );

    // A build that produced nothing is a real outcome and has to say so. A
    // Builder reporting success over an empty set is the first step of a
    // factory that reports progress it has not made.
    if (built.length === 0) {
      messages.push(
        emit('FINDING', {
          taskId: assignment.taskId,
          subject: 'the build produced no artifacts',
          detail: 'nothing was recorded for this change, so there is nothing to test, review or verify',
          risk: 'HIGH',
          contextRefs: [],
        }),
      );
    }
    return messages;
  }
}

// ---------------------------------------------------------------------- qa

/**
 * Reports what the runner did. QA needs no model: it reads an execution result
 * the factory obtained from the sandbox and submits it as evidence.
 *
 * The one judgement it makes is attribution, and it is mechanical: did the
 * output name the artifact? A suite that passed without executing the subject
 * proves nothing about the subject (SPEC-05 §2.1).
 */
export class QaAgent extends ConfiguredAgent {
  frame(): TaskFraming | null {
    return null;
  }

  protected override extraMessages(assignment: TaskAssignmentBody, _services: AgentServices, emit: Emit): readonly Envelope[] {
    const input = this.read<typeof QaInput._output>(QaInput, assignment, 'QA');
    if (input.execution === null) {
      return [
        emit('FINDING', {
          taskId: assignment.taskId,
          subject: 'no test run to report',
          detail: 'QA was assigned a task with no execution result, so it observed nothing and reports nothing',
          risk: 'HIGH',
          contextRefs: [],
        }),
      ];
    }

    const { exitCode, raw } = input.execution;
    const messages: Envelope[] = [];

    for (const artifact of input.artifacts) {
      const attributed = raw.includes(artifact.path) || raw.includes(artifact.artifactId);
      messages.push(
        emit('EVIDENCE_SUBMISSION', {
          taskId: assignment.taskId,
          experimentId: null,
          environment: 'SANDBOX',
          exitCode,
          raw,
          testKind: input.kind,
          claimedArtifacts: [artifact.artifactId],
        }),
      );
      if (exitCode === 0 && !attributed) {
        messages.push(
          emit('FINDING', {
            taskId: assignment.taskId,
            subject: `the suite passed without touching ${artifact.path}`,
            detail:
              'the run succeeded but its output never names this artifact, so it is evidence about the suite and not about the subject',
            risk: 'HIGH',
            contextRefs: [],
          }),
        );
      }
    }

    if (exitCode !== 0) {
      messages.push(
        emit('FINDING', {
          taskId: assignment.taskId,
          subject: `the test run exited ${exitCode}`,
          detail: raw.slice(0, 3900).trim().length === 0 ? 'the run produced no output' : raw.slice(0, 3900),
          risk: 'CRITICAL',
          contextRefs: [],
        }),
      );
    }
    return messages;
  }
}

// ---------------------------------------------------------------- security

/**
 * Reviews artifact text against deterministic rules. No model: the same text
 * gives the same findings every time, which is what lets a review be replayed.
 */
export class SecurityAgent extends ConfiguredAgent {
  frame(): TaskFraming | null {
    return null;
  }

  protected override extraMessages(assignment: TaskAssignmentBody, _services: AgentServices, emit: Emit): readonly Envelope[] {
    const input = this.read<typeof SecurityInput._output>(SecurityInput, assignment, 'SECURITY');
    const floor = input.severityFloor;
    const messages: Envelope[] = [];

    for (const artifact of input.artifacts) {
      for (const finding of reviewText(artifact.contents)) {
        // Below the floor is not reported. The floor is configuration, not a
        // judgement the role makes about what matters.
        if (!atLeastAsSevere(finding.severity, floor)) continue;
        messages.push(
          emit('FINDING', {
            taskId: assignment.taskId,
            subject: `${finding.rule} in ${artifact.path}:${finding.line}`,
            detail: `${finding.why} — matched: ${finding.matched}`,
            risk: riskOf(finding.severity),
            contextRefs: [artifact.artifactId],
          }),
        );
      }
    }

    // Said explicitly, because "no findings" and "nothing ran" look identical
    // from the outside, and only one of them means anything (ADR-0023 §4).
    if (messages.length === 0) {
      messages.push(
        emit('FINDING', {
          taskId: assignment.taskId,
          subject: 'no security rule matched',
          detail: `${SECURITY_CHECK_IDS.length} pattern checks ran over ${input.artifacts.length} artifact(s) and none matched. This is not a statement that the change is safe: these checks read artifact text and perform no dataflow analysis, no dependency review, and no inspection of anything outside the change.`,
          risk: 'LOW',
          contextRefs: input.artifacts.map((a) => a.artifactId),
        }),
      );
    }
    return messages;
  }
}

/** Severity to the risk vocabulary a finding carries. INFO and LOW are both LOW. */
export const riskOf = (severity: Severity): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' => {
  if (severity === 'CRITICAL') return 'CRITICAL';
  if (severity === 'HIGH') return 'HIGH';
  if (severity === 'MEDIUM') return 'MEDIUM';
  return 'LOW';
};

// ------------------------------------------------------------------ repair

/**
 * Reads a recorded failure and proposes what to change.
 *
 * Two things bound it. It refuses an attempt past its configured maximum, and
 * it refuses an approach whose signature it has already tried — a repair loop
 * that repeats itself is a loop, not a repair (ADR-0023 §6).
 */
export class RepairAgent extends ConfiguredAgent {
  frame(assignment: TaskAssignmentBody): TaskFraming {
    const input = this.read<typeof RepairInput._output>(RepairInput, assignment, 'REPAIR');
    if (input.attempt > this.config.maxRepairAttempts) {
      throw new AgentError(
        'CAPABILITY_REFUSED',
        `attempt ${input.attempt} is past the bound of ${this.config.maxRepairAttempts}; the change is blocked rather than retried again`,
      );
    }
    const tried = input.history.filter((h) => h.signature === input.failure.signature);
    const priors =
      tried.length === 0
        ? ''
        : `\n\nAlready tried for this failure, and did not fix it:\n${tried.map((h) => `- attempt ${h.attempt}: ${h.approach}`).join('\n')}`;
    const observed = input.failure.raw === null ? '' : `\n\nObserved output:\n${input.failure.raw.slice(0, 8000)}`;
    return {
      purpose: 'DIAGNOSE_FAILURE',
      kind: FACTORY_TASK_KINDS.REPAIR,
      text: `A ${input.failure.source} failure at stage ${input.failure.stage}: ${input.failure.summary}${observed}${priors}`,
      nodeIds: [],
      activeGoalId: assignment.contributesTo[0] ?? null,
      budgetTokens: this.manifest.maxContextTokens,
    };
  }

  protected override extraMessages(assignment: TaskAssignmentBody, services: AgentServices, emit: Emit): readonly Envelope[] {
    const input = this.read<typeof RepairInput._output>(RepairInput, assignment, 'REPAIR');
    const diagnosis = services.run?.produced as { rootCause?: string; approach?: string; targetArtifacts?: string[] } | null | undefined;

    if (diagnosis?.rootCause === undefined) {
      return [
        emit('FINDING', {
          taskId: assignment.taskId,
          subject: 'the failure was not diagnosed',
          detail: `attempt ${input.attempt} of ${input.maxAttempts} produced no reading of the failure, so no targeted repair follows from it`,
          risk: 'HIGH',
          contextRefs: [],
        }),
      ];
    }

    const repeated = input.history.some((h) => h.approach === diagnosis.approach);
    const messages: Envelope[] = [
      emit('FINDING', {
        taskId: assignment.taskId,
        subject: `diagnosis of ${input.failure.signature}`,
        detail: `${diagnosis.rootCause} — approach: ${diagnosis.approach ?? 'none given'}`,
        risk: 'MEDIUM',
        contextRefs: diagnosis.targetArtifacts ?? [],
      }),
    ];
    if (repeated) {
      messages.push(
        emit('FINDING', {
          taskId: assignment.taskId,
          subject: 'the diagnosis repeats an approach that already failed',
          detail: 'the same repair was attempted earlier for this failure and did not resolve it; repeating it would be a loop',
          risk: 'HIGH',
          contextRefs: [],
        }),
      );
    }
    return messages;
  }
}

/** Exported for the conformance test: every severity maps to a risk. */
export const ALL_SEVERITIES: readonly Severity[] = SEVERITIES;
