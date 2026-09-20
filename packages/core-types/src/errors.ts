/**
 * Typed errors.
 *
 * Every failure carries a stable `code` so callers branch on the code rather
 * than on message text, and so the self model can key `knownFailures` on a
 * normalised signature rather than on a string that changes when someone
 * rewords an error.
 */

export type GenesisErrorCode =
  | 'VALIDATION_FAILED'
  | 'SCOPE_MISMATCH'
  | 'APPEND_ONLY_VIOLATION'
  | 'SEQUENCE_CONFLICT'
  | 'CHAIN_INTEGRITY'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'AUTHORITY_NOT_PERMITTED'
  | 'PROJECTION_DIVERGENCE'
  | 'COGNITIVE_RULE_VIOLATION'
  | 'REASONING_FAILED'
  | 'MIRROR_DIVERGENCE'
  // A token could not be turned into a verified subject (ADR-0026 1). Never
  // 'not found': a refusal that distinguished an unknown subject from a wrong
  // secret would be an enumeration oracle (SPEC-06 2).
  | 'AUTHENTICATION_FAILED'
  // A SecretRef pointed at nothing this resolver could read (SPEC-06 5).
  | 'SECRET_UNRESOLVED'
  | 'NOT_FOUND';

export class GenesisError extends Error {
  readonly code: GenesisErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: GenesisErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends GenesisError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('VALIDATION_FAILED', message, details);
  }
}

/**
 * Raised when an operation is asked for data outside its project scope.
 *
 * Deliberately an error rather than an empty result: `null` would be
 * indistinguishable from "no such record" and would hide the bug (ADR-0008).
 */
export class ScopeMismatchError extends GenesisError {
  constructor(details: { expected: string; actual: string; subject: string }) {
    super(
      'SCOPE_MISMATCH',
      `${details.subject} belongs to project ${details.actual}, but the operation is scoped to ${details.expected}`,
      details,
    );
  }
}

export class AppendOnlyViolationError extends GenesisError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('APPEND_ONLY_VIOLATION', message, details);
  }
}

export class SequenceConflictError extends GenesisError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('SEQUENCE_CONFLICT', message, details);
  }
}

export class ChainIntegrityError extends GenesisError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('CHAIN_INTEGRITY', message, details);
  }
}

export class UnsupportedSchemaVersionError extends GenesisError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('UNSUPPORTED_SCHEMA_VERSION', message, details);
  }
}

/**
 * Raised when two folds over identical history disagree (ADR-0013 rule 5).
 *
 * This is non-determinism caught in the act. It is deliberately NOT a
 * validation error: nothing about the input was invalid, and the distinction
 * matters because the remedy is different — a divergence means the projector
 * itself depends on something outside the ledger.
 */
export class ProjectionDivergenceError extends GenesisError {
  constructor(details: {
    projection: string;
    projectId: string;
    lastSeq: number;
    stored: string;
    incoming: string;
  }) {
    super(
      'PROJECTION_DIVERGENCE',
      `projection ${details.projection} for project ${details.projectId} disagrees at seq ${details.lastSeq}: digest ${details.stored} vs ${details.incoming}`,
      details,
    );
  }
}

/**
 * A command a cognitive decider refused (ADR-0014 rule 3).
 *
 * Carries a stable `rule` identifier as well as a message, so a caller — and
 * later the question engine — can branch on WHICH rule was broken ("a goal
 * needs a success criterion before it can be ACTIVE") without parsing text.
 * Nothing is appended when this is thrown.
 */
export class CognitiveRuleViolationError extends GenesisError {
  readonly rule: string;

  constructor(rule: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super('COGNITIVE_RULE_VIOLATION', message, { rule, ...details });
    this.rule = rule;
  }
}

export class AuthorityNotPermittedError extends GenesisError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('AUTHORITY_NOT_PERMITTED', message, details);
  }
}

/**
 * The graph holds a mirrored node or edge that disagrees with the canonical
 * record it mirrors (ADR-0016, ADR-0018 §4).
 *
 * The mirror never overwrites to make them agree: a disagreement means
 * something other than the mirror wrote a cognitive record into the graph, and
 * that is the failure ADR-0016 exists to prevent, so it is surfaced.
 */
export class MirrorDivergenceError extends GenesisError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super('MIRROR_DIVERGENCE', message, details);
  }
}
