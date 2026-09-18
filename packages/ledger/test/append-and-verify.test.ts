/**
 * Unit tests for the append path and the chain verifier — both safety-critical
 * (SPEC-00 section 8.1).
 *
 * The conformance suite covers these through a real adapter. These tests reach
 * the cases an adapter cannot easily produce: malformed slices, foreign
 * projects, out-of-order sequences.
 */

import {
  AuthorityNotPermittedError,
  type EventId,
  type GenesisEvent,
  newEventId,
  newProjectId,
  projectScope,
  ValidationError,
} from '@genesis/core-types';
import {
  advanceHead,
  buildEvent,
  chainDigest,
  InMemoryEventLedger,
  verifyChain,
  verifyLedgerSlice,
} from '@genesis/ledger';
import { beforeEach, describe, expect, it } from 'vitest';

const scope = projectScope(newProjectId());
const otherScope = projectScope(newProjectId());

const input = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'REQUIREMENT_CHANGED',
  actor: { kind: 'HUMAN', id: 'dev' },
  authority: 'HUMAN_DECISION',
  ...overrides,
});

describe('buildEvent', () => {
  it('is deterministic given a fixed clock and id source', () => {
    const options = {
      now: () => new Date('2026-09-18T06:20:00.000Z'),
      newId: () => 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV' as EventId,
    };
    const a = buildEvent(scope, input(), null, options);
    const b = buildEvent(scope, input(), null, options);
    expect(a).toEqual(b);
    expect(a.payloadHash).toBe(b.payloadHash);
  });

  it('starts a chain at sequence 1 with a null prevHash', () => {
    const event = buildEvent(scope, input(), null);
    expect(event.seq).toBe(1);
    expect(event.prevHash).toBeNull();
  });

  it('continues from a head', () => {
    const first = buildEvent(scope, input(), null);
    const second = buildEvent(scope, input(), advanceHead(first));
    expect(second.seq).toBe(2);
    expect(second.prevHash).toBe(first.payloadHash);
  });

  it('stamps the scoped project id', () => {
    expect(buildEvent(scope, input(), null).projectId).toBe(scope.projectId);
  });

  it('defaults the timestamp from the injected clock', () => {
    const event = buildEvent(scope, input(), null, {
      now: () => new Date('2001-02-03T04:05:06.000Z'),
    });
    expect(event.timestamp).toBe('2001-02-03T04:05:06.000Z');
  });

  it('reports validation issues with their paths', () => {
    try {
      buildEvent(scope, input({ actor: { kind: 'ROBOT', id: 'x' } }), null);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const issues = (error as ValidationError).details['issues'] as { path: string }[];
      expect(issues.some((issue) => issue.path.includes('actor'))).toBe(true);
    }
  });

  it('rejects an authority the actor may not assert', () => {
    expect(() =>
      buildEvent(scope, input({ actor: { kind: 'AGENT', id: 'a' }, authority: 'HUMAN_DECISION' }), null),
    ).toThrow(AuthorityNotPermittedError);
  });

  it('rejects rather than clamps, so the ledger never disagrees with its caller', () => {
    // Clamping would record EVIDENCE where the caller asked for HUMAN_DECISION
    // and nobody would know. An event is an immutable statement of what
    // happened, so the honest response is refusal.
    expect(() =>
      buildEvent(scope, input({ actor: { kind: 'SYSTEM', id: 's' }, authority: 'HUMAN_DECISION' }), null),
    ).toThrow(/may not assert authority/);
  });

  it('catches a malformed constructed event before it can be stored', () => {
    expect(() =>
      buildEvent(scope, input(), null, { newId: () => 'not-an-event-id' as EventId }),
    ).toThrow(/constructed event failed its own schema/);
  });
});

describe('verifyChain', () => {
  let events: GenesisEvent[];

  beforeEach(async () => {
    const ledger = new InMemoryEventLedger();
    await ledger.appendMany(scope, Array.from({ length: 4 }, () => input()));
    events = await ledger.read(scope);
  });

  it('accepts a clean chain', () => {
    const report = verifyChain(scope, events);
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(4);
  });

  it('accepts an empty slice', () => {
    const report = verifyChain(scope, []);
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(0);
    expect(report.firstSeq).toBeNull();
  });

  it('rejects events belonging to another project', () => {
    const report = verifyChain(otherScope, events);
    expect(report.failure?.reason).toBe('FOREIGN_PROJECT');
  });

  it('rejects a slice that does not start where expected', () => {
    const report = verifyChain(scope, events.slice(1));
    expect(report.failure?.reason).toBe('WRONG_START_SEQUENCE');
  });

  it('rejects a first event carrying a link it should not have', () => {
    const forged = [{ ...(events[0] as GenesisEvent), prevHash: 'a'.repeat(64) }, ...events.slice(1)];
    const report = verifyChain(scope, forged as GenesisEvent[]);
    expect(report.failure?.reason).toBe('UNEXPECTED_GENESIS_LINK');
  });

  it('rejects a slice whose anchor hash does not match', () => {
    const report = verifyChain(scope, events.slice(1), {
      expectedStartSeq: 2,
      expectedPrevHash: 'b'.repeat(64),
    });
    expect(report.failure?.reason).toBe('BROKEN_LINK');
    expect(report.failure?.detail).toMatch(/before this slice/);
  });

  it('accepts a correctly anchored slice', () => {
    const report = verifyChain(scope, events.slice(1), {
      expectedStartSeq: 2,
      expectedPrevHash: events[0]?.payloadHash,
    });
    expect(report.ok).toBe(true);
  });

  it('detects a gap', () => {
    const report = verifyChain(scope, [events[0], events[2], events[3]] as GenesisEvent[]);
    expect(report.failure?.reason).toBe('SEQUENCE_GAP');
    expect(report.failure?.detail).toMatch(/1 event\(s\) missing/);
  });

  it('detects out-of-order sequences', () => {
    const report = verifyChain(scope, [events[1], events[1]] as GenesisEvent[], {
      expectedStartSeq: 2,
      expectedPrevHash: events[0]?.payloadHash,
    });
    expect(report.failure?.reason).toBe('SEQUENCE_OUT_OF_ORDER');
  });

  it('detects a broken link between adjacent events', () => {
    const broken = [...events];
    broken[2] = { ...(events[2] as GenesisEvent), prevHash: 'c'.repeat(64) };
    const report = verifyChain(scope, broken);
    expect(report.failure?.reason).toBe('BROKEN_LINK');
    expect(report.failure?.seq).toBe(3);
  });

  it('detects altered content', () => {
    const altered = [...events];
    altered[1] = { ...(events[1] as GenesisEvent), type: 'SOMETHING_ELSE' };
    const report = verifyChain(scope, altered);
    expect(report.failure?.reason).toBe('HASH_MISMATCH');
    expect(report.failure?.seq).toBe(2);
  });

  it('reports how many events it checked before failing', () => {
    const altered = [...events];
    altered[2] = { ...(events[2] as GenesisEvent), type: 'SOMETHING_ELSE' };
    expect(verifyChain(scope, altered).checked).toBe(2);
  });
});

describe('verifyLedgerSlice', () => {
  it('rejects a non-positive or fractional fromSeq', async () => {
    const ledger = new InMemoryEventLedger();
    for (const bad of [0, -1, 1.5]) {
      await expect(
        verifyLedgerSlice(
          scope,
          { fromSeq: bad },
          (range) => ledger.read(scope, range),
          (seq) => ledger.at(scope, seq),
        ),
      ).rejects.toThrow(/positive integer/);
    }
  });

  it('returns an empty report for an empty ledger', async () => {
    const ledger = new InMemoryEventLedger();
    const report = await verifyLedgerSlice(
      scope,
      {},
      (range) => ledger.read(scope, range),
      (seq) => ledger.at(scope, seq),
    );
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(0);
  });
});

describe('chainDigest', () => {
  it('is empty for no events', () => {
    expect(chainDigest([])).toBe('');
  });

  it('differs when history differs', async () => {
    const ledger = new InMemoryEventLedger();
    const local = projectScope(newProjectId());
    await ledger.append(local, input());
    const one = chainDigest(await ledger.read(local));
    await ledger.append(local, input());
    expect(chainDigest(await ledger.read(local))).not.toBe(one);
  });
});

describe('advanceHead', () => {
  it('reports the sequence and hash of the event just appended', () => {
    const event = buildEvent(scope, input(), null, { newId: () => newEventId() });
    expect(advanceHead(event)).toEqual({ seq: event.seq, hash: event.payloadHash });
  });
});
