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
  HUMAN_RESPONSE_KINDS,
  NODE_TYPES,
  QUESTION_AUDIENCES,
  QUESTION_STATUSES,
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

// =================================================================== questions

/** The four factors of SPEC-01 §9.2, each in [0, 1]. */
export const ScoreFactors = z
  .object({
    informationGain: z.number().min(0).max(1),
    decisionImpact: z.number().min(0).max(1),
    riskReduction: z.number().min(0).max(1),
    dependencyCoverage: z.number().min(0).max(1),
  })
  .strict();
export type ScoreFactors = z.infer<typeof ScoreFactors>;

/**
 * A recorded score: the value, the breakdown it is the product of, and which
 * scorer produced it (ADR-0017 rule 1). Recorded, never recomputed on read.
 */
export const QuestionScore = ScoreFactors.extend({
  value: z.number().min(0).max(1),
  scorer: z.object({ name: Text, version: z.number().int().positive() }).strict(),
}).strict();
export type QuestionScore = z.infer<typeof QuestionScore>;

/** A response to a question (ADR-0015 rule 2). Immutable once recorded. */
export const QuestionResponse = z
  .object({
    kind: z.enum(HUMAN_RESPONSE_KINDS),
    text: Text,
    authority: z.enum(AUTHORITY_LEVELS),
    respondedBy: RecordedBy,
    respondedAt: Timestamp,
    /** Ledger position of the response, so later effects can be told from earlier ones. */
    respondedSeq: z.number().int().positive(),
    /** Evidence the responder cited. */
    evidence: z.array(Id),
    /** For a contradiction's question: the side the answer says governs. */
    governingSide: z.union([z.literal(0), z.literal(1)]).nullable(),
    /** Related beliefs the answer was attached to, for and against. */
    supportsBeliefIds: z.array(Id),
    contradictsBeliefIds: z.array(Id),
    /** REJECT_ASSUMPTION: the beliefs downgraded to UNKNOWN. */
    rejectedBeliefIds: z.array(Id),
  })
  .strict();
export type QuestionResponse = z.infer<typeof QuestionResponse>;

/** SPEC-01 §9.2: did the answer change anything? Kept so the scorer can be judged. */
export const QuestionOutcome = z
  .object({
    changedPlan: z.boolean(),
    /** Beliefs that transitioned after the response. Checked against their history. */
    beliefsTransitioned: z.array(Id),
    recordedBy: RecordedBy,
    recordedAt: Timestamp,
  })
  .strict();
export type QuestionOutcome = z.infer<typeof QuestionOutcome>;

/** The question record of SPEC-01 §9.3 and ADR-0015 rule 1. */
export const Question = z
  .object({
    id: Id,
    text: Text,
    /** Why it is worth asking. */
    reason: Text,
    uncertaintyId: Id,
    audience: z.enum(QUESTION_AUDIENCES),
    /** The uncertainty's strategy when the question was drafted. */
    resolutionMethod: z.enum(UNCERTAINTY_RESOLUTIONS),
    affectedGoalIds: z.array(Id),
    affectedRefs: z.array(NodeRef),
    relatedBeliefIds: z.array(Id),
    /** Set when the uncertainty belongs to a contradiction. */
    contradictionId: Id.nullable(),
    /** Evidence relevant to the question, cited when it was drafted. */
    evidenceRefs: z.array(Id),
    /** The latest recorded score: at drafting, then at asking. */
    score: QuestionScore,
    status: z.enum(QUESTION_STATUSES),
    response: QuestionResponse.nullable(),
    outcome: QuestionOutcome.nullable(),
    createdBy: RecordedBy,
    createdAt: Timestamp,
    askedAt: Timestamp.nullable(),
    closedAt: Timestamp.nullable(),
    history: z.array(Transition),
  })
  .strict();
export type Question = z.infer<typeof Question>;

// ======================================================================= state

export const CognitionState = z
  .object({
    goals: z.record(Goal),
    beliefs: z.record(Belief),
    uncertainties: z.record(Uncertainty),
    contradictions: z.record(Contradiction),
    questions: z.record(Question),
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
  QUESTION_DRAFTED: 'QUESTION_DRAFTED',
  QUESTION_ASKED: 'QUESTION_ASKED',
  QUESTION_RESPONDED: 'QUESTION_RESPONDED',
  QUESTION_CLOSED: 'QUESTION_CLOSED',
  QUESTION_OUTCOME_RECORDED: 'QUESTION_OUTCOME_RECORDED',
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
/** A question as drafted: no response, outcome or history yet. */
export const NewQuestion = Question.omit({ history: true }).strict();
export type NewQuestion = z.infer<typeof NewQuestion>;

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

export const QuestionDraftedPayload = z.object({ question: NewQuestion }).strict();
export const QuestionAskedPayload = z.object({ questionId: Id, score: QuestionScore }).strict();
export const QuestionRespondedPayload = z
  .object({
    questionId: Id,
    // Who, when, where in the ledger and with what authority are the event's
    // own fields; the fold reads them from there, so they cannot disagree.
    response: QuestionResponse.omit({
      authority: true,
      respondedBy: true,
      respondedAt: true,
      respondedSeq: true,
    }).strict(),
  })
  .strict();
export const QuestionClosedPayload = z
  .object({
    questionId: Id,
    from: z.enum(QUESTION_STATUSES),
    to: z.enum(['WITHDRAWN', 'UNANSWERABLE']),
    reason: Text,
  })
  .strict();
export const QuestionOutcomeRecordedPayload = z
  .object({ questionId: Id, outcome: QuestionOutcome.omit({ recordedBy: true, recordedAt: true }).strict() })
  .strict();
