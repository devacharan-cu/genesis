/**
 * The question engine (SPEC-01 §9, ADR-0015, ADR-0017).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). A question is how the system finds out what it
 * does not know, and a response is how a person's decision enters the state. A
 * failure here either loses an answer — the system goes on assuming what a
 * person already refuted — or lets something other than that person answer for
 * them.
 *
 * Lifecycle:
 *
 *     DRAFT ──ask──▶ ASKED ──respond──▶ ANSWERED
 *       │              │
 *       └─withdraw─────┴──▶ WITHDRAWN          ASKED ──▶ UNANSWERABLE
 *
 * ANSWERED, WITHDRAWN and UNANSWERABLE are terminal. Nothing reopens a question.
 *
 * Rules:
 *   - A question settles one open uncertainty. An ASK_HUMAN uncertainty is only
 *     ever put to a HUMAN audience.
 *   - One open question per uncertainty and audience; a question whose text a
 *     human has already answered with HUMAN_DECISION authority is not drafted
 *     again (§9.4).
 *   - Agents may draft. Only the system or a human asks, withdraws or records an
 *     outcome, and nothing but a human responds to a HUMAN question, rejects an
 *     assumption or accepts a risk (ADR-0015 rule 4).
 *   - A system answer to a SELF or EXTERNAL question must cite evidence.
 *   - A response is recorded, and its effects on the uncertainty, beliefs and
 *     contradiction are decided by THEIR deciders, in the same append
 *     (ADR-0015 rule 2). This module never re-implements an uncertainty, belief
 *     or contradiction rule; it composes them.
 */

import {
  type Authority,
  type BeliefState,
  type EventActor,
  type GenesisEvent,
  HUMAN_RESPONSE_KINDS,
  type HumanResponseKind,
  QUESTION_AUDIENCES,
  type QuestionAudience,
  type QuestionStatus,
} from '@genesis/core-types';
import { z } from 'zod';
import { decideBelief, hasEvidence } from './beliefs.js';
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
import { decideContradiction } from './contradictions.js';
import {
  type Belief,
  COGNITION_EVENTS,
  type CognitionState,
  type Contradiction,
  type Goal,
  type NewQuestion,
  type Question,
  QuestionAskedPayload,
  QuestionClosedPayload,
  QuestionDraftedPayload,
  QuestionOutcomeRecordedPayload,
  QuestionRespondedPayload,
  type QuestionScore,
  type Uncertainty,
} from './records.js';
import { type QuestionScorer, scoreQuestion } from './scoring.js';
import { decideUncertainty, isTerminalUncertainty } from './uncertainties.js';

// ================================================================== commands

const Text = z.string().trim().min(1);
const Ids = z.array(Text);

/** The body of a response, one shape per kind, so a field that means nothing for a kind cannot be sent. */
export const ResponseInput = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('ANSWER'),
      text: Text,
      /** Evidence the answer rests on. Required from the system; optional from a human. */
      evidence: Ids.optional(),
      /** For a contradiction's question: which side governs. Required there, refused elsewhere. */
      governingSide: z.union([z.literal(0), z.literal(1)]).optional(),
      /** Related beliefs the answer supports or contradicts, attached as evidence. */
      supportsBeliefIds: Ids.optional(),
      contradictsBeliefIds: Ids.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('REJECT_ASSUMPTION'), text: Text, beliefIds: Ids }).strict(),
  z.object({ kind: z.literal('ACCEPT_RISK'), text: Text }).strict(),
]);
export type ResponseInput = z.infer<typeof ResponseInput>;

export const QuestionCommand = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('DRAFT_QUESTION'),
      uncertaintyId: Text,
      text: Text,
      /** Why it is worth asking. Defaults to what breaks if the uncertainty is wrong. */
      reason: Text.optional(),
      /** Defaults to HUMAN for an ASK_HUMAN uncertainty and SELF otherwise. */
      audience: z.enum(QUESTION_AUDIENCES).optional(),
      evidenceRefs: Ids.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('ASK_QUESTIONS'), questionIds: Ids.min(1) }).strict(),
  z
    .object({ kind: z.literal('RESPOND_TO_QUESTION'), questionId: Text, response: ResponseInput })
    .strict(),
  z.object({ kind: z.literal('WITHDRAW_QUESTION'), questionId: Text, reason: z.string().optional() }).strict(),
  z
    .object({ kind: z.literal('MARK_QUESTION_UNANSWERABLE'), questionId: Text, reason: z.string().optional() })
    .strict(),
  z
    .object({
      kind: z.literal('RECORD_QUESTION_OUTCOME'),
      questionId: Text,
      changedPlan: z.boolean(),
      beliefsTransitioned: Ids.optional(),
    })
    .strict(),
]);
export type QuestionCommand = z.infer<typeof QuestionCommand>;

// ================================================================= selectors

const TERMINAL: ReadonlySet<QuestionStatus> = new Set<QuestionStatus>(['ANSWERED', 'WITHDRAWN', 'UNANSWERABLE']);

export const isTerminalQuestion = (status: QuestionStatus): boolean => TERMINAL.has(status);

/**
 * The text two questions are compared by: case, surrounding space, runs of
 * space and trailing question marks do not make a different question.
 */
export const normalizeQuestionText = (text: string): string =>
  text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\?+$/, '').trim();

/**
 * The question's uncertainty. The fold admits a question only with a known
 * uncertainty, and uncertainties are never removed, so the lookup succeeds for
 * every question in a state.
 */
const uncertaintyOf = (state: CognitionState, question: Question): Uncertainty =>
  state.uncertainties[question.uncertaintyId] as Uncertainty;

/** A question a human already answered, with a decision's authority, in these words. */
function answeredByHuman(state: CognitionState, text: string): Question | undefined {
  const key = normalizeQuestionText(text);
  return sortById(Object.values(state.questions)).find(
    (q) => q.response?.authority === 'HUMAN_DECISION' && normalizeQuestionText(q.text) === key,
  );
}

export const questionsFor = (state: CognitionState, uncertaintyId: string): Question[] =>
  sortById(Object.values(state.questions).filter((q) => q.uncertaintyId === uncertaintyId));

/** Highest value first, then highest risk, then oldest, then id: a total order. */
const byScore = (a: { question: Question; score: QuestionScore }, b: { question: Question; score: QuestionScore }) =>
  b.score.value - a.score.value ||
  b.score.riskReduction - a.score.riskReduction ||
  Date.parse(a.question.createdAt) - Date.parse(b.question.createdAt);

export interface BatchOptions {
  /** Only questions to this audience. Default: every audience. */
  readonly audience?: QuestionAudience;
  /** At most this many. Default: no limit. */
  readonly limit?: number;
  readonly scorer?: QuestionScorer;
}

export interface ScoredQuestion {
  readonly question: Question;
  /** The live score, against this state. Recorded on the question when it is asked. */
  readonly score: QuestionScore;
}

/**
 * The next batch of questions to ask (SPEC-01 §9.4): drafts whose uncertainty
 * is still open and whose text no human has already decided, re-scored against
 * this state, one per uncertainty, best first. Pure; asking is a command.
 */
export function nextQuestionBatch(state: CognitionState, options: BatchOptions = {}): ScoredQuestion[] {
  if (options.limit !== undefined && !(Number.isInteger(options.limit) && options.limit >= 0)) {
    violation('INVALID_LIMIT', `a batch limit is a whole number of questions, not ${options.limit}`);
  }
  const scored = sortById(Object.values(state.questions))
    .filter((q) => q.status === 'DRAFT' && (options.audience === undefined || q.audience === options.audience))
    .map((question) => ({ question, uncertainty: uncertaintyOf(state, question) }))
    .filter(({ question, uncertainty }) => !isTerminalUncertainty(uncertainty.status) && answeredByHuman(state, question.text) === undefined)
    .map(({ question, uncertainty }) => ({ question, score: scoreQuestion(state, uncertainty, options.scorer) }))
    .sort(byScore);

  const seen = new Set<string>();
  const batch = scored.filter(({ question }) => {
    if (seen.has(question.uncertaintyId)) return false;
    seen.add(question.uncertaintyId);
    return true;
  });
  return batch.slice(0, options.limit ?? batch.length);
}

/** Questions waiting on a person, in the order a person should see them (ADR-0015 rule 3). */
export function pendingHumanQuestions(state: CognitionState): Question[] {
  return sortById(Object.values(state.questions))
    .filter(
      (q) => q.status === 'ASKED' && q.audience === 'HUMAN' && !isTerminalUncertainty(uncertaintyOf(state, q).status),
    )
    .map((question) => ({ question, score: question.score }))
    .sort(byScore)
    .map(({ question }) => question);
}

/** A belief as the interface shows it beside a question. */
export interface BeliefSummary {
  readonly id: string;
  readonly statement: string;
  readonly state: BeliefState;
  readonly authority: Authority;
  readonly evidence: readonly string[];
}

/** Everything a person needs to respond to a question, and which responses are open to them. */
export interface QuestionView {
  readonly question: Question;
  readonly uncertainty: Uncertainty;
  readonly goals: readonly Pick<Goal, 'id' | 'description' | 'status' | 'priority'>[];
  readonly beliefs: readonly BeliefSummary[];
  readonly contradiction: Contradiction | null;
  /** What a HUMAN may send now. Empty when the question is not open to a response. */
  readonly allowedResponses: readonly HumanResponseKind[];
  /** An ANSWER must name the governing side (the question is a contradiction's). */
  readonly requiresGoverningSide: boolean;
}

const summarise = (b: Belief): BeliefSummary => ({
  id: b.id,
  statement: b.statement,
  state: b.state,
  authority: b.authority,
  evidence: [...b.supportingEvidence, ...b.contradictingEvidence].map((e) => e.evidenceId).sort(),
});

/** The response kinds a human may send to this question in this state. */
function allowedResponses(state: CognitionState, q: Question, u: Uncertainty): HumanResponseKind[] {
  if (q.status !== 'ASKED' || isTerminalUncertainty(u.status)) return [];
  const related = new Set(q.relatedBeliefIds);
  const rejectable =
    u.source !== 'CONTRADICTION' &&
    Object.values(state.beliefs).some((b) => related.has(b.id) && b.state !== 'UNKNOWN');
  return HUMAN_RESPONSE_KINDS.filter((kind) => kind !== 'REJECT_ASSUMPTION' || rejectable);
}

/** The web interface's view of one question (ADR-0015 rule 3). */
export function questionView(state: CognitionState, questionId: string): QuestionView {
  const question = requireQuestion(state, questionId);
  const uncertainty = uncertaintyOf(state, question);
  const related = new Set(question.relatedBeliefIds);
  const affected = new Set(question.affectedGoalIds);
  return {
    question,
    uncertainty,
    goals: sortById(Object.values(state.goals).filter((g) => affected.has(g.id))).map((g) => ({
      id: g.id,
      description: g.description,
      status: g.status,
      priority: g.priority,
    })),
    beliefs: sortById(Object.values(state.beliefs).filter((b) => related.has(b.id))).map(summarise),
    contradiction: question.contradictionId === null ? null : (state.contradictions[question.contradictionId] ?? null),
    allowedResponses: allowedResponses(state, question, uncertainty),
    requiresGoverningSide: uncertainty.source === 'CONTRADICTION',
  };
}

// ================================================================== decisions

function requireQuestion(state: CognitionState, id: string): Question {
  const found = state.questions[id];
  if (found === undefined) return violation('QUESTION_NOT_FOUND', `no question ${id}`, { questionId: id });
  return found;
}

function requireOpen(u: Uncertainty, action: string): void {
  if (isTerminalUncertainty(u.status)) {
    violation('UNCERTAINTY_CLOSED', `cannot ${action}: uncertainty ${u.id} is ${u.status}`, { uncertaintyId: u.id });
  }
}

function refuseAgent(actor: EventActor, rule: string, what: string): void {
  if (actor.kind === 'AGENT') violation(rule, `an agent cannot ${what}`);
}

/**
 * A response's authority: a person's is a decision; the system's rests on the
 * evidence it cites, so it is evidence. Agents never respond.
 */
const responseAuthority = (actor: EventActor): Authority => (actor.kind === 'HUMAN' ? 'HUMAN_DECISION' : 'EVIDENCE');

function requireRelated(u: Uncertainty, beliefIds: readonly string[]): string[] {
  const ids = [...new Set(beliefIds)].sort();
  const unrelated = ids.filter((id) => !u.relatedBeliefs.includes(id));
  if (unrelated.length > 0) {
    violation('NOT_RELATED_BELIEF', `beliefs ${unrelated.join(', ')} are not related to uncertainty ${u.id}`, {
      beliefIds: unrelated,
    });
  }
  return ids;
}

function draft(state: CognitionState, command: Extract<QuestionCommand, { kind: 'DRAFT_QUESTION' }>, ctx: DecisionContext) {
  const u = state.uncertainties[command.uncertaintyId];
  if (u === undefined) {
    return violation('UNCERTAINTY_NOT_FOUND', `no uncertainty ${command.uncertaintyId}`, {
      uncertaintyId: command.uncertaintyId,
    });
  }
  requireOpen(u, 'draft a question');
  const audience = command.audience ?? (u.resolution === 'ASK_HUMAN' ? 'HUMAN' : 'SELF');
  if (u.resolution === 'ASK_HUMAN' && audience !== 'HUMAN') {
    violation('AUDIENCE_MISMATCH', `uncertainty ${u.id} is answered by a human, not ${audience}`);
  }
  const open = questionsFor(state, u.id).find((q) => q.audience === audience && !isTerminalQuestion(q.status));
  if (open !== undefined) {
    violation('DUPLICATE_QUESTION', `question ${open.id} already asks ${audience} about ${u.id}`, {
      questionId: open.id,
    });
  }
  const decided = answeredByHuman(state, command.text);
  if (decided !== undefined) {
    violation('ALREADY_ANSWERED', `a human already answered this question (${decided.id})`, {
      questionId: decided.id,
    });
  }
  const question: NewQuestion = {
    id: ctx.ids.question(),
    text: command.text,
    reason: command.reason ?? u.impact.whatBreaksIfWrong,
    uncertaintyId: u.id,
    audience,
    resolutionMethod: u.resolution,
    affectedGoalIds: [...u.blocksGoalIds],
    affectedRefs: [...u.impact.affectedRefs],
    relatedBeliefIds: [...u.relatedBeliefs],
    contradictionId: u.source === 'CONTRADICTION' ? u.sourceRef : null,
    evidenceRefs: [...new Set(command.evidenceRefs ?? [])].sort(),
    score: scoreQuestion(state, u, ctx.scorer),
    status: 'DRAFT',
    response: null,
    outcome: null,
    createdBy: recordedBy(ctx),
    createdAt: ctx.now,
    askedAt: null,
    closedAt: null,
  };
  return [cognitiveEvent(ctx, COGNITION_EVENTS.QUESTION_DRAFTED, { question })];
}

function ask(state: CognitionState, questionIds: readonly string[], ctx: DecisionContext): CognitiveEventInput[] {
  refuseAgent(ctx.actor, 'AGENT_CANNOT_ASK', 'ask a question; it may only draft one');
  const questions = [...new Set(questionIds)].sort().map((id) => requireQuestion(state, id));
  const events: CognitiveEventInput[] = [];
  const starting = new Map<string, Uncertainty>();
  for (const q of questions) {
    if (q.status !== 'DRAFT') violation('QUESTION_NOT_DRAFT', `question ${q.id} is ${q.status}`, { questionId: q.id });
    const u = uncertaintyOf(state, q);
    requireOpen(u, `ask question ${q.id}`);
    events.push(
      cognitiveEvent(ctx, COGNITION_EVENTS.QUESTION_ASKED, { questionId: q.id, score: scoreQuestion(state, u, ctx.scorer) }),
    );
    if (u.status === 'OPEN') starting.set(u.id, u);
  }
  // Asking is starting to resolve: each uncertainty moves once, however many of
  // its questions are in the batch.
  for (const u of sortById([...starting.values()])) {
    events.push(...decideUncertainty(state, { kind: 'START_RESOLVING', uncertaintyId: u.id }, ctx));
  }
  return events;
}

/** The answer attached to a belief: a descriptor of a person's (or the system's) statement. */
const answerEvidence = (questionId: string, actor: EventActor) => ({
  evidenceId: questionId,
  kind: actor.kind === 'HUMAN' ? ('HUMAN_STATEMENT' as const) : ('OBSERVATION' as const),
  producedBy: actor.id,
  environment: 'NONE' as const,
  // A statement is not an executed check; it can never count toward TESTED.
  couldFalsify: false,
});

function answerEffects(
  state: CognitionState,
  q: Question,
  u: Uncertainty,
  response: Extract<ResponseInput, { kind: 'ANSWER' }>,
  ctx: DecisionContext,
): { events: CognitiveEventInput[]; supports: string[]; contradicts: string[] } {
  const supports = requireRelated(u, response.supportsBeliefIds ?? []);
  const contradicts = requireRelated(u, response.contradictsBeliefIds ?? []);
  const both = supports.filter((id) => contradicts.includes(id));
  if (both.length > 0) {
    violation('CONFLICTING_BELIEF_EFFECTS', `an answer cannot both support and contradict ${both.join(', ')}`);
  }

  const events: CognitiveEventInput[] = [];
  for (const [ids, polarity] of [
    [supports, 'SUPPORTING'],
    [contradicts, 'CONTRADICTING'],
  ] as const) {
    for (const beliefId of ids) {
      events.push(
        ...decideBelief(
          state,
          { kind: 'ADD_BELIEF_EVIDENCE', beliefId, polarity, evidence: answerEvidence(q.id, ctx.actor) },
          ctx,
        ),
      );
    }
  }

  if (u.source === 'CONTRADICTION') {
    if (response.governingSide === undefined) {
      violation('GOVERNING_SIDE_REQUIRED', `question ${q.id} settles a contradiction; the answer must name the side that governs`);
    }
    // The contradiction engine resolves the contradiction and its uncertainty.
    events.push(
      ...decideContradiction(
        state,
        {
          kind: 'RESOLVE_CONTRADICTION',
          contradictionId: u.sourceRef as string,
          governingSide: response.governingSide,
          reason: response.text,
        },
        ctx,
      ),
    );
  } else {
    if (response.governingSide !== undefined) {
      violation('GOVERNING_SIDE_NOT_APPLICABLE', `question ${q.id} does not settle a contradiction`);
    }
    events.push(
      ...decideUncertainty(
        state,
        {
          kind: 'RESOLVE_UNCERTAINTY',
          uncertaintyId: u.id,
          evidence: [q.id, ...(response.evidence ?? [])],
          reason: `answered by question ${q.id}`,
        },
        ctx,
      ),
    );
  }
  return { events, supports, contradicts };
}

function rejectEffects(
  state: CognitionState,
  q: Question,
  u: Uncertainty,
  response: Extract<ResponseInput, { kind: 'REJECT_ASSUMPTION' }>,
  ctx: DecisionContext,
): { events: CognitiveEventInput[]; rejected: string[] } {
  if (u.source === 'CONTRADICTION') {
    violation('CONTRADICTION_OWNED', `question ${q.id} settles a contradiction; answer it by naming the governing side`);
  }
  const rejected = requireRelated(u, response.beliefIds);
  if (rejected.length === 0) violation('BELIEFS_REQUIRED', 'rejecting an assumption must name the beliefs rejected');

  const events: CognitiveEventInput[] = [];
  for (const beliefId of rejected) {
    // Related beliefs are known to the fold, so the lookup succeeds.
    const belief = state.beliefs[beliefId] as Belief;
    if (belief.state === 'UNKNOWN') {
      violation('NOTHING_TO_REJECT', `belief ${beliefId} is already UNKNOWN`, { beliefId });
    }
    if (hasEvidence(belief, q.id)) {
      violation('EVIDENCE_ALREADY_RECORDED', `question ${q.id} is already evidence on belief ${beliefId}`);
    }
    // Downgrade first, through the belief rules; then record the rejection as
    // contradicting evidence. Built directly rather than through
    // ADD_BELIEF_EVIDENCE, whose VERIFIED→TESTED step would describe a state the
    // downgrade has already left.
    events.push(...decideBelief(state, { kind: 'TRANSITION_BELIEF', beliefId, to: 'UNKNOWN', reason: response.text }, ctx));
    events.push(
      cognitiveEvent(ctx, COGNITION_EVENTS.BELIEF_EVIDENCE_ADDED, {
        beliefId,
        polarity: 'CONTRADICTING',
        evidence: answerEvidence(q.id, ctx.actor),
      }),
    );
  }
  events.push(
    ...decideUncertainty(
      state,
      {
        kind: 'RESOLVE_UNCERTAINTY',
        uncertaintyId: u.id,
        evidence: [q.id],
        reason: `assumption rejected by question ${q.id}`,
      },
      ctx,
    ),
  );
  return { events, rejected };
}

function respond(state: CognitionState, questionId: string, response: ResponseInput, ctx: DecisionContext) {
  const q = requireQuestion(state, questionId);
  refuseAgent(ctx.actor, 'AGENT_CANNOT_RESPOND', 'respond to a question');
  if (q.status !== 'ASKED') violation('QUESTION_NOT_ASKED', `question ${q.id} is ${q.status}`, { questionId: q.id });
  const u = uncertaintyOf(state, q);
  requireOpen(u, `respond to question ${q.id}`);
  if (q.audience === 'HUMAN' && ctx.actor.kind !== 'HUMAN') {
    violation('HUMAN_ANSWER_REQUIRED', `question ${q.id} is put to a human`);
  }
  if (response.kind !== 'ANSWER' && ctx.actor.kind !== 'HUMAN') {
    violation('HUMAN_ONLY', `only a human can respond with ${response.kind}`);
  }
  const evidence = response.kind === 'ANSWER' ? [...new Set(response.evidence ?? [])].sort() : [];
  if (ctx.actor.kind !== 'HUMAN' && evidence.length === 0) {
    violation('EVIDENCE_REQUIRED', `a system answer to question ${q.id} must cite evidence`);
  }

  let effects: CognitiveEventInput[];
  let supports: string[] = [];
  let contradicts: string[] = [];
  let rejected: string[] = [];
  let governingSide: 0 | 1 | null = null;
  switch (response.kind) {
    case 'ANSWER':
      ({ events: effects, supports, contradicts } = answerEffects(state, q, u, response, ctx));
      governingSide = response.governingSide ?? null;
      break;
    case 'REJECT_ASSUMPTION':
      ({ events: effects, rejected } = rejectEffects(state, q, u, response, ctx));
      break;
    case 'ACCEPT_RISK':
      effects = decideUncertainty(state, { kind: 'ACCEPT_UNCERTAINTY', uncertaintyId: u.id, reason: response.text }, ctx);
      break;
  }

  const responded = cognitiveEvent(
    ctx,
    COGNITION_EVENTS.QUESTION_RESPONDED,
    {
      questionId: q.id,
      response: {
        kind: response.kind,
        text: response.text,
        evidence,
        governingSide,
        supportsBeliefIds: supports,
        contradictsBeliefIds: contradicts,
        rejectedBeliefIds: rejected,
      },
    },
    responseAuthority(ctx.actor),
  );
  // The response first: every effect after it is a consequence of it.
  return [responded, ...effects];
}

function close(
  state: CognitionState,
  questionId: string,
  to: 'WITHDRAWN' | 'UNANSWERABLE',
  reason: string | undefined,
  ctx: DecisionContext,
) {
  const q = requireQuestion(state, questionId);
  refuseAgent(ctx.actor, 'AGENT_CANNOT_CLOSE', `close a question as ${to}`);
  if (to === 'WITHDRAWN') {
    if (isTerminalQuestion(q.status)) violation('QUESTION_CLOSED', `question ${q.id} is ${q.status}`);
  } else {
    if (q.status !== 'ASKED') violation('QUESTION_NOT_ASKED', `question ${q.id} is ${q.status}`);
    if (q.audience === 'HUMAN' && ctx.actor.kind !== 'HUMAN') {
      violation('HUMAN_ANSWER_REQUIRED', `only a human can say question ${q.id} cannot be answered`);
    }
  }
  const why = requireReason(reason, 'REASON_REQUIRED', `closing a question as ${to}`);
  return [cognitiveEvent(ctx, COGNITION_EVENTS.QUESTION_CLOSED, { questionId: q.id, from: q.status, to, reason: why })];
}

function recordOutcome(
  state: CognitionState,
  command: Extract<QuestionCommand, { kind: 'RECORD_QUESTION_OUTCOME' }>,
  ctx: DecisionContext,
) {
  const q = requireQuestion(state, command.questionId);
  refuseAgent(ctx.actor, 'AGENT_CANNOT_RECORD_OUTCOME', 'record what an answer changed');
  if (q.status !== 'ANSWERED') violation('QUESTION_NOT_ANSWERED', `question ${q.id} is ${q.status}`);
  if (q.outcome !== null) violation('OUTCOME_ALREADY_RECORDED', `question ${q.id} already has an outcome`);
  // ANSWERED always carries its response: the fold sets both together.
  const after = (q.response as NonNullable<Question['response']>).respondedSeq;
  const transitioned = [...new Set(command.beliefsTransitioned ?? [])].sort();
  for (const beliefId of transitioned) {
    const belief = state.beliefs[beliefId];
    if (belief === undefined) violation('BELIEF_NOT_FOUND', `no belief ${beliefId}`, { beliefId });
    // A claim that the answer moved a belief is checked against its history.
    if (!belief.history.some((t) => t.seq > after)) {
      violation('NOT_TRANSITIONED_AFTER_RESPONSE', `belief ${beliefId} has not changed since question ${q.id} was answered`, {
        beliefId,
      });
    }
  }
  return [
    cognitiveEvent(ctx, COGNITION_EVENTS.QUESTION_OUTCOME_RECORDED, {
      questionId: q.id,
      outcome: { changedPlan: command.changedPlan, beliefsTransitioned: transitioned },
    }),
  ];
}

export function decideQuestion(
  state: CognitionState,
  command: QuestionCommand,
  ctx: DecisionContext,
): CognitiveEventInput[] {
  switch (command.kind) {
    case 'DRAFT_QUESTION':
      return draft(state, command, ctx);
    case 'ASK_QUESTIONS':
      return ask(state, command.questionIds, ctx);
    case 'RESPOND_TO_QUESTION':
      return respond(state, command.questionId, command.response, ctx);
    case 'WITHDRAW_QUESTION':
      return close(state, command.questionId, 'WITHDRAWN', command.reason, ctx);
    case 'MARK_QUESTION_UNANSWERABLE':
      return close(state, command.questionId, 'UNANSWERABLE', command.reason, ctx);
    case 'RECORD_QUESTION_OUTCOME':
      return recordOutcome(state, command, ctx);
  }
}

// ======================================================================= fold

const putQuestion = (state: CognitionState, q: Question): CognitionState => ({
  ...state,
  questions: { ...state.questions, [q.id]: q },
});

function withQuestion(
  state: CognitionState,
  event: GenesisEvent,
  questionId: string,
  apply: (q: Question) => CognitionState,
): CognitionState {
  const q = state.questions[questionId];
  if (q === undefined) return anomaly(state, event, 'UNKNOWN_REFERENCE', `no question ${questionId}`);
  return apply(q);
}

export const questionFold: Record<string, (s: CognitionState, e: GenesisEvent) => CognitionState> = {
  [COGNITION_EVENTS.QUESTION_DRAFTED]: (state, event) =>
    withPayload(state, event, QuestionDraftedPayload, ({ question }) => {
      if (state.questions[question.id] !== undefined) {
        return anomaly(state, event, 'STATE_MISMATCH', `question ${question.id} already exists`);
      }
      const unborn =
        question.status !== 'DRAFT' ||
        question.response !== null ||
        question.outcome !== null ||
        question.askedAt !== null ||
        question.closedAt !== null;
      if (unborn) {
        return anomaly(state, event, 'STATE_MISMATCH', `a question is born a DRAFT with nothing answered`);
      }
      const u = state.uncertainties[question.uncertaintyId];
      const missing = [
        ...(u === undefined ? [question.uncertaintyId] : []),
        ...question.affectedGoalIds.filter((id) => state.goals[id] === undefined),
        ...question.relatedBeliefIds.filter((id) => state.beliefs[id] === undefined),
      ];
      if (u === undefined || missing.length > 0) {
        return anomaly(state, event, 'UNKNOWN_REFERENCE', `unknown records: ${missing.join(', ')}`);
      }
      // The link is kept both ways, so the uncertainty lists its questions.
      const relatedQuestions = [...new Set([...u.relatedQuestions, question.id])].sort();
      return {
        ...putQuestion(state, { ...question, history: [] }),
        uncertainties: { ...state.uncertainties, [u.id]: { ...u, relatedQuestions } },
      };
    }),

  [COGNITION_EVENTS.QUESTION_ASKED]: (state, event) =>
    withPayload(state, event, QuestionAskedPayload, ({ questionId, score }) =>
      withQuestion(state, event, questionId, (q) => {
        if (q.status !== 'DRAFT') return anomaly(state, event, 'STATE_MISMATCH', `question ${q.id} is ${q.status}, not DRAFT`);
        return putQuestion(state, {
          ...q,
          status: 'ASKED',
          score,
          askedAt: event.timestamp,
          history: [...q.history, transitionOf(event, 'DRAFT', 'ASKED', null)],
        });
      }),
    ),

  [COGNITION_EVENTS.QUESTION_RESPONDED]: (state, event) =>
    withPayload(state, event, QuestionRespondedPayload, ({ questionId, response }) =>
      withQuestion(state, event, questionId, (q) => {
        if (q.status !== 'ASKED') return anomaly(state, event, 'STATE_MISMATCH', `question ${q.id} is ${q.status}, not ASKED`);
        return putQuestion(state, {
          ...q,
          status: 'ANSWERED',
          closedAt: event.timestamp,
          response: {
            ...response,
            authority: event.authority,
            respondedBy: { actorKind: event.actor.kind, actorId: event.actor.id },
            respondedAt: event.timestamp,
            respondedSeq: event.seq,
          },
          history: [...q.history, transitionOf(event, 'ASKED', 'ANSWERED', response.kind)],
        });
      }),
    ),

  [COGNITION_EVENTS.QUESTION_CLOSED]: (state, event) =>
    withPayload(state, event, QuestionClosedPayload, ({ questionId, from, to, reason }) =>
      withQuestion(state, event, questionId, (q) => {
        const legal = q.status === from && (from === 'ASKED' || (from === 'DRAFT' && to === 'WITHDRAWN'));
        if (!legal) return anomaly(state, event, 'STATE_MISMATCH', `question ${q.id} is ${q.status}; no decider moves it ${from} → ${to}`);
        return putQuestion(state, {
          ...q,
          status: to,
          closedAt: event.timestamp,
          history: [...q.history, transitionOf(event, from, to, reason)],
        });
      }),
    ),

  [COGNITION_EVENTS.QUESTION_OUTCOME_RECORDED]: (state, event) =>
    withPayload(state, event, QuestionOutcomeRecordedPayload, ({ questionId, outcome }) =>
      withQuestion(state, event, questionId, (q) => {
        if (q.status !== 'ANSWERED' || q.outcome !== null) {
          return anomaly(state, event, 'STATE_MISMATCH', `question ${q.id} cannot take an outcome now`);
        }
        return putQuestion(state, {
          ...q,
          outcome: {
            ...outcome,
            recordedBy: { actorKind: event.actor.kind, actorId: event.actor.id },
            recordedAt: event.timestamp,
          },
        });
      }),
    ),
};
