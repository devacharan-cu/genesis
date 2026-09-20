/**
 * An in-memory SecretResolver, for development and for tests (ADR-0026 §1).
 *
 * It resolves only what it was given, and it reads a JSON secret's field the
 * same way Secrets Manager does, so a caller that works against this works
 * against that. Nothing here writes, caches or enumerates.
 */

import { type SecretRef, refKey, SecretResolutionError, type SecretResolver, SecretValue } from './port.js';

export class InMemorySecretResolver implements SecretResolver {
  readonly #secrets: Map<string, string>;
  #closed = false;

  /** Keyed by `provider:name`, so one entry can serve several `key` lookups. */
  constructor(secrets: Readonly<Record<string, string>> = {}) {
    this.#secrets = new Map(Object.entries(secrets));
  }

  async resolve(ref: SecretRef): Promise<SecretValue> {
    if (this.#closed) throw new SecretResolutionError('UNAVAILABLE', 'the secret resolver is closed');

    const stored = this.#secrets.get(`${ref.provider}:${ref.name}`);
    if (stored === undefined) {
      throw new SecretResolutionError('NOT_FOUND', `no secret at ${ref.provider}:${ref.name}`, { ref: refKey(ref) });
    }
    if (ref.key === null) return new SecretValue(stored);

    // A keyed reference means the secret holds JSON, which is how Secrets
    // Manager stores a set of related values under one name.
    let parsed: unknown;
    try {
      parsed = JSON.parse(stored);
    } catch {
      throw new SecretResolutionError('MALFORMED', `the secret at ${ref.name} is not JSON, so it has no fields`, {
        ref: refKey(ref),
      });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new SecretResolutionError('MALFORMED', `the secret at ${ref.name} is not a JSON object`, {
        ref: refKey(ref),
      });
    }
    const field = (parsed as Record<string, unknown>)[ref.key];
    if (typeof field !== 'string') {
      throw new SecretResolutionError('NO_SUCH_KEY', `the secret at ${ref.name} has no string field ${ref.key}`, {
        ref: refKey(ref),
      });
    }
    return new SecretValue(field);
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

/**
 * Resolves from process environment variables.
 *
 * Deliberately separate from the in-memory resolver: reading the environment is
 * a real capability with a real blast radius, and a caller should have to ask
 * for it by name rather than get it by default.
 */
export class EnvironmentSecretResolver implements SecretResolver {
  #closed = false;

  constructor(private readonly env: Readonly<Record<string, string | undefined>> = process.env) {}

  async resolve(ref: SecretRef): Promise<SecretValue> {
    if (this.#closed) throw new SecretResolutionError('UNAVAILABLE', 'the secret resolver is closed');
    if (ref.provider !== 'ENVIRONMENT') {
      throw new SecretResolutionError('FORBIDDEN', `this resolver serves ENVIRONMENT refs, not ${ref.provider}`, {
        ref: refKey(ref),
      });
    }
    const value = this.env[ref.name];
    if (value === undefined) {
      throw new SecretResolutionError('NOT_FOUND', `no environment variable ${ref.name}`, { ref: refKey(ref) });
    }
    return new SecretValue(value);
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
