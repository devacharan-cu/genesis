/**
 * The Secrets Manager / SSM SecretResolver adapter (SPEC-06 §5, SPEC-07 §3.14).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). A secret is a pointer the system carries and
 * a value it resolves at the moment of use, never a value it stores. This
 * resolves, and it deliberately does not cache: a cache would hold plaintext
 * for as long as the process lives, and would keep serving a credential after
 * it was rotated.
 *
 * `FORBIDDEN` is distinguished from `NOT_FOUND` here, unlike in the identity
 * adapter, because the caller is the system rather than a user. Knowing that a
 * secret exists but this role may not read it is the difference between fixing
 * a policy and fixing a name, and there is nobody here to enumerate anything.
 */

import { refKey, type SecretRef, SecretResolutionError, type SecretResolver, SecretValue } from '@genesis/secrets';

/** The operations this adapter issues against the two backends it serves. */
export interface SecretsClient {
  /** Secrets Manager: the secret string at a name or ARN, optionally a version. */
  getSecretValue(name: string, version: string | null): Promise<string | null>;
  /** SSM: the decrypted value of a parameter. */
  getParameter(name: string, version: string | null): Promise<string | null>;
  close(): Promise<void>;
}

export interface AwsSecretResolverOptions {
  readonly client: SecretsClient;
}

export class AwsSecretResolver implements SecretResolver {
  #closed = false;

  constructor(private readonly options: AwsSecretResolverOptions) {}

  async resolve(ref: SecretRef): Promise<SecretValue> {
    if (this.#closed) throw new SecretResolutionError('UNAVAILABLE', 'the secret resolver is closed');
    if (ref.provider !== 'SECRETS_MANAGER' && ref.provider !== 'SSM_PARAMETER') {
      throw new SecretResolutionError('FORBIDDEN', `this resolver does not serve ${ref.provider} refs`, {
        ref: refKey(ref),
      });
    }

    let raw: string | null;
    try {
      raw =
        ref.provider === 'SECRETS_MANAGER'
          ? await this.options.client.getSecretValue(ref.name, ref.version)
          : await this.options.client.getParameter(ref.name, ref.version);
    } catch (error) {
      // An access denial is a policy problem and reads like one. Anything else
      // is the backend being unreachable, which has a different fix.
      const message = error instanceof Error ? error.message : String(error);
      const denied = /AccessDenied|not authorized/i.test(message);
      throw new SecretResolutionError(denied ? 'FORBIDDEN' : 'UNAVAILABLE', message, { ref: refKey(ref) });
    }

    if (raw === null) {
      throw new SecretResolutionError('NOT_FOUND', `no secret at ${ref.provider}:${ref.name}`, { ref: refKey(ref) });
    }
    if (ref.key === null) return new SecretValue(raw);

    // A keyed reference means the secret holds JSON, which is how Secrets
    // Manager stores a set of related values under one name.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
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
    await this.options.client.close();
  }
}

/** An in-process backend with the two services' semantics, for tests. */
export class SecretsClientModel implements SecretsClient {
  constructor(
    private readonly secrets: Readonly<Record<string, string>> = {},
    private readonly parameters: Readonly<Record<string, string>> = {},
    /** Names this role may not read, so the FORBIDDEN path is exercisable. */
    private readonly denied: readonly string[] = [],
  ) {}

  #check(name: string): void {
    if (this.denied.includes(name)) throw new Error(`AccessDeniedException: not authorized to read ${name}`);
  }

  async getSecretValue(name: string, _version: string | null): Promise<string | null> {
    this.#check(name);
    return this.secrets[name] ?? null;
  }

  async getParameter(name: string, _version: string | null): Promise<string | null> {
    this.#check(name);
    return this.parameters[name] ?? null;
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
