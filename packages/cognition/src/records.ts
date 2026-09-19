/**
 * Cognitive record and event schemas (SPEC-01 §5–§8, ADR-0014).
 *
 * Every shape here is a zod schema with its type inferred from it, for the
 * reason ADR-0013 gives: the projected state must be plain JSON so a snapshot
 * of it is complete, and a stored state must be checkable on restore rather
 * than cast.
 *
 * The event payload schemas are `.strict()`. An event carrying a field the fold
 * does not know is not quietly accepted — it is an anomaly, because the most
 * likely cause is an event written by a different version of this code.
 */

import {
  AUTHORITY_LEVELS,
  BELIEF_STATES,
  GOAL_STATUSES,
  NODE_TYPES,
  RISK_LEVELS,
  SUCCESS_CHECK_KINDS,
  UNCERTAINTY_RESOLUTIONS,
  UNCERTAINTY_STATUSES,
} from '@genesis/core-types';
import { ObservationLog } from '@genesis/projections';
import { z } from 'zod';

const Id = z.string().min(1);
const Text = z.string().min(1);
const Timestamp = z.string().min(1);

/** A reference into the knowledge graph (SPEC-01 `subjectRefs`, `affectedRefs`). */
export const NodeRef = z.object({ nodeType: z.enum(NODE_TYPES), nodeId: Id }).strict();
export type NodeRef = z.infer<typeof NodeRef>;

/** Who did something, as recorded on a cognitive record. */
export const RecordedBy = z
  .object({
    actorKind: z.enum(['HUMAN', 'AGENT', 'SYSTEM']),
    actorId: Id,
  })
  .strict();
export type RecordedBy = z.infer<typeof RecordedBy>;

/** One status change, kept on the record so its history is readable in place. */
export const Transition = z
  .object({
    seq: z.number().int().positive(),
    from: Text,
    to: Text,
    at: Timestamp,
    by: Id,
    reason: z.string().nullable(),
  })
  .strict();
export type Transition = z.infer<typeof Transition>;

// ======================================================================= goals

export const SuccessCriterion = z
  .object({
    id: Id,
    statement: Text,
    checkKind: z.enum(SUCCESS_CHECK_KINDS),
    /** What performs the check: a test id, an evidence query. Null = not yet known. */
    checkRef: Id.nullable(),
    met: z.boolean(),
    metAt: Timestamp.nullable(),
    metBy: Id.nullable(),
    evidenceRef: Id.nullable(),
  })
  .strict();
export type SuccessCriterion = z.infer<typeof SuccessCriterion>;

export const Goal = z
  .object({
    id: Id,
    description: Text,
    priority: z.number().int().min(0).max(100),
    status: z.enum(GOAL_STATUSES),
    parentId: Id.nullable(),
    successCriteria: z.array(SuccessCriterion),
    createdBy: RecordedBy,
    createdAt: Timestamp,
    closedAt: Timestamp.nullable(),
    history: z.array(Transition),
  })
  .strict();
export type Goal = z.infer<typeof Goal>;

// ===================================================================== beliefs

export const EVIDENCE_KINDS = [
  'OBSERVATION',
  'TEST',
  'EXPERIMENT',
  'DOCUMENT',
  'HUMAN_STATEMENT',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const EVIDENCE_ENVIRONMENTS = ['TARGET', 'SANDBOX', 'NONE'] as const;
export type EvidenceEnvironment = (typeof EVIDENCE_ENVIRONMENTS)[number];

/**
 * What a belief transition needs to know about a piece of evidence.
 *
 * A DESCRIPTOR, not the evidence: that the evidence exists and its raw output
 * hashes correctly is the evidence writer's job (SPEC-05 §4, P5). The belief
 * rules check what the descriptor claims — see ADR-0014, "Evidence integrity".
 */
export const EvidenceRef = z
  .object({
    evidenceId: Id,
    kind: z.enum(EVIDENCE_KINDS),
    /** The run, reasoning call or actor that produced it. */
    producedBy: Id,
    environment: z.enum(EVIDENCE_ENVIRONMENTS),
    /** Whether the check that produced it could have come out the other way. */
    couldFalsify: z.boolean(),
  })
  .strict();
export type EvidenceRef = z.infer<typeof EvidenceRef>;

/**
 * Evidence as held on a belief: the descriptor plus who attached it and when.
 *
 * `addedBy` is what stops laundering. Without it an agent could attach a
 * descriptor claiming "an executed test, could have falsified this", and a
 * SYSTEM transition to TESTED would later count it. The TESTED and VERIFIED
 * rules only count evidence a non-agent attached (ADR-0014 rule 5).
 */
export const HeldEvidence = EvidenceRef.extend({
  addedBy: RecordedBy,
  addedAt: Timestamp,
}).strict();
export type HeldEvidence = z.infer<typeof HeldEvidence>;

export const ContradictingEvidence = HeldEvidence.extend({
  status: z.enum(['OPEN', 'DISMISSED']),
  dismissedReason: z.string().nullable(),
}).strict();
export type ContradictingEvidence = z.infer<typeof ContradictingEvidence>;

/** Why a belief's authority is lower than was asked for (ADR-0011, ADR-0014 rule 5). */
export const AUTHORITY_CLAMPS = ['ACTOR_CEILING', 'AGENT_ASSUMPTION_CAP'] as const;
export type AuthorityClamp = (typeof AUTHORITY_CLAMPS)[number];

export const Belief = z
  .object({
    id: Id,
    statement: Text,
    state: z.enum(BELIEF_STATES),
    authority: z.enum(AUTHORITY_LEVELS),
    authorityRequested: z.enum(AUTHORITY_LEVELS),
    authorityClamp: z.enum(AUTHORITY_CLAMPS).nullable(),
    rationale: z.string().nullable(),
    supportingEvidence: z.array(HeldEvidence),
    contradictingEvidence: z.array(ContradictingEvidence),
    /** Metadata only. Never a gate (SPEC-01 §6). */
    confidence: z.number().min(0).max(1).nullable(),
    subjectRefs: z.array(NodeRef),
    createdBy: RecordedBy,
    /** The reasoning call that produced the belief, when a model did. */
    reasoningCallId: Id.nullable(),
    createdAt: Timestamp,
    lastTransitionAt: Timestamp,
    /** Contradictions in which this belief lost on authority. Never cleared. */
    supersededBy: z.array(Id),
    history: z.array(Transition),
  })
  .strict();
export type Belief = z.infer<typeof Belief>;

// =============================================================== uncertainties

export const UNCERTAINTY_SOURCES = [
  'MANUAL',
  'BELIEF_GAP',
  'CRITERION_GAP',
  'CONTRADICTION',
  'SELF_MODEL_GAP',
] as const;
export type UncertaintySource = (typeof UNCERTAINTY_SOURCES)[number];

export const Uncertainty = z
  .object({
    id: Id,
    statement: Text,
    impact: z
      .object({
        /** SPEC-01 §7: WHAT_BREAKS_IF_WRONG. */
        whatBreaksIfWrong: Text,
        affectedRefs: z.array(NodeRef),
      })
      .strict(),
    risk: z.enum(RISK_LEVELS),
    /**
     * Goals this uncertainty blocks. SPEC-01's `blocking: bool` is derived from
     * this (`isBlocking`) rather than stored beside it, so the two cannot
     * disagree.
     */
    blocksGoalIds: z.array(Id),
    resolution: z.enum(UNCERTAINTY_RESOLUTIONS),
    status: z.enum(UNCERTAINTY_STATUSES),
    relatedBeliefs: z.array(Id),
    relatedQuestions: z.array(Id),
    source: z.enum(UNCERTAINTY_SOURCES),
    /** The record that gave rise to it: a criterion, a belief, a contradiction. */
    sourceRef: Id.nullable(),
    openedBy: RecordedBy,
    openedAt: Timestamp,
    resolvedAt: Timestamp.nullable(),
    resolutionEvidence: z.array(Id),
    history: z.array(Transition),
  })
  .strict();
export type Uncertainty = z.infer<typeof Uncertainty>;

// ============================================================== contradictions

/** SPEC-01 §8: the pairs between which a contradiction can be detected. */
export const CONTRADICTION_KINDS = [
  'REQUIREMENT_IMPLEMENTATION',
  'REQUIREMENT_TEST',
  'DECISION_IMPLEMENTATION',
  'DOCUMENTATION_IMPLEMENTATION',
  'BELIEF_EVIDENCE',
  'GOAL_ACTION',
] as const;
export type ContradictionKind = (typeof CONTRADICTION_KINDS)[number];

export const ContradictionSide = z
  .object({
    ref: z
      .object({
        /** A belief held in this state, or anything else, by id. */
        kind: z.enum(['BELIEF', 'EXTERNAL']),
        id: Id,
      })
      .strict(),
    claim: Text,
    authority: z.enum(AUTHORITY_LEVELS),
    /**
     * STATE: read from a record this projection holds — trustworthy.
     * ACTOR: supplied by whoever recorded the contradiction — trustworthy only
     * from a HUMAN or SYSTEM actor (ADR-0014 rule 5).
     */
    authoritySource: z.enum(['STATE', 'ACTOR']),
  })
  .strict();
export type ContradictionSide = z.infer<typeof ContradictionSide>;

export const CONTRADICTION_DETERMINATIONS = [
  'AUTHORITY',
  'EQUAL_AUTHORITY',
  'INDETERMINATE',
] as const;
export type ContradictionDetermination = (typeof CONTRADICTION_DETERMINATIONS)[number];

export const CONTRADICTION_STATUSES = [
  'RESOLVED_BY_AUTHORITY',
  'ESCALATED',
  'RESOLVED_BY_HUMAN',
] as const;
export type ContradictionStatus = (typeof CONTRADICTION_STATUSES)[number];

export const Contradiction = z
  .object({
    id: Id,
    kind: z.enum(CONTRADICTION_KINDS),
    /** Both sides, always. Nothing is overwritten or dropped (SPEC-01 §8.1 step 1). */
    sides: z.tuple([ContradictionSide, ContradictionSide]),
    determination: z.enum(CONTRADICTION_DETERMINATIONS),
    /** Index into `sides` of the side that governs; null while escalated. */
    governingSide: z.union([z.literal(0), z.literal(1)]).nullable(),
    status: z.enum(CONTRADICTION_STATUSES),
    /** The uncertainty opened when authority could not decide. */
    uncertaintyId: Id.nullable(),
    affectedRefs: z.array(NodeRef),
    detectedBy: RecordedBy,
    detectedAt: Timestamp,
    resolution: z
      .object({ by: Id, at: Timestamp, reason: Text })
      .strict()
      .nullable(),
  })
  .strict();
export type Contradiction = z.infer<typeof Contradiction>;

// ======================================================================= state

export const CognitionState = z
  .object({
    goals: z.record(Goal),
    beliefs: z.record(Belief),
    uncertainties: z.record(Uncertainty),
    contradictions: z.record(Contradiction),
    observations: ObservationLog,
  })
  .strict();
export type CognitionState = z.infer<typeof CognitionState>;

// ====================================================================== events

/**
 * The cognition event vocabulary. Every accepted change is exactly one of these,
 * which is what makes the state rebuildable from the ledger.
 */
export const COGNITION_EVENTS = {
  GOAL_PROPOSED: 'GOAL_PROPOSED',
  GOAL_CRITERION_ADDED: 'GOAL_CRITERION_ADDED',
  GOAL_CRITERION_MET: 'GOAL_CRITERION_MET',
  GOAL_PRIORITY_SET: 'GOAL_PRIORITY_SET',
  GOAL_STATUS_CHANGED: 'GOAL_STATUS_CHANGED',
  BELIEF_RECORDED: 'BELIEF_RECORDED',
  BELIEF_EVIDENCE_ADDED: 'BELIEF_EVIDENCE_ADDED',
  BELIEF_STATE_CHANGED: 'BELIEF_STATE_CHANGED',
  BELIEF_CONTRADICTING_EVIDENCE_DISMISSED: 'BELIEF_CONTRADICTING_EVIDENCE_DISMISSED',
  BELIEF_SUPERSEDED_BY_AUTHORITY: 'BELIEF_SUPERSEDED_BY_AUTHORITY',
  UNCERTAINTY_RECORDED: 'UNCERTAINTY_RECORDED',
  UNCERTAINTY_STATUS_CHANGED: 'UNCERTAINTY_STATUS_CHANGED',
  CONTRADICTION_RECORDED: 'CONTRADICTION_RECORDED',
  CONTRADICTION_RESOLVED: 'CONTRADICTION_RESOLVED',
} as const;
export type CognitionEventType = (typeof COGNITION_EVENTS)[keyof typeof COGNITION_EVENTS];

// A record as first written carries no history: the fold starts it. Each is
// spelled out rather than built by a generic helper, so the inferred payload
// types stay exact.
export const NewGoal = Goal.omit({ history: true }).strict();
export type NewGoal = z.infer<typeof NewGoal>;
export const NewBelief = Belief.omit({ history: true }).strict();
export type NewBelief = z.infer<typeof NewBelief>;
export const NewUncertainty = Uncertainty.omit({ history: true }).strict();
export type NewUncertainty = z.infer<typeof NewUncertainty>;

export const GoalProposedPayload = z.object({ goal: NewGoal }).strict();
export const GoalCriterionAddedPayload = z
  .object({ goalId: Id, criterion: SuccessCriterion })
  .strict();
export const GoalCriterionMetPayload = z
  .object({ goalId: Id, criterionId: Id, evidenceRef: Id.nullable() })
  .strict();
export const GoalPrioritySetPayload = z
  .object({
    goalId: Id,
    from: z.number().int().min(0).max(100),
    to: z.number().int().min(0).max(100),
  })
  .strict();
export const GoalStatusChangedPayload = z
  .object({
    goalId: Id,
    from: z.enum(GOAL_STATUSES),
    to: z.enum(GOAL_STATUSES),
    reason: z.string().nullable(),
  })
  .strict();

export const BeliefRecordedPayload = z.object({ belief: NewBelief }).strict();
export const BeliefEvidenceAddedPayload = z
  .object({
    beliefId: Id,
    polarity: z.enum(['SUPPORTING', 'CONTRADICTING']),
    evidence: EvidenceRef,
  })
  .strict();
export const BeliefStateChangedPayload = z
  .object({
    beliefId: Id,
    from: z.enum(BELIEF_STATES),
    to: z.enum(BELIEF_STATES),
    reason: z.string().nullable(),
  })
  .strict();
export const BeliefContradictingEvidenceDismissedPayload = z
  .object({ beliefId: Id, evidenceId: Id, reason: Text })
  .strict();
export const BeliefSupersededPayload = z
  .object({ beliefId: Id, contradictionId: Id })
  .strict();

export const UncertaintyRecordedPayload = z.object({ uncertainty: NewUncertainty }).strict();
export const UncertaintyStatusChangedPayload = z
  .object({
    uncertaintyId: Id,
    from: z.enum(UNCERTAINTY_STATUSES),
    to: z.enum(UNCERTAINTY_STATUSES),
    reason: z.string().nullable(),
    resolutionEvidence: z.array(Id),
  })
  .strict();

export const ContradictionRecordedPayload = z
  .object({ contradiction: Contradiction })
  .strict();
export const ContradictionResolvedPayload = z
  .object({
    contradictionId: Id,
    governingSide: z.union([z.literal(0), z.literal(1)]),
    reason: Text,
  })
  .strict();
