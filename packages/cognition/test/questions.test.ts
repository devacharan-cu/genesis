/**
 * The question engine (SPEC-01 §9, ADR-0015).
 *
 * Every rule is made to fire. The ones that matter most are about WHO: an agent
 * may draft a question but never ask one, answer one, or close one; nothing but
 * a human answers a question put to a human. And about EFFECT: a response is
 * not a note on the question — it resolves, accepts or refutes, through the
 * rules of the records it touches, in the same append.
 */

import {
  type CognitionState,
  isTerminalQuestion,
  nextQuestionBatch,
  normalizeQuestionText,
  pendingHumanQuestions,
  type QuestionScorer,
  questionsFor,
  questionView,
} from '@genesis/cognition';
import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT, evidence, expectRefused, HUMAN, Mind, SYSTEM, testCriterion } from './support.js';

let mind: Mind;
beforeEach(() => {
  mind = new Mind();
});

const uncertainty = (over: Record<string, unknown> = {}): string => {
  mind.run(SYSTEM, {
    kind: 'RECORD_UNCERTAINTY',
    statement: 'which region?',
    whatBreaksIfWrong: 'deploys land in the wrong region',
    risk: 'MEDIUM',
    resolution: 'ASK_HUMAN',
    ...over,
  });
  return mind.lastId('uncertainty');
};

const belief = (over: Record<string, unknown> = {}, actor = AGENT): string => {
  mind.run(actor, { kind: 'RECORD_BELIEF', statement: 'one timezone', state: 'ASSUMED', rationale: 'one office', ...over });
  return mind.lastId('belief');
};

const draft = (uncertaintyId: string, over: Record<string, unknown> = {}, actor = SYSTEM): string => {
  mind.run(actor, { kind: 'DRAFT_QUESTION', uncertaintyId, text: `What about ${uncertaintyId}?`, ...over });
  return mind.lastId('question');
};

const ask = (...questionIds: string[]): void => {
  mind.run(SYSTEM, { kind: 'ASK_QUESTIONS', questionIds });
};

const respond = (questionId: string, response: Record<string, unknown>, actor = HUMAN) =>
  mind.run(actor, { kind: 'RESPOND_TO_QUESTION', questionId, response });

/** A drafted and asked question on a fresh uncertainty. */
const asked = (over: Record<string, unknown> = {}, questionOver: Record<string, unknown> = {}): string => {
  const q = draft(uncertainty(over), questionOver);
  ask(q);
  return q;
};

const escalated = (): { contradiction: string; uncertainty: string; beliefs: [string, string] } => {
  const a = belief({ statement: 'a' });
  const b = belief({ statement: 'b' });
  mind.run(AGENT, {
    kind: 'RECORD_CONTRADICTION',
    contradictionKind: 'BELIEF_EVIDENCE',
    sides: [
      { kind: 'BELIEF', beliefId: a },
      { kind: 'BELIEF', beliefId: b },
    ],
  });
  return { contradiction: mind.lastId('contradiction'), uncertainty: mind.lastId('uncertainty'), beliefs: [a, b] };
};

// ==================================================================== drafting

describe('drafting', () => {
  it('records a structured question: text, reason, affected goals and nodes, evidence, method, score', () => {
    mind.run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'ship', priority: 5, successCriteria: [testCriterion()] });
    const goal = mind.lastId('goal');
    const b = belief();
    const u = uncertainty({
      blocksGoalIds: [goal],
      relatedBeliefs: [b],
      affectedRefs: [{ nodeType: 'COMPONENT', nodeId: 'node_api' }],
    });
    const id = draft(u, { reason: 'the data model depends on it', evidenceRefs: ['doc-2', 'doc-1', 'doc-2'] }, AGENT);
    const q = mind.state.questions[id];
    expect(q).toMatchObject({
      text: `What about ${u}?`,
      reason: 'the data model depends on it',
      uncertaintyId: u,
      audience: 'HUMAN',
      resolutionMethod: 'ASK_HUMAN',
      affectedGoalIds: [goal],
      affectedRefs: [{ nodeType: 'COMPONENT', nodeId: 'node_api' }],
      relatedBeliefIds: [b],
      contradictionId: null,
      evidenceRefs: ['doc-1', 'doc-2'],
      status: 'DRAFT',
      response: null,
      outcome: null,
      createdBy: { actorKind: 'AGENT', actorId: AGENT.id },
      askedAt: null,
      closedAt: null,
      history: [],
    });
    expect(q?.score.scorer).toEqual({ name: 'genesis.default-question-scorer', version: 1 });
    // The link is kept both ways.
    expect(mind.state.uncertainties[u]?.relatedQuestions).toEqual([id]);
  });

  it('defaults the reason to what breaks, and the audience to the strategy', () => {
    const human = draft(uncertainty());
    expect(mind.state.questions[human]).toMatchObject({ reason: 'deploys land in the wrong region', audience: 'HUMAN', evidenceRefs: [] });
    const self = draft(uncertainty({ resolution: 'SEARCH' }));
    expect(mind.state.questions[self]?.audience).toBe('SELF');
  });

  it('never puts an ASK_HUMAN uncertainty to anyone but a human', () => {
    const u = uncertainty();
    expectRefused(mind, 'AUDIENCE_MISMATCH', () => draft(u, { audience: 'SELF' }));
    // A SEARCH uncertainty may still be put to a person.
    const search = uncertainty({ resolution: 'SEARCH' });
    const toPerson = draft(search, { audience: 'HUMAN' });
    expect(mind.state.questions[toPerson]?.audience).toBe('HUMAN');
  });

  it('refuses a question about an uncertainty that is missing or closed', () => {
    expectRefused(mind, 'UNCERTAINTY_NOT_FOUND', () => draft('unc-404'));
    const u = uncertainty({ resolution: 'SEARCH' });
    mind.run(SYSTEM, { kind: 'RESOLVE_UNCERTAINTY', uncertaintyId: u, evidence: ['e'] });
    expectRefused(mind, 'UNCERTAINTY_CLOSED', () => draft(u));
  });

  it('keeps one open question per uncertainty and audience', () => {
    const u = uncertainty({ resolution: 'SEARCH' });
    const first = draft(u);
    expectRefused(mind, 'DUPLICATE_QUESTION', () => draft(u, { text: 'said differently' }));
    // Another audience is another question.
    draft(u, { audience: 'EXTERNAL' });
    // Once the first is closed, the audience is free again.
    mind.run(SYSTEM, { kind: 'WITHDRAW_QUESTION', questionId: first, reason: 'reworded' });
    expect(() => draft(u, { text: 'reworded' })).not.toThrow();
  });

  it('does not draft what a human has already decided (SPEC-01 §9.4)', () => {
    const q = asked({}, { text: 'Which region?' });
    respond(q, { kind: 'ANSWER', text: 'eu-west-1' });
    const again = uncertainty({ statement: 'region, again' });
    expectRefused(mind, 'ALREADY_ANSWERED', () => draft(again, { text: '  which   REGION ?? ' }));
  });

  it('marks a contradiction’s question with the contradiction', () => {
    const { contradiction, uncertainty: u } = escalated();
    const q = draft(u);
    expect(mind.state.questions[q]?.contradictionId).toBe(contradiction);
  });
});

// ====================================================================== asking

describe('asking', () => {
  it('is for the system or a human; an agent may only draft', () => {
    const q = draft(uncertainty(), {}, AGENT);
    expectRefused(mind, 'AGENT_CANNOT_ASK', () => mind.run(AGENT, { kind: 'ASK_QUESTIONS', questionIds: [q] }));
  });

  it('records the score at asking time, and starts resolving the uncertainty once', () => {
    const u = uncertainty({ resolution: 'SEARCH' });
    const a = draft(u);
    const b = draft(u, { audience: 'EXTERNAL', text: 'ask the vendor' });
    const events = mind.run(HUMAN, { kind: 'ASK_QUESTIONS', questionIds: [b, a, a] });
    expect(events.map((e) => e.type)).toEqual(['QUESTION_ASKED', 'QUESTION_ASKED', 'UNCERTAINTY_STATUS_CHANGED']);
    expect(mind.state.uncertainties[u]?.status).toBe('IN_PROGRESS');
    expect(mind.state.questions[a]).toMatchObject({ status: 'ASKED', askedAt: expect.any(String) as string });
    expect(mind.state.questions[a]?.history.map((t) => `${t.from}->${t.to}`)).toEqual(['DRAFT->ASKED']);

    // A later question on an uncertainty already in progress does not move it again.
    const c = draft(u, { audience: 'HUMAN', text: 'ask a person' });
    expect(mind.run(SYSTEM, { kind: 'ASK_QUESTIONS', questionIds: [c] }).map((e) => e.type)).toEqual(['QUESTION_ASKED']);
  });

  it('refuses a missing question, one not in DRAFT, and one whose uncertainty closed', () => {
    expectRefused(mind, 'QUESTION_NOT_FOUND', () => ask('qst-404'));
    const q = asked();
    expectRefused(mind, 'QUESTION_NOT_DRAFT', () => ask(q));

    const u = uncertainty({ resolution: 'SEARCH' });
    const late = draft(u);
    mind.run(SYSTEM, { kind: 'RESOLVE_UNCERTAINTY', uncertaintyId: u, evidence: ['found it'] });
    expectRefused(mind, 'UNCERTAINTY_CLOSED', () => ask(late));
  });
});

// ================================================================= responding

describe('responding: who', () => {
  it('refuses a missing question and any agent', () => {
    expectRefused(mind, 'QUESTION_NOT_FOUND', () => respond('qst-404', { kind: 'ANSWER', text: 'x' }));
    const q = asked();
    expectRefused(mind, 'AGENT_CANNOT_RESPOND', () => respond(q, { kind: 'ANSWER', text: 'x' }, AGENT));
  });

  it('answers only what was asked, while its uncertainty is open', () => {
    const q = draft(uncertainty());
    expectRefused(mind, 'QUESTION_NOT_ASKED', () => respond(q, { kind: 'ANSWER', text: 'x' }));

    const u = uncertainty({ resolution: 'SEARCH' });
    const open = draft(u, { audience: 'HUMAN' });
    ask(open);
    mind.run(HUMAN, { kind: 'ACCEPT_UNCERTAINTY', uncertaintyId: u, reason: 'moving on' });
    expectRefused(mind, 'UNCERTAINTY_CLOSED', () => respond(open, { kind: 'ANSWER', text: 'x' }));
  });

  it('lets nothing but a human answer a question put to a human', () => {
    const q = asked();
    expectRefused(mind, 'HUMAN_ANSWER_REQUIRED', () =>
      respond(q, { kind: 'ANSWER', text: 'x', evidence: ['e'] }, SYSTEM),
    );
  });

  it('lets the system answer its own question only with evidence, and never reject or accept', () => {
    const q = asked({ resolution: 'SEARCH' });
    expectRefused(mind, 'HUMAN_ONLY', () => respond(q, { kind: 'ACCEPT_RISK', text: 'x' }, SYSTEM));
    expectRefused(mind, 'EVIDENCE_REQUIRED', () => respond(q, { kind: 'ANSWER', text: 'x' }, SYSTEM));
    const events = respond(q, { kind: 'ANSWER', text: 'found in the runbook', evidence: ['doc-9', 'doc-9'] }, SYSTEM);
    expect(events[0]?.authority).toBe('EVIDENCE');
    expect(mind.state.questions[q]?.response).toMatchObject({
      kind: 'ANSWER',
      authority: 'EVIDENCE',
      evidence: ['doc-9'],
      respondedBy: { actorKind: 'SYSTEM', actorId: SYSTEM.id },
    });
  });
});

describe('responding: ANSWER', () => {
  it('is an immutable HUMAN_DECISION event that resolves the uncertainty with the question as evidence', () => {
    const q = asked();
    const u = mind.state.questions[q]?.uncertaintyId as string;
    const events = respond(q, { kind: 'ANSWER', text: 'eu-west-1' });
    expect(events.map((e) => e.type)).toEqual(['QUESTION_RESPONDED', 'UNCERTAINTY_STATUS_CHANGED']);
    expect(events[0]?.authority).toBe('HUMAN_DECISION');

    const question = mind.state.questions[q];
    expect(question).toMatchObject({ status: 'ANSWERED', closedAt: expect.any(String) as string });
    expect(question?.response).toMatchObject({
      kind: 'ANSWER',
      text: 'eu-west-1',
      authority: 'HUMAN_DECISION',
      respondedBy: { actorKind: 'HUMAN', actorId: HUMAN.id },
      evidence: [],
      governingSide: null,
      supportsBeliefIds: [],
      contradictsBeliefIds: [],
      rejectedBeliefIds: [],
    });
    expect(mind.state.uncertainties[u]).toMatchObject({ status: 'RESOLVED', resolutionEvidence: [q] });
    // Terminal: it cannot be answered twice.
    expectRefused(mind, 'QUESTION_NOT_ASKED', () => respond(q, { kind: 'ANSWER', text: 'us-east-1' }));
  });

  it('attaches the answer to related beliefs, for and against, as a human statement', () => {
    const pro = belief({ statement: 'pro' });
    const con = belief({ statement: 'con' });
    const q = asked({ relatedBeliefs: [pro, con] });
    respond(q, { kind: 'ANSWER', text: 'yes', supportsBeliefIds: [pro], contradictsBeliefIds: [con] });
    expect(mind.state.beliefs[pro]?.supportingEvidence).toEqual([
      expect.objectContaining({ evidenceId: q, kind: 'HUMAN_STATEMENT', couldFalsify: false, producedBy: HUMAN.id }),
    ]);
    expect(mind.state.beliefs[con]?.contradictingEvidence).toEqual([
      expect.objectContaining({ evidenceId: q, status: 'OPEN' }),
    ]);
    expect(mind.state.questions[q]?.response).toMatchObject({ supportsBeliefIds: [pro], contradictsBeliefIds: [con] });
  });

  it('attaches a system answer as an observation', () => {
    const b = belief();
    const q = asked({ resolution: 'SEARCH', relatedBeliefs: [b] });
    respond(q, { kind: 'ANSWER', text: 'yes', evidence: ['log-1'], supportsBeliefIds: [b] }, SYSTEM);
    expect(mind.state.beliefs[b]?.supportingEvidence[0]?.kind).toBe('OBSERVATION');
  });

  it('refuses beliefs the uncertainty does not name, and a belief both supported and contradicted', () => {
    const b = belief();
    const q = asked({ relatedBeliefs: [b] });
    const stranger = belief({ statement: 'unrelated' });
    expectRefused(mind, 'NOT_RELATED_BELIEF', () => respond(q, { kind: 'ANSWER', text: 'x', supportsBeliefIds: [stranger] }));
    expectRefused(mind, 'CONFLICTING_BELIEF_EFFECTS', () =>
      respond(q, { kind: 'ANSWER', text: 'x', supportsBeliefIds: [b], contradictsBeliefIds: [b] }),
    );
  });

  it('settles a contradiction only by naming the governing side', () => {
    const { contradiction, uncertainty: u, beliefs } = escalated();
    const q = draft(u);
    ask(q);
    expectRefused(mind, 'GOVERNING_SIDE_REQUIRED', () => respond(q, { kind: 'ANSWER', text: 'a holds' }));
    const events = respond(q, { kind: 'ANSWER', text: 'a holds', governingSide: 0 });
    expect(events.map((e) => e.type)).toEqual([
      'QUESTION_RESPONDED',
      'CONTRADICTION_RESOLVED',
      'BELIEF_SUPERSEDED_BY_AUTHORITY',
      'UNCERTAINTY_STATUS_CHANGED',
    ]);
    expect(mind.state.contradictions[contradiction]).toMatchObject({
      status: 'RESOLVED_BY_HUMAN',
      governingSide: 0,
      resolution: expect.objectContaining({ reason: 'a holds' }) as unknown,
    });
    expect(mind.state.beliefs[beliefs[1]]?.supersededBy).toEqual([contradiction]);
    expect(mind.state.uncertainties[u]?.status).toBe('RESOLVED');
    expect(mind.state.questions[q]?.response?.governingSide).toBe(0);
  });

  it('refuses a governing side where there is no contradiction', () => {
    const q = asked();
    expectRefused(mind, 'GOVERNING_SIDE_NOT_APPLICABLE', () => respond(q, { kind: 'ANSWER', text: 'x', governingSide: 1 }));
  });
});

describe('responding: REJECT_ASSUMPTION', () => {
  it('downgrades the named beliefs to UNKNOWN, records the rejection against them, and resolves', () => {
    const b = belief();
    mind.run(SYSTEM, { kind: 'ADD_BELIEF_EVIDENCE', beliefId: b, polarity: 'SUPPORTING', evidence: evidence('run-1') });
    mind.run(SYSTEM, { kind: 'TRANSITION_BELIEF', beliefId: b, to: 'SUPPORTED' });
    const q = asked({ relatedBeliefs: [b] });
    const u = mind.state.questions[q]?.uncertaintyId as string;
    const events = respond(q, { kind: 'REJECT_ASSUMPTION', text: 'users span three timezones', beliefIds: [b, b] });
    expect(events.map((e) => e.type)).toEqual([
      'QUESTION_RESPONDED',
      'BELIEF_STATE_CHANGED',
      'BELIEF_EVIDENCE_ADDED',
      'UNCERTAINTY_STATUS_CHANGED',
    ]);
    const after = mind.state.beliefs[b];
    expect(after?.state).toBe('UNKNOWN');
    expect(after?.history.at(-1)).toMatchObject({ from: 'SUPPORTED', to: 'UNKNOWN', reason: 'users span three timezones' });
    expect(after?.contradictingEvidence).toEqual([expect.objectContaining({ evidenceId: q, kind: 'HUMAN_STATEMENT' })]);
    expect(mind.state.uncertainties[u]).toMatchObject({ status: 'RESOLVED', resolutionEvidence: [q] });
    expect(mind.state.questions[q]?.response?.rejectedBeliefIds).toEqual([b]);
    expect(mind.anomalies()).toEqual([]);
  });

  it('is for a human', () => {
    const b = belief();
    const q = asked({ resolution: 'SEARCH', relatedBeliefs: [b] });
    expectRefused(mind, 'HUMAN_ONLY', () =>
      respond(q, { kind: 'REJECT_ASSUMPTION', text: 'x', beliefIds: [b] }, SYSTEM),
    );
  });

  it('refuses a contradiction’s question: that is settled by naming a side', () => {
    const { uncertainty: u, beliefs } = escalated();
    const q = draft(u);
    ask(q);
    expectRefused(mind, 'CONTRADICTION_OWNED', () =>
      respond(q, { kind: 'REJECT_ASSUMPTION', text: 'x', beliefIds: [beliefs[0]] }),
    );
  });

  it('must name related beliefs that are still more than UNKNOWN, and not already carrying this answer', () => {
    const b = belief();
    const unknown = belief({ state: 'UNKNOWN', statement: 'u' });
    const q = asked({ relatedBeliefs: [b, unknown] });
    expectRefused(mind, 'BELIEFS_REQUIRED', () => respond(q, { kind: 'REJECT_ASSUMPTION', text: 'x', beliefIds: [] }));
    expectRefused(mind, 'NOT_RELATED_BELIEF', () =>
      respond(q, { kind: 'REJECT_ASSUMPTION', text: 'x', beliefIds: ['bel-404'] }),
    );
    expectRefused(mind, 'NOTHING_TO_REJECT', () =>
      respond(q, { kind: 'REJECT_ASSUMPTION', text: 'x', beliefIds: [unknown] }),
    );
    mind.run(SYSTEM, {
      kind: 'ADD_BELIEF_EVIDENCE',
      beliefId: b,
      polarity: 'SUPPORTING',
      evidence: evidence(q, { kind: 'DOCUMENT' }),
    });
    expectRefused(mind, 'EVIDENCE_ALREADY_RECORDED', () =>
      respond(q, { kind: 'REJECT_ASSUMPTION', text: 'x', beliefIds: [b] }),
    );
  });
});

describe('responding: ACCEPT_RISK', () => {
  it('accepts the uncertainty — the gap stays a gap, by a person’s choice', () => {
    const q = asked();
    const u = mind.state.questions[q]?.uncertaintyId as string;
    respond(q, { kind: 'ACCEPT_RISK', text: 'launch small and measure' });
    expect(mind.state.uncertainties[u]).toMatchObject({ status: 'ACCEPTED', resolutionEvidence: [] });
    expect(mind.state.uncertainties[u]?.history.at(-1)?.reason).toBe('launch small and measure');
    expect(mind.state.questions[q]?.response?.kind).toBe('ACCEPT_RISK');
  });

  it('can accept a contradiction’s risk without deciding it', () => {
    const { contradiction, uncertainty: u } = escalated();
    const q = draft(u);
    ask(q);
    respond(q, { kind: 'ACCEPT_RISK', text: 'both may hold for now' });
    expect(mind.state.contradictions[contradiction]?.status).toBe('ESCALATED');
    expect(mind.state.uncertainties[u]?.status).toBe('ACCEPTED');
  });
});

// ==================================================================== closing

describe('withdrawing and unanswerable', () => {
  it('withdraws a draft or an asked question, with a reason, never by an agent', () => {
    const d = draft(uncertainty(), {}, AGENT);
    expectRefused(mind, 'AGENT_CANNOT_CLOSE', () => mind.run(AGENT, { kind: 'WITHDRAW_QUESTION', questionId: d, reason: 'x' }));
    expectRefused(mind, 'REASON_REQUIRED', () => mind.run(SYSTEM, { kind: 'WITHDRAW_QUESTION', questionId: d, reason: ' ' }));
    mind.run(SYSTEM, { kind: 'WITHDRAW_QUESTION', questionId: d, reason: 'superseded' });
    expect(mind.state.questions[d]).toMatchObject({ status: 'WITHDRAWN', closedAt: expect.any(String) as string });

    const a = asked();
    mind.run(HUMAN, { kind: 'WITHDRAW_QUESTION', questionId: a, reason: 'no longer relevant' });
    expect(mind.state.questions[a]?.history.map((t) => t.to)).toEqual(['ASKED', 'WITHDRAWN']);
    expectRefused(mind, 'QUESTION_CLOSED', () => mind.run(HUMAN, { kind: 'WITHDRAW_QUESTION', questionId: a, reason: 'again' }));
    expectRefused(mind, 'QUESTION_NOT_FOUND', () => mind.run(HUMAN, { kind: 'WITHDRAW_QUESTION', questionId: 'qst-404', reason: 'x' }));
  });

  it('marks only an asked question unanswerable, and leaves its uncertainty open', () => {
    const d = draft(uncertainty({ resolution: 'SEARCH' }));
    expectRefused(mind, 'QUESTION_NOT_ASKED', () =>
      mind.run(SYSTEM, { kind: 'MARK_QUESTION_UNANSWERABLE', questionId: d, reason: 'x' }),
    );
    ask(d);
    mind.run(SYSTEM, { kind: 'MARK_QUESTION_UNANSWERABLE', questionId: d, reason: 'no source has it' });
    const u = mind.state.questions[d]?.uncertaintyId as string;
    expect(mind.state.questions[d]?.status).toBe('UNANSWERABLE');
    expect(mind.state.uncertainties[u]?.status).toBe('IN_PROGRESS');
  });

  it('lets only a human say a human question cannot be answered', () => {
    const q = asked();
    expectRefused(mind, 'HUMAN_ANSWER_REQUIRED', () =>
      mind.run(SYSTEM, { kind: 'MARK_QUESTION_UNANSWERABLE', questionId: q, reason: 'x' }),
    );
    mind.run(HUMAN, { kind: 'MARK_QUESTION_UNANSWERABLE', questionId: q, reason: 'nobody knows yet' });
    expect(isTerminalQuestion(mind.state.questions[q]?.status ?? 'DRAFT')).toBe(true);
  });
});

// ==================================================================== outcomes

describe('outcomes (SPEC-01 §9.2)', () => {
  it('records whether the answer changed anything, checked against belief history', () => {
    const b = belief();
    const q = asked({ relatedBeliefs: [b] });
    expectRefused(mind, 'QUESTION_NOT_ANSWERED', () =>
      mind.run(SYSTEM, { kind: 'RECORD_QUESTION_OUTCOME', questionId: q, changedPlan: true }),
    );
    respond(q, { kind: 'ANSWER', text: 'yes', supportsBeliefIds: [b] });

    expectRefused(mind, 'AGENT_CANNOT_RECORD_OUTCOME', () =>
      mind.run(AGENT, { kind: 'RECORD_QUESTION_OUTCOME', questionId: q, changedPlan: true }),
    );
    expectRefused(mind, 'BELIEF_NOT_FOUND', () =>
      mind.run(SYSTEM, { kind: 'RECORD_QUESTION_OUTCOME', questionId: q, changedPlan: true, beliefsTransitioned: ['bel-404'] }),
    );
    // Evidence was attached, but the belief has not moved since the answer.
    expectRefused(mind, 'NOT_TRANSITIONED_AFTER_RESPONSE', () =>
      mind.run(SYSTEM, { kind: 'RECORD_QUESTION_OUTCOME', questionId: q, changedPlan: true, beliefsTransitioned: [b] }),
    );
    mind.run(SYSTEM, { kind: 'TRANSITION_BELIEF', beliefId: b, to: 'SUPPORTED' });
    mind.run(SYSTEM, { kind: 'RECORD_QUESTION_OUTCOME', questionId: q, changedPlan: true, beliefsTransitioned: [b, b] });
    expect(mind.state.questions[q]?.outcome).toMatchObject({
      changedPlan: true,
      beliefsTransitioned: [b],
      recordedBy: { actorKind: 'SYSTEM', actorId: SYSTEM.id },
    });
    expectRefused(mind, 'OUTCOME_ALREADY_RECORDED', () =>
      mind.run(HUMAN, { kind: 'RECORD_QUESTION_OUTCOME', questionId: q, changedPlan: false }),
    );
  });

  it('records a no-change outcome', () => {
    const q = asked();
    respond(q, { kind: 'ANSWER', text: 'as assumed' });
    mind.run(HUMAN, { kind: 'RECORD_QUESTION_OUTCOME', questionId: q, changedPlan: false });
    expect(mind.state.questions[q]?.outcome).toMatchObject({ changedPlan: false, beliefsTransitioned: [] });
  });
});

// ================================================================== selectors

describe('batching (SPEC-01 §9.4)', () => {
  it('orders drafts by live score, one per uncertainty, skipping closed and decided ones', () => {
    mind.run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'ship', priority: 5, successCriteria: [testCriterion()] });
    const goal = mind.lastId('goal');
    mind.run(HUMAN, { kind: 'ACTIVATE_GOAL', goalId: goal });

    const blocking = uncertainty({ blocksGoalIds: [goal], risk: 'HIGH' });
    const low = uncertainty({ risk: 'LOW' });
    const high = uncertainty({ risk: 'CRITICAL' });
    const qBlocking = draft(blocking);
    const qLow = draft(low);
    const qHigh = draft(high);
    // A second audience on the same uncertainty: only the better one is batched.
    const search = uncertainty({ resolution: 'SEARCH', risk: 'LOW' });
    draft(search);
    draft(search, { audience: 'EXTERNAL', text: 'ask the vendor' });

    const batch = nextQuestionBatch(mind.state);
    // Blocking scores above zero; the rest score 0 and fall back to risk, then age.
    expect(batch.map((b) => b.question.id)).toEqual([qBlocking, qHigh, qLow, 'qst-4']);
    expect(batch[0]?.score.value).toBeGreaterThan(0);
    expect(nextQuestionBatch(mind.state, { limit: 2 }).map((b) => b.question.id)).toEqual([qBlocking, qHigh]);
    expect(nextQuestionBatch(mind.state, { audience: 'EXTERNAL' }).map((b) => b.question.id)).toEqual(['qst-5']);
    expect(nextQuestionBatch(mind.state, { limit: 0 })).toEqual([]);

    ask(qBlocking);
    mind.run(SYSTEM, { kind: 'RESOLVE_UNCERTAINTY', uncertaintyId: search, evidence: ['found'] });
    expect(nextQuestionBatch(mind.state).map((b) => b.question.id)).toEqual([qHigh, qLow]);
  });

  it('skips a draft whose words a human has since decided elsewhere', () => {
    const first = draft(uncertainty(), { text: 'Which region?' });
    const second = draft(uncertainty({ statement: 'again' }), { text: 'which region' });
    ask(first);
    respond(first, { kind: 'ANSWER', text: 'eu-west-1' });
    expect(nextQuestionBatch(mind.state).map((b) => b.question.id)).not.toContain(second);
  });

  it('refuses a limit that is not a whole number of questions', () => {
    expect(() => nextQuestionBatch(mind.state, { limit: -1 })).toThrow(/whole number/);
    expect(() => nextQuestionBatch(mind.state, { limit: 1.5 })).toThrow(/whole number/);
  });

  it('breaks an exact tie on value and risk by age', () => {
    const older = draft(uncertainty());
    const newer = draft(uncertainty({ statement: 'twin' }));
    expect(nextQuestionBatch(mind.state).map((b) => b.question.id)).toEqual([older, newer]);
  });

  it('uses an injected scorer for the live score', () => {
    const q = draft(uncertainty());
    const flat: QuestionScorer = {
      name: 'test.flat',
      version: 3,
      score: () => ({ informationGain: 0.5, decisionImpact: 0.5, riskReduction: 1, dependencyCoverage: 1 }),
    };
    const [only] = nextQuestionBatch(mind.state, { scorer: flat });
    expect(only?.question.id).toBe(q);
    expect(only?.score).toMatchObject({ value: 0.25, scorer: { name: 'test.flat', version: 3 } });
  });
});

describe('the interface’s view (ADR-0015 rule 3)', () => {
  it('lists asked human questions whose uncertainty is still open, best recorded score first', () => {
    const low = asked({ risk: 'LOW' });
    const high = asked({ risk: 'HIGH' });
    draft(uncertainty());
    asked({ resolution: 'SEARCH' });
    const moot = asked({ resolution: 'SEARCH', risk: 'CRITICAL' }, { audience: 'HUMAN' });
    mind.run(HUMAN, {
      kind: 'RESOLVE_UNCERTAINTY',
      uncertaintyId: mind.state.questions[moot]?.uncertaintyId,
      evidence: ['settled elsewhere'],
    });
    expect(pendingHumanQuestions(mind.state).map((q) => q.id)).toEqual([high, low]);
  });

  it('shows the question with its goals, beliefs, contradiction and the responses open to a person', () => {
    mind.run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'ship', priority: 7, successCriteria: [testCriterion()] });
    const goal = mind.lastId('goal');
    const b = belief();
    mind.run(SYSTEM, { kind: 'ADD_BELIEF_EVIDENCE', beliefId: b, polarity: 'SUPPORTING', evidence: evidence('run-3') });
    const unknown = belief({ state: 'UNKNOWN', statement: 'unknown one' });
    const q = asked({ blocksGoalIds: [goal], relatedBeliefs: [b, unknown] });
    const view = questionView(mind.state, q);
    expect(view.goals).toEqual([{ id: goal, description: 'ship', status: 'PROPOSED', priority: 7 }]);
    expect(view.beliefs.map((x) => [x.id, x.state, x.evidence])).toEqual([
      [b, 'ASSUMED', ['run-3']],
      [unknown, 'UNKNOWN', []],
    ]);
    expect(view.contradiction).toBeNull();
    expect(view.allowedResponses).toEqual(['ANSWER', 'REJECT_ASSUMPTION', 'ACCEPT_RISK']);
    expect(view.requiresGoverningSide).toBe(false);
    expect(questionsFor(mind.state, view.uncertainty.id).map((x) => x.id)).toEqual([q]);
  });

  it('offers no REJECT_ASSUMPTION when nothing is assumed, or when a contradiction must be decided', () => {
    const nothing = asked({ relatedBeliefs: [belief({ state: 'UNKNOWN' })] });
    expect(questionView(mind.state, nothing).allowedResponses).toEqual(['ANSWER', 'ACCEPT_RISK']);

    const { contradiction, uncertainty: u } = escalated();
    const q = draft(u);
    ask(q);
    const view = questionView(mind.state, q);
    expect(view.allowedResponses).toEqual(['ANSWER', 'ACCEPT_RISK']);
    expect(view.requiresGoverningSide).toBe(true);
    expect(view.contradiction?.id).toBe(contradiction);
  });

  it('offers nothing for a question that is not open to a response', () => {
    const d = draft(uncertainty());
    expect(questionView(mind.state, d).allowedResponses).toEqual([]);
    const u = uncertainty({ resolution: 'SEARCH' });
    const q = draft(u, { audience: 'HUMAN' });
    ask(q);
    mind.run(HUMAN, { kind: 'RESOLVE_UNCERTAINTY', uncertaintyId: u, evidence: ['elsewhere'] });
    expect(questionView(mind.state, q).allowedResponses).toEqual([]);
  });

  it('shows a missing contradiction as missing rather than inventing one', () => {
    const { contradiction, uncertainty: u } = escalated();
    const q = draft(u);
    const { [contradiction]: _dropped, ...rest } = mind.state.contradictions;
    const damaged: CognitionState = { ...mind.state, contradictions: rest };
    expect(questionView(damaged, q).contradiction).toBeNull();
  });

  it('refuses an unknown question', () => {
    expect(() => questionView(mind.state, 'qst-404')).toThrow(/no question qst-404/);
  });
});

describe('text normalisation', () => {
  it('ignores case, spacing and trailing question marks, nothing else', () => {
    expect(normalizeQuestionText('  Which   REGION??  ')).toBe('which region');
    expect(normalizeQuestionText('which region?')).toBe(normalizeQuestionText('Which region'));
    expect(normalizeQuestionText('which regions')).not.toBe(normalizeQuestionText('which region'));
  });
});
