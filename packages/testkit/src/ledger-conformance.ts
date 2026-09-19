/**
 * EventLedger conformance suite.
 *
 * Written against the PORT, never against an adapter. Every adapter runs this
 * identical suite, which is how "the SQLite adapter and the DynamoDB adapter
 * are interchangeable" becomes something proven rather than asserted
 * (ADR-0003).
 *
 * If a test here needs to know which adapter it is running against, the port
 * is underspecified and the port should be fixed — not the test.
 */

import {
  type EventId,
  type GenesisEvent,
  newProjectId,
  type ProjectScope,
  projectScope,
  ScopeMismatchError,
  SequenceConflictError,
  ValidationError,
} from '@genesis/core-types';
import {
  type EventLedger,
  hashEvent,
  type TamperableLedger,
} from '@genesis/ledger';
import { beforeEach, describe, expect, it } from 'vitest';

export type LedgerUnderTest = EventLedger & TamperableLedger;

export interface LedgerHarness {
  /** Adapter name, used in the test report. */
  readonly name: string;
  /** Creates an empty ledger. Each test gets its own. */
  create(): Promise<LedgerUnderTest>;
}

const humanEvent = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'REQUIREMENT_CHANGED',
  actor: { kind: 'HUMAN', id: 'dev' },
  authority: 'HUMAN_DECISION',
  ...overrides,
});

const agentEvent = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'OBSERVATION_RECORDED',
  actor: { kind: 'AGENT', id: 'agt-1', agentRole: 'Researcher' },
  authority: 'EVIDENCE',
  ...overrides,
});

export function describeLedgerConformance(harness: LedgerHarness): void {
  describe(`EventLedger conformance: ${harness.name}`, () => {
    let ledger: LedgerUnderTest;
    let scope: ProjectScope;
    let other: ProjectScope;

    beforeEach(async () => {
      ledger = await harness.create();
      scope = projectScope(newProjectId());
      other = projectScope(newProjectId());
    });

    // ---------------------------------------------------------------- append

    describe('append and sequencing', () => {
      it('assigns sequence 1 and a null prevHash to the first event', async () => {
        const event = await ledger.append(scope, humanEvent());
        expect(event.seq).toBe(1);
        expect(event.prevHash).toBeNull();
        expect(event.projectId).toBe(scope.projectId);
      });

      it('assigns gapless ascending sequences', async () => {
        for (let i = 0; i < 5; i++) await ledger.append(scope, humanEvent());
        const events = await ledger.read(scope);
        expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
      });

      it('links each event to its predecessor', async () => {
        const first = await ledger.append(scope, humanEvent());
        const second = await ledger.append(scope, humanEvent());
        expect(second.prevHash).toBe(first.payloadHash);
      });

      it('mints a distinct event id per event', async () => {
        const a = await ledger.append(scope, humanEvent());
        const b = await ledger.append(scope, humanEvent());
        expect(a.id).not.toBe(b.id);
        expect(a.id).toMatch(/^evt_/);
      });

      it('records the current schema version', async () => {
        const event = await ledger.append(scope, humanEvent());
        expect(event.schemaVersion).toBe(1);
      });

      it('defaults the timestamp but honours a supplied one', async () => {
        const supplied = '2020-01-02T03:04:05.000Z';
        const withDefault = await ledger.append(scope, humanEvent());
        const withSupplied = await ledger.append(scope, humanEvent({ timestamp: supplied }));
        expect(Number.isNaN(Date.parse(withDefault.timestamp))).toBe(false);
        expect(withSupplied.timestamp).toBe(supplied);
      });

      it('carries before and after through unchanged', async () => {
        const event = await ledger.append(
          scope,
          humanEvent({ before: '24 hours', after: '12 hours' }),
        );
        expect(event.before).toBe('24 hours');
        expect(event.after).toBe('12 hours');
      });

      it('updates the head', async () => {
        expect(await ledger.head(scope)).toBeNull();
        const event = await ledger.append(scope, humanEvent());
        expect(await ledger.head(scope)).toEqual({ seq: 1, hash: event.payloadHash });
      });

      it('counts events per project', async () => {
        expect(await ledger.count(scope)).toBe(0);
        await ledger.append(scope, humanEvent());
        await ledger.append(scope, humanEvent());
        expect(await ledger.count(scope)).toBe(2);
      });
    });

    describe('append rejects what it must', () => {
      it('rejects a caller-supplied sequence (ADR-0009 rule 1)', async () => {
        await expect(ledger.append(scope, humanEvent({ seq: 7 }))).rejects.toThrow(
          /invalid event input/i,
        );
      });

      it('rejects caller-supplied hashes', async () => {
        await expect(
          ledger.append(scope, humanEvent({ payloadHash: 'a'.repeat(64) })),
        ).rejects.toThrow(/invalid event input/i);
        await expect(
          ledger.append(scope, humanEvent({ prevHash: 'a'.repeat(64) })),
        ).rejects.toThrow(/invalid event input/i);
      });

      it('rejects a malformed event type', async () => {
        await expect(ledger.append(scope, humanEvent({ type: 'lowercase' }))).rejects.toThrow();
      });

      it('rejects an unknown authority', async () => {
        await expect(ledger.append(scope, humanEvent({ authority: 'VIBES' }))).rejects.toThrow();
      });

      it('rejects an agent asserting a human decision (ADR-0005)', async () => {
        await expect(
          ledger.append(
            scope,
            agentEvent({ authority: 'HUMAN_DECISION' }),
          ),
        ).rejects.toThrow(/may not assert authority/i);
      });

      it('rejects an agent asserting verified system state', async () => {
        await expect(
          ledger.append(scope, agentEvent({ authority: 'VERIFIED_SYSTEM_STATE' })),
        ).rejects.toThrow(/may not assert authority/i);
      });

      it('permits an agent to carry evidence and below', async () => {
        await expect(ledger.append(scope, agentEvent({ authority: 'EVIDENCE' }))).resolves.toBeDefined();
        await expect(
          ledger.append(scope, agentEvent({ authority: 'AI_ASSUMPTION' })),
        ).resolves.toBeDefined();
      });

      it('leaves the chain untouched after a rejected append', async () => {
        await ledger.append(scope, humanEvent());
        await expect(ledger.append(scope, humanEvent({ type: 'bad' }))).rejects.toThrow();
        expect(await ledger.count(scope)).toBe(1);
        expect((await ledger.verify(scope)).ok).toBe(true);
      });
    });

    describe('appendMany', () => {
      it('chains events within one batch', async () => {
        const events = await ledger.appendMany(scope, [humanEvent(), humanEvent(), humanEvent()]);
        expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
        expect(events[1]?.prevHash).toBe(events[0]?.payloadHash);
        expect(events[2]?.prevHash).toBe(events[1]?.payloadHash);
      });

      it('continues the chain from an existing head', async () => {
        const first = await ledger.append(scope, humanEvent());
        const batch = await ledger.appendMany(scope, [humanEvent(), humanEvent()]);
        expect(batch[0]?.seq).toBe(2);
        expect(batch[0]?.prevHash).toBe(first.payloadHash);
      });

      it('is atomic: one invalid input stores nothing', async () => {
        await expect(
          ledger.appendMany(scope, [humanEvent(), humanEvent({ type: 'nope' }), humanEvent()]),
        ).rejects.toThrow();
        expect(await ledger.count(scope)).toBe(0);
      });

      it('accepts an empty batch without touching the chain', async () => {
        expect(await ledger.appendMany(scope, [])).toEqual([]);
        expect(await ledger.count(scope)).toBe(0);
      });
    });

    // ------------------------------------------------------- project scoping

    describe('project isolation (ADR-0008)', () => {
      it('gives each project its own sequence starting at 1', async () => {
        const a = await ledger.append(scope, humanEvent());
        const b = await ledger.append(other, humanEvent());
        expect(a.seq).toBe(1);
        expect(b.seq).toBe(1);
        expect(b.prevHash).toBeNull();
      });

      it('does not leak events between projects on read', async () => {
        await ledger.appendMany(scope, [humanEvent(), humanEvent()]);
        await ledger.append(other, humanEvent());
        expect(await ledger.count(scope)).toBe(2);
        expect(await ledger.count(other)).toBe(1);
        const read = await ledger.read(other);
        expect(read.every((e) => e.projectId === other.projectId)).toBe(true);
      });

      it('keeps heads independent', async () => {
        await ledger.append(scope, humanEvent());
        expect(await ledger.head(other)).toBeNull();
      });

      it('THROWS rather than returning null for a foreign event (ADR-0008 rule 6)', async () => {
        const foreign = await ledger.append(other, humanEvent());
        await expect(ledger.get(scope, foreign.id)).rejects.toThrow(ScopeMismatchError);
      });

      it('returns null for an id that exists nowhere', async () => {
        const absent = 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV' as EventId;
        expect(await ledger.get(scope, absent)).toBeNull();
      });

      it('finds an event by id within its own project', async () => {
        const event = await ledger.append(scope, humanEvent());
        expect((await ledger.get(scope, event.id))?.seq).toBe(1);
      });

      it('does not find a foreign event by sequence', async () => {
        await ledger.append(other, humanEvent());
        expect(await ledger.at(scope, 1)).toBeNull();
      });

      it('verifies each project independently', async () => {
        await ledger.appendMany(scope, [humanEvent(), humanEvent()]);
        await ledger.append(other, humanEvent());
        expect((await ledger.verify(scope)).ok).toBe(true);
        expect((await ledger.verify(other)).ok).toBe(true);
        expect((await ledger.verify(scope)).checked).toBe(2);
      });
    });

    // ------------------------------------------------------------- reading

    describe('reading', () => {
      beforeEach(async () => {
        await ledger.appendMany(scope, Array.from({ length: 10 }, () => humanEvent()));
      });

      it('returns events in ascending sequence order', async () => {
        const events = await ledger.read(scope);
        expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      });

      it('honours fromSeq and toSeq', async () => {
        const events = await ledger.read(scope, { fromSeq: 3, toSeq: 5 });
        expect(events.map((e) => e.seq)).toEqual([3, 4, 5]);
      });

      it('honours limit', async () => {
        const events = await ledger.read(scope, { limit: 4 });
        expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
      });

      it('rejects a non-positive limit', async () => {
        await expect(ledger.read(scope, { limit: 0 })).rejects.toThrow(/limit must be positive/);
      });

      it('fetches by sequence', async () => {
        expect((await ledger.at(scope, 7))?.seq).toBe(7);
        expect(await ledger.at(scope, 99)).toBeNull();
      });

      it('returns copies, so a caller cannot mutate stored history', async () => {
        const [first] = await ledger.read(scope, { limit: 1 });
        expect(first).toBeDefined();
        (first as unknown as { type: string }).type = 'TAMPERED';
        const [again] = await ledger.read(scope, { limit: 1 });
        expect(again?.type).toBe('REQUIREMENT_CHANGED');
      });
    });

    // --------------------------------------------------------- hash chain

    describe('hash chain integrity (ADR-0009)', () => {
      beforeEach(async () => {
        await ledger.appendMany(scope, Array.from({ length: 5 }, () => humanEvent()));
      });

      it('verifies a clean chain', async () => {
        const report = await ledger.verify(scope);
        expect(report.ok).toBe(true);
        expect(report.checked).toBe(5);
        expect(report.failure).toBeNull();
        expect(report.firstSeq).toBe(1);
        expect(report.lastSeq).toBe(5);
      });

      it('verifies an empty chain as trivially ok', async () => {
        const report = await ledger.verify(other);
        expect(report.ok).toBe(true);
        expect(report.checked).toBe(0);
      });

      it('detects edited content', async () => {
        await ledger.unsafeTamper(scope.projectId, 3, { after: 'something else entirely' });
        const report = await ledger.verify(scope);
        expect(report.ok).toBe(false);
        expect(report.failure?.reason).toBe('HASH_MISMATCH');
        expect(report.failure?.seq).toBe(3);
      });

      it('detects an edited payloadHash', async () => {
        await ledger.unsafeTamper(scope.projectId, 2, { payloadHash: 'b'.repeat(64) });
        const report = await ledger.verify(scope);
        expect(report.ok).toBe(false);
        expect(report.failure?.seq).toBe(2);
      });

      /**
       * The property that actually matters: an attacker who edits an event AND
       * recomputes its hash correctly is still caught, because the NEXT event's
       * prevHash commits to the old value. Rewriting one event undetectably
       * requires rewriting every event after it.
       */
      it('detects a consistently rewritten event via the following link', async () => {
        const target = await ledger.at(scope, 3);
        expect(target).not.toBeNull();
        const rewritten = { ...(target as GenesisEvent), after: 'rewritten' };
        const { payloadHash: _old, ...hashable } = rewritten;
        const recomputed = hashEvent(hashable);

        await ledger.unsafeTamper(scope.projectId, 3, {
          after: 'rewritten',
          payloadHash: recomputed,
        });

        const report = await ledger.verify(scope);
        expect(report.ok).toBe(false);
        expect(report.failure?.reason).toBe('BROKEN_LINK');
        expect(report.failure?.seq).toBe(4);
      });

      it('detects a deleted event as a gap', async () => {
        await ledger.unsafeDelete(scope.projectId, 3);
        const report = await ledger.verify(scope);
        expect(report.ok).toBe(false);
        expect(report.failure?.reason).toBe('SEQUENCE_GAP');
        expect(report.failure?.seq).toBe(4);
      });

      it('detects a deleted first event', async () => {
        await ledger.unsafeDelete(scope.projectId, 1);
        const report = await ledger.verify(scope);
        expect(report.ok).toBe(false);
        expect(report.failure?.reason).toBe('WRONG_START_SEQUENCE');
      });

      it('detects a forged link on the first event', async () => {
        await ledger.unsafeTamper(scope.projectId, 1, { prevHash: 'c'.repeat(64) });
        const report = await ledger.verify(scope);
        expect(report.ok).toBe(false);
        expect(report.failure?.reason).toBe('UNEXPECTED_GENESIS_LINK');
        expect(report.failure?.seq).toBe(1);
      });

      it('reports the FIRST failure, not merely that something is wrong', async () => {
        await ledger.unsafeTamper(scope.projectId, 2, { after: 'x' });
        await ledger.unsafeTamper(scope.projectId, 4, { after: 'y' });
        const report = await ledger.verify(scope);
        expect(report.failure?.seq).toBe(2);
      });

      it('verifies a slice anchored on the event before it', async () => {
        const report = await ledger.verify(scope, { fromSeq: 3 });
        expect(report.ok).toBe(true);
        expect(report.firstSeq).toBe(3);
      });

      it('detects tampering inside a slice that does not start at 1', async () => {
        await ledger.unsafeTamper(scope.projectId, 4, { after: 'x' });
        const report = await ledger.verify(scope, { fromSeq: 3 });
        expect(report.ok).toBe(false);
        expect(report.failure?.seq).toBe(4);
      });

      it('refuses to verify a slice whose anchor is missing', async () => {
        await ledger.unsafeDelete(scope.projectId, 2);
        await expect(ledger.verify(scope, { fromSeq: 3 })).rejects.toThrow(/nothing to anchor/i);
      });
    });

    // ------------------------------------------------------------- replay

    describe('replay', () => {
      beforeEach(async () => {
        await ledger.appendMany(scope, Array.from({ length: 6 }, () => humanEvent()));
      });

      it('visits every event once, in order', async () => {
        const seen: number[] = [];
        const summary = await ledger.replay(scope, (event) => {
          seen.push(event.seq);
        });
        expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
        expect(summary.events).toBe(6);
        expect(summary.lastSeq).toBe(6);
      });

      it('produces the same digest on a second replay', async () => {
        const first = await ledger.replay(scope, () => undefined);
        const second = await ledger.replay(scope, () => undefined);
        expect(second.digest).toBe(first.digest);
      });

      it('produces a different digest for different history', async () => {
        const before = await ledger.replay(scope, () => undefined);
        await ledger.append(scope, humanEvent());
        const after = await ledger.replay(scope, () => undefined);
        expect(after.digest).not.toBe(before.digest);
      });

      it('verifies while replaying, by default', async () => {
        await ledger.unsafeTamper(scope.projectId, 2, { after: 'x' });
        const summary = await ledger.replay(scope, () => undefined);
        expect(summary.verification?.ok).toBe(false);
        expect(summary.verification?.failure?.seq).toBe(2);
      });

      it('reports null verification when the check was skipped, never a fake pass', async () => {
        const summary = await ledger.replay(scope, () => undefined, { verify: false });
        expect(summary.verification).toBeNull();
      });

      it('supports an async visitor', async () => {
        const seen: number[] = [];
        await ledger.replay(scope, async (event) => {
          await Promise.resolve();
          seen.push(event.seq);
        });
        expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
      });

      it('replays an empty project without complaint', async () => {
        const summary = await ledger.replay(other, () => undefined);
        expect(summary.events).toBe(0);
        expect(summary.lastSeq).toBeNull();
      });
    });

    // -------------------------------------------------------- concurrency

    describe('concurrent appends', () => {
      it('produces a gapless, verifiable chain under parallel appends', async () => {
        await Promise.all(
          Array.from({ length: 25 }, (_, i) => ledger.append(scope, humanEvent({ after: i }))),
        );
        const events = await ledger.read(scope, { limit: 100 });
        expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
        expect((await ledger.verify(scope)).ok).toBe(true);
      });

      it('keeps parallel appends to different projects independent', async () => {
        await Promise.all([
          ...Array.from({ length: 10 }, () => ledger.append(scope, humanEvent())),
          ...Array.from({ length: 10 }, () => ledger.append(other, humanEvent())),
        ]);
        expect(await ledger.count(scope)).toBe(10);
        expect(await ledger.count(other)).toBe(10);
        expect((await ledger.verify(scope)).ok).toBe(true);
        expect((await ledger.verify(other)).ok).toBe(true);
      });
    });

    // ------------------------------------------------- conditional append

    describe('conditional append (ADR-0014 rule 4)', () => {
      it('appends when the head is where the caller expected', async () => {
        const first = await ledger.appendMany(scope, [humanEvent()], { expectedLastSeq: 0 });
        expect(first.map((e) => e.seq)).toEqual([1]);

        const next = await ledger.appendMany(scope, [humanEvent(), humanEvent()], {
          expectedLastSeq: 1,
        });
        expect(next.map((e) => e.seq)).toEqual([2, 3]);
      });

      it('refuses, and writes nothing, when the head has moved', async () => {
        await ledger.append(scope, humanEvent());
        await expect(
          ledger.appendMany(scope, [humanEvent(), humanEvent()], { expectedLastSeq: 0 }),
        ).rejects.toThrow(SequenceConflictError);
        expect(await ledger.count(scope)).toBe(1);
        expect((await ledger.verify(scope)).ok).toBe(true);
      });

      it('refuses an expectation ahead of the head', async () => {
        await expect(
          ledger.appendMany(scope, [humanEvent()], { expectedLastSeq: 5 }),
        ).rejects.toThrow(/at seq 0, but the append expected 5/);
        expect(await ledger.count(scope)).toBe(0);
      });

      it('rejects an expectation that is not a sequence', async () => {
        for (const bad of [-1, 1.5, Number.NaN]) {
          await expect(
            ledger.appendMany(scope, [humanEvent()], { expectedLastSeq: bad }),
          ).rejects.toThrow(ValidationError);
        }
        expect(await ledger.count(scope)).toBe(0);
      });

      it('lets exactly one of two racing writers with the same expectation win', async () => {
        const results = await Promise.allSettled([
          ledger.appendMany(scope, [humanEvent({ payload: { writer: 'a' } })], {
            expectedLastSeq: 0,
          }),
          ledger.appendMany(scope, [humanEvent({ payload: { writer: 'b' } })], {
            expectedLastSeq: 0,
          }),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
        expect(await ledger.count(scope)).toBe(1);
      });

      it('checks the expectation per project', async () => {
        await ledger.append(other, humanEvent());
        const landed = await ledger.appendMany(scope, [humanEvent()], { expectedLastSeq: 0 });
        expect(landed[0]?.seq).toBe(1);
      });

      it('behaves as a plain append when no expectation is given', async () => {
        await ledger.append(scope, humanEvent());
        const landed = await ledger.appendMany(scope, [humanEvent()], {});
        expect(landed[0]?.seq).toBe(2);
      });
    });

    // --------------------------------------------------------- append-only

    describe('append-only surface', () => {
      it('exposes no mutation methods on the port', () => {
        for (const forbidden of ['update', 'delete', 'remove', 'truncate', 'set']) {
          expect(
            (ledger as unknown as Record<string, unknown>)[forbidden],
            `EventLedger must not expose "${forbidden}"`,
          ).toBeUndefined();
        }
      });

      it('rejects use after close', async () => {
        await ledger.close();
        await expect(ledger.append(scope, humanEvent())).rejects.toThrow(/closed/i);
      });

      it('tolerates being closed twice', async () => {
        await ledger.close();
        await expect(ledger.close()).resolves.toBeUndefined();
      });
    });
  });
}
