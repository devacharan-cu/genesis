/**
 * The AWS resolver against the identical suite the in-memory one passes
 * (ADR-0026 §1), plus the failures only a real backend can express: a denial,
 * an unreachable service, and a provider this resolver does not serve.
 */

import { SecretRef, SecretResolutionError } from '@genesis/secrets';
import { describeSecretResolverConformance } from '@genesis/testkit';
import { describe, expect, it } from 'vitest';
import { AwsSecretResolver, type SecretsClient, SecretsClientModel } from '../src/secrets.js';

const SECRETS = {
  'genesis/plain': 'the-plain-value',
  'genesis/structured': JSON.stringify({ password: 'the-keyed-value', username: 'svc', port: 5432 }),
  'genesis/not-json': 'plain text, which has no fields',
  'genesis/array': '["a","b"]',
};
const PARAMETERS = { '/genesis/param': 'the-parameter-value' };

const resolver = (denied: readonly string[] = []): AwsSecretResolver =>
  new AwsSecretResolver({ client: new SecretsClientModel(SECRETS, PARAMETERS, denied) });

const ref = (provider: string, name: string, key: string | null = null): SecretRef =>
  SecretRef.parse({ provider, name, key });

describeSecretResolverConformance({
  name: 'AwsSecretResolver',
  create: async () => ({
    resolver: resolver(),
    plain: ref('SECRETS_MANAGER', 'genesis/plain'),
    plainValue: 'the-plain-value',
    keyed: ref('SECRETS_MANAGER', 'genesis/structured', 'password'),
    keyedValue: 'the-keyed-value',
    absent: ref('SECRETS_MANAGER', 'genesis/nothing'),
  }),
});

describe('what the AWS resolver serves', () => {
  it('resolves an SSM parameter as readily as a secret', async () => {
    const value = await resolver().resolve(ref('SSM_PARAMETER', '/genesis/param'));
    expect(value.reveal()).toBe('the-parameter-value');
  });

  it('passes a pinned version through to the backend rather than ignoring it', async () => {
    const asked: Array<[string, string | null]> = [];
    const client: SecretsClient = {
      getSecretValue: async (name, version) => {
        asked.push([name, version]);
        return 'pinned';
      },
      getParameter: async (name, version) => {
        asked.push([name, version]);
        return 'pinned';
      },
      close: async () => undefined,
    };
    const pinning = new AwsSecretResolver({ client });
    await pinning.resolve(SecretRef.parse({ provider: 'SECRETS_MANAGER', name: 'a', version: 'v7' }));
    await pinning.resolve(SecretRef.parse({ provider: 'SSM_PARAMETER', name: '/b', version: '3' }));
    expect(asked).toEqual([
      ['a', 'v7'],
      ['/b', '3'],
    ]);
  });

  it('does not cache: a rotated secret resolves to its new value', async () => {
    let current = 'before-rotation';
    const rotating = new AwsSecretResolver({
      client: {
        getSecretValue: async () => current,
        getParameter: async () => null,
        close: async () => undefined,
      },
    });
    expect((await rotating.resolve(ref('SECRETS_MANAGER', 'r'))).reveal()).toBe('before-rotation');
    current = 'after-rotation';
    expect((await rotating.resolve(ref('SECRETS_MANAGER', 'r'))).reveal()).toBe('after-rotation');
  });
});

describe('what the AWS resolver refuses', () => {
  const kindOf = async (target: SecretRef, denied: readonly string[] = []): Promise<string> => {
    const error = await resolver(denied)
      .resolve(target)
      .then(() => null, (thrown: unknown) => thrown as SecretResolutionError);
    expect(error).toBeInstanceOf(SecretResolutionError);
    return (error as SecretResolutionError).kind;
  };

  it('reports a denial as a policy problem, not as a missing secret', async () => {
    expect(await kindOf(ref('SECRETS_MANAGER', 'genesis/plain'), ['genesis/plain'])).toBe('FORBIDDEN');
    expect(await kindOf(ref('SSM_PARAMETER', '/genesis/param'), ['/genesis/param'])).toBe('FORBIDDEN');
  });

  it('reports an unreachable backend as unavailable, which has a different fix', async () => {
    const broken = new AwsSecretResolver({
      client: {
        getSecretValue: async () => {
          throw new Error('ETIMEDOUT talking to the endpoint');
        },
        getParameter: async () => null,
        close: async () => undefined,
      },
    });
    const error = await broken
      .resolve(ref('SECRETS_MANAGER', 'x'))
      .then(() => null, (thrown: unknown) => thrown as SecretResolutionError);
    expect(error?.kind).toBe('UNAVAILABLE');
  });

  it('reports a non-Error rejection as unavailable rather than crashing', async () => {
    const odd = new AwsSecretResolver({
      client: {
        getSecretValue: async () => {
          throw 'a string, as some SDK layers throw';
        },
        getParameter: async () => null,
        close: async () => undefined,
      },
    });
    const error = await odd
      .resolve(ref('SECRETS_MANAGER', 'x'))
      .then(() => null, (thrown: unknown) => thrown as SecretResolutionError);
    expect(error?.kind).toBe('UNAVAILABLE');
    expect(error?.message).toContain('a string');
  });

  it('refuses a provider it does not serve, rather than guessing a backend', async () => {
    expect(await kindOf(ref('ENVIRONMENT', 'PATH'))).toBe('FORBIDDEN');
    expect(await kindOf(ref('LOCAL', 'x'))).toBe('FORBIDDEN');
  });

  it('refuses a keyed reference into a secret that is not JSON', async () => {
    expect(await kindOf(ref('SECRETS_MANAGER', 'genesis/not-json', 'x'))).toBe('MALFORMED');
  });

  it('refuses a keyed reference into a JSON array, which has no fields', async () => {
    expect(await kindOf(ref('SECRETS_MANAGER', 'genesis/array', 'x'))).toBe('MALFORMED');
  });

  it('refuses a field the secret does not have', async () => {
    expect(await kindOf(ref('SECRETS_MANAGER', 'genesis/structured', 'token'))).toBe('NO_SUCH_KEY');
  });

  it('refuses a field that is not a string, because a secret is bytes', async () => {
    expect(await kindOf(ref('SECRETS_MANAGER', 'genesis/structured', 'port'))).toBe('NO_SUCH_KEY');
  });

  it('refuses a missing SSM parameter', async () => {
    expect(await kindOf(ref('SSM_PARAMETER', '/nothing'))).toBe('NOT_FOUND');
  });

  it('refuses after closing, and closes the client under it', async () => {
    let closed = false;
    const closing = new AwsSecretResolver({
      client: {
        getSecretValue: async () => 'v',
        getParameter: async () => null,
        close: async () => {
          closed = true;
        },
      },
    });
    await closing.close();
    expect(closed).toBe(true);
    const error = await closing
      .resolve(ref('SECRETS_MANAGER', 'x'))
      .then(() => null, (thrown: unknown) => thrown as SecretResolutionError);
    expect(error?.kind).toBe('UNAVAILABLE');
  });

  it('never puts the resolved value in the failure it reports', async () => {
    const error = await resolver(['genesis/plain'])
      .resolve(ref('SECRETS_MANAGER', 'genesis/plain'))
      .then(() => null, (thrown: unknown) => thrown as SecretResolutionError);
    expect(JSON.stringify(error?.details ?? {})).not.toContain('the-plain-value');
    expect(error?.message).not.toContain('the-plain-value');
  });
});

describe('the backend model itself', () => {
  it('holds nothing by default, so a test must state what it is standing on', async () => {
    const empty = new SecretsClientModel();
    expect(await empty.getSecretValue('anything', null)).toBeNull();
    expect(await empty.getParameter('/anything', null)).toBeNull();
    await expect(empty.close()).resolves.toBeUndefined();
  });
});
