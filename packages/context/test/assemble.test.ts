/**
 * Context assembly (SPEC-01 §11, ADR-0017). Mandatory context is never crowded
 * out, overflow splits the task rather than dropping anything, and every
 * assembly is explainable and exactly repeatable.
 */

import {
  assembleContext,
  type ContextCandidate,
  CONTEXT_ASSEMBLED,
  contextAssembledEvent,
  DEFAULT_CONTEXT_WEIGHTS,
  type RelevanceScorer,
  type TokenEstimator,
} from '@genesis/context';
import { EventInput, JsonValue, ValidationError } from '@genesis/core-types';
import { describe, expect, it } from 'vitest';
import { AGENT, AS_OF, HUMAN, request, SYSTEM } from './support.js';

const candidate = (id: string, over: Partial<ContextCandidate> = {}): ContextCandidate => ({
  id,
  kind: 'MEMORY',
  text: `about ${id}`,
  authority: 'EVIDENCE',
  goalDistance: null,
  dependencyDistance: null,
  evidenceStrength: 0,
  timestamp: null,
  mandatory: null,
  source: { store: 'MEMORY', id, version: 1 },
  ...over,
});

/** One token per character, so budgets in tests are easy to reason about. */
const perChar: TokenEstimator = { name: 'test.per-char', version: 1, estimate: (t) => t.length };

describe('scoring and selection', () => {
  it('scores on the six weighted signals and records every one', () => {
    const c = candidate('memory:a', {
      text: 'booking cancellation',
      authority: 'HUMAN_DECISION',
      goalDistance: 1,
      dependencyDistance: 0,
      evidenceStrength: 0.5,
      timestamp: AS_OF,
    });
    const { manifest, items } = assembleContext(request(), [c]);
    expect(items).toEqual([c]);
    const [entry] = manifest.entries;
    expect(entry?.signals).toEqual({ relevance: 2 / 3, authority: 1, goal: 0.5, dependency: 1, evidence: 0.5, recency: 1 });
    const expected = 0.3 * (2 / 3) + 0.25 * 1 + 0.15 * 0.5 + 0.15 * 1 + 0.1 * 0.5 + 0.05 * 1;
    expect(entry?.score).toBeCloseTo(expected, 12);
    expect(manifest).toMatchObject({
      status: 'ASSEMBLED',
      taskId: 'task-1',
      taskKind: 'implement',
      activeGoalId: null,
      asOf: AS_OF,
      weights: DEFAULT_CONTEXT_WEIGHTS,
      relevanceScorer: { name: 'genesis.lexical-term-coverage', version: 1 },
      tokenEstimator: { name: 'genesis.chars-over-four', version: 1 },
      recencyHalfLifeDays: 30,
      minScore: 0,
      usedTokens: 5,
      mandatoryTokens: 0,
    });
  });

  it('puts mandatory items first, in reason order, and never scores them', () => {
    const out = assembleContext(request(), [
      candidate('m:failure', { kind: 'KNOWN_FAILURE', mandatory: 'MATCHING_FAILURE' }),
      candidate('m:policy', { kind: 'POLICY', mandatory: 'POLICY' }),
      candidate('m:contradiction-b', { kind: 'CONTRADICTION', mandatory: 'CONTRADICTION_IN_IMPACT' }),
      candidate('m:contradiction-a', { kind: 'CONTRADICTION', mandatory: 'CONTRADICTION_IN_IMPACT' }),
      candidate('m:blocking', { kind: 'UNCERTAINTY', mandatory: 'BLOCKING_UNCERTAINTY' }),
      candidate('scored', { authority: 'HUMAN_DECISION' }),
    ]);
    expect(out.items.map((c) => c.id)).toEqual([
      'm:policy',
      'm:blocking',
      'm:contradiction-a',
      'm:contradiction-b',
      'm:failure',
      'scored',
    ]);
    expect(out.manifest.entries.slice(0, 5).every((e) => e.signals === null && e.score === null)).toBe(true);
  });

  it('takes the best that fit, skips what does not, and lets a smaller one after it in', () => {
    const { manifest, items } = assembleContext(
      request({ budgetTokens: 20 }),
      [
        candidate('big', { text: 'x'.repeat(15), authority: 'HUMAN_DECISION' }),
        candidate('huge', { text: 'y'.repeat(30), authority: 'HUMAN_DECISION', evidenceStrength: 1 }),
        candidate('small', { text: 'z'.repeat(5), authority: 'UNGROUNDED' }),
        candidate('tiny', { text: 'w', authority: 'UNGROUNDED' }),
      ],
      { tokens: perChar },
    );
    expect(items.map((c) => c.id)).toEqual(['big', 'small']);
    expect(manifest.usedTokens).toBe(20);
    expect(manifest.entries.map((e) => [e.id, e.included, e.exclusion])).toEqual([
      ['big', true, null],
      ['small', true, null],
      ['huge', false, 'BUDGET'],
      ['tiny', false, 'BUDGET'],
    ]);
  });

  it('breaks score ties by id, so the order never depends on input order', () => {
    const a = candidate('a');
    const b = candidate('b');
    expect(assembleContext(request(), [b, a]).items.map((c) => c.id)).toEqual(['a', 'b']);
    expect(assembleContext(request(), [a, b]).items.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('excludes what scores below the minimum', () => {
    const { manifest } = assembleContext(request(), [candidate('weak', { authority: 'UNGROUNDED' })], { minScore: 0.5 });
    expect(manifest.entries[0]).toMatchObject({ included: false, exclusion: 'BELOW_MIN_SCORE' });
  });
});

describe('mandatory overflow (SPEC-01 §11.3)', () => {
  it('returns SPLIT_REQUIRED and no context rather than drop a mandatory item', () => {
    const { manifest, items } = assembleContext(
      request({ budgetTokens: 10 }),
      [
        candidate('policy', { kind: 'POLICY', text: 'p'.repeat(8), mandatory: 'POLICY' }),
        candidate('failure', { kind: 'KNOWN_FAILURE', text: 'f'.repeat(8), mandatory: 'MATCHING_FAILURE' }),
        candidate('other', { text: 'o' }),
      ],
      { tokens: perChar },
    );
    expect(items).toEqual([]);
    expect(manifest).toMatchObject({ status: 'SPLIT_REQUIRED', usedTokens: 0, mandatoryTokens: 16, budgetTokens: 10 });
    expect(manifest.entries.map((e) => [e.id, e.exclusion])).toEqual([
      ['failure', 'MANDATORY_OVERFLOW'],
      ['other', 'BUDGET'],
      ['policy', 'MANDATORY_OVERFLOW'],
    ]);
  });

  it('fills exactly to the budget with mandatory items', () => {
    const { manifest } = assembleContext(
      request({ budgetTokens: 8 }),
      [candidate('policy', { kind: 'POLICY', text: 'p'.repeat(8), mandatory: 'POLICY' })],
      { tokens: perChar },
    );
    expect(manifest).toMatchObject({ status: 'ASSEMBLED', usedTokens: 8 });
  });
});

describe('inputs are checked', () => {
  it('refuses an invalid request, candidate or duplicate', () => {
    expect(() => assembleContext({ ...request(), budgetTokens: 0 }, [])).toThrow(/invalid context request/);
    expect(() => assembleContext(request(), [{ ...candidate('a'), timestamp: 'yesterday' }])).toThrow(/context candidate 0/);
    expect(() => assembleContext(request(), [candidate('a'), candidate('a')])).toThrow(/duplicate context candidate a/);
  });

  it('refuses bad options and a scorer or estimator that returns nonsense', () => {
    const badRelevance: RelevanceScorer = { name: 'test.bad', version: 1, score: () => 2 };
    const badTokens: TokenEstimator = { name: 'test.bad', version: 1, estimate: () => 1.5 };
    const one = [candidate('a')];
    expect(() => assembleContext(request(), one, { relevance: badRelevance })).toThrow(/relevance scorer test.bad/);
    expect(() => assembleContext(request(), one, { tokens: badTokens })).toThrow(/token estimator test.bad/);
    expect(() => assembleContext(request(), one, { recencyHalfLifeDays: 0 })).toThrow(ValidationError);
    expect(() => assembleContext(request(), one, { minScore: 2 })).toThrow(ValidationError);
    expect(() => assembleContext(request(), one, { weights: { ...DEFAULT_CONTEXT_WEIGHTS, recency: 0.5 } })).toThrow(/sum to 1/);
  });
});

describe('determinism and explanation', () => {
  it('gives the identical manifest for the same inputs, whatever order the weights were written in', () => {
    const inputs = [candidate('a', { timestamp: '2026-02-01T00:00:00.000Z', goalDistance: 2 }), candidate('b', { evidenceStrength: 0.3 })];
    const reordered = Object.fromEntries(Object.entries(DEFAULT_CONTEXT_WEIGHTS).reverse()) as typeof DEFAULT_CONTEXT_WEIGHTS;
    const first = assembleContext(request(), inputs);
    const second = assembleContext(request(), [...inputs].reverse(), { weights: reordered });
    expect(JSON.stringify(second.manifest.entries)).toBe(JSON.stringify(first.manifest.entries));
  });

  it('is recorded as a CONTEXT_ASSEMBLED event the ledger will accept, by the system only', () => {
    const { manifest } = assembleContext(request(), [candidate('a'), candidate('p', { mandatory: 'POLICY', kind: 'POLICY' })]);
    const provenance = {
      asOfSeq: 7,
      impact: [{ nodeId: 'node_01ARZ3NDEKTSV4RRFFQ69G5FA1', depth: 1, weakestAuthorityRank: 4 }] as never,
    };
    const event = contextAssembledEvent(manifest, provenance, SYSTEM, AS_OF);
    expect(EventInput.safeParse(event).success).toBe(true);
    expect(JsonValue.safeParse(event.payload).success).toBe(true);
    expect(event).toMatchObject({
      type: CONTEXT_ASSEMBLED,
      authority: 'VERIFIED_SYSTEM_STATE',
      payload: { manifest, asOfSeq: 7, impact: [{ nodeId: 'node_01ARZ3NDEKTSV4RRFFQ69G5FA1', depth: 1, weakestAuthorityRank: 4 }] },
    });
    expect(() => contextAssembledEvent(manifest, provenance, AGENT, AS_OF)).toThrow(/recorded by the system, not by AGENT/);
    expect(() => contextAssembledEvent(manifest, provenance, HUMAN, AS_OF)).toThrow(ValidationError);
  });
});
