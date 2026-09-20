/**
 * The HTTP surface, against a whole in-process deployment.
 *
 * The three properties from `api.ts` are what these tests are for: there is
 * always a subject, the subject is always acting on this deployment's project,
 * and the only thing a write records is an intent.
 */

import { projectScope, ValidationError } from '@genesis/core-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { apiHandler, type HttpRequest, INTENT_EVENT_TYPE } from '../src/api.js';
import { claimsFor, deployment, type Deployment, humanEvent, ledgerWith, SUBJECT, TOKEN } from './harness.js';

let d: Deployment;

beforeEach(() => {
  d = deployment();
});

const request = (overrides: Partial<HttpRequest> = {}): HttpRequest => ({
  rawPath: `/projects/${d.projectId}/head`,
  requestContext: { http: { method: 'GET' } },
  headers: { authorization: `Bearer ${TOKEN}` },
  ...overrides,
});

const body = (response: { body: string }): Record<string, unknown> => JSON.parse(response.body);

const VALID_INTENT = {
  goalId: 'goal-1',
  title: 'Add the thing',
  specification: 'It should do the thing, and a test should prove it.',
  testCommand: ['npm', 'test'],
};

describe('authentication', () => {
  it('refuses a request with no Authorization header', async () => {
    const response = await apiHandler(d.runtime, request({ headers: {} }));
    expect(response.statusCode).toBe(401);
  });

  it('refuses a header that is not a bearer token', async () => {
    for (const authorization of ['', 'Basic abc', 'Bearer', 'token-without-scheme']) {
      expect((await apiHandler(d.runtime, request({ headers: { authorization } }))).statusCode, authorization).toBe(401);
    }
  });

  it('reads the header whatever case it arrived in', async () => {
    const response = await apiHandler(d.runtime, request({ headers: { Authorization: `Bearer ${TOKEN}` } }));
    expect(response.statusCode).toBe(200);
  });

  it('refuses a token the pool did not mint', async () => {
    expect((await apiHandler(d.runtime, request({ headers: { authorization: 'Bearer forged' } }))).statusCode).toBe(401);
  });

  it('refuses an expired token', async () => {
    const expired = deployment({ claims: claimsFor({ exp: Math.floor(Date.now() / 1_000) - 1 }) });
    const response = await apiHandler(expired.runtime, {
      rawPath: `/projects/${expired.projectId}/head`,
      requestContext: { http: { method: 'GET' } },
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('says nothing about why a token was refused', async () => {
    const response = await apiHandler(d.runtime, request({ headers: { authorization: 'Bearer forged' } }));
    expect(body(response)).toEqual({ error: 'authentication required' });
  });

  it('authenticates before it looks at the route, so an unknown path leaks nothing', async () => {
    const response = await apiHandler(d.runtime, request({ rawPath: '/admin', headers: {} }));
    expect(response.statusCode).toBe(401);
  });
});

describe('project isolation', () => {
  it('refuses a path naming another project', async () => {
    const response = await apiHandler(d.runtime, request({ rawPath: '/projects/prj-somebody-else/head' }));
    expect(response.statusCode).toBe(404);
  });

  it('answers a path naming another project exactly as it answers a nonexistent one', async () => {
    const other = await apiHandler(d.runtime, request({ rawPath: '/projects/prj-somebody-else/head' }));
    const nothing = await apiHandler(d.runtime, request({ rawPath: '/projects/prj-does-not-exist/head' }));
    expect(other).toEqual(nothing);
  });
});

describe('reading history', () => {
  beforeEach(async () => {
    const scope = projectScope(d.projectId);
    for (let i = 0; i < 3; i += 1) await d.runtime.ledger.append(scope, humanEvent({ after: { i } }));
  });

  it('answers the head of the chain', async () => {
    const response = await apiHandler(d.runtime, request());
    expect(response.statusCode).toBe(200);
    expect(body(response)['head']).toMatchObject({ seq: 3 });
  });

  it('answers the events', async () => {
    const response = await apiHandler(d.runtime, request({ rawPath: `/projects/${d.projectId}/events` }));
    expect((body(response)['events'] as unknown[]).length).toBe(3);
  });

  it('honours a sequence range', async () => {
    const response = await apiHandler(
      d.runtime,
      request({ rawPath: `/projects/${d.projectId}/events`, queryStringParameters: { fromSeq: '2', toSeq: '3' } }),
    );
    expect((body(response)['events'] as { seq: number }[]).map((e) => e.seq)).toEqual([2, 3]);
  });

  it('refuses a sequence that is not a positive integer', async () => {
    for (const fromSeq of ['0', '-1', 'two', '1.5']) {
      const response = await apiHandler(
        d.runtime,
        request({ rawPath: `/projects/${d.projectId}/events`, queryStringParameters: { fromSeq } }),
      );
      expect(response.statusCode, fromSeq).toBe(400);
    }
  });

  it('verifies the chain on request, because that is what the ledger is for', async () => {
    const response = await apiHandler(d.runtime, request({ rawPath: `/projects/${d.projectId}/verify` }));
    expect(response.statusCode).toBe(200);
    expect(body(response)['ok']).toBe(true);
  });

  it('never caches an answer about history', async () => {
    expect((await apiHandler(d.runtime, request())).headers['cache-control']).toBe('no-store');
  });

  it('refuses a write method on a read route', async () => {
    const response = await apiHandler(d.runtime, request({ requestContext: { http: { method: 'DELETE' } } }));
    expect(response.statusCode).toBe(405);
  });

  it('defaults to GET when the request does not say', async () => {
    expect((await apiHandler(d.runtime, request({ requestContext: {} }))).statusCode).toBe(200);
  });

  it('refuses a route it does not serve', async () => {
    for (const rawPath of ['/', '/projects', `/projects/${d.projectId}`, `/projects/${d.projectId}/anything`]) {
      expect((await apiHandler(d.runtime, request({ rawPath }))).statusCode, rawPath).toBe(404);
    }
  });
});

describe('recording an intent', () => {
  const post = (payload: unknown, method = 'POST'): HttpRequest =>
    request({
      rawPath: `/projects/${d.projectId}/intent`,
      requestContext: { http: { method } },
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });

  it('appends an event attributed to the authenticated person', async () => {
    const response = await apiHandler(d.runtime, post(VALID_INTENT));
    expect(response.statusCode).toBe(202);

    const [event] = await d.runtime.ledger.read(projectScope(d.projectId));
    expect(event?.type).toBe(INTENT_EVENT_TYPE);
    expect(event?.actor).toMatchObject({ kind: 'HUMAN', id: SUBJECT });
    expect(event?.authority).toBe('HUMAN_DECISION');
    expect(event?.after).toEqual(VALID_INTENT);
  });

  it('answers 202, because recording an ask is not agreeing to build it', async () => {
    const response = await apiHandler(d.runtime, post(VALID_INTENT));
    expect(response.statusCode).toBe(202);
    expect(Object.keys(body(response)).sort()).toEqual(['eventId', 'seq']);
  });

  it('starts nothing: the event is the only effect', async () => {
    await apiHandler(d.runtime, post(VALID_INTENT));
    expect(await d.runtime.ledger.count(projectScope(d.projectId))).toBe(1);
    expect(d.bus.published).toEqual([]);
  });

  it('refuses an intent that is missing what the factory needs', async () => {
    for (const partial of [
      { ...VALID_INTENT, goalId: undefined },
      { ...VALID_INTENT, testCommand: [] },
      { ...VALID_INTENT, specification: '' },
      {},
    ]) {
      const response = await apiHandler(d.runtime, post(partial));
      expect(response.statusCode, JSON.stringify(partial)).toBe(400);
    }
  });

  it('refuses anything the intent did not declare', async () => {
    const response = await apiHandler(d.runtime, post({ ...VALID_INTENT, authority: 'VERIFIED' }));
    expect(response.statusCode).toBe(400);
    expect(body(response)['fields']).toContain('authority');
  });

  it('refuses a body that is not JSON', async () => {
    expect((await apiHandler(d.runtime, post('not json at all'))).statusCode).toBe(400);
  });

  it('refuses a request with no body', async () => {
    const response = await apiHandler(
      d.runtime,
      request({ rawPath: `/projects/${d.projectId}/intent`, requestContext: { http: { method: 'POST' } }, body: null }),
    );
    expect(response.statusCode).toBe(400);
  });

  it('refuses a read method on the write route', async () => {
    expect((await apiHandler(d.runtime, post(VALID_INTENT, 'GET'))).statusCode).toBe(405);
  });

  it('cannot be used to record something at another project', async () => {
    const response = await apiHandler(
      d.runtime,
      request({ rawPath: '/projects/prj-elsewhere/intent', requestContext: { http: { method: 'POST' } }, body: JSON.stringify(VALID_INTENT) }),
    );
    expect(response.statusCode).toBe(404);
    expect(await d.runtime.ledger.count(projectScope(d.projectId))).toBe(0);
  });
});

describe('when the runtime itself is broken', () => {
  it('refuses a request that carries no headers at all', async () => {
    const response = await apiHandler(d.runtime, { rawPath: `/projects/${d.projectId}/head` });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a request that names no path at all', async () => {
    const response = await apiHandler(d.runtime, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.statusCode).toBe(404);
  });

  it('answers 400 when the ledger rejects what was asked of it', async () => {
    const broken = {
      ...d.runtime,
      ledger: ledgerWith(d.runtime.ledger, {
        head: async () => {
          throw new ValidationError('the read was not understood', {});
        },
      }),
    };
    expect((await apiHandler(broken, request())).statusCode).toBe(400);
  });

  it('lets an unexpected read failure surface rather than answering 200', async () => {
    const broken = {
      ...d.runtime,
      ledger: ledgerWith(d.runtime.ledger, {
        head: async () => {
          throw new TypeError('the adapter is misconfigured');
        },
      }),
    };
    await expect(apiHandler(broken, request())).rejects.toThrow(TypeError);
  });

  it('answers 400 when the ledger refuses the intent it was handed', async () => {
    const broken = {
      ...d.runtime,
      ledger: ledgerWith(d.runtime.ledger, {
        append: async () => {
          throw new ValidationError('invalid event input', {});
        },
      }),
    };
    const response = await apiHandler(broken, {
      rawPath: `/projects/${d.projectId}/intent`,
      requestContext: { http: { method: 'POST' } },
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(VALID_INTENT),
    });
    expect(response.statusCode).toBe(400);
  });

  it('lets an unexpected append failure surface', async () => {
    const broken = {
      ...d.runtime,
      ledger: ledgerWith(d.runtime.ledger, {
        append: async () => {
          throw new TypeError('the adapter is misconfigured');
        },
      }),
    };
    const post = {
      rawPath: `/projects/${d.projectId}/intent`,
      requestContext: { http: { method: 'POST' } },
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(VALID_INTENT),
    };
    await expect(apiHandler(broken, post)).rejects.toThrow(TypeError);
  });

  it('lets an unexpected authentication failure surface rather than answering 200', async () => {
    const broken = {
      ...d.runtime,
      identity: {
        authenticate: async () => {
          throw new TypeError('the provider is misconfigured');
        },
        close: async () => undefined,
      },
    };
    await expect(apiHandler(broken, request())).rejects.toThrow(TypeError);
  });
});
