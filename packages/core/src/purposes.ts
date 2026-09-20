/**
 * What a model may be asked for, and what happens to what comes back
 * (ADR-0022).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). This table is the whole of the core's side of
 * the reasoning port. It owns three things per purpose, and owning all three in
 * one place is the point:
 *
 *   - the **system prompt**, so no wording lives in a domain package;
 *   - the **output schema**, so the model is held to a shape rather than asked
 *     nicely for one (ADR-0007 rule 2);
 *   - the **outcome kind**, which decides how the orchestrator records what
 *     came back.
 *
 * A role names a purpose and supplies nothing else. It cannot write a prompt,
 * pick a model, or add an instruction, so a role cannot carry model-specific
 * behaviour even by accident.
 *
 * Every prompt here says the same thing three ways, because it is the one thing
 * the model must not get wrong: you propose, the core decides, and nothing you
 * return is true because you returned it.
 */

import { type JsonValue, REASONING_PURPOSES, type ReasoningPurpose } from '@genesis/core-types';
import { z } from 'zod';
import { PROPOSAL_OUTPUT_SCHEMA } from './proposals.js';

/** How the orchestrator records a purpose's output. One arm per shape of thing. */
export const OUTCOME_KINDS = ['COGNITIVE_PROPOSALS', 'ARTIFACTS', 'DIAGNOSIS'] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

const COGNITIVE_PROMPT = [
  'You are the reasoning component of GENESIS, a software engineering system.',
  'You do not decide what is true and you cannot change the project: you PROPOSE, and the core checks every proposal against its rules.',
  'You may propose only these kinds: RECORD_BELIEF (an assumption or an open claim, never a verified fact),',
  'RECORD_UNCERTAINTY (something unknown that matters), DRAFT_QUESTION (about an existing uncertainty),',
  'and RECORD_CONTRADICTION (two claims that cannot both hold).',
  'Every proposal must give its rationale and name, in contributesTo, at least one ACTIVE goal id taken from the context.',
  'Prefer recording an uncertainty to guessing. Propose nothing rather than something unfounded: an empty list is a valid answer.',
].join('\n');

const ARTIFACT_PROMPT = [
  'You are the implementation component of GENESIS, a software engineering system.',
  'You produce source artifacts. You do not test them, you do not verify them, and you cannot mark them as working:',
  'the core runs the tests and a separate engine decides what the results justify.',
  'Return each artifact as a path and its complete contents. Paths are relative and must stay inside the workspace.',
  'Write only what the specification asks for. Do not add a file the specification does not call for.',
  'If you cannot implement part of it, say so in limitations rather than writing a placeholder that looks finished.',
  'An empty artifact list with a stated limitation is a better answer than a plausible file that does not work.',
].join('\n');

const DIAGNOSIS_PROMPT = [
  'You are the diagnostic component of GENESIS, a software engineering system.',
  'You are given a recorded failure and the artifacts it implicates. You read it and say what you think caused it.',
  'Your reading is recorded as an assumption, not as a finding of fact, and the repair it suggests is checked and tested like any other change.',
  'Name the smallest set of artifacts a fix would touch. A diagnosis that implicates everything has diagnosed nothing.',
  'If the failure does not say enough to locate a cause, say that. A confident wrong root cause costs more than an admitted unknown.',
].join('\n');

/** What a `PRODUCE_ARTIFACT` run must return. */
export const ARTIFACT_OUTPUT_SCHEMA: Record<string, JsonValue> = {
  type: 'object',
  additionalProperties: false,
  required: ['artifacts'],
  properties: {
    artifacts: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'contents'],
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 400 },
          contents: { type: 'string' },
          language: { type: 'string', minLength: 1, maxLength: 40 },
        },
      },
    },
    limitations: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 4000 } },
  },
};

/** What a `DIAGNOSE_FAILURE` run must return. */
export const DIAGNOSIS_OUTPUT_SCHEMA: Record<string, JsonValue> = {
  type: 'object',
  additionalProperties: false,
  required: ['rootCause', 'targetArtifacts', 'approach'],
  properties: {
    rootCause: { type: 'string', minLength: 1, maxLength: 4000 },
    targetArtifacts: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', minLength: 1 } },
    approach: { type: 'string', minLength: 1, maxLength: 4000 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
};

// The zod side is the one that decides, as it is for proposals: the JSON Schema
// is what the model is asked for, and this is what the core accepts.
export const ArtifactOutput = z
  .object({
    artifacts: z
      .array(
        z
          .object({
            path: z.string().trim().min(1).max(400),
            contents: z.string(),
            language: z.string().trim().min(1).max(40).default('typescript'),
          })
          .strict(),
      )
      .max(50),
    limitations: z.array(z.string().trim().min(1).max(4000)).max(20).default([]),
  })
  .strict();
export type ArtifactOutput = z.infer<typeof ArtifactOutput>;

export const DiagnosisOutput = z
  .object({
    rootCause: z.string().trim().min(1).max(4000),
    targetArtifacts: z.array(z.string().trim().min(1)).min(1).max(10),
    approach: z.string().trim().min(1).max(4000),
    confidence: z.number().min(0).max(1).default(0.5),
  })
  .strict();
export type DiagnosisOutput = z.infer<typeof DiagnosisOutput>;

export interface PurposeContract {
  readonly system: string;
  readonly outputSchema: Record<string, JsonValue>;
  readonly outcome: OutcomeKind;
  /** Checks what came back. The zod side decides; the JSON Schema only asks. */
  readonly accepts: z.ZodTypeAny;
}

export const PURPOSE_CONTRACTS = {
  PROPOSE_COGNITIVE_UPDATES: {
    system: COGNITIVE_PROMPT,
    outputSchema: PROPOSAL_OUTPUT_SCHEMA,
    outcome: 'COGNITIVE_PROPOSALS',
    // Checked item by item by `checkEnvelope`/`checkProposal`, which report per
    // proposal rather than failing the run on one bad entry.
    accepts: z.unknown(),
  },
  PRODUCE_ARTIFACT: {
    system: ARTIFACT_PROMPT,
    outputSchema: ARTIFACT_OUTPUT_SCHEMA,
    outcome: 'ARTIFACTS',
    accepts: ArtifactOutput,
  },
  DIAGNOSE_FAILURE: {
    system: DIAGNOSIS_PROMPT,
    outputSchema: DIAGNOSIS_OUTPUT_SCHEMA,
    outcome: 'DIAGNOSIS',
    accepts: DiagnosisOutput,
  },
} as const satisfies Record<ReasoningPurpose, PurposeContract>;

/** The contract for a purpose. Total over the canonical set, by construction. */
export const contractFor = (purpose: ReasoningPurpose): PurposeContract => PURPOSE_CONTRACTS[purpose];

/**
 * Every canonical purpose, for the completeness test. A purpose added to the
 * enum but not to the table is a runtime gap rather than a compile error in a
 * lookup, so the test closes it (ADR-0022 consequences).
 */
export const DECLARED_PURPOSES: readonly ReasoningPurpose[] = REASONING_PURPOSES;
