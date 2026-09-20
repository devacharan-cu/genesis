/**
 * The console's client for the GENESIS API.
 *
 * Every value the UI shows comes through here, and the stream carries RAW
 * ledger events rather than anything pre-digested: the browser folds them with
 * `@genesis/console`, the same function the server uses. That is what makes a
 * replay in the UI provably the same reading of history as the server's.
 */

import type { GenesisEvent } from '@genesis/core-types';

const BASE = (import.meta.env['VITE_GENESIS_API'] as string | undefined) ?? 'http://127.0.0.1:3001';

export type RunStatus = 'IDLE' | 'RUNNING' | 'FINISHED' | 'ERRORED';

export interface ProjectMeta {
  readonly projectId: string;
  readonly intent: string;
  readonly scenario: string;
  readonly goalId: string;
  readonly createdAt: string;
  readonly status: RunStatus;
  readonly error: string | null;
}

export interface Health {
  readonly ok: boolean;
  readonly reasoning: string;
  readonly ledger: string;
  readonly sandbox: string;
  readonly projects: number;
}

export interface Scenario {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly expected: 'VERIFIED' | 'BLOCKED';
}

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, init);
  } catch {
    // A refused connection is the single most likely failure in a demo, and it
    // deserves a sentence rather than "Failed to fetch".
    throw new ApiError('the GENESIS API is not reachable — is it running on port 3001?', 0);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `the API answered ${response.status}`, response.status);
  }
  return (await response.json()) as T;
}

export const getHealth = (): Promise<Health> => request<Health>('/api/health');

export const getScenarios = (): Promise<{ scenarios: Scenario[] }> => request('/api/scenarios');

export const createProject = (intent: string, scenario: string): Promise<{ project: ProjectMeta }> =>
  request('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intent, scenario }),
  });

export const startRun = (projectId: string): Promise<{ status: RunStatus }> =>
  request(`/api/projects/${projectId}/runs`, { method: 'POST' });

export const getProject = (projectId: string): Promise<{ project: ProjectMeta }> =>
  request(`/api/projects/${projectId}`);

export interface ChainReport {
  readonly ok: boolean;
  readonly checked: number;
  readonly failedAtSeq?: number | null;
}

export const getEvents = (projectId: string): Promise<{ events: GenesisEvent[]; chain: ChainReport }> =>
  request(`/api/projects/${projectId}/events`);

export interface StreamHandlers {
  readonly onSnapshot: (events: readonly GenesisEvent[], project: ProjectMeta) => void;
  readonly onAppend: (event: GenesisEvent) => void;
  readonly onStatus: (status: RunStatus, error: string | null) => void;
  readonly onError: (message: string) => void;
}

/**
 * Follows a project's ledger.
 *
 * Returns a close function. The snapshot arrives first and carries the whole
 * history, so a late connection or a reconnect shows the entire run rather than
 * only what happens next.
 */
export function streamProject(projectId: string, handlers: StreamHandlers): () => void {
  const source = new EventSource(`${BASE}/api/projects/${projectId}/stream`);

  const parse = <T,>(raw: MessageEvent): T | null => {
    try {
      return JSON.parse(raw.data as string) as T;
    } catch {
      handlers.onError('the stream sent something that is not JSON');
      return null;
    }
  };

  source.addEventListener('snapshot', (raw) => {
    const data = parse<{ events: GenesisEvent[]; project: ProjectMeta }>(raw as MessageEvent);
    if (data !== null) handlers.onSnapshot(data.events, data.project);
  });

  source.addEventListener('append', (raw) => {
    const data = parse<{ event: GenesisEvent }>(raw as MessageEvent);
    if (data !== null) handlers.onAppend(data.event);
  });

  source.addEventListener('status', (raw) => {
    const data = parse<{ status: RunStatus; error: string | null }>(raw as MessageEvent);
    if (data !== null) handlers.onStatus(data.status, data.error);
  });

  source.addEventListener('error', (raw) => {
    const data = parse<{ error: string }>(raw as MessageEvent);
    if (data !== null) handlers.onError(data.error);
  });

  source.onerror = (): void => {
    if (source.readyState === EventSource.CLOSED) handlers.onError('the event stream closed');
  };

  return () => source.close();
}
