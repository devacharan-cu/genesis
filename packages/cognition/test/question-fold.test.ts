/**
 * The question fold's defensive paths (ADR-0014 rule 3, ADR-0013 rule 4).
 *
 * No decider produces these events; tampering, an upstream bug or another
 * version of the code would. Each must change nothing but the observation log,
 * and say what it refused.
 */

import { type CognitionState, type CognitiveEventInput, decide } from '@genesis/cognition';
import type { JsonValue } from '@genesis/core-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { HUMAN, Mind, SYSTEM } from './support.js';

let mind: Mind;
let uncertaintyId: string;

beforeEach(() => {
  mind = new Mind();
  mind.run(SYSTEM, {
    kind: 'RECORD_UNCERTAINTY',
    statement: 's',
    whatBreaksIfWrong: 'w',
    risk: 'LOW',
    resolution: 'ASK_HUMAN',
  });
  uncertaintyId = mind.lastId('uncertainty');
});

const withoutLog = (s: CognitionState): Omit<CognitionState, 'observations'> => {
  const { observations: _ignored, ...rest } = s;
  return rest;
};

function expectAnomaly(kind: string, type: string, payload: JsonValue): void {
  const before = withoutLog(mind.state);
  const count = mind.state.observations.anomalies.length;
  mind.fold({ type, actor: HUMAN, authority: 'HUMAN_DECISION', subject: null, payload, timestamp: '2026-01-01T00:00:00.000Z' });
  expect(withoutLog(mind.state), 'the fold must not apply it').toEqual(before);
  expect(mind.state.observations.anomalies).toHaveLength(count + 1);
  expect(mind.state.observations.anomalies.at(-1)?.kind).toBe(kind);
}

/** The first event a command WOULD produce, as a mutable payload. */
const first = (command: unknown, actor = SYSTEM): { type: string; payload: Record<string, JsonValue> } => {
  const [input] = decide(mind.state, command, mind.ctx(actor)) as [CognitiveEventInput];
  return { type: input.type, payload: input.payload as Record<string, JsonValue> };
};

const drafted = () => first({ kind: 'DRAFT_QUESTION', uncertaintyId, text: 'q?' });
const draftedQuestion = () => drafted().payload['question'] as Record<string, JsonValue>;

const draftAndAsk = (): string => {
  mind.run(SYSTEM, { kind: 'DRAFT_QUESTION', uncertaintyId, text: 'q?' });
  const id = mind.lastId('question');
  mind.run(SYSTEM, { kind: 'ASK_QUESTIONS', questionIds: [id] });
  return id;
};

describe('QUESTION_DRAFTED', () => {
  it('refuses a malformed payload', () => {
    expectAnomaly('MALFORMED_PAYLOAD', 'QUESTION_DRAFTED', { question: 'no' });
  });

  it('refuses a question that already exists', () => {
    const event = drafted();
    mind.fold({ ...event, actor: SYSTEM, authority: 'VERIFIED_SYSTEM_STATE', subject: null, timestamp: '2026-01-01T00:00:00.000Z' });
    expectAnomaly('STATE_MISMATCH', event.type, event.payload);
  });

  it.each([
    ['status', 'ASKED'],
    ['askedAt', '2026-01-01T00:00:00.000Z'],
    ['closedAt', '2026-01-01T00:00:00.000Z'],
    ['outcome', { changedPlan: true, beliefsTransitioned: [], recordedBy: { actorKind: 'HUMAN', actorId: 'x' }, recordedAt: 't' }],
    [
      'response',
      {
        kind: 'ANSWER',
        text: 't',
        authority: 'HUMAN_DECISION',
        respondedBy: { actorKind: 'HUMAN', actorId: 'x' },
        respondedAt: 't',
        respondedSeq: 1,
        evidence: [],
        governingSide: null,
        supportsBeliefIds: [],
        contradictsBeliefIds: [],
        rejectedBeliefIds: [],
      },
    ],
  ] as const)('refuses a question born with %s already set', (field: string, value: unknown) => {
    expectAnomaly('STATE_MISMATCH', 'QUESTION_DRAFTED', { question: { ...draftedQuestion(), [field]: value as JsonValue } });
  });

  it('refuses a question about an unknown uncertainty, goal or belief', () => {
    expectAnomaly('UNKNOWN_REFERENCE', 'QUESTION_DRAFTED', { question: { ...draftedQuestion(), uncertaintyId: 'unc-404' } });
    expectAnomaly('UNKNOWN_REFERENCE', 'QUESTION_DRAFTED', { question: { ...draftedQuestion(), affectedGoalIds: ['goal-404'] } });
    expectAnomaly('UNKNOWN_REFERENCE', 'QUESTION_DRAFTED', { question: { ...draftedQuestion(), relatedBeliefIds: ['bel-404'] } });
    expect(mind.state.observations.anomalies.at(-1)?.detail).toMatch(/bel-404/);
  });
});

describe('QUESTION_ASKED', () => {
  it('refuses an unknown question, and one not in DRAFT', () => {
    const q = draftAndAsk();
    const score = mind.state.questions[q]?.score as unknown as JsonValue;
    expectAnomaly('UNKNOWN_REFERENCE', 'QUESTION_ASKED', { questionId: 'qst-404', score });
    expectAnomaly('STATE_MISMATCH', 'QUESTION_ASKED', { questionId: q, score });
    expectAnomaly('MALFORMED_PAYLOAD', 'QUESTION_ASKED', { questionId: q });
  });
});

describe('QUESTION_RESPONDED', () => {
  const response = {
    kind: 'ANSWER',
    text: 't',
    evidence: [],
    governingSide: null,
    supportsBeliefIds: [],
    contradictsBeliefIds: [],
    rejectedBeliefIds: [],
  };

  it('refuses an unknown question, one not ASKED, and a response carrying its own authority', () => {
    mind.run(SYSTEM, { kind: 'DRAFT_QUESTION', uncertaintyId, text: 'q?' });
    const q = mind.lastId('question');
    expectAnomaly('UNKNOWN_REFERENCE', 'QUESTION_RESPONDED', { questionId: 'qst-404', response });
    expectAnomaly('STATE_MISMATCH', 'QUESTION_RESPONDED', { questionId: q, response });
    // Who answered, and with what authority, are the event's own fields.
    expectAnomaly('MALFORMED_PAYLOAD', 'QUESTION_RESPONDED', {
      questionId: q,
      response: { ...response, authority: 'HUMAN_DECISION' },
    });
  });
});

describe('QUESTION_CLOSED', () => {
  it('refuses an unknown question and every move no decider makes', () => {
    mind.run(SYSTEM, { kind: 'DRAFT_QUESTION', uncertaintyId, text: 'q?' });
    const draft = mind.lastId('question');
    expectAnomaly('UNKNOWN_REFERENCE', 'QUESTION_CLOSED', { questionId: 'qst-404', from: 'DRAFT', to: 'WITHDRAWN', reason: 'r' });
    // The wrong `from`.
    expectAnomaly('STATE_MISMATCH', 'QUESTION_CLOSED', { questionId: draft, from: 'ASKED', to: 'WITHDRAWN', reason: 'r' });
    // A draft was never asked, so it cannot be unanswerable.
    expectAnomaly('STATE_MISMATCH', 'QUESTION_CLOSED', { questionId: draft, from: 'DRAFT', to: 'UNANSWERABLE', reason: 'r' });

    mind.run(SYSTEM, { kind: 'ASK_QUESTIONS', questionIds: [draft] });
    mind.run(HUMAN, { kind: 'RESPOND_TO_QUESTION', questionId: draft, response: { kind: 'ANSWER', text: 'a' } });
    // Terminal stays terminal.
    expectAnomaly('STATE_MISMATCH', 'QUESTION_CLOSED', { questionId: draft, from: 'ANSWERED', to: 'WITHDRAWN', reason: 'r' });
  });
});

describe('QUESTION_OUTCOME_RECORDED', () => {
  const outcome = { changedPlan: true, beliefsTransitioned: [] };

  it('refuses an unknown question, one not answered, and a second outcome', () => {
    const q = draftAndAsk();
    expectAnomaly('UNKNOWN_REFERENCE', 'QUESTION_OUTCOME_RECORDED', { questionId: 'qst-404', outcome });
    expectAnomaly('STATE_MISMATCH', 'QUESTION_OUTCOME_RECORDED', { questionId: q, outcome });
    mind.run(HUMAN, { kind: 'RESPOND_TO_QUESTION', questionId: q, response: { kind: 'ANSWER', text: 'a' } });
    mind.run(HUMAN, { kind: 'RECORD_QUESTION_OUTCOME', questionId: q, changedPlan: false });
    expectAnomaly('STATE_MISMATCH', 'QUESTION_OUTCOME_RECORDED', { questionId: q, outcome });
  });
});
