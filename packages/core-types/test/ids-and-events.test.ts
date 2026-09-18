import { describe, expect, it } from 'vitest';
import {
  EventActor,
  EventInput,
  EventType,
  GenesisEvent,
  JsonValue,
  newEventId,
  newMemoryId,
  newNodeId,
  newProjectId,
  ProjectId,
  Sha256Hex,
} from '@genesis/core-types';

describe('branded ids', () => {
  it('mints ids with the right prefix and shape', () => {
    expect(newProjectId()).toMatch(/^prj_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newEventId()).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newMemoryId()).toMatch(/^mem_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newNodeId()).toMatch(/^node_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('rejects an id of the wrong kind at the boundary', () => {
    const memoryId = newMemoryId();
    expect(ProjectId.safeParse(memoryId).success).toBe(false);
  });

  it('rejects ambiguous characters that are not in the ULID alphabet', () => {
    expect(ProjectId.safeParse(`prj_${'I'.repeat(26)}`).success).toBe(false);
  });

  it('rejects an id of the wrong length', () => {
    expect(ProjectId.safeParse('prj_0123').success).toBe(false);
  });
});

describe('Sha256Hex', () => {
  it('accepts a lowercase 64-character digest', () => {
    expect(Sha256Hex.safeParse('a'.repeat(64)).success).toBe(true);
  });

  it('rejects uppercase, so hashes compare by simple equality', () => {
    expect(Sha256Hex.safeParse('A'.repeat(64)).success).toBe(false);
  });

  it('rejects the wrong length', () => {
    expect(Sha256Hex.safeParse('ab').success).toBe(false);
  });
});

describe('JsonValue', () => {
  it('accepts nested plain JSON', () => {
    expect(JsonValue.safeParse({ a: [1, 'two', true, null, { b: 3 }] }).success).toBe(true);
  });

  it('rejects NaN and Infinity, which do not survive a JSON round trip', () => {
    expect(JsonValue.safeParse(Number.NaN).success).toBe(false);
    expect(JsonValue.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });

  it('rejects undefined and non-JSON values that would hash inconsistently', () => {
    expect(JsonValue.safeParse(undefined).success).toBe(false);
    expect(JsonValue.safeParse(new Date()).success).toBe(false);
    expect(JsonValue.safeParse(new Map()).success).toBe(false);
  });
});

describe('EventType', () => {
  it('accepts SCREAMING_SNAKE_CASE', () => {
    expect(EventType.safeParse('REQUIREMENT_CHANGED').success).toBe(true);
    expect(EventType.safeParse('OBSERVATION').success).toBe(true);
    expect(EventType.safeParse('BELIEF_STATE_CHANGED').success).toBe(true);
  });

  it('rejects other casings and shapes', () => {
    for (const bad of ['requirement_changed', 'Requirement_Changed', 'A__B', '_LEADING', '']) {
      expect(EventType.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('EventActor', () => {
  it('accepts the three actor kinds', () => {
    for (const kind of ['HUMAN', 'AGENT', 'SYSTEM'] as const) {
      expect(EventActor.safeParse({ kind, id: 'someone' }).success).toBe(true);
    }
  });

  it('rejects an unknown actor kind', () => {
    expect(EventActor.safeParse({ kind: 'ROBOT', id: 'x' }).success).toBe(false);
  });

  it('rejects unknown fields rather than dropping them', () => {
    expect(EventActor.safeParse({ kind: 'HUMAN', id: 'x', sneaky: true }).success).toBe(false);
  });
});

describe('EventInput', () => {
  const minimal = {
    type: 'REQUIREMENT_CHANGED',
    actor: { kind: 'HUMAN', id: 'dev' },
    authority: 'HUMAN_DECISION',
  };

  it('accepts a minimal input and defaults the optional fields to null', () => {
    const parsed = EventInput.parse(minimal);
    expect(parsed.subject).toBeNull();
    expect(parsed.before).toBeNull();
    expect(parsed.after).toBeNull();
    expect(parsed.cause).toBeNull();
    expect(parsed.cycleId).toBeNull();
    expect(parsed.payload).toBeNull();
  });

  it('carries before and after values for change events', () => {
    const parsed = EventInput.parse({ ...minimal, before: '24 hours', after: '12 hours' });
    expect(parsed.before).toBe('24 hours');
    expect(parsed.after).toBe('12 hours');
  });

  it('accepts a subject referring to a graph node', () => {
    const parsed = EventInput.parse({
      ...minimal,
      subject: { nodeType: 'REQUIREMENT', nodeId: newNodeId() },
    });
    expect(parsed.subject?.nodeType).toBe('REQUIREMENT');
  });

  it('rejects a subject whose node type is not canonical', () => {
    const result = EventInput.safeParse({
      ...minimal,
      subject: { nodeType: 'WIDGET', nodeId: newNodeId() },
    });
    expect(result.success).toBe(false);
  });

  it('accepts UNCERTAINTY as a subject node type (decision E2)', () => {
    const result = EventInput.safeParse({
      ...minimal,
      subject: { nodeType: 'UNCERTAINTY', nodeId: newNodeId() },
    });
    expect(result.success).toBe(true);
  });

  it('REFUSES a caller-supplied seq — the ledger assigns it (ADR-0009 rule 1)', () => {
    expect(EventInput.safeParse({ ...minimal, seq: 1 }).success).toBe(false);
  });

  it('REFUSES caller-supplied hashes', () => {
    expect(EventInput.safeParse({ ...minimal, payloadHash: 'a'.repeat(64) }).success).toBe(false);
    expect(EventInput.safeParse({ ...minimal, prevHash: 'a'.repeat(64) }).success).toBe(false);
  });

  it('REFUSES a caller-supplied projectId — the scope decides that', () => {
    expect(EventInput.safeParse({ ...minimal, projectId: newProjectId() }).success).toBe(false);
  });

  it('rejects a timestamp that is not an ISO-8601 instant with an offset', () => {
    expect(EventInput.safeParse({ ...minimal, timestamp: 'last tuesday' }).success).toBe(false);
    expect(EventInput.safeParse({ ...minimal, timestamp: '2026-09-18' }).success).toBe(false);
    expect(EventInput.safeParse({ ...minimal, timestamp: '2026-09-18T06:20:00Z' }).success).toBe(
      true,
    );
  });

  it('rejects an authority outside the canonical list', () => {
    expect(EventInput.safeParse({ ...minimal, authority: 'VIBES' }).success).toBe(false);
  });
});

describe('GenesisEvent', () => {
  it('requires the ledger-assigned fields', () => {
    const result = GenesisEvent.safeParse({
      id: newEventId(),
      projectId: newProjectId(),
      type: 'OBSERVATION',
      actor: { kind: 'SYSTEM', id: 'probe' },
      authority: 'EVIDENCE',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-positive sequence number', () => {
    const base = {
      id: newEventId(),
      projectId: newProjectId(),
      seq: 0,
      schemaVersion: 1,
      type: 'OBSERVATION',
      actor: { kind: 'SYSTEM', id: 'probe' },
      subject: null,
      before: null,
      after: null,
      cause: null,
      cycleId: null,
      authority: 'EVIDENCE',
      payload: null,
      timestamp: '2026-09-18T06:20:00.000Z',
      payloadHash: 'a'.repeat(64),
      prevHash: null,
    };
    expect(GenesisEvent.safeParse(base).success).toBe(false);
    expect(GenesisEvent.safeParse({ ...base, seq: 1 }).success).toBe(true);
  });
});
