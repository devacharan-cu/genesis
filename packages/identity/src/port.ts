/**
 * The IdentityProvider port (SPEC-07 §3.12, ADR-0026 §1).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). The authority hierarchy tops out at
 * `HUMAN_DECISION` ([ADR-0005](../../../docs/adr/0005-authority-over-confidence.md)),
 * and a human decision nobody can attribute is a claim nobody can check. This
 * is the only thing standing between "a person decided" and "something said a
 * person decided".
 *
 * Note what is ABSENT: there is no anonymous subject, no `unauthenticated`
 * result and no default identity. `authenticate` either returns a verified
 * subject or throws. A fallback is exactly how an unattributed
 * `HUMAN_DECISION` gets written, so the type does not offer one.
 *
 * The provider does not decide what a subject may do. Authorisation is the
 * core's, against the authority rules; this answers only *who*.
 */

import type { ActorKind } from '@genesis/core-types';
import { GenesisError } from '@genesis/core-types';

/** A verified human. `subject` is the stable identifier a decision is attributed to. */
export interface Subject {
  /** Stable and opaque. An email can change; this cannot. */
  readonly subject: string;
  /** For display only. Never used to decide anything. */
  readonly displayName: string | null;
  readonly email: string | null;
  /** Groups the identity provider asserted. The core maps these to permissions. */
  readonly groups: readonly string[];
  /** When the assertion was issued and when it stops being good, as ISO instants. */
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/** Why an authentication was refused. Typed, so a caller can tell them apart. */
export const AUTH_FAILURES = ['MALFORMED', 'EXPIRED', 'UNTRUSTED_ISSUER', 'UNKNOWN_SUBJECT', 'UNAVAILABLE'] as const;
export type AuthFailureKind = (typeof AUTH_FAILURES)[number];

export class AuthenticationError extends GenesisError {
  constructor(
    readonly kind: AuthFailureKind,
    message: string,
    context: Readonly<Record<string, unknown>> = {},
  ) {
    super('AUTHENTICATION_FAILED', message, context);
    this.name = 'AuthenticationError';
  }
}

export interface IdentityProvider {
  /** Who this token belongs to, or a typed refusal. Never a default subject. */
  authenticate(token: string): Promise<Subject>;
  close(): Promise<void>;
}

/**
 * The actor a verified subject becomes on the ledger.
 *
 * `HUMAN`, always: this port authenticates people. An agent's identity is its
 * manifest and a system actor is the runtime's own, and neither comes from
 * here. The kind is derived rather than supplied so that a caller cannot
 * authenticate a person and then record the event as the system.
 */
export const actorFor = (subject: Subject): { kind: ActorKind; id: string } => ({
  kind: 'HUMAN',
  id: subject.subject,
});

/** True when the assertion is still good at this instant. */
export const isCurrent = (subject: Subject, at: Date): boolean => Date.parse(subject.expiresAt) > at.getTime();
