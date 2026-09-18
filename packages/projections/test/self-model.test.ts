/**
 * The self model projection (SPEC-01 section 4).
 *
 * The test that matters most is the evidence rule: an event claiming a
 * capability is AVAILABLE with nothing behind it must NOT produce a self model
 * that believes the system can act. Everything else here is bookkeeping.
 */

import { type GenesisEvent, type JsonValue, ValidationError } from '@genesis/core-types';
import {
  capabilitiesByStatus,
  hasOpenUncertainty,
  type SelfModelState,
  selfModelProjector,
} from '@genesis/projections';
import { describe, expect, it } from 'vitest';
import { AGENT, HUMAN, SYSTEM } from './support.js';

let nextSeq = 0;

const ev = (type: string, payload: JsonValue, over: Partial<GenesisEvent> = {}): GenesisEvent => {
  nextSeq += 1;
  return {
    id: `evt_${String(nextSeq).padStart(26, '0')}`,
    projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    seq: nextSeq,
    schemaVersion: 1,
    type,
    actor: SYSTEM,
    subject: null,
    before: null,
    after: null,
    cause: null,
    cycleId: null,
    authority: 'EVIDENCE',
    payload,
    timestamp: `2026-01-0${(nextSeq % 9) + 1}T00:00:00.000Z`,
    payloadHash: 'a'.repeat(64),
    prevHash: null,
    ...over,
  } as GenesisEvent;
};

const fold = (events: readonly GenesisEvent[]): SelfModelState =>
  events.reduce<SelfModelState>(
    (state, event) => selfModelProjector.apply(state, event),
    selfModelProjector.initial(),
  );

describe('self model: capabilities', () => {
  it('records an evidence-backed capability as claimed', () => {
    const state = fold([
      ev('CAPABILITY_OBSERVED', {
        id: 'run-tests',
        description: 'runs the suite',
        status: 'AVAILABLE',
        evidenceRef: 'run-1',
      }),
    ]);
    expect(state.capabilities['run-tests']?.status).toBe('AVAILABLE');
    expect(state.observations.anomalies).toEqual([]);
  });

  it('accepts a human declaring a capability with no evidence', () => {
    const state = fold([
      ev('CAPABILITY_OBSERVED', { id: 'deploy', status: 'AVAILABLE' }, { actor: HUMAN }),
    ]);
    expect(state.capabilities['deploy']?.status).toBe('AVAILABLE');
    expect(state.capabilities['deploy']?.description).toBe('');
  });

  it('refuses an unevidenced AVAILABLE claim and records the over-claim', () => {
    // SPEC-01 section 4 rule 1. This is the whole point of the projection: a
    // self model that believes it can deploy, on nothing but an agent saying
    // so, would act on that belief.
    const state = fold([
      ev('CAPABILITY_OBSERVED', { id: 'deploy', status: 'AVAILABLE' }, { actor: AGENT }),
    ]);

    expect(state.capabilities['deploy']?.status).toBe('UNAVAILABLE');
    expect(state.capabilities['deploy']?.evidenceRef).toBeNull();
    expect(state.observations.anomalies[0]?.kind).toBe('FORBIDDEN_VALUE');
  });

  it('accepts a lower status from anyone, with or without evidence', () => {
    const state = fold([
      ev('CAPABILITY_OBSERVED', { id: 'deploy', status: 'DEGRADED' }, { actor: AGENT }),
    ]);
    expect(state.capabilities['deploy']?.status).toBe('DEGRADED');
    expect(state.observations.anomalies).toEqual([]);
  });

  it('keeps `since` while the status is unchanged, and moves it when it changes', () => {
    const first = ev('CAPABILITY_OBSERVED', { id: 'c', status: 'DEGRADED' });
    const same = ev('CAPABILITY_OBSERVED', { id: 'c', status: 'DEGRADED' });
    const changed = ev('CAPABILITY_OBSERVED', { id: 'c', status: 'UNAVAILABLE' });

    expect(fold([first, same]).capabilities['c']?.since).toBe(first.timestamp);
    expect(fold([first, same, changed]).capabilities['c']?.since).toBe(changed.timestamp);
  });

  it('records a malformed capability as an anomaly', () => {
    const state = fold([ev('CAPABILITY_OBSERVED', { id: 'c', status: 'SORT_OF' })]);
    expect(state.capabilities).toEqual({});
    expect(state.observations.anomalies[0]?.kind).toBe('MALFORMED_PAYLOAD');
  });

  it('filters capabilities by status', () => {
    const state = fold([
      ev('CAPABILITY_OBSERVED', { id: 'a', status: 'AVAILABLE', evidenceRef: 'e' }),
      ev('CAPABILITY_OBSERVED', { id: 'b', status: 'UNAVAILABLE' }),
    ]);
    expect(capabilitiesByStatus(state, 'AVAILABLE').map((c) => c.id)).toEqual(['a']);
    expect(capabilitiesByStatus(state, 'DEGRADED')).toEqual([]);
  });
});

describe('self model: limitations', () => {
  it('records a declared limitation and keeps its original date', () => {
    const first = ev('LIMITATION_DECLARED', {
      id: 'no-prod',
      description: 'no production writes',
      source: 'DECLARED',
    });
    const again = ev('LIMITATION_DECLARED', {
      id: 'no-prod',
      description: 'no production writes, at all',
      source: 'OBSERVED',
    });
    const state = fold([first, again]);

    expect(state.limitations['no-prod']?.since).toBe(first.timestamp);
    expect(state.limitations['no-prod']?.source).toBe('OBSERVED');
  });

  it('records a malformed limitation as an anomaly', () => {
    const state = fold([ev('LIMITATION_DECLARED', { id: 'x', source: 'GUESSED' })]);
    expect(state.observations.anomalies[0]?.kind).toBe('MALFORMED_PAYLOAD');
  });
});

describe('self model: current task and goal', () => {
  it('follows the ledger', () => {
    const state = fold([
      ev('GOAL_ACTIVATED', { goalId: 'g1' }),
      ev('TASK_STARTED', { taskId: 't1' }),
    ]);
    expect(state.currentGoal).toBe('g1');
    expect(state.currentTask).toBe('t1');
  });

  it('clears them when they finish', () => {
    const state = fold([
      ev('GOAL_ACTIVATED', { goalId: 'g1' }),
      ev('TASK_STARTED', { taskId: 't1' }),
      ev('TASK_FINISHED', { taskId: 't1' }),
      ev('GOAL_CLOSED', { goalId: 'g1' }),
    ]);
    expect(state.currentGoal).toBeNull();
    expect(state.currentTask).toBeNull();
  });

  it('accepts a repeat of what is already current without complaint', () => {
    const state = fold([
      ev('TASK_STARTED', { taskId: 't1' }),
      ev('TASK_STARTED', { taskId: 't1' }),
      ev('GOAL_ACTIVATED', { goalId: 'g1' }),
      ev('GOAL_ACTIVATED', { goalId: 'g1' }),
    ]);
    expect(state.observations.anomalies).toEqual([]);
  });

  it('records an overlap rather than resolving it', () => {
    const state = fold([
      ev('TASK_STARTED', { taskId: 't1' }),
      ev('TASK_STARTED', { taskId: 't2' }),
      ev('GOAL_ACTIVATED', { goalId: 'g1' }),
      ev('GOAL_ACTIVATED', { goalId: 'g2' }),
    ]);

    expect(state.currentTask).toBe('t2');
    expect(state.currentGoal).toBe('g2');
    expect(state.observations.anomalies.map((a) => a.kind)).toEqual([
      'STATE_MISMATCH',
      'STATE_MISMATCH',
    ]);
  });

  it('records finishing something that was not current', () => {
    const state = fold([
      ev('TASK_FINISHED', { taskId: 't9' }),
      ev('TASK_STARTED', { taskId: 't1' }),
      ev('TASK_FINISHED', { taskId: 't9' }),
      ev('GOAL_CLOSED', { goalId: 'g9' }),
    ]);

    expect(state.currentTask).toBe('t1');
    expect(state.observations.anomalies).toHaveLength(3);
    expect(state.observations.anomalies[0]?.detail).toMatch(/current task is none/);
    expect(state.observations.anomalies[1]?.detail).toMatch(/current task is t1/);
    expect(state.observations.anomalies[2]?.detail).toMatch(/active goal is none/);
  });

  it('records malformed task and goal payloads', () => {
    const state = fold([
      ev('TASK_STARTED', { nope: 1 }),
      ev('TASK_FINISHED', { nope: 1 }),
      ev('GOAL_ACTIVATED', { nope: 1 }),
      ev('GOAL_CLOSED', { nope: 1 }),
    ]);
    expect(state.observations.anomalies.map((a) => a.kind)).toEqual([
      'MALFORMED_PAYLOAD',
      'MALFORMED_PAYLOAD',
      'MALFORMED_PAYLOAD',
      'MALFORMED_PAYLOAD',
    ]);
  });

  it('records closing a goal that is not the active one', () => {
    const state = fold([
      ev('GOAL_ACTIVATED', { goalId: 'g1' }),
      ev('GOAL_CLOSED', { goalId: 'g2' }),
    ]);
    expect(state.currentGoal).toBe('g1');
    expect(state.observations.anomalies[0]?.detail).toMatch(/active goal is g1/);
  });
});

describe('self model: known failures', () => {
  it('counts repeats of one signature rather than duplicating it', () => {
    const first = ev('EXECUTION_FAILED', { signature: 'ETIMEDOUT:deploy' });
    const second = ev('EXECUTION_FAILED', {
      signature: 'ETIMEDOUT:deploy',
      mitigation: 'longer timeout',
    });
    const third = ev('EXECUTION_FAILED', { signature: 'ETIMEDOUT:deploy' });
    const state = fold([first, second, third]);

    expect(state.knownFailures['ETIMEDOUT:deploy']).toEqual({
      signature: 'ETIMEDOUT:deploy',
      occurrences: 3,
      firstSeen: first.timestamp,
      lastSeen: third.timestamp,
      // A later silent failure does not erase a mitigation already learned.
      mitigation: 'longer timeout',
    });
  });

  it('starts with no mitigation when none was reported', () => {
    const state = fold([ev('EXECUTION_FAILED', { signature: 'EACCES:write' })]);
    expect(state.knownFailures['EACCES:write']?.mitigation).toBeNull();
    expect(state.knownFailures['EACCES:write']?.occurrences).toBe(1);
  });

  it('records a malformed failure as an anomaly', () => {
    const state = fold([ev('EXECUTION_FAILED', { reason: 'unspecified' })]);
    expect(state.knownFailures).toEqual({});
    expect(state.observations.anomalies[0]?.kind).toBe('MALFORMED_PAYLOAD');
  });
});

describe('self model: assumptions and uncertainties', () => {
  it('keeps both as sorted sets', () => {
    const state = fold([
      ev('ASSUMPTION_ADDED', { beliefId: 'bel-2' }),
      ev('ASSUMPTION_ADDED', { beliefId: 'bel-1' }),
      ev('ASSUMPTION_ADDED', { beliefId: 'bel-1' }),
      ev('UNCERTAINTY_OPENED', { uncertaintyId: 'unc-2' }),
      ev('UNCERTAINTY_OPENED', { uncertaintyId: 'unc-1' }),
    ]);

    expect(state.assumptions).toEqual(['bel-1', 'bel-2']);
    expect(state.uncertainties).toEqual(['unc-1', 'unc-2']);
  });

  it('removes them when they are dropped or resolved', () => {
    const state = fold([
      ev('ASSUMPTION_ADDED', { beliefId: 'bel-1' }),
      ev('ASSUMPTION_DROPPED', { beliefId: 'bel-1' }),
      ev('UNCERTAINTY_OPENED', { uncertaintyId: 'unc-1' }),
      ev('UNCERTAINTY_RESOLVED', { uncertaintyId: 'unc-1' }),
    ]);

    expect(state.assumptions).toEqual([]);
    expect(state.uncertainties).toEqual([]);
    expect(hasOpenUncertainty(state)).toBe(false);
  });

  it('can say it does not know', () => {
    // SPEC-01 section 4 rule 2: the "I cannot determine this" state has to be
    // representable, not merely describable.
    expect(hasOpenUncertainty(fold([ev('UNCERTAINTY_OPENED', { uncertaintyId: 'u' })]))).toBe(true);
  });

  it('records dropping something that was never held', () => {
    const state = fold([
      ev('ASSUMPTION_DROPPED', { beliefId: 'bel-9' }),
      ev('UNCERTAINTY_RESOLVED', { uncertaintyId: 'unc-9' }),
    ]);
    expect(state.observations.anomalies.map((a) => a.kind)).toEqual([
      'UNKNOWN_REFERENCE',
      'UNKNOWN_REFERENCE',
    ]);
  });

  it('records malformed belief and uncertainty payloads', () => {
    const state = fold([
      ev('ASSUMPTION_ADDED', { nope: 1 }),
      ev('ASSUMPTION_DROPPED', { nope: 1 }),
      ev('UNCERTAINTY_OPENED', { nope: 1 }),
      ev('UNCERTAINTY_RESOLVED', { nope: 1 }),
    ]);
    expect(state.observations.anomalies).toHaveLength(4);
  });
});

describe('self model: the fold itself', () => {
  it('counts an event type it does not handle', () => {
    const state = fold([ev('CYCLE_STARTED', null), ev('WORLD_FACT_OBSERVED', null)]);
    expect(state.observations.unhandled).toEqual({ CYCLE_STARTED: 1, WORLD_FACT_OBSERVED: 1 });
  });

  it('tracks the timestamp of the last event', () => {
    const last = ev('CYCLE_STARTED', null);
    expect(fold([ev('TASK_STARTED', { taskId: 't' }), last]).lastEventAt).toBe(last.timestamp);
  });

  it('starts empty', () => {
    const initial = selfModelProjector.initial();
    expect(initial.currentGoal).toBeNull();
    expect(initial.knownFailures).toEqual({});
    expect(selfModelProjector.observationsOf(initial).unhandled).toEqual({});
  });

  it('refuses a stored state that is not a self model', () => {
    expect(() => selfModelProjector.parse({ capabilities: [] })).toThrow(ValidationError);
  });

  it('parses a state it produced', () => {
    const state = fold([ev('TASK_STARTED', { taskId: 't1' })]);
    expect(selfModelProjector.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });
});
