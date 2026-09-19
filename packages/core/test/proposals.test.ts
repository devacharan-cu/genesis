/**
 * The door from model output to state (ADR-0018 §3). Every way through it is
 * named here, and every way it should stay shut.
 */

import {
  buildReasoningRequest,
  checkEnvelope,
  checkProposal,
  MAX_PROPOSALS,
  PROPOSAL_KINDS,
  PROPOSAL_OUTPUT_SCHEMA,
  PROPOSAL_SCHEMAS,
  requestHash,
  responseHash,
  SYSTEM_PROMPT,
  toCommand,
} from '@genesis/core';
import type { ContextCandidate } from '@genesis/context';
import type { JsonValue } from '@genesis/core-types';
import { describe, expect, it } from 'vitest';

const served = { rationale: 'because', contributesTo: ['goal-1'] };

const VALID = {
  RECORD_BELIEF: { kind: 'RECORD_BELIEF', ...served, statement: 's', state: 'ASSUMED', confidence: 0.4, subjectRefs: [{ nodeType: 'API', nodeId: 'n' }] },
  RECORD_UNCERTAINTY: {
    kind: 'RECORD_UNCERTAINTY',
    ...served,
    statement: 's',
    whatBreaksIfWrong: 'w',
    risk: 'LOW',
    resolution: 'SEARCH',
    blocksGoalIds: ['goal-1'],
    relatedBeliefs: ['bel-1'],
    affectedRefs: [{ nodeType: 'API', nodeId: 'n' }],
  },
  DRAFT_QUESTION: { kind: 'DRAFT_QUESTION', ...served, uncertaintyId: 'unc-1', text: 'q?', reason: 'r', audience: 'HUMAN' },
  RECORD_CONTRADICTION: {
    kind: 'RECORD_CONTRADICTION',
    ...served,
    contradictionKind: 'BELIEF_EVIDENCE',
    sides: [
      { kind: 'BELIEF', beliefId: 'bel-1' },
      { kind: 'EXTERNAL', id: 'x', claim: 'c', authority: 'EVIDENCE' },
    ],
    affectedRefs: [],
    risk: 'HIGH',
    blocksGoalIds: [],
  },
} as const;

describe('checkEnvelope', () => {
  it('accepts an object holding a bounded list, and nothing else', () => {
    expect(checkEnvelope({ proposals: [] })).toEqual({ ok: true, items: [] });
    for (const bad of [[], 'text', null, { proposals: 'x' }, { proposals: [], extra: 1 }, { proposals: Array(MAX_PROPOSALS + 1).fill({}) }]) {
      const check = checkEnvelope(bad as JsonValue);
      expect(check.ok).toBe(false);
    }
    expect(checkEnvelope('text')).toMatchObject({ ok: false, issues: [expect.stringMatching(/^<root>/) as string] });
  });
});

describe('checkProposal', () => {
  it('accepts each permitted kind in its full shape', () => {
    for (const kind of PROPOSAL_KINDS) expect(checkProposal(VALID[kind])).toMatchObject({ ok: true, proposal: { kind } });
  });

  it('refuses what has no kind, a kind a model may not propose, and any field it may not set', () => {
    expect(checkProposal(42)).toMatchObject({ ok: false, reason: 'MALFORMED', kind: null });
    expect(checkProposal(null)).toMatchObject({ ok: false, reason: 'MALFORMED', kind: null });
    expect(checkProposal({ kind: 7 })).toMatchObject({ ok: false, reason: 'MALFORMED', kind: null });
    for (const kind of ['RESOLVE_UNCERTAINTY', 'TRANSITION_BELIEF', 'SATISFY_GOAL', 'ASK_QUESTIONS', 'RESPOND_TO_QUESTION', 'RESOLVE_CONTRADICTION']) {
      expect(checkProposal({ ...served, kind })).toMatchObject({ ok: false, reason: 'NOT_PERMITTED', kind });
    }
    // The core's fields: a model cannot set them.
    for (const [kind, field, value] of [
      ['RECORD_BELIEF', 'authority', 'HUMAN_DECISION'],
      ['RECORD_BELIEF', 'reasoningCallId', 'rsn_forged'],
      ['RECORD_UNCERTAINTY', 'source', 'CONTRADICTION'],
      ['DRAFT_QUESTION', 'evidenceRefs', ['e']],
    ] as const) {
      expect(checkProposal({ ...VALID[kind], [field]: value })).toMatchObject({ ok: false, reason: 'MALFORMED', kind });
    }
  });

  it('requires a rationale and at least one goal', () => {
    const { rationale: _r, ...noRationale } = VALID.RECORD_BELIEF;
    expect(checkProposal(noRationale)).toMatchObject({ ok: false, reason: 'MALFORMED' });
    expect(checkProposal({ ...VALID.RECORD_BELIEF, contributesTo: [] })).toMatchObject({ ok: false, reason: 'MALFORMED' });
  });
});

describe('toCommand', () => {
  it('strips what only the proposal needs, and sets a belief’s call itself', () => {
    const belief = checkProposal(VALID.RECORD_BELIEF);
    if (!belief.ok) throw new Error('fixture');
    expect(toCommand(belief.proposal, 'rsn_1')).toEqual({
      kind: 'RECORD_BELIEF',
      statement: 's',
      state: 'ASSUMED',
      confidence: 0.4,
      subjectRefs: [{ nodeType: 'API', nodeId: 'n' }],
      rationale: 'because',
      reasoningCallId: 'rsn_1',
    });
    for (const kind of ['RECORD_UNCERTAINTY', 'DRAFT_QUESTION', 'RECORD_CONTRADICTION'] as const) {
      const check = checkProposal(VALID[kind]);
      if (!check.ok) throw new Error('fixture');
      const command = toCommand(check.proposal, 'rsn_1');
      expect(command).not.toHaveProperty('rationale');
      expect(command).not.toHaveProperty('contributesTo');
      expect(command['kind']).toBe(kind);
    }
  });
});

describe('the JSON Schema the model is given', () => {
  const variants = ((PROPOSAL_OUTPUT_SCHEMA['properties'] as Record<string, JsonValue>)['proposals'] as {
    items: { oneOf: { required: string[]; properties: Record<string, { const?: string }> }[] };
  }).items.oneOf;

  it('describes exactly the fields each zod schema accepts, and requires exactly the required ones', () => {
    expect(variants.map((v) => v.properties['kind']?.const)).toEqual([...PROPOSAL_KINDS]);
    for (const variant of variants) {
      const kind = variant.properties['kind']?.const as (typeof PROPOSAL_KINDS)[number];
      const shape = PROPOSAL_SCHEMAS[kind].shape as Record<string, { isOptional(): boolean }>;
      expect(Object.keys(variant.properties).sort()).toEqual(Object.keys(shape).sort());
      const required = Object.keys(shape).filter((k) => !shape[k]?.isOptional());
      expect([...variant.required].sort()).toEqual(required.sort());
    }
  });

  it('bounds the list as the envelope does', () => {
    const proposals = (PROPOSAL_OUTPUT_SCHEMA['properties'] as Record<string, { maxItems: number }>)['proposals'];
    expect(proposals?.maxItems).toBe(MAX_PROPOSALS);
  });
});

describe('buildReasoningRequest', () => {
  const candidate = (id: string, authority: ContextCandidate['authority']): ContextCandidate => ({
    id,
    kind: 'BELIEF',
    text: `text of ${id}`,
    authority,
    goalDistance: null,
    dependencyDistance: null,
    evidenceStrength: 0,
    timestamp: null,
    mandatory: null,
    source: { store: 'COGNITION', id, version: null },
  });

  it('passes established context as context, and a model’s or nobody’s claims as untrusted', () => {
    const request = buildReasoningRequest(
      'rsn_1',
      'do the task',
      [candidate('a', 'HUMAN_DECISION'), candidate('b', 'AI_ASSUMPTION'), candidate('c', 'UNGROUNDED'), candidate('d', 'EVIDENCE')],
      { maxOutputTokens: 100, timeoutMs: 1000 },
    );
    expect(request.context.map((b) => b.id)).toEqual(['a', 'd']);
    expect(request.untrustedContent).toEqual([
      { source: 'b (BELIEF, AI_ASSUMPTION)', text: 'text of b' },
      { source: 'c (BELIEF, UNGROUNDED)', text: 'text of c' },
    ]);
    expect(request).toMatchObject({
      callId: 'rsn_1',
      purpose: 'PROPOSE_COGNITIVE_UPDATES',
      system: SYSTEM_PROMPT,
      task: 'do the task',
      outputSchema: PROPOSAL_OUTPUT_SCHEMA,
      budget: { maxOutputTokens: 100, timeoutMs: 1000 },
    });
  });

  it('hashes a request by content, whatever order its keys were written in', () => {
    const request = buildReasoningRequest('rsn_1', 't', [], { maxOutputTokens: 1, timeoutMs: 1 });
    const reordered = Object.fromEntries(Object.entries(request).reverse()) as typeof request;
    expect(requestHash(reordered)).toBe(requestHash(request));
    expect(requestHash({ ...request, task: 'u' })).not.toBe(requestHash(request));
    expect(responseHash('{}')).toMatch(/^[0-9a-f]{64}$/);
  });
});
