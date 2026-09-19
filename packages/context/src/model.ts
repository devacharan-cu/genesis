/**
 * The shapes context assembly works on (SPEC-01 §11, ADR-0017).
 *
 * Everything that enters an assembly is parsed here first. Assembly is pure and
 * its manifest is recorded in the ledger, so an input that is not what it
 * claims to be — a timestamp that is not a time, a weight that is not a number —
 * is refused at the door rather than turned into a score nobody can explain.
 */

import { AUTHORITY_LEVELS, ValidationError } from '@genesis/core-types';
import { z } from 'zod';

const Id = z.string().min(1);
const Instant = z.string().datetime({ offset: true });

/** What the context is for. */
export const ContextTask = z
  .object({
    id: Id,
    /** The task kind known failures are matched against, e.g. `implement` or `migrate`. */
    kind: Id,
    /** What the task says. Relevance is measured against this text. */
    text: z.string().min(1),
    /** Graph nodes the task is about: distance 0 for the dependency signal. */
    nodeIds: z.array(Id).default([]),
  })
  .strict();
export type ContextTask = z.input<typeof ContextTask>;

export const ContextRequest = z
  .object({
    task: ContextTask,
    /** The goal the task serves; the goal-relevance signal is distance from it. */
    activeGoalId: Id.nullable().default(null),
    /**
     * The instant recency is measured from. Supplied, never read from a clock,
     * so the same request always scores the same.
     */
    asOf: Instant,
    budgetTokens: z.number().int().positive(),
  })
  .strict();
export type ContextRequest = z.input<typeof ContextRequest>;
export type ParsedContextRequest = z.output<typeof ContextRequest>;

/**
 * Why a candidate must be included whatever its score (SPEC-01 §11.3). Listed
 * in the order they are placed in a context.
 */
export const MANDATORY_REASONS = [
  'POLICY',
  'BLOCKING_UNCERTAINTY',
  'CONTRADICTION_IN_IMPACT',
  'MATCHING_FAILURE',
] as const;
export type MandatoryReason = (typeof MANDATORY_REASONS)[number];

export const CANDIDATE_KINDS = [
  'POLICY',
  'GOAL',
  'BELIEF',
  'UNCERTAINTY',
  'CONTRADICTION',
  'ANSWER',
  'KNOWN_FAILURE',
  'MEMORY',
  'GRAPH_NODE',
] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

/** Something that might be put in front of a model, with what the signals need to score it. */
export const ContextCandidate = z
  .object({
    /** Unique within an assembly: `<kind>:<record id>`. */
    id: Id,
    kind: z.enum(CANDIDATE_KINDS),
    text: z.string().min(1),
    authority: z.enum(AUTHORITY_LEVELS),
    /** Steps in the goal tree from the active goal; null when unrelated. */
    goalDistance: z.number().int().nonnegative().nullable(),
    /** Hops in the graph from the task's nodes; null when unconnected. */
    dependencyDistance: z.number().int().nonnegative().nullable(),
    /** Belief state and evidence count, folded to [0, 1] by the builder. */
    evidenceStrength: z.number().min(0).max(1),
    /** When the fact was last established; null when it has no time. */
    timestamp: Instant.nullable(),
    mandatory: z.enum(MANDATORY_REASONS).nullable(),
    /** The record it came from, and its version where records have one (ADR-0016 rule 5). */
    source: z.object({ store: z.enum(['COGNITION', 'SELF_MODEL', 'POLICY', 'MEMORY', 'GRAPH']), id: Id, version: z.number().int().positive().nullable() }).strict(),
  })
  .strict();
export type ContextCandidate = z.infer<typeof ContextCandidate>;

/** SPEC-01 §11.2's six signals. */
export const SIGNALS = ['relevance', 'authority', 'goal', 'dependency', 'evidence', 'recency'] as const;
export type Signal = (typeof SIGNALS)[number];

export type ContextWeights = Readonly<Record<Signal, number>>;

/** SPEC-01 §11.2 defaults. Recency is deliberately the weakest signal. */
export const DEFAULT_CONTEXT_WEIGHTS: ContextWeights = {
  relevance: 0.3,
  authority: 0.25,
  goal: 0.15,
  dependency: 0.15,
  evidence: 0.1,
  recency: 0.05,
};

const WeightsSchema = z
  .object(Object.fromEntries(SIGNALS.map((s) => [s, z.number().finite().min(0).max(1)])) as Record<Signal, z.ZodNumber>)
  .strict();

/**
 * Checks a weights configuration: six finite, non-negative weights that sum to
 * 1. A sum other than 1 would make scores from two configurations
 * incomparable, and the manifest records scores for later comparison.
 */
export function parseWeights(weights: unknown): ContextWeights {
  const parsed = WeightsSchema.safeParse(weights);
  if (!parsed.success) {
    throw new ValidationError('context weights must be six numbers in [0, 1], one per signal', {
      issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    });
  }
  const sum = SIGNALS.reduce((total, s) => total + parsed.data[s], 0);
  if (Math.abs(sum - 1) > 1e-9) {
    throw new ValidationError(`context weights must sum to 1, not ${sum}`, { sum });
  }
  return parsed.data;
}

/** Parses with a schema, or refuses with a ValidationError that names the field. */
export function parseOrRefuse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(`invalid ${what}`, {
      issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    });
  }
  return parsed.data;
}
