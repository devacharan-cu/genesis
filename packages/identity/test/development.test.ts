/**
 * The development identity provider, past what the shared suite asks.
 *
 * Its refusals are the interesting part. A local identity provider is the
 * easiest thing in a system to turn into a default credential by accident, and
 * every check here exists to make that impossible rather than discouraged.
 */

import { ValidationError } from '@genesis/core-types';
import { describe, expect, it } from 'vitest';
import { DevelopmentIdentityProvider } from '../src/development.js';
import { actorFor, AuthenticationError, isCurrent, type Subject } from '../src/port.js';

const AT = new Date('2026-09-20T12:00:00.000Z');

const build = (
  subjects: readonly {
    token: string;
    subject: string;
    displayName?: string;
    email?: string;
    groups?: readonly string[];
    ttlSeconds?: number;
  }[],
): DevelopmentIdentityProvider => new DevelopmentIdentityProvider(subjects, { now: () => AT });

const kindOf = async (act: () => Promise<unknown>): Promise<string> => {
  const error = await act().then(() => null, (thrown: unknown) => thrown as AuthenticationError);
  expect(error).toBeInstanceOf(AuthenticationError);
  return (error as AuthenticationError).kind;
};

describe('what it refuses to be constructed as', () => {
  it('refuses a subject with no token, which would be unreachable', () => {
    expect(() => build([{ token: '', subject: 'dev' }])).toThrow(ValidationError);
    expect(() => build([{ token: '   ', subject: 'dev' }])).toThrow(/needs a token/);
  });

  it('refuses two subjects behind one token', () => {
    // Whoever logs in would be whichever the map happened to keep, which is
    // not an identity system.
    expect(() => build([{ token: 't', subject: 'a' }, { token: 't', subject: 'b' }])).toThrow(/share a token/);
  });

  it('names no token in the refusal', () => {
    try {
      build([{ token: 'the-real-token', subject: 'a' }, { token: 'the-real-token', subject: 'b' }]);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('the-real-token');
      expect(JSON.stringify((error as ValidationError).details)).not.toContain('the-real-token');
    }
  });

  it('has no default subject, so an empty provider accepts nobody', async () => {
    expect(await kindOf(() => build([]).authenticate('anything'))).toBe('UNKNOWN_SUBJECT');
  });
});

describe('what it returns', () => {
  const full = build([
    { token: 't', subject: 'dev-1', displayName: 'Dev', email: 'dev@example.test', groups: ['operators'], ttlSeconds: 60 },
  ]);

  it('carries everything the subject was declared with', async () => {
    const subject = await full.authenticate('t');
    expect(subject).toEqual({
      subject: 'dev-1',
      displayName: 'Dev',
      email: 'dev@example.test',
      groups: ['operators'],
      issuedAt: AT.toISOString(),
      expiresAt: new Date(AT.getTime() + 60_000).toISOString(),
    });
  });

  it('records nothing it was not told', async () => {
    const bare = build([{ token: 't', subject: 'dev-2' }]);
    const subject = await bare.authenticate('t');
    expect(subject.displayName).toBeNull();
    expect(subject.email).toBeNull();
    expect(subject.groups).toEqual([]);
  });

  it('defaults the lifetime to an hour rather than to forever', async () => {
    const subject = await build([{ token: 't', subject: 'dev-3' }]).authenticate('t');
    expect(Date.parse(subject.expiresAt) - Date.parse(subject.issuedAt)).toBe(3_600_000);
  });

  it('copies the groups rather than aliasing what it was given', async () => {
    const groups = ['operators'];
    const subject = await build([{ token: 't', subject: 'dev-4', groups }]).authenticate('t');
    (subject.groups as string[]).push('admins');
    expect(groups).toEqual(['operators']);
  });

  it('uses the real clock when none is injected', async () => {
    const live = new DevelopmentIdentityProvider([{ token: 't', subject: 'dev-5' }]);
    const subject = await live.authenticate('t');
    expect(Date.parse(subject.issuedAt)).toBeGreaterThan(Date.now() - 5_000);
  });
});

describe('what it refuses at the door', () => {
  const one = build([{ token: 'the-token', subject: 'dev-1' }]);

  it('refuses an empty token', async () => {
    expect(await kindOf(() => one.authenticate(''))).toBe('MALFORMED');
    expect(await kindOf(() => one.authenticate('  '))).toBe('MALFORMED');
  });

  it('refuses an unknown token without saying it nearly matched', async () => {
    const error = await one
      .authenticate('the-toke')
      .then(() => null, (thrown: unknown) => thrown as AuthenticationError);
    expect(error?.kind).toBe('UNKNOWN_SUBJECT');
    expect(error?.message).not.toContain('the-token');
    expect(error?.message).not.toContain('dev-1');
  });

  it('refuses an assertion that expired as it was issued', async () => {
    // A zero lifetime is how a test asks for an already-expired assertion
    // without waiting for one.
    const instant = build([{ token: 't', subject: 'dev-6', ttlSeconds: 0 }]);
    expect(await kindOf(() => instant.authenticate('t'))).toBe('EXPIRED');
    const past = build([{ token: 't', subject: 'dev-7', ttlSeconds: -60 }]);
    expect(await kindOf(() => past.authenticate('t'))).toBe('EXPIRED');
  });

  it('refuses everything once closed', async () => {
    const closing = build([{ token: 't', subject: 'dev-8' }]);
    expect((await closing.authenticate('t')).subject).toBe('dev-8');
    await closing.close();
    expect(await kindOf(() => closing.authenticate('t'))).toBe('UNAVAILABLE');
    await expect(closing.close()).resolves.toBeUndefined();
  });
});

describe('what a subject is for', () => {
  const subject: Subject = {
    subject: 'dev-1',
    displayName: 'Dev',
    email: null,
    groups: [],
    issuedAt: AT.toISOString(),
    expiresAt: new Date(AT.getTime() + 60_000).toISOString(),
  };

  it('becomes the actor a HUMAN_DECISION is attributed to', () => {
    expect(actorFor(subject)).toEqual({ kind: 'HUMAN', id: 'dev-1' });
  });

  it('is current until the instant it expires, and not after', () => {
    expect(isCurrent(subject, AT)).toBe(true);
    expect(isCurrent(subject, new Date(AT.getTime() + 59_999))).toBe(true);
    // Expiry is an instant, not a grace period.
    expect(isCurrent(subject, new Date(AT.getTime() + 60_000))).toBe(false);
    expect(isCurrent(subject, new Date(AT.getTime() + 60_001))).toBe(false);
  });
});
