/**
 * Cognito against the identical suite the development provider passes
 * (ADR-0026 §1), plus the refusals only a real token can express: the wrong
 * pool, the wrong app, and an expiry the verifier did not enforce.
 */

import { AuthenticationError } from '@genesis/identity';
import { describeIdentityConformance } from '@genesis/testkit';
import { describe, expect, it } from 'vitest';
import { CognitoIdentityProvider, UnverifiedClaimsVerifier } from '../src/cognito.js';

const ISSUER = 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_TESTPOOL';
const AUDIENCE = 'genesis-console';
const NOW = new Date('2026-09-20T12:00:00.000Z');
const SECONDS = Math.floor(NOW.getTime() / 1_000);

const provider = (claims: Readonly<Record<string, unknown>>): CognitoIdentityProvider =>
  new CognitoIdentityProvider({
    verifier: new UnverifiedClaimsVerifier(claims),
    issuer: ISSUER,
    audience: AUDIENCE,
    now: () => NOW,
  });

const GOOD = {
  sub: 'cognito-subject-1',
  iss: ISSUER,
  aud: AUDIENCE,
  exp: SECONDS + 3_600,
  iat: SECONDS - 60,
  email: 'dev@example.test',
  name: 'Dev',
  'cognito:groups': ['operators'],
};

describeIdentityConformance({
  name: 'CognitoIdentityProvider',
  create: async () => ({
    provider: provider({ 'good-token': GOOD }),
    validToken: 'good-token',
    expectedSubject: 'cognito-subject-1',
  }),
});

describe('what the Cognito adapter accepts', () => {
  it('names the app through client_id, as an access token does', async () => {
    const subject = await provider({ t: { ...GOOD, aud: undefined, client_id: AUDIENCE } }).authenticate('t');
    expect(subject.subject).toBe('cognito-subject-1');
  });

  it('accepts an aud that is a list containing this app', async () => {
    const subject = await provider({ t: { ...GOOD, aud: ['another-app', AUDIENCE] } }).authenticate('t');
    expect(subject.subject).toBe('cognito-subject-1');
  });

  it('carries the display name, email and groups the token asserts', async () => {
    const subject = await provider({ t: GOOD }).authenticate('t');
    expect(subject.displayName).toBe('Dev');
    expect(subject.email).toBe('dev@example.test');
    expect(subject.groups).toEqual(['operators']);
    expect(subject.issuedAt).toBe(new Date((SECONDS - 60) * 1_000).toISOString());
    expect(subject.expiresAt).toBe(new Date((SECONDS + 3_600) * 1_000).toISOString());
  });

  it('falls back to the Cognito username when the token carries no name', async () => {
    const subject = await provider({
      t: { ...GOOD, name: undefined, 'cognito:username': 'devuser' },
    }).authenticate('t');
    expect(subject.displayName).toBe('devuser');
  });

  it('records no name, email or group when the token asserts none', async () => {
    const subject = await provider({ t: { sub: 's', iss: ISSUER, aud: AUDIENCE, exp: SECONDS + 10 } }).authenticate('t');
    expect(subject.displayName).toBeNull();
    expect(subject.email).toBeNull();
    expect(subject.groups).toEqual([]);
    // Absent `iat` means the clock's now, not a missing field: a subject
    // without an issue time could not be checked for currency at all.
    expect(subject.issuedAt).toBe(new Date(SECONDS * 1_000).toISOString());
  });

  it('copies the groups rather than aliasing the claims', async () => {
    const groups = ['operators'];
    const subject = await provider({ t: { ...GOOD, 'cognito:groups': groups } }).authenticate('t');
    (subject.groups as string[]).push('admins');
    expect(groups).toEqual(['operators']);
  });
});

describe('what the Cognito adapter refuses', () => {
  const refusalFor = async (claims: unknown): Promise<AuthenticationError> => {
    const outcome = await provider({ t: claims })
      .authenticate('t')
      .then(() => null, (error: unknown) => error as AuthenticationError);
    expect(outcome).toBeInstanceOf(AuthenticationError);
    return outcome as AuthenticationError;
  };

  it('refuses a token minted by another pool', async () => {
    const failure = await refusalFor({ ...GOOD, iss: 'https://cognito-idp.us-east-1.amazonaws.com/other' });
    expect(failure.kind).toBe('UNTRUSTED_ISSUER');
  });

  it('refuses a token minted for another app', async () => {
    expect((await refusalFor({ ...GOOD, aud: 'another-app' })).kind).toBe('UNTRUSTED_ISSUER');
    expect((await refusalFor({ ...GOOD, aud: ['a', 'b'] })).kind).toBe('UNTRUSTED_ISSUER');
    expect((await refusalFor({ ...GOOD, aud: undefined })).kind).toBe('UNTRUSTED_ISSUER');
    expect((await refusalFor({ ...GOOD, aud: undefined, client_id: 'another-app' })).kind).toBe('UNTRUSTED_ISSUER');
  });

  it('refuses an expired token against its own clock, not the verifier’s', async () => {
    expect((await refusalFor({ ...GOOD, exp: SECONDS - 1 })).kind).toBe('EXPIRED');
    // Expiry is an instant, not a grace period: exactly now is already expired.
    expect((await refusalFor({ ...GOOD, exp: SECONDS })).kind).toBe('EXPIRED');
  });

  it('refuses claims that are not the shape a subject needs', async () => {
    expect((await refusalFor({ iss: ISSUER, exp: SECONDS + 10 })).kind).toBe('MALFORMED');
    expect((await refusalFor({ sub: '', iss: ISSUER, aud: AUDIENCE, exp: SECONDS + 10 })).kind).toBe('MALFORMED');
    expect((await refusalFor({ ...GOOD, exp: 'soon' })).kind).toBe('MALFORMED');
    expect((await refusalFor('not an object at all')).kind).toBe('MALFORMED');
  });

  it('reports a verifier that rejected the signature as a refusal, not a crash', async () => {
    const failure = await provider({})
      .authenticate('forged')
      .then(() => null, (error: unknown) => error as AuthenticationError);
    expect(failure?.kind).toBe('MALFORMED');
    expect(failure?.message).toBe('the token was not accepted');
  });

  it('reports a verifier that threw something other than an Error', async () => {
    const odd = new CognitoIdentityProvider({
      verifier: {
        verify: async () => {
          throw 'a string, as some crypto layers throw';
        },
      },
      issuer: ISSUER,
      audience: AUDIENCE,
      now: () => NOW,
    });
    const failure = await odd.authenticate('t').then(() => null, (error: unknown) => error as AuthenticationError);
    expect(failure?.kind).toBe('MALFORMED');
    expect(JSON.stringify(failure?.details)).toContain('a string');
  });

  it('never names the pool, the app or the subject in a refusal', async () => {
    for (const claims of [
      { ...GOOD, iss: 'https://elsewhere' },
      { ...GOOD, aud: 'another-app' },
      { ...GOOD, exp: SECONDS - 1 },
    ]) {
      const failure = await refusalFor(claims);
      expect(failure.message).toBe('the token was not accepted');
      expect(failure.message).not.toContain(AUDIENCE);
      expect(failure.message).not.toContain('cognito-subject-1');
    }
  });

  it('refuses everything once closed, including a token it would have accepted', async () => {
    const closing = provider({ 'good-token': GOOD });
    expect((await closing.authenticate('good-token')).subject).toBe('cognito-subject-1');
    await closing.close();
    const failure = await closing
      .authenticate('good-token')
      .then(() => null, (error: unknown) => error as AuthenticationError);
    expect(failure?.kind).toBe('UNAVAILABLE');
    await expect(closing.close()).resolves.toBeUndefined();
  });

  it('uses the real clock when none is injected', async () => {
    const live = new CognitoIdentityProvider({
      verifier: new UnverifiedClaimsVerifier({ t: { ...GOOD, exp: Math.floor(Date.now() / 1_000) + 600 } }),
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect((await live.authenticate('t')).subject).toBe('cognito-subject-1');
  });
});
