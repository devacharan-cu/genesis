/**
 * The ReasoningProvider port (ADR-0007, ADR-0018).
 *
 * The core talks to a model through this and nothing else. Everything here is
 * provider-neutral: no SDK type, no model-specific field, no transport detail.
 * An adapter's job is to turn a `ReasoningRequest` into whatever its provider
 * wants, and whatever comes back into a `ReasoningResult` or a
 * `ReasoningError` — nothing provider-shaped crosses the port in either
 * direction.
 *
 * The request and result are zod schemas so the core can check what an
 * adapter hands back instead of trusting its static type: an adapter is
 * third-party code talking to a third-party service.
 */

import { AUTHORITY_LEVELS, JsonValue } from '@genesis/core-types';
import { z } from 'zod';

/** What a call is for. Recorded on every call event (ADR-0007 rule 4). */
export const REASONING_PURPOSES = ['PROPOSE_COGNITIVE_UPDATES'] as const;
export type ReasoningPurpose = (typeof REASONING_PURPOSES)[number];

/** A piece of assembled context, labelled with where it came from and how established it is. */
export const ContextBlock = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    authority: z.enum(AUTHORITY_LEVELS),
    text: z.string().min(1),
  })
  .strict();
export type ContextBlock = z.infer<typeof ContextBlock>;

/**
 * Content that must be read as data, never followed as instruction
 * (SPEC-06 §6). The source says where it came from.
 */
export const UntrustedBlock = z.object({ source: z.string().min(1), text: z.string().min(1) }).strict();
export type UntrustedBlock = z.infer<typeof UntrustedBlock>;

export const ReasoningRequest = z
  .object({
    callId: z.string().min(1),
    purpose: z.enum(REASONING_PURPOSES),
    system: z.string().min(1),
    task: z.string().min(1),
    context: z.array(ContextBlock),
    untrustedContent: z.array(UntrustedBlock),
    /** The JSON Schema the output must satisfy. Structured output only (ADR-0007 rule 2). */
    outputSchema: z.record(JsonValue),
    budget: z
      .object({
        maxOutputTokens: z.number().int().positive(),
        timeoutMs: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();
export type ReasoningRequest = z.infer<typeof ReasoningRequest>;

/** Why generation stopped, normalised. Anything but END_TURN is noteworthy. */
export const STOP_REASONS = ['END_TURN', 'STOP_SEQUENCE', 'OTHER'] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export const TokenUsage = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();
export type TokenUsage = z.infer<typeof TokenUsage>;

export const ReasoningResult = z
  .object({
    /** The output, parsed as JSON. Validated against the request's schema by the core, not here. */
    output: JsonValue,
    /** The exact text the output was parsed from, so a run can be explained later. */
    outputText: z.string(),
    modelId: z.string().min(1),
    stopReason: z.enum(STOP_REASONS),
    usage: TokenUsage,
  })
  .strict();
export type ReasoningResult = z.infer<typeof ReasoningResult>;

export interface ReasoningProvider {
  /** Recorded on every call event, for provenance. */
  readonly id: string;
  /**
   * One call. Resolves with a result, or rejects with a `ReasoningError`.
   * Must honour `request.budget.timeoutMs`.
   */
  complete(request: ReasoningRequest): Promise<ReasoningResult>;
}
