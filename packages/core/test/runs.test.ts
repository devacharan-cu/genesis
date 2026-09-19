/**
 * The run projection's defensive paths (ADR-0013 rule 4). No orchestrator
 * writes these; each must leave the runs untouched and say what it refused.
 */

import { isInterrupted, runsProjector, type RunsState } from '@genesis/core';
import type { GenesisEvent, JsonValue } from '@genesis/core-types';
import { beforeEach, describe, expect, it } from 'vitest';

const CYCLE = 'cyc_00000000000000000000000001';
let state: RunsState;
let seq: number;

const event = (type: string, payload: JsonValue, cycleId: string | null = CYCLE): GenesisEvent =>
  ({
    id: `evt_${String((seq += 1)).padStart(26, '0')}`,
    projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    seq,
    schemaVersion: 1,
    type,
    actor: { kind: 'SYSTEM', id: 'orchestrator' },
    subject: null,
    before: null,
    after: null,
    cause: null,
    cycleId,
    authority: 'VERIFIED_SYSTEM_STATE',
    payload,
    timestamp: '2026-06-01T00:00:00.000Z',
    payloadHash: 'a'.repeat(64),
    prevHash: null,
  }) as GenesisEvent;

const apply = (type: string, payload: JsonValue, cycleId: string | null = CYCLE) => {
  state = runsProjector.apply(state, event(type, payload, cycleId));
};

const lastAnomaly = () => state.observations.anomalies.at(-1)?.kind;

beforeEach(() => {
  state = runsProjector.initial();
  seq = 0;
});

describe('runs', () => {
  it('ignores events that belong to no run, and types that are not a run’s', () => {
    apply('TASK_STARTED', { taskId: 't' }, null);
    apply('BELIEF_RECORDED', { belief: {} });
    expect(state.runs).toEqual({});
    expect(state.observations.unhandled).toEqual({ TASK_STARTED: 1, BELIEF_RECORDED: 1 });
  });

  it('refuses a malformed start and a second start of the same run', () => {
    apply('TASK_STARTED', { task: 't' });
    expect(lastAnomaly()).toBe('MALFORMED_PAYLOAD');
    apply('TASK_STARTED', { taskId: 't' });
    apply('TASK_STARTED', { taskId: 't' });
    expect(lastAnomaly()).toBe('STATE_MISMATCH');
  });

  it('refuses an event for a run that never started', () => {
    apply('REASONING_REQUESTED', { taskId: 't', callId: 'c', providerId: 'p', purpose: 'PROPOSE_COGNITIVE_UPDATES', requestHash: 'a'.repeat(64), contextIds: [] });
    expect(lastAnomaly()).toBe('UNKNOWN_REFERENCE');
  });

  it('refuses a malformed payload within a run', () => {
    apply('TASK_STARTED', { taskId: 't' });
    apply('REASONING_FAILED', { callId: 'c', kind: 'NOT_A_KIND', retryable: false, message: '' });
    expect(lastAnomaly()).toBe('MALFORMED_PAYLOAD');
    expect(state.runs[CYCLE]?.status).toBe('RUNNING');
  });

  it('refuses anything after a run failed, and a second finish', () => {
    apply('TASK_STARTED', { taskId: 't' });
    apply('REASONING_FAILED', { callId: 'c', kind: 'TIMEOUT', retryable: true, message: 'slow' });
    apply('EXECUTION_FAILED', { signature: 't:reasoning:TIMEOUT' });
    apply('PROPOSAL_EVALUATED', { callId: 'c', index: 0, kind: null, outcome: 'REJECTED', reason: 'MALFORMED', rule: null, detail: null, eventSeqs: [] });
    expect(lastAnomaly()).toBe('STATE_MISMATCH');
    apply('TASK_FINISHED', { taskId: 't' });
    expect(state.runs[CYCLE]).toMatchObject({ status: 'FAILED', failure: 'TIMEOUT', finishedSeq: 5 });
    expect(isInterrupted(state.runs[CYCLE] as never)).toBe(false);
    const anomalies = state.observations.anomalies.length;
    apply('TASK_FINISHED', { taskId: 't' });
    expect(state.observations.anomalies).toHaveLength(anomalies + 1);
  });

  it('counts accepted and rejected proposals, and a started run with no finish is interrupted', () => {
    apply('TASK_STARTED', { taskId: 't' });
    const evaluated = (outcome: string) => ({ callId: 'c', index: 0, kind: 'RECORD_BELIEF', outcome, reason: null, rule: null, detail: null, eventSeqs: [] });
    apply('PROPOSAL_EVALUATED', evaluated('ACCEPTED'));
    apply('PROPOSAL_EVALUATED', evaluated('REJECTED'));
    expect(state.runs[CYCLE]).toMatchObject({ accepted: 1, rejected: 1 });
    expect(isInterrupted(state.runs[CYCLE] as never)).toBe(true);
  });

  it('parses a stored state and refuses one that is not a runs state', () => {
    expect(runsProjector.parse(runsProjector.initial())).toEqual(runsProjector.initial());
    expect(() => runsProjector.parse({ runs: 'no' })).toThrow();
    expect(runsProjector.observationsOf(state)).toBe(state.observations);
  });
});
