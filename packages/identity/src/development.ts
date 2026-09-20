/**
 * The development identity provider (ADR-0026 §1).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). It exists so the system can be run and tested
 * without Cognito, which means it is also the thing most likely to be left in
 * front of a real deployment by accident.
 *
 * So it is built to be useless by default. It is constructed with the exact
 * tokens it will accept; there is no default credential, no wildcard and no
 * "allow any token in development" switch. A deployment that forgot to
 * configure a real provider authenticates *nobody* rather than everybody, and
 * the failure is a refused login rather than an unattributed decision.
 *
 * It also honours expiry, because a provider that ignored it would let every
 * test pass against a rule production enforces.
 */

import { ValidationError } from '@genesis/core-types';
import { AuthenticationError, type IdentityProvider, isCurrent, type Subject } from './port.js';

export interface DevelopmentSubject {
  readonly token: string;
  readonly subject: string;
  readonly displayName?: string | undefined;
  readonly email?: string | undefined;
  readonly groups?: readonly string[] | undefined;
  /** Seconds the assertion is good for, from `now`. Defaults to an hour. */
  readonly ttlSeconds?: number | undefined;
}

export interface DevelopmentIdentityOptions {
  /** Injectable clock, for deterministic tests. */
  readonly now?: (() => Date) | undefined;
}

const DEFAULT_TTL_SECONDS = 3_600;

export class DevelopmentIdentityProvider implements IdentityProvider {
  readonly #subjects = new Map<string, DevelopmentSubject>();
  readonly #now: () => Date;
  #closed = false;

  constructor(subjects: readonly DevelopmentSubject[], options: DevelopmentIdentityOptions = {}) {
    for (const subject of subjects) {
      if (subject.token.trim().length === 0) {
        throw new ValidationError('a development subject needs a token to be recognised by', {
          subject: subject.subject,
        });
      }
      if (this.#subjects.has(subject.token)) {
        // Two subjects behind one token means whoever logs in is whichever the
        // map happened to keep, which is not an identity system.
        throw new ValidationError('two development subjects share a token', { token: '<redacted>' });
      }
      this.#subjects.set(subject.token, subject);
    }
    this.#now = options.now ?? ((): Date => new Date());
  }

  async authenticate(token: string): Promise<Subject> {
    if (this.#closed) throw new AuthenticationError('UNAVAILABLE', 'the identity provider is closed');
    if (token.trim().length === 0) throw new AuthenticationError('MALFORMED', 'no token was presented');

    const found = this.#subjects.get(token);
    if (found === undefined) {
      // The message names no token and no near miss: a login endpoint that
      // distinguishes "no such user" from "wrong password" is an enumeration
      // oracle (SPEC-06 §2).
      throw new AuthenticationError('UNKNOWN_SUBJECT', 'the token is not one this provider accepts');
    }

    const at = this.#now();
    const expiresAt = new Date(at.getTime() + (found.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1_000);
    const subject: Subject = {
      subject: found.subject,
      displayName: found.displayName ?? null,
      email: found.email ?? null,
      groups: [...(found.groups ?? [])],
      issuedAt: at.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    if (!isCurrent(subject, at)) {
      // Reachable with a zero or negative ttl, which is how a test asks for an
      // already-expired assertion without waiting for one.
      throw new AuthenticationError('EXPIRED', 'the assertion expired as it was issued', { subject: found.subject });
    }
    return subject;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
