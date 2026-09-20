/**
 * The SecretResolver port (SPEC-06 §5, SPEC-07 §3.14, ADR-0026 §1).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). SPEC-06 §5 says a secret is a *pointer* the
 * system carries and a *value* it resolves at the moment of use, never a value
 * it stores. This is that distinction in the type system.
 *
 * Three things follow, and each is in the shapes rather than in guidance:
 *
 *   - **A `SecretRef` is serialisable and a `SecretValue` is not.** A ref can
 *     go in an event, a config file or a log. A value carries no `toJSON`, and
 *     stringifying it yields a redaction rather than the secret — so the
 *     ordinary way a credential leaks, someone logging the object that holds
 *     it, produces `[redacted]`.
 *   - **There is no `list` and no `getAll`.** A caller resolves the one ref it
 *     needs. An enumerable secret store is an inventory of what to steal.
 *   - **There is no `put`.** Secrets are written by the deployment, not by the
 *     application. An application that could write one could rotate itself into
 *     a credential nobody provisioned.
 */

import { GenesisError } from '@genesis/core-types';
import { z } from 'zod';

/** Where a secret lives. Safe to record: it names a location, not a value. */
export const SecretRef = z
  .object({
    /** Which backend resolves it. */
    provider: z.enum(['SECRETS_MANAGER', 'SSM_PARAMETER', 'ENVIRONMENT', 'LOCAL']),
    /** The backend's own identifier: an ARN, a parameter path, a variable name. */
    name: z.string().trim().min(1).max(2048),
    /** A field within a JSON secret, when the secret holds several. */
    key: z.string().trim().min(1).max(256).nullable().default(null),
    /** A specific version, when the backend versions secrets. Null means current. */
    version: z.string().trim().min(1).max(256).nullable().default(null),
  })
  .strict();
export type SecretRef = z.infer<typeof SecretRef>;

/**
 * A resolved secret.
 *
 * A class rather than a string so that it cannot be interpolated by accident:
 * `${value}` gives the redaction, and so do `JSON.stringify`, `console.log` and
 * every logger that calls one of them. Reading the secret takes saying
 * `reveal()`, which is greppable.
 */
export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The secret. The one place it becomes a string, and easy to find. */
  reveal(): string {
    return this.#value;
  }

  get length(): number {
    return this.#value.length;
  }

  toString(): string {
    return '[redacted]';
  }

  toJSON(): string {
    return '[redacted]';
  }

  /** Node's inspector, so `console.log(value)` redacts too. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[redacted]';
  }
}

export const SECRET_FAILURES = ['NOT_FOUND', 'NO_SUCH_KEY', 'FORBIDDEN', 'UNAVAILABLE', 'MALFORMED'] as const;
export type SecretFailureKind = (typeof SECRET_FAILURES)[number];

export class SecretResolutionError extends GenesisError {
  constructor(
    readonly kind: SecretFailureKind,
    message: string,
    context: Readonly<Record<string, unknown>> = {},
  ) {
    super('SECRET_UNRESOLVED', message, context);
    this.name = 'SecretResolutionError';
  }
}

export interface SecretResolver {
  /** Resolves one reference, or throws a typed refusal. */
  resolve(ref: SecretRef): Promise<SecretValue>;
  close(): Promise<void>;
}

/** A reference's stable identity, for caching and for error messages. */
export const refKey = (ref: SecretRef): string =>
  `${ref.provider}:${ref.name}:${ref.key ?? '-'}:${ref.version ?? 'current'}`;
