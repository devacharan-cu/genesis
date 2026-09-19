/**
 * The six retrieval signals and the replaceable parts behind them (SPEC-01
 * §11.2, ADR-0017).
 *
 * Each signal maps a candidate to [0, 1]. Two of them depend on judgement that
 * will improve — how relevant a text is, and how many tokens it costs — so they
 * are interfaces with named, versioned, deterministic defaults. The other four
 * are arithmetic on facts the candidate already carries.
 *
 * Nothing here calls a model. Embedding similarity (open decision E5) will be a
 * `RelevanceScorer` supplied from outside the core, behind the reasoning
 * provider port (ADR-0007).
 */

import { type Authority, AUTHORITY_LEVELS, authorityRank } from '@genesis/core-types';

export interface RelevanceScorer {
  readonly name: string;
  readonly version: number;
  /** How relevant `text` is to the task, in [0, 1]. Must be pure. */
  score(taskText: string, text: string): number;
}

export interface TokenEstimator {
  readonly name: string;
  readonly version: number;
  /** A whole, non-negative number of tokens. Must be pure. */
  estimate(text: string): number;
}

/** Words too common to say anything about relevance. Fixed, so scores are stable. */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from', 'has', 'have', 'how', 'if', 'in',
  'is', 'it', 'its', 'of', 'on', 'or', 'should', 'that', 'the', 'this', 'to', 'was', 'what', 'when',
  'which', 'who', 'will', 'with',
]);

/**
 * Lowercased terms of two or more letters or digits, minus stopwords. Unicode
 * letters count, so non-English text is not silently scored as empty.
 */
export function terms(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.filter((w) => w.length > 1 && !STOPWORDS.has(w)));
}

/**
 * The default relevance: the share of the task's terms the text contains.
 * Lexical only — it misses paraphrase, and ADR-0017 says so. A task with no
 * terms makes everything equally (ir)relevant: 0.
 */
export const lexicalRelevance: RelevanceScorer = {
  name: 'genesis.lexical-term-coverage',
  version: 1,
  score(taskText, text) {
    const wanted = terms(taskText);
    if (wanted.size === 0) return 0;
    const have = terms(text);
    let found = 0;
    for (const term of wanted) if (have.has(term)) found += 1;
    return found / wanted.size;
  },
};

/**
 * The default token estimate: a character count over four, rounded up. A
 * documented approximation, not a model's tokenizer (ADR-0017 rule 4).
 */
export const charTokenEstimator: TokenEstimator = {
  name: 'genesis.chars-over-four',
  version: 1,
  estimate: (text) => Math.ceil(text.length / 4),
};

/** Most authoritative 1, least 0, evenly spaced by rank (ADR-0005). */
export function authoritySignal(authority: Authority): number {
  return (AUTHORITY_LEVELS.length - authorityRank(authority)) / (AUTHORITY_LEVELS.length - 1);
}

/** 1 at distance 0, halving-ish with each step (1 / (1 + d)); 0 when unconnected. */
export function distanceSignal(distance: number | null): number {
  return distance === null ? 0 : 1 / (1 + distance);
}

export const DEFAULT_RECENCY_HALF_LIFE_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * 1 for something established at `asOf`, halving every `halfLifeDays` before
 * it; 0 when it has no time. A timestamp after `asOf` counts as `asOf`: the
 * future is not more recent than now.
 */
export function recencySignal(timestamp: string | null, asOf: string, halfLifeDays: number): number {
  if (timestamp === null) return 0;
  const ageDays = Math.max(0, Date.parse(asOf) - Date.parse(timestamp)) / DAY_MS;
  return 0.5 ** (ageDays / halfLifeDays);
}
