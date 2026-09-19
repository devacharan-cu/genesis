/**
 * The P6 roles (SPEC-04 §2).
 *
 * Each is a small difference from `BaseAgent`, which is the point: duplicating
 * the shared reading of a run per role would give nine places for the same bug.
 * A role supplies what to ask for, and occasionally a message of its own.
 *
 * The Verifier is the interesting one. It frames no run, because it needs no
 * model: it reads the evidence it was given and says whether that evidence is
 * *adequate*. What state the evidence justifies is the core's verification
 * engine's answer, not its own (ADR-0020 §8) — so the Verifier raises findings
 * and never proposes a state.
 */

import type { AgentRole } from '@genesis/core-types';
import { type AgentManifest, type Envelope, type TaskAssignmentBody, type TaskFraming } from '@genesis/protocol';
import { BaseAgent, type Emit } from './base.js';
import type { AgentServices } from './contract.js';

/** The task kinds each role answers to. A router matches on these. */
export const ROLE_TASK_KINDS = {
  PLANNER: 'DECOMPOSE_GOAL',
  ARCHITECT: 'PROPOSE_STRUCTURE',
  RESEARCHER: 'RESOLVE_UNCERTAINTY',
  VERIFIER: 'ASSESS_EVIDENCE',
} as const satisfies Partial<Record<AgentRole, string>>;

/** The budget a framing asks for: the agent's declared ceiling, never more. */
const budget = (manifest: AgentManifest): number => manifest.maxContextTokens;

/**
 * The goal a run serves. Shared rather than repeated per role: three copies of
 * `contributesTo[0] ?? null` is three places for the empty case to be wrong.
 */
const activeGoalOf = (assignment: TaskAssignmentBody): string | null => assignment.contributesTo[0] ?? null;

/**
 * Decomposes an active goal into an ordered plan.
 *
 * It frames the instruction it was given rather than composing its own, because
 * the assignment's instruction came from the core and the context came from the
 * core. A Planner that rewrote its own task would be choosing its own work.
 */
export class PlannerAgent extends BaseAgent {
  frame(assignment: TaskAssignmentBody): TaskFraming {
    return {
      kind: ROLE_TASK_KINDS.PLANNER,
      text: assignment.instruction,
      nodeIds: [],
      activeGoalId: activeGoalOf(assignment),
      budgetTokens: budget(this.manifest),
    };
  }
}

/** Proposes structural decisions and component boundaries. */
export class ArchitectAgent extends BaseAgent {
  frame(assignment: TaskAssignmentBody): TaskFraming {
    return {
      kind: ROLE_TASK_KINDS.ARCHITECT,
      text: assignment.instruction,
      nodeIds: [],
      activeGoalId: activeGoalOf(assignment),
      budgetTokens: budget(this.manifest),
    };
  }
}

/**
 * Resolves `SEARCH`-strategy uncertainties from what the project already knows.
 *
 * When the run was shown nothing, the Researcher says so as a finding rather
 * than reasoning from an empty context and reporting a conclusion. That is the
 * difference between "I found nothing" and "there is nothing".
 */
export class ResearcherAgent extends BaseAgent {
  frame(assignment: TaskAssignmentBody): TaskFraming {
    return {
      kind: ROLE_TASK_KINDS.RESEARCHER,
      text: assignment.instruction,
      nodeIds: [],
      activeGoalId: activeGoalOf(assignment),
      budgetTokens: budget(this.manifest),
    };
  }

  protected override extraMessages(
    assignment: TaskAssignmentBody,
    services: AgentServices,
    emit: Emit,
  ): readonly Envelope[] {
    const shown = services.run?.context.shown ?? [];
    if (shown.length > 0) return [];
    return [
      emit('FINDING', {
        taskId: assignment.taskId,
        subject: 'the search had nothing to search',
        detail:
          'context assembly returned no items for this task, so an absence of findings here is an absence of evidence, not evidence of absence',
        risk: 'MEDIUM',
        contextRefs: [],
      }),
    ];
  }
}

/**
 * How adequate a piece of evidence is, and why. Deterministic.
 *
 * A union rather than a flag and a nullable string, so an inadequate
 * assessment cannot exist without saying what is wrong with it. That removes
 * the "no concern recorded" case rather than handling it.
 */
export type EvidenceAssessment =
  | { readonly artifactId: string; readonly adequate: true; readonly note: string | null }
  | { readonly artifactId: string; readonly adequate: false; readonly concern: string };

/**
 * The checks the Verifier applies, in order. Each names the failure mode it
 * exists for; SPEC-04 §2 lists them as the Verifier's mandate.
 */
export function assessEvidence(evidence: {
  readonly exitCode: number;
  readonly raw: string;
  readonly testKind?: string | undefined;
  readonly claimedArtifacts: readonly string[];
  readonly environment: string;
}): readonly EvidenceAssessment[] {
  return evidence.claimedArtifacts.map((artifactId) => {
    if (evidence.exitCode !== 0) {
      return { artifactId, adequate: false, concern: `the run exited ${evidence.exitCode}; a failing run proves nothing passed` };
    }
    if (evidence.raw.trim().length === 0) {
      return { artifactId, adequate: false, concern: 'the run produced no output, so nothing attributes it to this artifact' };
    }
    if (!evidence.raw.includes(artifactId)) {
      return {
        artifactId,
        adequate: false,
        concern: `the output never mentions ${artifactId}, so the claim that it was covered is unattributed`,
      };
    }
    if (evidence.testKind === undefined) {
      return { artifactId, adequate: true, note: 'a static check, which says the artifact holds together and no more' };
    }
    if (evidence.environment === 'LOCAL' && evidence.testKind === 'E2E') {
      return {
        artifactId,
        adequate: false,
        concern: 'an end-to-end result from a local environment does not describe the deployed system',
      };
    }
    return { artifactId, adequate: true, note: null };
  });
}

/**
 * Judges whether submitted evidence is adequate. Deterministic: no model, no
 * provider, no framing.
 *
 * It never says what state the evidence justifies. That question belongs to the
 * verification engine, and an agent answering it would be an agent making
 * something verified.
 */
export class VerifierAgent extends BaseAgent {
  constructor(
    manifest: AgentManifest,
    /** The evidence to judge, handed to the agent by the runtime with its task. */
    private readonly evidence: Parameters<typeof assessEvidence>[0] | null = null,
  ) {
    super(manifest);
  }

  frame(): TaskFraming | null {
    return null;
  }

  protected override extraMessages(
    assignment: TaskAssignmentBody,
    _services: AgentServices,
    emit: Emit,
  ): readonly Envelope[] {
    if (this.evidence === null) {
      return [
        emit('FINDING', {
          taskId: assignment.taskId,
          subject: 'nothing to verify',
          detail: 'the assignment carried no evidence, so no judgement about adequacy is possible',
          risk: 'MEDIUM',
          contextRefs: [],
        }),
      ];
    }
    const inadequate = assessEvidence(this.evidence).filter(
      (assessment): assessment is Extract<EvidenceAssessment, { adequate: false }> => !assessment.adequate,
    );
    return inadequate.map((assessment) =>
      emit('FINDING', {
        taskId: assignment.taskId,
        subject: `the evidence for ${assessment.artifactId} is not adequate`,
        detail: assessment.concern,
        risk: 'HIGH',
        contextRefs: [],
      }),
    );
  }
}
