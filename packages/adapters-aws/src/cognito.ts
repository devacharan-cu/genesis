/**
 * The Cognito IdentityProvider adapter (SPEC-07 §3.12, ADR-0026 §1).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). Every `HUMAN_DECISION` on the ledger is
 * attributed to what this returns, so a token accepted that should not be is an
 * unattributable claim at the top of the authority hierarchy (ADR-0005).
 *
 * Verification is deliberately **not** hand-rolled here. Signature checking,
 * key rotation and the JOSE edge cases are exactly the places a bespoke
 * implementation gets it wrong, so the adapter takes a `TokenVerifier` — in a
 * deployment, one backed by Cognito's JWKS — and concerns itself only with what
 * the architecture cares about:
 *
 *   - the claims are the shape a subject needs, and are refused otherwise;
 *   - the issuer and audience are the configured ones, so a token minted by
 *     another pool for another app is not accepted here;
 *   - expiry is enforced against the injected clock, not the verifier's;
 *   - a refusal never says which of those failed, because an error that
 *     distinguishes them is an enumeration oracle (SPEC-06 §2).
 */

import { AuthenticationError, type IdentityProvider, type Subject } from '@genesis/identity';
import { z } from 'zod';

/** What a verifier hands back: the claims, already signature-checked. */
export const CognitoClaims = z
  .object({
    sub: z.string().min(1),
    iss: z.string().min(1),
    /** Access tokens carry `client_id`; id tokens carry `aud`. Either may be present. */
    aud: z.union([z.string(), z.array(z.string())]).optional(),
    client_id: z.string().optional(),
    token_use: z.string().optional(),
    exp: z.number().int(),
    iat: z.number().int().optional(),
    email: z.string().optional(),
    name: z.string().optional(),
    'cognito:username': z.string().optional(),
    'cognito:groups': z.array(z.string()).optional(),
  })
  .passthrough();
export type CognitoClaims = z.infer<typeof CognitoClaims>;

/**
 * Checks a token's signature and returns its claims, or throws.
 *
 * The seam exists so the adapter is testable without a pool, and so the
 * cryptography is somebody else's job (`aws-jwt-verify` in a deployment).
 */
export interface TokenVerifier {
  verify(token: string): Promise<unknown>;
}

export interface CognitoIdentityOptions {
  readonly verifier: TokenVerifier;
  /** `https://cognito-idp.<region>.amazonaws.com/<userPoolId>`. */
  readonly issuer: string;
  /** The app client this deployment accepts tokens for. */
  readonly audience: string;
  readonly now?: (() => Date) | undefined;
}

export class CognitoIdentityProvider implements IdentityProvider {
  readonly #now: () => Date;
  #closed = false;

  constructor(private readonly options: CognitoIdentityOptions) {
    this.#now = options.now ?? ((): Date => new Date());
  }

  async authenticate(token: string): Promise<Subject> {
    if (this.#closed) throw new AuthenticationError('UNAVAILABLE', 'the identity provider is closed');
    if (token.trim().length === 0) throw new AuthenticationError('MALFORMED', 'no token was presented');

    let raw: unknown;
    try {
      raw = await this.options.verifier.verify(token);
    } catch (error) {
      // Whatever the verifier's reason, the caller learns only that it was not
      // accepted. The detail goes in the context, for an operator's logs.
      throw new AuthenticationError('MALFORMED', 'the token was not accepted', {
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    const parsed = CognitoClaims.safeParse(raw);
    if (!parsed.success) {
      throw new AuthenticationError('MALFORMED', 'the token was not accepted', {
        issues: parsed.error.issues.slice(0, 3).map((i) => i.path.join('.')),
      });
    }
    const claims = parsed.data;

    // A valid token from the wrong pool or the wrong app is still the wrong
    // token. The verifier may or may not check this; the adapter always does.
    if (claims.iss !== this.options.issuer) {
      throw new AuthenticationError('UNTRUSTED_ISSUER', 'the token was not accepted', { issuer: claims.iss });
    }
    const audiences = claims.aud === undefined ? [] : Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const clientIds = claims.client_id === undefined ? [] : [claims.client_id];
    if (![...audiences, ...clientIds].includes(this.options.audience)) {
      throw new AuthenticationError('UNTRUSTED_ISSUER', 'the token was not accepted', {});
    }

    const expiresAt = new Date(claims.exp * 1_000);
    if (expiresAt.getTime() <= this.#now().getTime()) {
      throw new AuthenticationError('EXPIRED', 'the token was not accepted', {});
    }

    return {
      subject: claims.sub,
      displayName: claims.name ?? claims['cognito:username'] ?? null,
      email: claims.email ?? null,
      groups: [...(claims['cognito:groups'] ?? [])],
      issuedAt: new Date((claims.iat ?? Math.floor(this.#now().getTime() / 1_000)) * 1_000).toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

/**
 * A verifier that returns claims it was given, for tests.
 *
 * It performs no cryptography and says so in its name: a deployment that wired
 * this in would be accepting unsigned tokens, which is why it lives beside the
 * adapter rather than being its default.
 */
export class UnverifiedClaimsVerifier implements TokenVerifier {
  constructor(private readonly claims: Readonly<Record<string, unknown>>) {}

  async verify(token: string): Promise<unknown> {
    const found = this.claims[token];
    if (found === undefined) throw new Error('no such token');
    return found;
  }
}
