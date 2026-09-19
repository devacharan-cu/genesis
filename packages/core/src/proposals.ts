/**
 * What a model may propose, and how a proposal becomes a cognitive command
 * (ADR-0018 §3, SPEC-04 §4).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). This is the only door from model output to
 * canonical state, so it is narrow on purpose:
 *
 *   - Four kinds, the ones an agent may already issue: RECORD_BELIEF,
 *     RECORD_UNCERTAINTY, DRAFT_QUESTION, RECORD_CONTRADICTION. Nothing that
 *     transitions, resolves, satisfies, asks or answers.
 *   - Every field is named in a strict schema. A proposal cannot carry an
 *     authority for its own belief, a `reasoningCallId`, an uncertainty
 *     `source`, or evidence refs: those are the core's to set.
 *   - Every proposal names the goals it serves and why (SPEC-04 §4, PROPOSE).
 *
 * The JSON Schema sent to the model and the zod schemas that check what comes
 * back describe the same shapes; the tests hold them to each other. The zod
 * side is the one that decides.
 */

import { AUTHORITY_LEVELS, type JsonValue, NODE_TYPES, RISK_LEVELS, UNCERTAINTY_RESOLUTIONS } from '@genesis/core-types';
import { CONTRADICTION_KINDS } from '@genesis/cognition';
import { z } from 'zod';

export const PROPOSAL_KINDS = ['RECORD_BELIEF', 'RECORD_UNCERTAINTY', 'DRAFT_QUESTION', 'RECORD_CONTRADICTION'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/** A run proposes at most this many changes; more is a malformed envelope, not a long queue. */
export const MAX_PROPOSALS = 20;

const Text = z.string().trim().min(1).max(4000);
const Ids = z.array(z.string().trim().min(1)).max(50);
const Ref = z.object({ nodeType: z.enum(NODE_TYPES), nodeId: z.string().trim().min(1) }).strict();

const common = {
  rationale: Text,
  contributesTo: Ids.min(1),
};

const Side = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('BELIEF'), beliefId: z.string().trim().min(1) }).strict(),
  z
    .object({ kind: z.literal('EXTERNAL'), id: z.string().trim().min(1), claim: Text, authority: z.enum(AUTHORITY_LEVELS) })
    .strict(),
]);

export const PROPOSAL_SCHEMAS = {
  RECORD_BELIEF: z
    .object({
      kind: z.literal('RECORD_BELIEF'),
      ...common,
      statement: Text,
      state: z.enum(['UNKNOWN', 'ASSUMED']).optional(),
      confidence: z.number().min(0).max(1).optional(),
      subjectRefs: z.array(Ref).max(50).optional(),
    })
    .strict(),
  RECORD_UNCERTAINTY: z
    .object({
      kind: z.literal('RECORD_UNCERTAINTY'),
      ...common,
      statement: Text,
      whatBreaksIfWrong: Text,
      risk: z.enum(RISK_LEVELS),
      resolution: z.enum(UNCERTAINTY_RESOLUTIONS),
      blocksGoalIds: Ids.optional(),
      relatedBeliefs: Ids.optional(),
      affectedRefs: z.array(Ref).max(50).optional(),
    })
    .strict(),
  DRAFT_QUESTION: z
    .object({
      kind: z.literal('DRAFT_QUESTION'),
      ...common,
      uncertaintyId: z.string().trim().min(1),
      text: Text,
      reason: Text.optional(),
      audience: z.enum(['HUMAN', 'SELF', 'EXTERNAL']).optional(),
    })
    .strict(),
  RECORD_CONTRADICTION: z
    .object({
      kind: z.literal('RECORD_CONTRADICTION'),
      ...common,
      contradictionKind: z.enum(CONTRADICTION_KINDS),
      sides: z.tuple([Side, Side]),
      affectedRefs: z.array(Ref).max(50).optional(),
      risk: z.enum(RISK_LEVELS).optional(),
      blocksGoalIds: Ids.optional(),
    })
    .strict(),
} as const satisfies Record<ProposalKind, z.ZodTypeAny>;

export type Proposal = z.infer<(typeof PROPOSAL_SCHEMAS)[ProposalKind]>;

const issuesOf = (error: z.ZodError): string[] =>
  error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);

/** The top level of the output: an object holding a bounded list. Items are checked one by one. */
const Envelope = z.object({ proposals: z.array(z.unknown()).max(MAX_PROPOSALS) }).strict();

export type EnvelopeCheck =
  | { readonly ok: true; readonly items: readonly unknown[] }
  | { readonly ok: false; readonly issues: readonly string[] };

export function checkEnvelope(output: JsonValue): EnvelopeCheck {
  const parsed = Envelope.safeParse(output);
  return parsed.success ? { ok: true, items: parsed.data.proposals } : { ok: false, issues: issuesOf(parsed.error) };
}

export type ProposalCheck =
  | { readonly ok: true; readonly proposal: Proposal }
  | { readonly ok: false; readonly reason: 'MALFORMED' | 'NOT_PERMITTED'; readonly kind: string | null; readonly issues: readonly string[] };

/** One item of the envelope: a permitted kind, in exactly its shape. */
export function checkProposal(item: unknown): ProposalCheck {
  const kind =
    typeof item === 'object' && item !== null && typeof (item as { kind?: unknown }).kind === 'string'
      ? (item as { kind: string }).kind
      : null;
  if (kind === null) return { ok: false, reason: 'MALFORMED', kind: null, issues: ['kind: a proposal names its kind'] };
  if (!(PROPOSAL_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: 'NOT_PERMITTED', kind, issues: [`kind: ${kind} is not a kind a model may propose`] };
  }
  const parsed = PROPOSAL_SCHEMAS[kind as ProposalKind].safeParse(item);
  return parsed.success
    ? { ok: true, proposal: parsed.data }
    : { ok: false, reason: 'MALFORMED', kind, issues: issuesOf(parsed.error) };
}

/**
 * The cognitive command a checked proposal becomes. The core fills in what the
 * model may not: a belief's reasoning call is the call it came from, and its
 * authority is left to the belief rules, which cap an agent at AI_ASSUMPTION.
 */
export function toCommand(proposal: Proposal, callId: string): Record<string, unknown> {
  const { rationale, contributesTo: _served, ...rest } = proposal;
  switch (rest.kind) {
    case 'RECORD_BELIEF':
      // The rationale doubles as the belief's own: an ASSUMED belief needs one.
      return { ...rest, rationale, reasoningCallId: callId };
    case 'RECORD_UNCERTAINTY':
    case 'DRAFT_QUESTION':
    case 'RECORD_CONTRADICTION':
      return rest;
  }
}

// ------------------------------------------------------------ JSON Schema

const str = { type: 'string', minLength: 1 };
const text = { type: 'string', minLength: 1, maxLength: 4000 };
const ids = { type: 'array', items: str, maxItems: 50 };
const ref = {
  type: 'object',
  additionalProperties: false,
  required: ['nodeType', 'nodeId'],
  properties: { nodeType: { enum: [...NODE_TYPES] }, nodeId: str },
};
const refs = { type: 'array', items: ref, maxItems: 50 };

const variant = (kind: ProposalKind, required: readonly string[], properties: Record<string, JsonValue>): JsonValue => ({
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'rationale', 'contributesTo', ...required],
  properties: {
    kind: { const: kind },
    rationale: text,
    contributesTo: { ...ids, minItems: 1 },
    ...properties,
  },
});

/** The schema the model is asked to satisfy (ADR-0007 rule 2). */
export const PROPOSAL_OUTPUT_SCHEMA: Record<string, JsonValue> = {
  type: 'object',
  additionalProperties: false,
  required: ['proposals'],
  properties: {
    proposals: {
      type: 'array',
      maxItems: MAX_PROPOSALS,
      items: {
        oneOf: [
          variant('RECORD_BELIEF', ['statement'], {
            statement: text,
            state: { enum: ['UNKNOWN', 'ASSUMED'] },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            subjectRefs: refs,
          }),
          variant('RECORD_UNCERTAINTY', ['statement', 'whatBreaksIfWrong', 'risk', 'resolution'], {
            statement: text,
            whatBreaksIfWrong: text,
            risk: { enum: [...RISK_LEVELS] },
            resolution: { enum: [...UNCERTAINTY_RESOLUTIONS] },
            blocksGoalIds: ids,
            relatedBeliefs: ids,
            affectedRefs: refs,
          }),
          variant('DRAFT_QUESTION', ['uncertaintyId', 'text'], {
            uncertaintyId: str,
            text: text,
            reason: text,
            audience: { enum: ['HUMAN', 'SELF', 'EXTERNAL'] },
          }),
          variant('RECORD_CONTRADICTION', ['contradictionKind', 'sides'], {
            contradictionKind: { enum: [...CONTRADICTION_KINDS] },
            sides: {
              type: 'array',
              minItems: 2,
              maxItems: 2,
              items: {
                oneOf: [
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind', 'beliefId'],
                    properties: { kind: { const: 'BELIEF' }, beliefId: str },
                  },
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['kind', 'id', 'claim', 'authority'],
                    properties: {
                      kind: { const: 'EXTERNAL' },
                      id: str,
                      claim: text,
                      authority: { enum: [...AUTHORITY_LEVELS] },
                    },
                  },
                ],
              },
            },
            affectedRefs: refs,
            risk: { enum: [...RISK_LEVELS] },
            blocksGoalIds: ids,
          }),
        ],
      },
    },
  },
};
