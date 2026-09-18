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

export class AuthorityNotPermittedError extends GenesisError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('AUTHORITY_NOT_PERMITTED', message, details);
  }
}
