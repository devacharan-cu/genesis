/**
 * The two local resolvers, past what the shared conformance suite asks.
 *
 * The suite proves a resolver resolves and redacts. These prove the refusals a
 * resolver must make and the capability it must not acquire by default: reading
 * the process environment is separate, by name, because it has a real blast
 * radius (SPEC-06 §5).
 */

import { describe, expect, it } from 'vitest';
import { EnvironmentSecretResolver, InMemorySecretResolver } from '../src/in-memory.js';
import { refKey, SecretRef, SecretResolutionError, SecretValue } from '../src/port.js';

const ref = (provider: string, name: string, key: string | null = null): SecretRef =>
  SecretRef.parse({ provider, name, key });

const kindOf = async (resolve: () => Promise<unknown>): Promise<string> => {
  const error = await resolve().then(() => null, (thrown: unknown) => thrown as SecretResolutionError);
  expect(error).toBeInstanceOf(SecretResolutionError);
  return (error as SecretResolutionError).kind;
};

describe('the in-memory resolver’s refusals', () => {
  const resolver = (): InMemorySecretResolver =>
    new InMemorySecretResolver({
      'LOCAL:plain': 'the-value',
      'LOCAL:structured': JSON.stringify({ password: 'kept', port: 5432 }),
      'LOCAL:not-json': 'plain text, which has no fields',
      'LOCAL:array': '["a"]',
      'LOCAL:null': 'null',
    });

  it('refuses a keyed reference into something that is not JSON', async () => {
    expect(await kindOf(() => resolver().resolve(ref('LOCAL', 'not-json', 'password')))).toBe('MALFORMED');
  });

  it('refuses a keyed reference into a JSON array, which has no fields', async () => {
    expect(await kindOf(() => resolver().resolve(ref('LOCAL', 'array', 'password')))).toBe('MALFORMED');
  });

  it('refuses a keyed reference into JSON null', async () => {
    expect(await kindOf(() => resolver().resolve(ref('LOCAL', 'null', 'password')))).toBe('MALFORMED');
  });

  it('refuses a field that is not a string, because a secret is bytes', async () => {
    expect(await kindOf(() => resolver().resolve(ref('LOCAL', 'structured', 'port')))).toBe('NO_SUCH_KEY');
  });

  it('refuses a field the secret does not have', async () => {
    expect(await kindOf(() => resolver().resolve(ref('LOCAL', 'structured', 'token')))).toBe('NO_SUCH_KEY');
  });

  it('keys on the provider as well as the name', async () => {
    // A `LOCAL:plain` entry must not answer an `ENVIRONMENT:plain` reference.
    expect(await kindOf(() => resolver().resolve(ref('ENVIRONMENT', 'plain')))).toBe('NOT_FOUND');
  });

  it('holds nothing when it was given nothing', async () => {
    expect(await kindOf(() => new InMemorySecretResolver().resolve(ref('LOCAL', 'anything')))).toBe('NOT_FOUND');
  });

  it('never puts the secret in the failure it reports', async () => {
    const error = await resolver()
      .resolve(ref('LOCAL', 'structured', 'token'))
      .then(() => null, (thrown: unknown) => thrown as SecretResolutionError);
    expect(JSON.stringify(error?.details)).not.toContain('kept');
  });
});

describe('the environment resolver', () => {
  const resolver = (env: Record<string, string | undefined> = { GENESIS_TEST_SECRET: 'from-the-environment' }) =>
    new EnvironmentSecretResolver(env);

  it('resolves a variable it was pointed at', async () => {
    const value = await resolver().resolve(ref('ENVIRONMENT', 'GENESIS_TEST_SECRET'));
    expect(value).toBeInstanceOf(SecretValue);
    expect(value.reveal()).toBe('from-the-environment');
  });

  it('refuses a variable that is not set', async () => {
    expect(await kindOf(() => resolver().resolve(ref('ENVIRONMENT', 'GENESIS_NOT_SET')))).toBe('NOT_FOUND');
  });

  it('serves only ENVIRONMENT references, so it cannot stand in for a backend', async () => {
    for (const provider of ['LOCAL', 'SECRETS_MANAGER', 'SSM_PARAMETER']) {
      expect(await kindOf(() => resolver().resolve(ref(provider, 'GENESIS_TEST_SECRET'))), provider).toBe('FORBIDDEN');
    }
  });

  it('refuses after closing', async () => {
    const closing = resolver();
    await closing.close();
    expect(await kindOf(() => closing.resolve(ref('ENVIRONMENT', 'GENESIS_TEST_SECRET')))).toBe('UNAVAILABLE');
  });

  it('reads the real environment only when nobody supplied one', async () => {
    // The default is `process.env`, which is the capability a caller has to ask
    // for by choosing this resolver at all.
    process.env['GENESIS_COVERAGE_PROBE'] = 'present';
    try {
      const live = new EnvironmentSecretResolver();
      expect((await live.resolve(ref('ENVIRONMENT', 'GENESIS_COVERAGE_PROBE'))).reveal()).toBe('present');
    } finally {
      delete process.env['GENESIS_COVERAGE_PROBE'];
    }
  });

  it('offers no way to enumerate or write', () => {
    const surface = resolver() as unknown as Record<string, unknown>;
    for (const forbidden of ['list', 'keys', 'entries', 'put', 'set']) {
      expect(surface[forbidden], forbidden).toBeUndefined();
    }
  });
});

describe('a resolved value', () => {
  it('redacts through Node’s inspector, so console.log leaks nothing', async () => {
    const value = new SecretValue('the-secret');
    const inspect = (value as unknown as Record<symbol, (() => string) | undefined>)[
      Symbol.for('nodejs.util.inspect.custom')
    ];
    expect(inspect?.call(value)).toBe('[redacted]');
  });

  it('reveals only when asked in so many words', () => {
    const value = new SecretValue('the-secret');
    expect(`${value}`).toBe('[redacted]');
    expect(JSON.stringify({ value })).toBe('{"value":"[redacted]"}');
    expect(value.reveal()).toBe('the-secret');
  });
});

describe('a reference’s identity', () => {
  it('distinguishes every part of it', () => {
    expect(refKey(ref('LOCAL', 'a'))).toBe('LOCAL:a:-:current');
    expect(refKey(SecretRef.parse({ provider: 'LOCAL', name: 'a', key: 'k', version: 'v2' }))).toBe('LOCAL:a:k:v2');
  });
});
