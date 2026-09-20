/**
 * What the factory's roles are handed, and what they hand back
 * (ADR-0022, ADR-0023).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). These are the shapes through which a Builder
 * claims to have built something, QA claims to have tested it, and Security
 * claims to have reviewed it. If a shape lets a role assert a conclusion rather
 * than report an observation, the factory reports success it has not earned.
 *
 * What a role reports it says through the protocol's existing message bodies —
 * a FINDING, an EVIDENCE_SUBMISSION, a RESULT (SPEC-04 §3.1). There is no
 * second report vocabulary here, because two ways to say the same thing drift,
 * and one of them ends up being the one that can say more than it should.
 *
 * What is here is what a role is *given*: its typed input, validated by the
 * role that reads it, and the configuration it may vary.
 *
 * `RoleConfig` is the whole of what a role may vary: bounded numbers and
 * members of closed sets. There is no string here that a model ever sees
 * (ADR-0022 §2).
 *
 * An execution result is on the assignment rather than handed to an agent some
 * other way, so a QA task can be replayed from what the ledger recorded instead
 * of from state somebody still holds.
 */

import {
  FACTORY_STAGES,
  type JsonValue,
  REASONING_PURPOSES,
  SEVERITIES,
} from '@genesis/core-types';
import { z } from 'zod';

const Id = z.string().trim().min(1);
const Text = z.string().trim().min(1).max(4000);

// ------------------------------------------------------------- role config

/**
 * How a role is configured. Every field is a number or a member of a closed
 * set, so a role's behaviour is something the system can test rather than a
 * sentence someone hopes works.
 */
export const RoleConfig = z
  .object({
    /** Which purpose contract this role's runs use. The core owns the rest. */
    purpose: z.enum(REASONING_PURPOSES).nullable().default(null),
    /** A bound on how much one run may produce. */
    maxArtifacts: z.number().int().min(1).max(50).default(10),
    /** Bytes per artifact. A model that returns a megabyte is a failure, not a build. */
    maxArtifactBytes: z.number().int().min(1).max(1_000_000).default(64_000),
    /** How many times a change may be repaired before it is blocked (ADR-0023 §6). */
    maxRepairAttempts: z.number().int().min(1).max(5).default(3),
    /** Findings below this are not reported. */
    severityFloor: z.enum(SEVERITIES).default('INFO'),
    /** Findings at or above this stop the change before VERIFY. */
    blockAt: z.enum(SEVERITIES).default('HIGH'),
  })
  .strict();
export type RoleConfig = z.infer<typeof RoleConfig>;

export const defaultRoleConfig = (): RoleConfig => RoleConfig.parse({});

// ------------------------------------------------------------------- tests

export const TEST_KINDS = ['PROPERTY', 'UNIT', 'CONFORMANCE', 'INTEGRATION', 'E2E', 'REGRESSION'] as const;
export type TestKind = (typeof TEST_KINDS)[number];

// --------------------------------------------------------------- diagnosis

export const FAILURE_SOURCES = ['BUILD', 'TEST', 'SECURITY', 'VERIFICATION'] as const;
export type FailureSource = (typeof FAILURE_SOURCES)[number];

/** A failure handed to Repair. Structured, so a repair can be targeted rather than a guess. */
export const FailureReport = z
  .object({
    source: z.enum(FAILURE_SOURCES),
    stage: z.enum(FACTORY_STAGES),
    /** Stable across occurrences of the same failure, so repetition is visible. */
    signature: Id,
    summary: Text,
    /** The artifacts implicated, when the failure names any. */
    artifactIds: z.array(Id).max(50).default([]),
    /** The observed output, when there was an execution. Null for a judgement. */
    raw: z.string().max(200_000).nullable().default(null),
  })
  .strict();
export type FailureReport = z.infer<typeof FailureReport>;

// ------------------------------------------------------------ role inputs

/**
 * What a role is handed beyond its instruction. Typed per role and validated by
 * the role itself, so a Builder handed a QA input fails loudly rather than
 * working on nothing.
 */
export const BuilderInput = z
  .object({
    /** What to build, from the architecture stage. */
    specification: Text,
    /** Existing artifacts the change may modify. */
    existing: z.array(z.object({ artifactId: Id, path: Id, contents: z.string() }).strict()).max(50).default([]),
  })
  .strict();
export type BuilderInput = z.infer<typeof BuilderInput>;

/**
 * What the sandbox actually did. On the assignment rather than handed to the
 * agent some other way, so a QA task can be replayed from what was recorded
 * instead of from state somebody still holds.
 */
export const ExecutionResult = z
  .object({
    exitCode: z.number().int(),
    raw: z.string().max(200_000),
    durationMs: z.number().int().nonnegative(),
    /** Set when the run never produced an exit code: a timeout, a cancellation. */
    failureKind: Id.nullable().default(null),
  })
  .strict();
export type ExecutionResult = z.infer<typeof ExecutionResult>;

export const QaInput = z
  .object({
    artifacts: z.array(z.object({ artifactId: Id, path: Id, contents: z.string() }).strict()).min(1).max(50),
    /** The command the factory ran, recorded so the run is reproducible (SPEC-05 §4). */
    command: z.array(z.string()).min(1).max(50),
    kind: z.enum(TEST_KINDS),
    /** What the sandbox observed. Null when no run happened, which QA reports as such. */
    execution: ExecutionResult.nullable().default(null),
  })
  .strict();
export type QaInput = z.infer<typeof QaInput>;

export const SecurityInput = z
  .object({
    artifacts: z.array(z.object({ artifactId: Id, path: Id, contents: z.string() }).strict()).min(1).max(50),
    blockAt: z.enum(SEVERITIES).default('HIGH'),
    severityFloor: z.enum(SEVERITIES).default('INFO'),
  })
  .strict();
export type SecurityInput = z.infer<typeof SecurityInput>;

export const RepairInput = z
  .object({
    failure: FailureReport,
    attempt: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    /** Every prior attempt on this change, so a repair does not repeat one. */
    history: z.array(z.object({ attempt: z.number().int().positive(), signature: Id, approach: z.string() }).strict()).max(10).default([]),
    artifacts: z.array(z.object({ artifactId: Id, path: Id, contents: z.string() }).strict()).max(50).default([]),
  })
  .strict();
export type RepairInput = z.infer<typeof RepairInput>;

/** The inputs, by the role that reads them. Used by the completeness test. */
export const ROLE_INPUTS = {
  BUILDER: BuilderInput,
  QA: QaInput,
  SECURITY: SecurityInput,
  REPAIR: RepairInput,
} as const;

/**
 * Reads a role's input off an assignment, or says why it could not. A role
 * handed the wrong shape fails its task rather than working on a default.
 */
export type InputCheck<T> = { readonly ok: true; readonly input: T } | { readonly ok: false; readonly reason: string };

export function checkInput<T>(schema: z.ZodType<T>, value: JsonValue, role: string): InputCheck<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, input: parsed.data };
  const issues = parsed.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
  return { ok: false, reason: `${role} was handed an input it cannot read: ${issues}` };
}

