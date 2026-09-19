/**
 * The uncertainty engine (SPEC-01 §7, ADR-0014).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). Unknowns are first-class records, not the
 * absence of records. A failure here makes a gap disappear — which is worse
 * than never having recorded it, because the system then believes it checked.
 *
 * Rules:
 *   - RESOLVED, ACCEPTED and OBSOLETE are terminal.
 *   - Resolving needs resolution evidence. An ASK_HUMAN uncertainty is resolved
 *     only by a human: its answer is a human's to give.
 *   - Only a human may ACCEPT one. Acceptance records that a person chose to
 *     live with the gap; it does not pretend the gap closed.
 *   - An uncertainty opened by the contradiction engine belongs to that
 *     contradiction. It is settled by resolving the contradiction, so the two
 *     can never disagree about whether the question is answered.
 *
 * Detection (§7.1) is offered as pure functions that return DRAFTS. They never
 * write: whether a detected gap becomes a record is a decision, and decisions
 * go through the decider like everything else. Sources 1, 3 and 5 are here;
 * source 4 is the contradiction engine itself; source 2 (requirement gaps)
 * needs the knowledge graph and is out of P2 (ADR-0014).
 */

import {
  type GenesisEvent,
  NODE_TYPES,
  RISK_LEVELS,
  type RiskLevel,
  UNCERTAINTY_RESOLUTIONS,
  type UncertaintyResolution,
  type UncertaintyStatus,
} from '@genesis/core-types';
import type { SelfModelState } from '@genesis/projections';
import { z } from 'zod';
import {
  anomaly,
  cognitiveEvent,
  type CognitiveEventInput,
  type DecisionContext,
  recordedBy,
  requireReason,
  sortById,
  transitionOf,
  violation,
  withPayload,
} from './context.js';
import { isTerminalGoal } from './goals.js';
import {
  COGNITION_EVENTS,
  type CognitionState,
  type NewUncertainty,
  type NodeRef,
  type Uncertainty,
  UNCERTAINTY_SOURCES,
  UncertaintyRecordedPayload,
  type UncertaintySource,
  UncertaintyStatusChangedPayload,
} from './records.js';

// ================================================================== commands

const Text = z.string().trim().min(1);
const Ref = z.object({ nodeType: z.enum(NODE_TYPES), nodeId: Text }).strict();

export const RecordUncertaintyCommand = z
  .object({
    kind: z.literal('RECORD_UNCERTAINTY'),
    statement: Text,
    whatBreaksIfWrong: Text,
    affectedRefs: z.array(Ref).optional(),
    risk: z.enum(RISK_LEVELS),
    blocksGoalIds: z.array(Text).optional(),
    resolution: z.enum(UNCERTAINTY_RESOLUTIONS),
    relatedBeliefs: z.array(Text).optional(),
    relatedQuestions: z.array(Text).optional(),
    source: z.enum(UNCERTAINTY_SOURCES).optional(),
    sourceRef: Text.optional(),
  })
  .strict();
export type RecordUncertaintyCommand = z.infer<typeof RecordUncertaintyCommand>;

export const UncertaintyCommand = z.discriminatedUnion('kind', [
  RecordUncertaintyCommand,
  z.object({ kind: z.literal('START_RESOLVING'), uncertaintyId: Text }).strict(),
  z
    .object({
      kind: z.literal('RESOLVE_UNCERTAINTY'),
      uncertaintyId: Text,
      evidence: z.array(Text),
      reason: z.string().optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal('ACCEPT_UNCERTAINTY'), uncertaintyId: Text, reason: z.string().optional() })
    .strict(),
  z
    .object({
      kind: z.literal('MARK_UNCERTAINTY_OBSOLETE'),
      uncertaintyId: Text,
      reason: z.string().optional(),
    })
    .strict(),
]);
export type UncertaintyCommand = z.infer<typeof UncertaintyCommand>;

// ================================================================= selectors

const TERMINAL: ReadonlySet<UncertaintyStatus> = new Set<UncertaintyStatus>([
  'RESOLVED',
  'ACCEPTED',
  'OBSOLETE',
]);

export const isTerminalUncertainty = (status: UncertaintyStatus): boolean => TERMINAL.has(status);

/** SPEC-01's `blocking: bool`, derived so it cannot disagree with the goal list. */
export const isBlocking = (u: Uncertainty): boolean =>
  !isTerminalUncertainty(u.status) && u.blocksGoalIds.length > 0;

export const openUncertainties = (state: CognitionState): Uncertainty[] =>
  sortById(Object.values(state.uncertainties).filter((u) => !isTerminalUncertainty(u.status)));

const riskRank = (risk: RiskLevel): number => RISK_LEVELS.indexOf(risk);

/**
 * Open uncertainties, highest risk first, then oldest, then by id — a total
 * order, so two runs over one state always list them identically. The id
 * tiebreak comes from sorting by id first: `Array.prototype.sort` is stable, so
 * entries the comparator calls equal keep that order.
 */
export const uncertaintiesByRisk = (state: CognitionState): Uncertainty[] =>
  openUncertainties(state).sort(
    (a, b) => riskRank(b.risk) - riskRank(a.risk) || Date.parse(a.openedAt) - Date.parse(b.openedAt),
  );

/**
 * Strategy selection (SPEC-01 §7.2): the cheapest strategy that can actually
 * settle it, SEARCH → EXPERIMENT → ASK_HUMAN. A human can always decide, so
 * ASK_HUMAN is the fallback — chosen when the others CANNOT settle it, not when
 * they are merely inconvenient. Which strategies can settle a question is an
 * input: judging that is not this function's job, and guessing it would be.
 */
export function selectResolution(canSettle: {
  readonly bySearch: boolean;
  readonly byExperiment: boolean;
}): UncertaintyResolution {
  if (canSettle.bySearch) return 'SEARCH';
  if (canSettle.byExperiment) return 'EXPERIMENT';
  return 'ASK_HUMAN';
}

// ================================================================== detection

/** A detected gap, not yet a record. Turn it into one with `draftToCommand`. */
export interface UncertaintyDraft {
  readonly statement: string;
  readonly whatBreaksIfWrong: string;
  readonly risk: RiskLevel;
  readonly resolution: UncertaintyResolution;
  readonly source: Exclude<UncertaintySource, 'MANUAL' | 'CONTRADICTION'>;
  readonly sourceRef: string;
  readonly relatedBeliefs: readonly string[];
}

/** True when an open uncertainty already covers this source and ref. */
const covered = (state: CognitionState, source: UncertaintySource, sourceRef: string): boolean =>
  openUncertainties(state).some((u) => u.source === source && u.sourceRef === sourceRef);

/**
 * Source 1: beliefs a plan depends on that are still UNKNOWN or ASSUMED.
 *
 * The dependency set is an input because plans do not exist yet (P3+). An id
 * that is not a belief is refused rather than skipped: a plan depending on a
 * belief nobody recorded is itself the bug.
 */
export function detectBeliefGaps(
  state: CognitionState,
  dependedOn: readonly string[],
): UncertaintyDraft[] {
  const drafts: UncertaintyDraft[] = [];
  for (const id of [...new Set(dependedOn)].sort()) {
    const belief = state.beliefs[id];
    if (belief === undefined) return violation('BELIEF_NOT_FOUND', `no belief ${id}`, { beliefId: id });
    if (belief.state !== 'UNKNOWN' && belief.state !== 'ASSUMED') continue;
    if (covered(state, 'BELIEF_GAP', id)) continue;
    drafts.push({
      statement: `Is it true that: ${belief.statement}`,
      whatBreaksIfWrong: `A plan depends on belief ${id}, which is only ${belief.state}`,
      risk: belief.state === 'UNKNOWN' ? 'HIGH' : 'MEDIUM',
      resolution: 'SEARCH',
      source: 'BELIEF_GAP',
      sourceRef: id,
      relatedBeliefs: [id],
    });
  }
  return drafts;
}

/** Source 3: criteria of ACTIVE goals that are meant to be machine-checked but name no check. */
export function detectCriterionGaps(state: CognitionState): UncertaintyDraft[] {
  const drafts: UncertaintyDraft[] = [];
  const active = sortById(Object.values(state.goals).filter((g) => g.status === 'ACTIVE'));
  for (const goal of active) {
    for (const criterion of goal.successCriteria) {
      if (criterion.met || criterion.checkKind === 'HUMAN_CONFIRMATION' || criterion.checkRef !== null) continue;
      if (covered(state, 'CRITERION_GAP', criterion.id)) continue;
      drafts.push({
        statement: `How is "${criterion.statement}" checked for goal ${goal.id}?`,
        whatBreaksIfWrong: `Goal ${goal.id} cannot be shown to be satisfied`,
        risk: 'MEDIUM',
        resolution: 'SEARCH',
        source: 'CRITERION_GAP',
        sourceRef: criterion.id,
        relatedBeliefs: [],
      });
    }
  }
  return drafts;
}

/**
 * Source 5: capabilities a task requires that the self model has as
 * UNAVAILABLE, or has never observed at all. Whether a capability works is an
 * empirical property, so the strategy is EXPERIMENT.
 */
export function detectCapabilityGaps(
  state: CognitionState,
  selfModel: SelfModelState,
  required: readonly string[],
): UncertaintyDraft[] {
  const drafts: UncertaintyDraft[] = [];
  for (const id of [...new Set(required)].sort()) {
    const capability = selfModel.capabilities[id];
    if (capability !== undefined && capability.status !== 'UNAVAILABLE') continue;
    if (covered(state, 'SELF_MODEL_GAP', id)) continue;
    drafts.push({
      statement: `Can the system do "${id}"?`,
      whatBreaksIfWrong: `The task requires capability ${id}, which is ${capability === undefined ? 'unobserved' : 'UNAVAILABLE'}`,
      risk: 'HIGH',
      resolution: 'EXPERIMENT',
      source: 'SELF_MODEL_GAP',
      sourceRef: id,
      relatedBeliefs: [],
    });
  }
  return drafts;
}

export function draftToCommand(draft: UncertaintyDraft): RecordUncertaintyCommand {
  return {
    kind: 'RECORD_UNCERTAINTY',
    statement: draft.statement,
    whatBreaksIfWrong: draft.whatBreaksIfWrong,
    risk: draft.risk,
    resolution: draft.resolution,
    source: draft.source,
    sourceRef: draft.sourceRef,
    relatedBeliefs: [...draft.relatedBeliefs],
  };
}

// ================================================================== decisions

function requireUncertainty(state: CognitionState, id: string): Uncertainty {
  const found = state.uncertainties[id];
  if (found === undefined) return violation('UNCERTAINTY_NOT_FOUND', `no uncertainty ${id}`, { uncertaintyId: id });
  return found;
}

function requireOpenUncertainty(u: Uncertainty, action: string): void {
  if (isTerminalUncertainty(u.status)) {
    violation('UNCERTAINTY_CLOSED', `cannot ${action}: uncertainty ${u.id} is ${u.status}`);
  }
}

function refuseContradictionOwned(u: Uncertainty, action: string): void {
  if (u.source === 'CONTRADICTION') {
    violation(
      'CONTRADICTION_OWNED',
      `cannot ${action} uncertainty ${u.id} directly; resolve the contradiction it belongs to`,
      { uncertaintyId: u.id, contradictionId: u.sourceRef },
    );
  }
}

function statusChange(
  ctx: DecisionContext,
  u: Uncertainty,
  to: UncertaintyStatus,
  reason: string | null,
  resolutionEvidence: readonly string[] = [],
): CognitiveEventInput {
  return cognitiveEvent(ctx, COGNITION_EVENTS.UNCERTAINTY_STATUS_CHANGED, {
    uncertaintyId: u.id,
    from: u.status,
    to,
    reason,
    resolutionEvidence: [...resolutionEvidence],
  });
}

/**
 * Builds a new uncertainty record. Shared with the contradiction engine, which
 * opens one in the same decision as the contradiction it belongs to.
 */
export function newUncertainty(
  state: CognitionState,
  ctx: DecisionContext,
  input: {
    readonly statement: string;
    readonly whatBreaksIfWrong: string;
    readonly affectedRefs: readonly NodeRef[];
    readonly risk: RiskLevel;
    readonly blocksGoalIds: readonly string[];
    readonly resolution: UncertaintyResolution;
    readonly relatedBeliefs: readonly string[];
    readonly relatedQuestions: readonly string[];
    readonly source: UncertaintySource;
    readonly sourceRef: string | null;
  },
): NewUncertainty {
  for (const goalId of input.blocksGoalIds) {
    const goal = state.goals[goalId];
    if (goal === undefined) violation('GOAL_NOT_FOUND', `no goal ${goalId}`, { goalId });
    if (isTerminalGoal(goal.status)) {
      violation('GOAL_CLOSED', `cannot block goal ${goalId}: it is ${goal.status}`, { goalId });
    }
  }
  for (const beliefId of input.relatedBeliefs) {
    if (state.beliefs[beliefId] === undefined) {
      violation('BELIEF_NOT_FOUND', `no belief ${beliefId}`, { beliefId });
    }
  }
  return {
    id: ctx.ids.uncertainty(),
    statement: input.statement,
    impact: { whatBreaksIfWrong: input.whatBreaksIfWrong, affectedRefs: [...input.affectedRefs] },
    risk: input.risk,
    blocksGoalIds: [...new Set(input.blocksGoalIds)].sort(),
    resolution: input.resolution,
    status: 'OPEN',
    relatedBeliefs: [...new Set(input.relatedBeliefs)].sort(),
    relatedQuestions: [...new Set(input.relatedQuestions)].sort(),
    source: input.source,
    sourceRef: input.sourceRef,
    openedBy: recordedBy(ctx),
    openedAt: ctx.now,
    resolvedAt: null,
    resolutionEvidence: [],
  };
}

export function decideUncertainty(
  state: CognitionState,
  command: UncertaintyCommand,
  ctx: DecisionContext,
): CognitiveEventInput[] {
  switch (command.kind) {
    case 'RECORD_UNCERTAINTY': {
      const source = command.source ?? 'MANUAL';
      const sourceRef = command.sourceRef ?? null;
      if (source === 'CONTRADICTION') {
        violation('RESERVED_SOURCE', 'contradiction uncertainties are opened by the contradiction engine only');
      }
      if (source !== 'MANUAL') {
        if (sourceRef === null) {
          violation('SOURCE_REF_REQUIRED', `an uncertainty from ${source} must name the record it came from`);
        }
        if (covered(state, source, sourceRef)) {
          violation('DUPLICATE_UNCERTAINTY', `an open uncertainty already covers ${source} ${sourceRef}`);
        }
      }
      const uncertainty = newUncertainty(state, ctx, {
        statement: command.statement,
        whatBreaksIfWrong: command.whatBreaksIfWrong,
        affectedRefs: command.affectedRefs ?? [],
        risk: command.risk,
        blocksGoalIds: command.blocksGoalIds ?? [],
        resolution: command.resolution,
        relatedBeliefs: command.relatedBeliefs ?? [],
        relatedQuestions: command.relatedQuestions ?? [],
        source,
        sourceRef,
      });
      return [cognitiveEvent(ctx, COGNITION_EVENTS.UNCERTAINTY_RECORDED, { uncertainty })];
    }

    case 'START_RESOLVING': {
      const u = requireUncertainty(state, command.uncertaintyId);
      if (u.status !== 'OPEN') {
        violation('UNCERTAINTY_NOT_OPEN', `only an OPEN uncertainty can be started; ${u.id} is ${u.status}`);
      }
      return [statusChange(ctx, u, 'IN_PROGRESS', null)];
    }

    case 'RESOLVE_UNCERTAINTY': {
      const u = requireUncertainty(state, command.uncertaintyId);
      requireOpenUncertainty(u, 'resolve it');
      refuseContradictionOwned(u, 'resolve');
      if (command.evidence.length === 0) {
        violation('RESOLUTION_EVIDENCE_REQUIRED', `resolving ${u.id} requires resolution evidence`);
      }
      if (u.resolution === 'ASK_HUMAN' && ctx.actor.kind !== 'HUMAN') {
        violation('HUMAN_ANSWER_REQUIRED', `uncertainty ${u.id} is answered by a human`);
      }
      return [
        statusChange(ctx, u, 'RESOLVED', command.reason?.trim() || null, [...new Set(command.evidence)].sort()),
      ];
    }

    case 'ACCEPT_UNCERTAINTY': {
      const u = requireUncertainty(state, command.uncertaintyId);
      requireOpenUncertainty(u, 'accept it');
      if (ctx.actor.kind !== 'HUMAN') {
        violation('HUMAN_ONLY', 'only a human can accept an uncertainty');
      }
      const reason = requireReason(command.reason, 'REASON_REQUIRED', 'accepting an uncertainty');
      return [statusChange(ctx, u, 'ACCEPTED', reason)];
    }

    case 'MARK_UNCERTAINTY_OBSOLETE': {
      const u = requireUncertainty(state, command.uncertaintyId);
      requireOpenUncertainty(u, 'mark it obsolete');
      refuseContradictionOwned(u, 'obsolete');
      const reason = requireReason(command.reason, 'REASON_REQUIRED', 'marking an uncertainty obsolete');
      return [statusChange(ctx, u, 'OBSOLETE', reason)];
    }
  }
}

// ======================================================================= fold

const putUncertainty = (state: CognitionState, u: Uncertainty): CognitionState => ({
  ...state,
  uncertainties: { ...state.uncertainties, [u.id]: u },
});

export const uncertaintyFold: Record<string, (s: CognitionState, e: GenesisEvent) => CognitionState> = {
  [COGNITION_EVENTS.UNCERTAINTY_RECORDED]: (state, event) =>
    withPayload(state, event, UncertaintyRecordedPayload, ({ uncertainty }) => {
      if (state.uncertainties[uncertainty.id] !== undefined) {
        return anomaly(state, event, 'STATE_MISMATCH', `uncertainty ${uncertainty.id} already exists`);
      }
      if (uncertainty.status !== 'OPEN') {
        return anomaly(state, event, 'STATE_MISMATCH', `an uncertainty is born OPEN, not ${uncertainty.status}`);
      }
      const missing = [
        ...uncertainty.blocksGoalIds.filter((id) => state.goals[id] === undefined),
        ...uncertainty.relatedBeliefs.filter((id) => state.beliefs[id] === undefined),
      ];
      if (missing.length > 0) {
        return anomaly(state, event, 'UNKNOWN_REFERENCE', `unknown records: ${missing.join(', ')}`);
      }
      return putUncertainty(state, { ...uncertainty, history: [] });
    }),

  [COGNITION_EVENTS.UNCERTAINTY_STATUS_CHANGED]: (state, event) =>
    withPayload(state, event, UncertaintyStatusChangedPayload, (p) => {
      const u = state.uncertainties[p.uncertaintyId];
      if (u === undefined) {
        return anomaly(state, event, 'UNKNOWN_REFERENCE', `no uncertainty ${p.uncertaintyId}`);
      }
      if (u.status !== p.from) {
        return anomaly(state, event, 'STATE_MISMATCH', `uncertainty ${u.id} is ${u.status}, not ${p.from}`);
      }
      if (isTerminalUncertainty(p.from)) {
        return anomaly(state, event, 'STATE_MISMATCH', `uncertainty ${u.id} is ${p.from}, which is terminal`);
      }
      return putUncertainty(state, {
        ...u,
        status: p.to,
        resolvedAt: isTerminalUncertainty(p.to) ? event.timestamp : u.resolvedAt,
        resolutionEvidence: [...u.resolutionEvidence, ...p.resolutionEvidence],
        history: [...u.history, transitionOf(event, p.from, p.to, p.reason)],
      });
    }),
};
