/**
 * The authenticated HTTP surface (SPEC-07 §3.6).
 *
 * Three properties hold for every request, and they are checked in this order
 * because each depends on the one before it:
 *
 *   1. **There is a subject.** No anonymous route exists. A caller without a
 *      verified Cognito subject cannot do anything, because nothing it did
 *      could be attributed on the ledger (ADR-0005).
 *   2. **The subject is acting on this deployment's project.** One stack serves
 *      one project (SPEC-07 §7), so a path naming another project is refused
 *      rather than served from a store that would have answered.
 *   3. **What it writes is an intent, not a conclusion.** The write route
 *      appends a `HUMAN_INTENT_RECORDED` event and nothing else. It does not
 *      start a run, decide anything, or produce state: Step Functions reacts to
 *      the event (SPEC-07 §3.7), so the API cannot become a second orchestrator.
 *
 * Failures never distinguish "no such project" from "not your project", for the
 * same reason the identity adapter does not distinguish its refusals.
 */

import { projectScope, ValidationError } from '@genesis/core-types';
import { AuthenticationError, actorFor, type Subject } from '@genesis/identity';
import { z } from 'zod';
import type { CloudRuntime } from './runtime.js';

export interface HttpRequest {
  readonly rawPath?: string;
  readonly requestContext?: { readonly http?: { readonly method?: string } };
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly queryStringParameters?: Readonly<Record<string, string | undefined>> | null;
  readonly body?: string | null;
}

export interface HttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const json = (statusCode: number, value: unknown): HttpResponse => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(value),
});

/** Every refusal says only this. The detail goes to the log, not to the caller. */
const refuse = (statusCode: number, reason: string): HttpResponse => json(statusCode, { error: reason });

/** What a human may ask the factory to build. Validated before it reaches history. */
export const IntentBody = z
  .object({
    goalId: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(200),
    specification: z.string().trim().min(1).max(20_000),
    testCommand: z.array(z.string().min(1)).min(1).max(20),
  })
  .strict();
export type IntentBody = z.infer<typeof IntentBody>;

export const INTENT_EVENT_TYPE = 'HUMAN_INTENT_RECORDED';

const PROJECT_ROUTE = /^\/projects\/(?<projectId>[^/]+)\/(?<resource>head|events|verify|intent)$/;

const bearer = (headers: Readonly<Record<string, string | undefined>> | undefined): string | null => {
  // Header names arrive in whatever case the client sent.
  const raw = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
  if (raw === undefined) return null;
  const match = /^Bearer (?<token>.+)$/i.exec(raw.trim());
  return match?.groups?.['token'] ?? null;
};

const positiveInt = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new ValidationError('a sequence must be a positive integer', {});
  return value;
};

/**
 * Handles one request.
 *
 * Returns a response for every outcome including a refusal, and throws only
 * when the runtime itself is broken — because an exception out of a handler
 * becomes a 502 with no body, which tells a caller nothing.
 */
export async function apiHandler(runtime: CloudRuntime, request: HttpRequest): Promise<HttpResponse> {
  const token = bearer(request.headers);
  if (token === null) return refuse(401, 'authentication required');

  let subject: Subject;
  try {
    subject = await runtime.identity.authenticate(token);
  } catch (error) {
    if (error instanceof AuthenticationError) return refuse(401, 'authentication required');
    throw error;
  }

  const route = PROJECT_ROUTE.exec(request.rawPath ?? '');
  if (route === null) return refuse(404, 'no such route');
  const { projectId, resource } = route.groups as { projectId: string; resource: string };

  // One stack, one project. Another project's id is refused identically to a
  // project that does not exist.
  if (projectId !== runtime.config.projectId) return refuse(404, 'no such project');
  const scope = projectScope(runtime.config.projectId as never);

  const method = (request.requestContext?.http?.method ?? 'GET').toUpperCase();
  if (resource === 'intent') {
    if (method !== 'POST') return refuse(405, 'method not allowed');
    return recordIntent(runtime, scope, subject, request.body ?? null);
  }
  if (method !== 'GET') return refuse(405, 'method not allowed');

  try {
    if (resource === 'head') {
      const head = await runtime.ledger.head(scope);
      return json(200, { projectId, head });
    }
    if (resource === 'verify') {
      return json(200, await runtime.ledger.verify(scope));
    }
    const query = request.queryStringParameters ?? {};
    const fromSeq = positiveInt(query['fromSeq']);
    const toSeq = positiveInt(query['toSeq']);
    const events = await runtime.ledger.read(scope, {
      ...(fromSeq === undefined ? {} : { fromSeq }),
      ...(toSeq === undefined ? {} : { toSeq }),
      limit: 100,
    });
    return json(200, { projectId, events });
  } catch (error) {
    if (error instanceof ValidationError) return refuse(400, 'the request was not understood');
    throw error;
  }
}

/**
 * Records what a person asked for.
 *
 * `HUMAN_DECISION` is the highest authority the system recognises (ADR-0005),
 * and this is the only place in the deployment that mints one. It is attributed
 * to the Cognito subject rather than to the API, so the ledger says who asked —
 * which is the whole reason the route is authenticated.
 */
async function recordIntent(
  runtime: CloudRuntime,
  scope: ReturnType<typeof projectScope>,
  subject: Subject,
  body: string | null,
): Promise<HttpResponse> {
  if (body === null) return refuse(400, 'the request was not understood');

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return refuse(400, 'the request was not understood');
  }
  const intent = IntentBody.safeParse(parsed);
  if (!intent.success) {
    // Names the fields, never the values. A caller fixing its request needs to
    // know which field was wrong; echoing what it sent would put unvalidated
    // input into a response.
    const fields = intent.error.issues.flatMap((issue) =>
      issue.code === 'unrecognized_keys' ? issue.keys : [issue.path.join('.')],
    );
    return json(400, { error: 'the request was not understood', fields: [...new Set(fields)].sort() });
  }

  try {
    const event = await runtime.ledger.append(scope, {
      type: INTENT_EVENT_TYPE,
      actor: actorFor(subject),
      authority: 'HUMAN_DECISION',
      after: intent.data,
    });
    // 202, not 201: the intent is recorded, and whether anything gets built is
    // decided by the factory, which has not run yet.
    return json(202, { eventId: event.id, seq: event.seq });
  } catch (error) {
    if (error instanceof ValidationError) return refuse(400, 'the request was not understood');
    throw error;
  }
}
