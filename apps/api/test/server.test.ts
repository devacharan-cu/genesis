/**
 * The console API, against itself.
 *
 * Every test here starts the real server, which builds real runtimes and runs
 * the real factory in a real sandbox. Nothing is stubbed: what is under test is
 * that the HTTP surface reports exactly what the ledger says and nothing more.
 *
 * The properties that matter are the ones a demo would otherwise get away with
 * being wrong about — no duplicated events, a terminal status that actually
 * arrives, and two projects that cannot see each other.
 */

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { foldConsole } from '@genesis/console';
import type { GenesisEvent } from '@genesis/core-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = createServer({ maxProjects: 4 });
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const get = async <T,>(path: string): Promise<T> => (await fetch(`${base}${path}`)).json() as Promise<T>;

const post = (path: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });

interface Snapshot {
  project: { projectId: string; intent: string; scenario: string; goalId: string; status: string };
  console: ReturnType<typeof foldConsole>;
}

const newProject = async (intent = 'build a capacity planner', scenario = 'verified'): Promise<Snapshot> => {
  const response = await post('/api/projects', { intent, scenario });
  expect(response.status).toBe(201);
  return (await response.json()) as Snapshot;
};

/** Reads an SSE stream to completion, returning the frames in order. */
async function readStream(projectId: string, until: (frames: Frame[]) => boolean, timeoutMs = 60_000): Promise<Frame[]> {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/projects/${projectId}/stream`, { signal: controller.signal });
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';
      for (const chunk of chunks) {
        const name = /^event: (.+)$/m.exec(chunk)?.[1];
        const data = /^data: (.+)$/m.exec(chunk)?.[1];
        if (name === undefined || data === undefined) continue;
        frames.push({ name, data: JSON.parse(data) as Record<string, unknown> });
      }
      if (until(frames)) break;
    }
  } finally {
    controller.abort();
  }
  return frames;
}

interface Frame {
  readonly name: string;
  readonly data: Record<string, unknown>;
}

const finished = (frames: Frame[]): boolean =>
  frames.some((f) => f.name === 'status' && (f.data['status'] === 'FINISHED' || f.data['status'] === 'ERRORED'));

// --------------------------------------------------------------- the surface

describe('what the server says about itself', () => {
  it('names what is actually answering', async () => {
    const health = await get<Record<string, string>>('/api/health');
    expect(health['ok']).toBe(true);
    // Stated plainly rather than implied: the demo reasons locally, and a
    // console for a system about provenance should not be vague about its own.
    expect(health['reasoning']).toBe('deterministic-local');
    expect(health['ledger']).toContain('hash-chained');
  });

  it('lists the scenarios it can run, and what each is expected to end as', async () => {
    const { scenarios } = await get<{ scenarios: { name: string; expected: string }[] }>('/api/scenarios');
    expect(scenarios.map((s) => s.name).sort()).toEqual(['repair', 'security', 'verified']);
    expect(scenarios.find((s) => s.name === 'security')?.expected).toBe('BLOCKED');
  });

  it('answers a route it does not serve with JSON, not with HTML', async () => {
    const response = await fetch(`${base}/nope`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'no such route' });
  });
});

describe('creating a project', () => {
  it('records the intent as a real goal through the core', async () => {
    const snapshot = await newProject('build a tutoring centre capacity planner');
    expect(snapshot.project.goalId).toMatch(/^goal_/);
    expect(snapshot.console.goals).toHaveLength(1);
    expect(snapshot.console.goals[0]?.description).toBe('build a tutoring centre capacity planner');
    // Proposed and then activated, both by a human actor: the API asked the
    // core to record this, it did not write it.
    expect(snapshot.console.goals[0]?.status).toBe('ACTIVE');
    expect(snapshot.console.events.map((e) => e.type)).toEqual(['GOAL_PROPOSED', 'GOAL_STATUS_CHANGED']);
    expect(snapshot.console.events.every((e) => e.authority === 'HUMAN_DECISION')).toBe(true);
  });

  it('refuses an empty intent', async () => {
    const response = await post('/api/projects', { intent: '   ', scenario: 'verified' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { field: string }).field).toBe('intent');
  });

  it('refuses an intent longer than it will accept', async () => {
    const response = await post('/api/projects', { intent: 'x'.repeat(401), scenario: 'verified' });
    expect(response.status).toBe(400);
  });

  it('refuses a scenario it does not have', async () => {
    const response = await post('/api/projects', { intent: 'build a thing', scenario: 'magic' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { field: string }).field).toBe('scenario');
  });

  it('refuses a body that is not an object', async () => {
    const response = await post('/api/projects', 'just a string');
    expect(response.status).toBe(400);
  });

  it('answers 404 for a project that does not exist', async () => {
    expect((await fetch(`${base}/api/projects/prj_nope`)).status).toBe(404);
    expect((await post('/api/projects/prj_nope/runs')).status).toBe(404);
  });
});

// ----------------------------------------------------------------- the run

describe('a run, end to end', () => {
  it('reaches a verified artifact and says why', async () => {
    const created = await newProject('build a capacity planner', 'verified');
    const id = created.project.projectId;

    const streaming = readStream(id, finished);
    expect((await post(`/api/projects/${id}/runs`)).status).toBe(202);
    const frames = await streaming;

    const state = await get<Snapshot>(`/api/projects/${id}`);
    expect(state.console.run?.outcome).toBe('VERIFIED');
    expect(state.console.stages.map((s) => `${s.stage}:${s.result}`)).toEqual([
      'PLAN:PASSED',
      'ARCHITECT:PASSED',
      'BUILD:PASSED',
      'TEST:PASSED',
      'SECURITY_REVIEW:PASSED',
      'VERIFY:PASSED',
    ]);
    const artifact = state.console.artifacts[0];
    expect(artifact?.state).toBe('UNIT_TESTED');
    expect(artifact?.evidenceCount).toBeGreaterThan(0);
    expect(frames.some((f) => f.name === 'status' && f.data['status'] === 'FINISHED')).toBe(true);
  }, 90_000);

  it('fails genuinely, diagnoses, repairs, and re-checks before verifying', async () => {
    const created = await newProject('build a capacity planner', 'repair');
    const id = created.project.projectId;

    const streaming = readStream(id, finished);
    await post(`/api/projects/${id}/runs`);
    await streaming;

    const state = await get<Snapshot>(`/api/projects/${id}`);
    const stages = state.console.stages.map((s) => `${s.stage}:${s.result}`);
    expect(stages).toEqual([
      'PLAN:PASSED',
      'ARCHITECT:PASSED',
      'BUILD:PASSED',
      'TEST:FAILED',
      'DIAGNOSE:PASSED',
      'REPAIR:PASSED',
      'TEST:PASSED',
      'SECURITY_REVIEW:PASSED',
      'VERIFY:PASSED',
    ]);
    expect(state.console.run?.outcome).toBe('VERIFIED');
    expect(state.console.run?.repairAttempts).toBe(1);
    // The broken attempt is still there. History is not overwritten by the fix.
    expect(state.console.artifacts).toHaveLength(2);
    expect(state.console.artifacts.filter((a) => a.state === 'GENERATED')).toHaveLength(1);
  }, 90_000);

  it('blocks a change the security review refuses', async () => {
    const created = await newProject('build a capacity planner', 'security');
    const id = created.project.projectId;

    const streaming = readStream(id, finished);
    await post(`/api/projects/${id}/runs`);
    await streaming;

    const state = await get<Snapshot>(`/api/projects/${id}`);
    expect(state.console.run?.outcome).toBe('BLOCKED');
    expect(state.console.run?.blockedReason).not.toBeNull();
    expect(state.console.findings.length).toBeGreaterThan(0);
    // Nothing reached a verified state, whatever the tests said.
    expect(state.console.artifacts.every((a) => a.verifiedSeq === null)).toBe(true);
  }, 90_000);

  it('refuses a second run while one is in flight', async () => {
    const created = await newProject('build a capacity planner', 'verified');
    const id = created.project.projectId;
    const streaming = readStream(id, finished);
    await post(`/api/projects/${id}/runs`);
    const second = await post(`/api/projects/${id}/runs`);
    expect(second.status).toBe(409);
    await streaming;
  }, 90_000);
});

// -------------------------------------------------------------- the stream

describe('the event stream', () => {
  it('sends a snapshot, then every event once, in order', async () => {
    const created = await newProject('build a capacity planner', 'verified');
    const id = created.project.projectId;

    const streaming = readStream(id, finished);
    await post(`/api/projects/${id}/runs`);
    const frames = await streaming;

    const snapshots = frames.filter((f) => f.name === 'snapshot');
    expect(snapshots).toHaveLength(1);
    expect(Object.keys(snapshots[0]?.data ?? {}).sort()).toEqual(['events', 'lastSeq', 'project']);

    const appended = frames.filter((f) => f.name === 'append').map((f) => (f.data['event'] as GenesisEvent).seq);
    expect(appended.length).toBeGreaterThan(40);
    // The single thing a timeline must never do.
    expect(new Set(appended).size).toBe(appended.length);
    expect([...appended]).toEqual([...appended].sort((a, b) => a - b));
  }, 90_000);

  it('sends a status only when it changes', async () => {
    const created = await newProject('build a capacity planner', 'verified');
    const id = created.project.projectId;
    const streaming = readStream(id, finished);
    await post(`/api/projects/${id}/runs`);
    const frames = await streaming;

    const statuses = frames.filter((f) => f.name === 'status').map((f) => f.data['status']);
    // Not one per event: a status frame per append would drown the stream.
    expect(statuses).toEqual(['RUNNING', 'FINISHED']);
  }, 90_000);

  it('carries raw ledger events, so a client folds the same history the server does', async () => {
    const created = await newProject('build a capacity planner', 'verified');
    const id = created.project.projectId;
    const streaming = readStream(id, finished);
    await post(`/api/projects/${id}/runs`);
    const frames = await streaming;

    const streamed = frames.filter((f) => f.name === 'append').map((f) => f.data['event'] as GenesisEvent);
    const server = await get<Snapshot>(`/api/projects/${id}`);
    // The client's fold of what it was sent must equal the server's fold of the
    // ledger. If these ever diverge, the console is lying to somebody.
    expect(foldConsole(streamed).stages).toEqual(server.console.stages);
    expect(foldConsole(streamed).artifacts).toEqual(server.console.artifacts);
    expect(foldConsole(streamed).run).toEqual(server.console.run);
  }, 90_000);

  it('replays the whole run to a client that connects after it finished', async () => {
    const created = await newProject('build a capacity planner', 'verified');
    const id = created.project.projectId;
    const first = readStream(id, finished);
    await post(`/api/projects/${id}/runs`);
    await first;

    // A second client, connecting late, must see everything.
    const late = await readStream(id, (frames) => frames.some((f) => f.name === 'snapshot'), 15_000);
    const snapshot = late.find((f) => f.name === 'snapshot');
    expect((snapshot?.data['events'] as GenesisEvent[]).length).toBeGreaterThan(40);
  }, 90_000);
});

// ----------------------------------------------------------------- history

describe('the ledger behind it', () => {
  it('serves the raw events and confirms the chain', async () => {
    const created = await newProject('build a capacity planner', 'verified');
    const id = created.project.projectId;
    const streaming = readStream(id, finished);
    await post(`/api/projects/${id}/runs`);
    await streaming;

    const { events, chain } = await get<{ events: GenesisEvent[]; chain: { ok: boolean } }>(
      `/api/projects/${id}/events`,
    );
    expect(chain.ok).toBe(true);
    expect(events[0]?.prevHash).toBeNull();
    expect(events.every((event, index) => event.seq === index + 1)).toBe(true);
  }, 90_000);

  it('keeps two projects entirely apart', async () => {
    const a = await newProject('project a', 'verified');
    const b = await newProject('project b', 'verified');
    expect(a.project.projectId).not.toBe(b.project.projectId);

    const streaming = readStream(a.project.projectId, finished);
    await post(`/api/projects/${a.project.projectId}/runs`);
    await streaming;

    const stateB = await get<Snapshot>(`/api/projects/${b.project.projectId}`);
    // B never ran. Nothing from A's run may appear in it.
    expect(stateB.console.run).toBeNull();
    expect(stateB.console.artifacts).toEqual([]);
    expect(stateB.console.events).toHaveLength(2);
    expect(stateB.console.goals[0]?.description).toBe('project b');
  }, 90_000);

  it('understands every event it streams', async () => {
    const created = await newProject('build a capacity planner', 'repair');
    const id = created.project.projectId;
    const streaming = readStream(id, finished);
    await post(`/api/projects/${id}/runs`);
    await streaming;

    const state = await get<Snapshot>(`/api/projects/${id}`);
    // Nothing the system recorded is shown to a person as an unread type.
    expect(state.console.anomalies).toEqual([]);
  }, 90_000);
});
