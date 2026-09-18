/**
 * The world model projection (SPEC-01 section 3).
 *
 * Built from synthetic events rather than a ledger, so each handler's branches
 * can be reached directly — including the ones a well-behaved system would
 * never produce, which are the ones that decide whether a malformed history
 * corrupts the model or is merely recorded as not understood.
 */

import { type GenesisEvent, newNodeId, ValidationError } from '@genesis/core-types';
import {
  rebuildSubjectIndex,
  subjectKey,
  type WorldModelState,
  worldFactsByStatus,
  worldFactsForSubject,
  worldModelProjector,
} from '@genesis/projections';
import { describe, expect, it } from 'vitest';
import { AGENT, SYSTEM } from './support.js';

const GATEWAY = newNodeId();
const DATABASE = newNodeId();

let nextSeq = 0;

const ev = (over: Partial<GenesisEvent>): GenesisEvent => {
  nextSeq += 1;
  return {
    id: `evt_${String(nextSeq).padStart(26, '0')}`,
    projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    seq: nextSeq,
    schemaVersion: 1,
    type: 'WORLD_FACT_OBSERVED',
    actor: SYSTEM,
    subject: null,
    before: null,
    after: null,
    cause: null,
    cycleId: null,
    authority: 'EVIDENCE',
    payload: null,
    timestamp: `2026-01-01T00:00:${String(nextSeq % 60).padStart(2, '0')}.000Z`,
    payloadHash: 'a'.repeat(64),
    prevHash: null,
    ...over,
  } as GenesisEvent;
};

const observed = (
  nodeId: string,
  statement: string,
  over: Partial<GenesisEvent> = {},
): GenesisEvent =>
  ev({
    type: 'WORLD_FACT_OBSERVED',
    subject: { nodeType: 'COMPONENT', nodeId } as GenesisEvent['subject'],
    after: { statement },
    ...over,
  });

const fold = (events: readonly GenesisEvent[]): WorldModelState =>
  events.reduce<WorldModelState>(
    (state, event) => worldModelProjector.apply(state, event),
    worldModelProjector.initial(),
  );

describe('world model: observation', () => {
  it('records a fact with its subject, authority and provenance', () => {
    const event = observed(GATEWAY, 'the gateway is deployed', {
      actor: AGENT,
      authority: 'AI_ASSUMPTION',
      after: { statement: 'the gateway is deployed', beliefId: 'bel-1', sourceRefs: ['run-1'] },
    });
    const state = fold([event]);

    expect(state.facts[event.id]).toEqual({
      id: event.id,
      statement: 'the gateway is deployed',
      subjectType: 'COMPONENT',
      subjectId: GATEWAY,
      authority: 'AI_ASSUMPTION',
      beliefId: 'bel-1',
      observedAt: event.timestamp,
      observedBy: AGENT.id,
      sourceRefs: ['run-1'],
      status: 'ACTIVE',
      supersededBy: null,
      contradicts: [],
      seq: event.seq,
    });
  });

  it('defaults the optional parts of an observation', () => {
    const event = observed(GATEWAY, 'a bare observation');
    const fact = fold([event]).facts[event.id];
    expect(fact?.beliefId).toBeNull();
    expect(fact?.sourceRefs).toEqual([]);
  });

  it('indexes facts by subject, in observation order', () => {
    const a = observed(GATEWAY, 'first');
    const b = observed(DATABASE, 'second', {
      subject: { nodeType: 'DATABASE', nodeId: DATABASE } as GenesisEvent['subject'],
    });
    const c = observed(GATEWAY, 'third');
    const state = fold([a, b, c]);

    expect(state.bySubject[subjectKey('COMPONENT', GATEWAY)]).toEqual([a.id, c.id]);
    expect(state.bySubject[subjectKey('DATABASE', DATABASE)]).toEqual([b.id]);
    expect(rebuildSubjectIndex(state)).toEqual(state.bySubject);
  });

  it('records an observation with no subject as an anomaly', () => {
    const state = fold([ev({ type: 'WORLD_FACT_OBSERVED', after: { statement: 'orphan' } })]);
    expect(state.facts).toEqual({});
    expect(state.observations.anomalies[0]?.kind).toBe('MISSING_SUBJECT');
  });

  it('records a malformed observation as an anomaly', () => {
    const state = fold([
      observed(GATEWAY, 'x', { after: { statement: '' } }),
      observed(GATEWAY, 'x', { after: 42 }),
      observed(GATEWAY, 'x', { after: { statement: 'ok', unexpected: true } }),
    ]);
    expect(state.facts).toEqual({});
    expect(state.observations.anomalies.map((a) => a.kind)).toEqual([
      'MALFORMED_PAYLOAD',
      'MALFORMED_PAYLOAD',
      'MALFORMED_PAYLOAD',
    ]);
  });

  it('records a repeated fact id as an anomaly rather than overwriting', () => {
    const first = observed(GATEWAY, 'original');
    const duplicate = { ...observed(GATEWAY, 'replacement'), id: first.id };
    const state = fold([first, duplicate]);

    expect(state.facts[first.id]?.statement).toBe('original');
    expect(state.observations.anomalies[0]?.kind).toBe('STATE_MISMATCH');
  });
});

describe('world model: supersession', () => {
  it('marks a fact superseded by another observed fact', () => {
    const older = observed(DATABASE, 'revision 4');
    const newer = observed(DATABASE, 'revision 5');
    const state = fold([
      older,
      newer,
      ev({ type: 'WORLD_FACT_SUPERSEDED', payload: { factId: older.id, supersededBy: newer.id } }),
    ]);

    expect(state.facts[older.id]?.status).toBe('SUPERSEDED');
    expect(state.facts[older.id]?.supersededBy).toBe(newer.id);
    expect(state.facts[newer.id]?.status).toBe('ACTIVE');
  });

  it('allows a supersession with no named replacement', () => {
    const older = observed(DATABASE, 'revision 4');
    const state = fold([older, ev({ type: 'WORLD_FACT_SUPERSEDED', payload: { factId: older.id } })]);
    expect(state.facts[older.id]?.status).toBe('SUPERSEDED');
    expect(state.facts[older.id]?.supersededBy).toBeNull();
  });

  it('records a malformed supersession as an anomaly', () => {
    const state = fold([ev({ type: 'WORLD_FACT_SUPERSEDED', payload: { nope: true } })]);
    expect(state.observations.anomalies[0]?.kind).toBe('MALFORMED_PAYLOAD');
  });

  it('refuses to supersede a fact it has never seen', () => {
    const state = fold([ev({ type: 'WORLD_FACT_SUPERSEDED', payload: { factId: 'evt_unknown' } })]);
    expect(state.observations.anomalies[0]?.kind).toBe('UNKNOWN_REFERENCE');
  });

  it('refuses a replacement it has never seen, rather than storing a dangling pointer', () => {
    const older = observed(DATABASE, 'revision 4');
    const state = fold([
      older,
      ev({
        type: 'WORLD_FACT_SUPERSEDED',
        payload: { factId: older.id, supersededBy: 'evt_ghost' },
      }),
    ]);

    expect(state.facts[older.id]?.status).toBe('ACTIVE');
    expect(state.observations.anomalies[0]?.detail).toMatch(/has not been observed/);
  });
});

describe('world model: contradiction', () => {
  it('retains both sides and links them', () => {
    const yes = observed(GATEWAY, 'deployed');
    const no = observed(GATEWAY, 'not deployed');
    const state = fold([
      yes,
      no,
      ev({ type: 'WORLD_FACT_CONTRADICTED', payload: { factIds: [yes.id, no.id] } }),
    ]);

    // SPEC-01 section 3: contradictory facts are RETAINED, not resolved here.
    expect(state.facts[yes.id]?.status).toBe('CONTRADICTED');
    expect(state.facts[no.id]?.status).toBe('CONTRADICTED');
    expect(state.facts[yes.id]?.contradicts).toEqual([no.id]);
    expect(state.facts[no.id]?.contradicts).toEqual([yes.id]);
  });

  it('accumulates further contradictions without duplicating them', () => {
    const a = observed(GATEWAY, 'a');
    const b = observed(GATEWAY, 'b');
    const c = observed(GATEWAY, 'c');
    const state = fold([
      a,
      b,
      c,
      ev({ type: 'WORLD_FACT_CONTRADICTED', payload: { factIds: [a.id, b.id] } }),
      ev({ type: 'WORLD_FACT_CONTRADICTED', payload: { factIds: [a.id, b.id, c.id] } }),
    ]);

    expect(state.facts[a.id]?.contradicts).toEqual([b.id, c.id].sort());
  });

  it('records a malformed contradiction as an anomaly', () => {
    const state = fold([ev({ type: 'WORLD_FACT_CONTRADICTED', payload: { factIds: ['only-one'] } })]);
    expect(state.observations.anomalies[0]?.kind).toBe('MALFORMED_PAYLOAD');
  });

  it('marks nothing when fewer than two sides are known', () => {
    const only = observed(GATEWAY, 'a');
    const state = fold([
      only,
      ev({ type: 'WORLD_FACT_CONTRADICTED', payload: { factIds: [only.id, 'evt_ghost'] } }),
    ]);

    expect(state.facts[only.id]?.status).toBe('ACTIVE');
    expect(state.observations.anomalies[0]?.detail).toMatch(/needs two observed facts/);
  });

  it('marks the known sides and reports the unknown ones', () => {
    const a = observed(GATEWAY, 'a');
    const b = observed(GATEWAY, 'b');
    const state = fold([
      a,
      b,
      ev({ type: 'WORLD_FACT_CONTRADICTED', payload: { factIds: [a.id, b.id, 'evt_ghost'] } }),
    ]);

    expect(state.facts[a.id]?.status).toBe('CONTRADICTED');
    expect(state.observations.anomalies[0]?.detail).toMatch(/unobserved facts: evt_ghost/);
  });
});

describe('world model: the fold itself', () => {
  it('counts an event type it does not handle', () => {
    const state = fold([ev({ type: 'CYCLE_STARTED' }), ev({ type: 'CYCLE_STARTED' })]);
    expect(state.observations.unhandled).toEqual({ CYCLE_STARTED: 2 });
  });

  it('tracks the timestamp of the last event, handled or not', () => {
    const last = ev({ type: 'CYCLE_STARTED' });
    const state = fold([observed(GATEWAY, 'a'), last]);
    expect(state.lastEventAt).toBe(last.timestamp);
  });

  it('starts with nothing', () => {
    const initial = worldModelProjector.initial();
    expect(initial.facts).toEqual({});
    expect(initial.lastEventAt).toBeNull();
    expect(worldModelProjector.observationsOf(initial).anomalies).toEqual([]);
  });

  it('does not mutate the state it is handed', () => {
    const before = fold([observed(GATEWAY, 'a')]);
    const snapshot = JSON.stringify(before);
    worldModelProjector.apply(before, observed(GATEWAY, 'b'));
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('world model: selectors and parsing', () => {
  it('finds the facts recorded about a subject', () => {
    const a = observed(GATEWAY, 'a');
    const b = observed(GATEWAY, 'b');
    const state = fold([a, b]);

    expect(worldFactsForSubject(state, 'COMPONENT', GATEWAY).map((f) => f.id)).toEqual([a.id, b.id]);
    expect(worldFactsForSubject(state, 'COMPONENT', newNodeId())).toEqual([]);
  });

  it('skips an index entry with no fact behind it', () => {
    // Reachable through a restored state: the schema cannot express the
    // relationship between the index and the facts it points at.
    const restored = worldModelProjector.parse({
      facts: {},
      bySubject: { 'COMPONENT:node_01ARZ3NDEKTSV4RRFFQ69G5FAV': ['evt_ghost'] },
      lastEventAt: null,
      observations: { anomalies: [], anomaliesDropped: 0, unhandled: {} },
    });
    expect(worldFactsForSubject(restored, 'COMPONENT', 'node_01ARZ3NDEKTSV4RRFFQ69G5FAV')).toEqual(
      [],
    );
  });

  it('filters facts by status', () => {
    const a = observed(GATEWAY, 'a');
    const b = observed(GATEWAY, 'b');
    const state = fold([a, b, ev({ type: 'WORLD_FACT_SUPERSEDED', payload: { factId: a.id } })]);

    expect(worldFactsByStatus(state, 'ACTIVE').map((f) => f.id)).toEqual([b.id]);
    expect(worldFactsByStatus(state, 'SUPERSEDED').map((f) => f.id)).toEqual([a.id]);
    expect(worldFactsByStatus(state, 'CONTRADICTED')).toEqual([]);
  });

  it('refuses a stored state that is not a world model', () => {
    expect(() => worldModelProjector.parse({ facts: 'not a map' })).toThrow(ValidationError);
  });
});
