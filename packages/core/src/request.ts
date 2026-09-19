/**
 * Building the reasoning request from an assembled context (ADR-0018 §3).
 *
 * Pure and model-agnostic: the same assembly and task always give the same
 * request, byte for byte, and so the same request hash on the ledger. How the
 * request is worded for a particular model is the adapter's business; what it
 * contains is decided here.
 *
 * Context items whose authority is a model's — AI_ASSUMPTION — or nobody's —
 * UNGROUNDED — go in as untrusted content (SPEC-06 §6): they may be the output
 * of an earlier call, and an earlier call's output is exactly what an injection
 * would hide in.
 */

import type { Authority } from '@genesis/core-types';
import type { ContextCandidate } from '@genesis/context';
import { canonicalJson, sha256Hex } from '@genesis/ledger';
import type { ContextBlock, ReasoningRequest, UntrustedBlock } from '@genesis/reasoning';
import { PROPOSAL_OUTPUT_SCHEMA } from './proposals.js';

const UNTRUSTED_AUTHORITIES: ReadonlySet<Authority> = new Set<Authority>(['AI_ASSUMPTION', 'UNGROUNDED']);

export const SYSTEM_PROMPT = [
  'You are the reasoning component of GENESIS, a software engineering system.',
  'You do not decide what is true and you cannot change the project: you PROPOSE, and the core checks every proposal against its rules.',
  'You may propose only these kinds: RECORD_BELIEF (an assumption or an open claim, never a verified fact),',
  'RECORD_UNCERTAINTY (something unknown that matters), DRAFT_QUESTION (about an existing uncertainty),',
  'and RECORD_CONTRADICTION (two claims that cannot both hold).',
  'Every proposal must give its rationale and name, in contributesTo, at least one ACTIVE goal id taken from the context.',
  'Prefer recording an uncertainty to guessing. Propose nothing rather than something unfounded: an empty list is a valid answer.',
].join('\n');

export interface ReasoningBudget {
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

export function buildReasoningRequest(
  callId: string,
  taskText: string,
  items: readonly ContextCandidate[],
  budget: ReasoningBudget,
): ReasoningRequest {
  const context: ContextBlock[] = items
    .filter((c) => !UNTRUSTED_AUTHORITIES.has(c.authority))
    .map((c) => ({ id: c.id, kind: c.kind, authority: c.authority, text: c.text }));
  const untrustedContent: UntrustedBlock[] = items
    .filter((c) => UNTRUSTED_AUTHORITIES.has(c.authority))
    .map((c) => ({ source: `${c.id} (${c.kind}, ${c.authority})`, text: c.text }));
  return {
    callId,
    purpose: 'PROPOSE_COGNITIVE_UPDATES',
    system: SYSTEM_PROMPT,
    task: taskText,
    context,
    untrustedContent,
    outputSchema: PROPOSAL_OUTPUT_SCHEMA,
    budget: { maxOutputTokens: budget.maxOutputTokens, timeoutMs: budget.timeoutMs },
  };
}

/** The request's identity on the ledger (ADR-0007 rule 4), by the ledger's own canonical form. */
export const requestHash = (request: ReasoningRequest): string => sha256Hex(canonicalJson(request));

/** The response's identity: the hash of the exact text the model returned. */
export const responseHash = (outputText: string): string => sha256Hex(outputText);
