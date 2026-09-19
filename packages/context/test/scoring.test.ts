/**
 * The retrieval signals and their defaults (SPEC-01 §11.2, ADR-0017). Pinned
 * to exact values: a change is a failing test and a version bump.
 */

import {
  authoritySignal,
  charTokenEstimator,
  DEFAULT_CONTEXT_WEIGHTS,
  distanceSignal,
  lexicalRelevance,
  parseOrRefuse,
  parseWeights,
  recencySignal,
  SIGNALS,
  terms,
} from '@genesis/context';
import { AUTHORITY_LEVELS, ValidationError } from '@genesis/core-types';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

describe('terms', () => {
  it('lowercases, drops stopwords and one-letter words, and keeps non-English letters', () => {
    expect([...terms('The Booking API: cancel a booking, x!')].sort()).toEqual(['api', 'booking', 'cancel']);
    expect([...terms('Straße über café 42')].sort()).toEqual(['42', 'café', 'straße', 'über']);
    expect(terms('!!! ??')).toEqual(new Set());
  });
});

describe('lexicalRelevance', () => {
  it('is the share of the task’s terms the text contains', () => {
    expect(lexicalRelevance.score('cancel a booking', 'Booking cancellation rules')).toBe(0.5);
    expect(lexicalRelevance.score('cancel booking', 'cancel the booking')).toBe(1);
    expect(lexicalRelevance.score('cancel booking', 'deploy region')).toBe(0);
  });

  it('scores everything 0 against a task with no terms', () => {
    expect(lexicalRelevance.score('the of a', 'anything at all')).toBe(0);
  });

  it('is named and versioned', () => {
    expect([lexicalRelevance.name, lexicalRelevance.version]).toEqual(['genesis.lexical-term-coverage', 1]);
  });
});

describe('charTokenEstimator', () => {
  it('is characters over four, rounded up', () => {
    expect(['', 'a', 'abcd', 'abcde'].map((t) => charTokenEstimator.estimate(t))).toEqual([0, 1, 1, 2]);
  });
});

describe('signals', () => {
  it('ranks authority from 1 (human decision) to 0 (ungrounded), evenly', () => {
    expect(authoritySignal('HUMAN_DECISION')).toBe(1);
    expect(authoritySignal('UNGROUNDED')).toBe(0);
    const all = AUTHORITY_LEVELS.map(authoritySignal);
    expect([...all].sort((a, b) => b - a)).toEqual(all);
  });

  it('turns a distance into 1 / (1 + d), and no connection into 0', () => {
    expect([0, 1, 3].map(distanceSignal)).toEqual([1, 0.5, 0.25]);
    expect(distanceSignal(null)).toBe(0);
  });

  it('halves recency every half-life, never counts the future as newer, and gives no time 0', () => {
    const asOf = '2026-03-31T00:00:00.000Z';
    expect(recencySignal(asOf, asOf, 30)).toBe(1);
    expect(recencySignal('2026-03-01T00:00:00.000Z', asOf, 30)).toBe(0.5);
    expect(recencySignal('2026-01-30T00:00:00.000Z', asOf, 30)).toBe(0.25);
    expect(recencySignal('2027-01-01T00:00:00.000Z', asOf, 30)).toBe(1);
    expect(recencySignal(null, asOf, 30)).toBe(0);
  });
});

describe('weights', () => {
  it('accepts the SPEC-01 defaults, which sum to 1', () => {
    expect(parseWeights(DEFAULT_CONTEXT_WEIGHTS)).toEqual(DEFAULT_CONTEXT_WEIGHTS);
    expect(SIGNALS.reduce((s, k) => s + DEFAULT_CONTEXT_WEIGHTS[k], 0)).toBeCloseTo(1, 12);
  });

  it('refuses a missing, extra, negative or non-finite weight', () => {
    const { recency: _dropped, ...missing } = DEFAULT_CONTEXT_WEIGHTS;
    for (const bad of [
      missing,
      { ...DEFAULT_CONTEXT_WEIGHTS, novelty: 0 },
      { ...DEFAULT_CONTEXT_WEIGHTS, relevance: -0.1, authority: 0.65 },
      { ...DEFAULT_CONTEXT_WEIGHTS, relevance: Number.NaN },
      null,
    ]) {
      expect(() => parseWeights(bad)).toThrow(ValidationError);
    }
  });

  it('refuses weights that do not sum to 1', () => {
    expect(() => parseWeights({ ...DEFAULT_CONTEXT_WEIGHTS, relevance: 0.5 })).toThrow(/sum to 1/);
  });
});

describe('parseOrRefuse', () => {
  it('names the field that failed, and the root when there is none', () => {
    const schema = z.object({ n: z.number() }).strict();
    expect(parseOrRefuse(schema, { n: 1 }, 'thing')).toEqual({ n: 1 });
    try {
      parseOrRefuse(schema, { n: 'x' }, 'thing');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toMatchObject({ issues: [expect.stringMatching(/^n:/) as string] });
    }
    expect(() => parseOrRefuse(schema, 'x', 'thing')).toThrow(/invalid thing/);
  });
});
