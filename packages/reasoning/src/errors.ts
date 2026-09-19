/**
 * Provider failures, typed (ADR-0018 §2).
 *
 * Every way a call can fail is one of these kinds, whatever the provider. The
 * core branches on the kind — it records it, and it becomes the self model's
 * failure signature `reasoning:<KIND>` — so an adapter that let a raw SDK error
 * through would make failures unclassifiable. `unexpected()` exists for the
 * errors an adapter did not anticipate: they are still a `ReasoningError`, of
 * kind UNKNOWN, with the original message kept.
 */

import { GenesisError, type JsonValue } from '@genesis/core-types';

export const REASONING_FAILURE_KINDS = [
  'TIMEOUT',
  'THROTTLED',
  'UNAVAILABLE',
  'ACCESS_DENIED',
  'INVALID_REQUEST',
  'INVALID_RESPONSE',
  'OUTPUT_TRUNCATED',
  'CONTENT_FILTERED',
  'UNKNOWN',
] as const;
export type ReasoningFailureKind = (typeof REASONING_FAILURE_KINDS)[number];

/**
 * Kinds where the same request might succeed later. Everything else fails the
 * same way again: a bad request, a denied permission, a filtered prompt.
 */
const RETRYABLE: ReadonlySet<ReasoningFailureKind> = new Set<ReasoningFailureKind>([
  'TIMEOUT',
  'THROTTLED',
  'UNAVAILABLE',
]);

export class ReasoningError extends GenesisError {
  readonly kind: ReasoningFailureKind;
  readonly retryable: boolean;

  constructor(kind: ReasoningFailureKind, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super('REASONING_FAILED', message, { kind, ...details });
    this.kind = kind;
    this.retryable = RETRYABLE.has(kind);
  }
}

/** Anything thrown by a provider, as a ReasoningError. A ReasoningError passes through unchanged. */
export function asReasoningError(error: unknown): ReasoningError {
  if (error instanceof ReasoningError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ReasoningError('UNKNOWN', `unexpected provider failure: ${message}`);
}

/**
 * Parses a model's text as exactly one JSON value.
 *
 * A model asked for JSON sometimes wraps it in a markdown fence. That one
 * wrapper is removed — it carries no meaning — but nothing else is repaired:
 * text around the JSON, two JSON values, or JSON with a trailing comma is
 * INVALID_RESPONSE. Guessing at what malformed output meant would be parsing
 * free-form text heuristically, which ADR-0007 rule 2 forbids.
 */
export function parseJsonOutput(text: string): JsonValue {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\n([\s\S]*)\n```$/.exec(trimmed);
  const body = fenced === null ? trimmed : (fenced[1] as string);
  try {
    return JSON.parse(body) as JsonValue;
  } catch (error) {
    throw new ReasoningError('INVALID_RESPONSE', `the model's output is not JSON: ${(error as Error).message}`, {
      length: text.length,
    });
  }
}
