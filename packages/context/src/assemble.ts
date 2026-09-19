/**
 * Context assembly (SPEC-01 §11, ADR-0017).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). What a model is shown decides what it can get
 * right. A failure here either crowds out something the task must respect — a
 * policy, a blocking unknown, an unsettled contradiction, a known failure — or
 * makes a context nobody can later explain.
 *
 *   1. Every input is parsed. Duplicate candidate ids are refused.
 *   2. Mandatory candidates go first, in reason order, and are never scored out.
 *      If they alone exceed the budget the result is SPLIT_REQUIRED and there is
 *      NO context: a partial one would silently drop a mandatory item.
 *   3. Every other candidate is scored on the six weighted signals and taken
 *      greedily by score (then id) while it fits. One that does not fit is
 *      skipped, not truncated, and a smaller one after it may still fit.
 *   4. The manifest records the weights, the scorers, every candidate's signals
 *      and score, and why each was or was not included.
 *
 * Pure: the same request, candidates and options always give the same manifest.
 */

import { ValidationError } from '@genesis/core-types';
import { z } from 'zod';
import {
  ContextCandidate,
  ContextRequest,
  type ContextWeights,
  DEFAULT_CONTEXT_WEIGHTS,
  MANDATORY_REASONS,
  type ParsedContextRequest,
  parseOrRefuse,
  parseWeights,
  type Signal,
  SIGNALS,
} from './model.js';
import {
  authoritySignal,
  charTokenEstimator,
  DEFAULT_RECENCY_HALF_LIFE_DAYS,
  distanceSignal,
  lexicalRelevance,
  recencySignal,
  type RelevanceScorer,
  type TokenEstimator,
} from './scoring.js';

export interface AssemblyOptions {
  readonly weights?: ContextWeights;
  readonly relevance?: RelevanceScorer;
  readonly tokens?: TokenEstimator;
  readonly recencyHalfLifeDays?: number;
  /** Scored candidates below this are excluded whatever the budget. Default 0. */
  readonly minScore?: number;
}

export type Exclusion = 'BUDGET' | 'BELOW_MIN_SCORE' | 'MANDATORY_OVERFLOW';

export interface ManifestEntry {
  readonly id: string;
  readonly kind: ContextCandidate['kind'];
  readonly source: ContextCandidate['source'];
  readonly mandatory: ContextCandidate['mandatory'];
  readonly tokens: number;
  /** Null for a mandatory candidate: it is placed by reason, not by score. */
  readonly signals: Readonly<Record<Signal, number>> | null;
  readonly score: number | null;
  readonly included: boolean;
  readonly exclusion: Exclusion | null;
}

export interface ContextManifest {
  readonly status: 'ASSEMBLED' | 'SPLIT_REQUIRED';
  readonly taskId: string;
  readonly taskKind: string;
  readonly activeGoalId: string | null;
  readonly asOf: string;
  readonly budgetTokens: number;
  readonly usedTokens: number;
  readonly mandatoryTokens: number;
  readonly weights: ContextWeights;
  readonly relevanceScorer: { readonly name: string; readonly version: number };
  readonly tokenEstimator: { readonly name: string; readonly version: number };
  readonly recencyHalfLifeDays: number;
  readonly minScore: number;
  /** Included entries first, in context order; then the excluded, by id. */
  readonly entries: readonly ManifestEntry[];
}

export interface ContextAssembly {
  readonly manifest: ContextManifest;
  /** The candidates to show, in order. Empty when the task must be split. */
  readonly items: readonly ContextCandidate[];
}

const Positive = z.number().finite().positive();
const Unit = z.number().finite().min(0).max(1);
const WholeTokens = z.number().int().nonnegative();

function checked(value: number, schema: z.ZodNumber, what: string): number {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ValidationError(`${what} returned ${value}`, { value });
  return parsed.data;
}

const reasonRank = (c: ContextCandidate): number => MANDATORY_REASONS.indexOf(c.mandatory as (typeof MANDATORY_REASONS)[number]);

export function assembleContext(
  request: ContextRequest,
  candidates: readonly unknown[],
  options: AssemblyOptions = {},
): ContextAssembly {
  const req: ParsedContextRequest = parseOrRefuse(ContextRequest, request, 'context request');
  const weights = parseWeights(options.weights ?? DEFAULT_CONTEXT_WEIGHTS);
  const relevance = options.relevance ?? lexicalRelevance;
  const estimator = options.tokens ?? charTokenEstimator;
  const halfLife = checked(options.recencyHalfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS, Positive, 'recency half-life');
  const minScore = checked(options.minScore ?? 0, Unit, 'minimum score');

  const parsed = candidates.map((c, i) => parseOrRefuse(ContextCandidate, c, `context candidate ${i}`));
  const seen = new Set<string>();
  for (const c of parsed) {
    if (seen.has(c.id)) throw new ValidationError(`duplicate context candidate ${c.id}`, { id: c.id });
    seen.add(c.id);
  }

  const tokensOf = (c: ContextCandidate): number =>
    checked(estimator.estimate(c.text), WholeTokens, `token estimator ${estimator.name}`);

  const signalsOf = (c: ContextCandidate): Record<Signal, number> => ({
    relevance: checked(relevance.score(req.task.text, c.text), Unit, `relevance scorer ${relevance.name}`),
    authority: authoritySignal(c.authority),
    goal: distanceSignal(c.goalDistance),
    dependency: distanceSignal(c.dependencyDistance),
    evidence: c.evidenceStrength,
    recency: recencySignal(c.timestamp, req.asOf, halfLife),
  });

  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1);

  // 2. Mandatory first, by reason then id.
  const mandatory = parsed
    .filter((c) => c.mandatory !== null)
    .sort((a, b) => reasonRank(a) - reasonRank(b) || byId(a, b))
    .map((c) => ({ candidate: c, tokens: tokensOf(c) }));
  const mandatoryTokens = mandatory.reduce((sum, m) => sum + m.tokens, 0);

  // 3. The rest, scored.
  const scored = parsed
    .filter((c) => c.mandatory === null)
    .map((c) => {
      const signals = signalsOf(c);
      // Summed in the fixed SIGNALS order: floating-point addition is not
      // associative, and the same weights must always give the same score.
      const score = SIGNALS.reduce((sum, s) => sum + weights[s] * signals[s], 0);
      return { candidate: c, tokens: tokensOf(c), signals, score };
    })
    .sort((a, b) => b.score - a.score || byId(a.candidate, b.candidate));

  const base = {
    taskId: req.task.id,
    taskKind: req.task.kind,
    activeGoalId: req.activeGoalId,
    asOf: req.asOf,
    budgetTokens: req.budgetTokens,
    mandatoryTokens,
    weights,
    relevanceScorer: { name: relevance.name, version: relevance.version },
    tokenEstimator: { name: estimator.name, version: estimator.version },
    recencyHalfLifeDays: halfLife,
    minScore,
  };

  const entry = (
    m: { candidate: ContextCandidate; tokens: number; signals?: Record<Signal, number>; score?: number },
    included: boolean,
    exclusion: Exclusion | null,
  ): ManifestEntry => ({
    id: m.candidate.id,
    kind: m.candidate.kind,
    source: m.candidate.source,
    mandatory: m.candidate.mandatory,
    tokens: m.tokens,
    signals: m.signals ?? null,
    score: m.score ?? null,
    included,
    exclusion,
  });

  if (mandatoryTokens > req.budgetTokens) {
    const entries = [...mandatory.map((m) => entry(m, false, 'MANDATORY_OVERFLOW')), ...scored.map((s) => entry(s, false, 'BUDGET'))];
    return {
      manifest: { ...base, status: 'SPLIT_REQUIRED', usedTokens: 0, entries: entries.sort(byId) },
      items: [],
    };
  }

  let used = mandatoryTokens;
  const taken: typeof scored = [];
  const left: ManifestEntry[] = [];
  for (const s of scored) {
    if (s.score < minScore) {
      left.push(entry(s, false, 'BELOW_MIN_SCORE'));
    } else if (used + s.tokens > req.budgetTokens) {
      left.push(entry(s, false, 'BUDGET'));
    } else {
      used += s.tokens;
      taken.push(s);
    }
  }

  return {
    manifest: {
      ...base,
      status: 'ASSEMBLED',
      usedTokens: used,
      entries: [
        ...mandatory.map((m) => entry(m, true, null)),
        ...taken.map((s) => entry(s, true, null)),
        ...left.sort(byId),
      ],
    },
    items: [...mandatory.map((m) => m.candidate), ...taken.map((s) => s.candidate)],
  };
}
