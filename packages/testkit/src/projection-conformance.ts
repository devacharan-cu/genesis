/**
 * Projection conformance suites (ADR-0013).
 *
 * Two suites live here, written against the CONTRACTS rather than against any
 * implementation:
 *
 *   describeProjectorConformance                — the laws every projector obeys
 *   describeProjectionSnapshotStoreConformance  — the port both adapters satisfy
 *
 * The projector suite is the interesting one. It is where "the world model can
 * be rebuilt from the event ledger" — a sentence SPEC-01 has asserted since the
 * pre-build phase — becomes something that runs.
 *
 * The property that does the most work is `snapshot + tail == full replay`.
 * Determinism catches a clock or a random source; purity catches shared
 * mutation; but a projector that keeps a counter in a closure passes both of
 * those and still cannot be rebuilt. Splitting the history at every point, and
 * requiring the two halves to compose to the whole, is what catches it: state
 * held outside the snapshotted value is simply absent from the left side.
 */

import {
  type EventInput,
  type GenesisEvent,
  type JsonValue,
  newProjectId,
  ProjectionDivergenceError,
  type ProjectScope,
  projectScope,
  ScopeMismatchError,
  SequenceConflictError,
} from '@genesis/core-types';
import { canonicalJson, type EventLedger } from '@genesis/ledger';
import {
  applyEvent,
  applyEvents,
  emptyProjection,
  InMemoryProjectionSnapshotStore,
  type ProjectionSnapshotStore,
  type ProjectionState,
  projectionDigest,
  type Projector,
  replayProjection,
  restoreProjection,
  resumeProjection,
} from '@genesis/projections';
import { beforeEach, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Freezes a value and everything reachable from it.
 *
 * The projector contract says `apply` must not mutate its input. TypeScript
 * cannot express that — `readonly` is shallow and erased at runtime — so the
 * suite enforces it the only way available: make the input genuinely
 * unwritable, and let a mutating projector throw in strict mode.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

/** Wraps a projector so every `apply` receives a frozen state. */
function freezing<S extends JsonValue>(projector: Projector<S>): Projector<S> {
  return {
    name: projector.name,
    version: projector.version,
    initial: () => projector.initial(),
    apply: (state, event) => projector.apply(deepFreeze(state), event),
    parse: (state) => projector.parse(state),
    observationsOf: (state) => projector.observationsOf(state),
  };
}

const UNHANDLED_EVENT: EventInput = {
  type: 'A_TYPE_NO_PROJECTION_HANDLES',
  actor: { kind: 'SYSTEM', id: 'conformance' },
  authority: 'EVIDENCE',
  payload: { note: 'deliberately uninterpretable' },
};

// ---------------------------------------------------------------------------
// Projector laws
// ---------------------------------------------------------------------------

export interface ProjectorHarness<S extends JsonValue> {
  readonly name: string;
  readonly projector: Projector<S>;
  /** A fresh, empty ledger. */
  createLedger(): Promise<EventLedger>;
  /**
   * Appends a history that exercises this projection, and returns it.
   *
   * Takes the ledger rather than returning inputs, because a realistic history
   * refers to its own earlier events — a fact is superseded by id, and that id
   * does not exist until the first event has been appended. A harness that
   * could only return a static list could not express that, and the projections
   * whose interesting behaviour is exactly that would go untested.
   */
  seed(ledger: EventLedger, scope: ProjectScope): Promise<GenesisEvent[]>;
}

export function describeProjectorConformance<S extends JsonValue>(
  harness: ProjectorHarness<S>,
): void {
  describe(`projector conformance: ${harness.name}`, () => {
    let ledger: EventLedger;
    let scope: ProjectScope;
    let other: ProjectScope;
    let events: GenesisEvent[];

    const projector = harness.projector;

    beforeEach(async () => {
      ledger = await harness.createLedger();
      scope = projectScope(newProjectId());
      other = projectScope(newProjectId());
      events = await harness.seed(ledger, scope);
      expect(events.length).toBeGreaterThanOrEqual(3);
    });

    // -------------------------------------------------------------- the state

    it('produces a fresh initial state on every call', () => {
      const a = projector.initial();
      const b = projector.initial();
      expect(a).not.toBe(b);
      expect(canonicalJson(a)).toBe(canonicalJson(b));
    });

    it('starts at seq 0, before the first event', () => {
      const empty = emptyProjection(projector, scope);
      expect(empty.lastSeq).toBe(0);
      expect(empty.projectId).toBe(scope.projectId);
      expect(empty.projection).toBe(projector.name);
      expect(empty.version).toBe(projector.version);
    });

    it('never mutates the state it is given', () => {
      // If `apply` writes through its argument, the frozen object throws.
      const folded = applyEvents(freezing(projector), emptyProjection(projector, scope), events);
      expect(folded.lastSeq).toBe(events.length);
    });

    it('parses the state it produces', () => {
      const folded = applyEvents(projector, emptyProjection(projector, scope), events);
      const reparsed = projector.parse(JSON.parse(JSON.stringify(folded.state)) as unknown);
      expect(canonicalJson(reparsed)).toBe(canonicalJson(folded.state));
    });

    // ------------------------------------------------------------ determinism

    it('is deterministic: the same history folds to the same digest', () => {
      const first = applyEvents(projector, emptyProjection(projector, scope), events);
      const second = applyEvents(projector, emptyProjection(projector, scope), events);
      expect(projectionDigest(first)).toBe(projectionDigest(second));
    });

    it('distinguishes different histories', async () => {
      const before = applyEvents(projector, emptyProjection(projector, scope), events);
      const extra = await ledger.append(scope, UNHANDLED_EVENT);
      const after = applyEvent(projector, before, extra);
      expect(projectionDigest(after)).not.toBe(projectionDigest(before));
    });

    it('is not digest-equal across projects for the same state', () => {
      const here = applyEvents(projector, emptyProjection(projector, scope), events);
      const there: ProjectionState<S> = { ...here, projectId: other.projectId };
      expect(projectionDigest(there)).not.toBe(projectionDigest(here));
    });

    // ------------------------------------------------ ordering and duplicates

    it('absorbs an event it has already applied', () => {
      const once = applyEvents(projector, emptyProjection(projector, scope), events);
      const first = events[0];
      expect(first).toBeDefined();
      if (first === undefined) return;
      // Identity, not merely equality: a re-applied event must not even rebuild
      // the state, or "idempotent" would depend on the projector being pure.
      expect(applyEvent(projector, once, first)).toBe(once);
    });

    it('absorbs a whole replayed history', () => {
      const once = applyEvents(projector, emptyProjection(projector, scope), events);
      const twice = applyEvents(projector, once, events);
      expect(projectionDigest(twice)).toBe(projectionDigest(once));
      expect(twice.lastSeq).toBe(once.lastSeq);
    });

    it('refuses a gap in the sequence', () => {
      const empty = emptyProjection(projector, scope);
      const first = events[0];
      expect(first).toBeDefined();
      if (first === undefined) return;
      const skipped: GenesisEvent = { ...first, seq: first.seq + 1 };
      expect(() => applyEvent(projector, empty, skipped)).toThrow(SequenceConflictError);
    });

    it('refuses an event from another project', () => {
      const empty = emptyProjection(projector, scope);
      const first = events[0];
      expect(first).toBeDefined();
      if (first === undefined) return;
      const foreign: GenesisEvent = { ...first, projectId: other.projectId };
      expect(() => applyEvent(projector, empty, foreign)).toThrow(ScopeMismatchError);
    });

    it('is not affected by another project’s ledger', async () => {
      await harness.seed(ledger, other);
      const here = await replayProjection(projector, scope, ledger);
      const direct = applyEvents(projector, emptyProjection(projector, scope), events);
      expect(projectionDigest(here.projection)).toBe(projectionDigest(direct));
    });

    // --------------------------------------------------------- replay == live

    it('replays to exactly the state the live fold produced', async () => {
      const live = applyEvents(projector, emptyProjection(projector, scope), events);
      const replayed = await replayProjection(projector, scope, ledger);
      expect(projectionDigest(replayed.projection)).toBe(projectionDigest(live));
      expect(replayed.projection.lastSeq).toBe(live.lastSeq);
      expect(replayed.summary.events).toBe(events.length);
      // Replay verifies the chain by default; a rebuilt projection is only as
      // trustworthy as the history it was rebuilt from.
      expect(replayed.summary.verification?.ok).toBe(true);
    });

    it('rebuilds from any snapshot point: snapshot + tail == full replay', async () => {
      const full = await replayProjection(projector, scope, ledger);
      const expected = projectionDigest(full.projection);

      for (let split = 0; split <= events.length; split++) {
        const head = applyEvents(
          projector,
          emptyProjection(projector, scope),
          events.slice(0, split),
        );
        const resumed = await resumeProjection(projector, head, ledger);
        expect(projectionDigest(resumed.projection), `split at ${split}`).toBe(expected);
      }
    });

    it('survives a snapshot round trip through a store', async () => {
      const store = new InMemoryProjectionSnapshotStore({ now: () => '2026-01-01T00:00:00.000Z' });
      const live = applyEvents(projector, emptyProjection(projector, scope), events);

      await store.save(scope, live);
      const loaded = await store.load(scope, projector.name, projector.version);
      expect(loaded).not.toBeNull();
      if (loaded === null) return;

      const restored = restoreProjection(scope, projector, loaded);
      expect(projectionDigest(restored)).toBe(projectionDigest(live));
      await store.close();
    });

    // --------------------------------------------------------------- honesty

    it('records an event type it does not handle rather than dropping it', async () => {
      const before = applyEvents(projector, emptyProjection(projector, scope), events);
      const unknown = await ledger.append(scope, UNHANDLED_EVENT);
      const after = applyEvent(projector, before, unknown);

      const seen = projector.observationsOf(after.state).unhandled[UNHANDLED_EVENT.type];
      const previously = projector.observationsOf(before.state).unhandled[UNHANDLED_EVENT.type] ?? 0;
      expect(seen).toBe(previously + 1);
    });

    it('never throws on event content', async () => {
      // Every projector must survive an event whose payload means nothing to
      // it. The ledger is append-only: a projector that throws here makes its
      // projection permanently unbuildable (ADR-0013 rule 4).
      const nonsense = await ledger.appendMany(scope, [
        { ...UNHANDLED_EVENT, type: 'WORLD_FACT_OBSERVED', payload: null, after: 42 },
        { ...UNHANDLED_EVENT, type: 'CAPABILITY_OBSERVED', payload: { wrong: true } },
        { ...UNHANDLED_EVENT, type: 'TASK_FINISHED', payload: { taskId: 'never-started' } },
      ]);
      const folded = applyEvents(
        projector,
        applyEvents(projector, emptyProjection(projector, scope), events),
        nonsense,
      );
      expect(folded.lastSeq).toBe(events.length + nonsense.length);
    });
  });
}

// ---------------------------------------------------------------------------
// Snapshot store port
// ---------------------------------------------------------------------------

export interface ProjectionSnapshotStoreHarness {
  readonly name: string;
  create(): Promise<ProjectionSnapshotStore>;
}

const PROJECTION = 'conformanceProjection';

export function describeProjectionSnapshotStoreConformance(
  harness: ProjectionSnapshotStoreHarness,
): void {
  describe(`ProjectionSnapshotStore conformance: ${harness.name}`, () => {
    let store: ProjectionSnapshotStore;
    let scope: ProjectScope;
    let other: ProjectScope;

    beforeEach(async () => {
      store = await harness.create();
      scope = projectScope(newProjectId());
      other = projectScope(newProjectId());
    });

    const at = (
      s: ProjectScope,
      lastSeq: number,
      state: JsonValue,
      version = 1,
    ): ProjectionState<JsonValue> => ({
      projectId: s.projectId,
      projection: PROJECTION,
      version,
      lastSeq,
      state,
    });

    it('returns null when nothing has been saved', async () => {
      expect(await store.load(scope, PROJECTION, 1)).toBeNull();
    });

    it('round-trips a snapshot with its digest', async () => {
      const projection = at(scope, 7, { counted: [1, 2, 3], note: 'hello' });
      const saved = await store.save(scope, projection);

      expect(saved.lastSeq).toBe(7);
      expect(saved.digest).toBe(projectionDigest(projection));

      const loaded = await store.load(scope, PROJECTION, 1);
      expect(loaded).not.toBeNull();
      expect(canonicalJson(loaded?.state)).toBe(canonicalJson(projection.state));
      expect(loaded?.digest).toBe(saved.digest);
    });

    it('keeps versions apart', async () => {
      await store.save(scope, at(scope, 1, { v: 1 }, 1));
      await store.save(scope, at(scope, 9, { v: 2 }, 2));

      expect((await store.load(scope, PROJECTION, 1))?.lastSeq).toBe(1);
      expect((await store.load(scope, PROJECTION, 2))?.lastSeq).toBe(9);
    });

    it('does not leak across projects', async () => {
      await store.save(scope, at(scope, 3, { who: 'here' }));
      expect(await store.load(other, PROJECTION, 1)).toBeNull();

      await store.save(other, at(other, 5, { who: 'there' }));
      expect((await store.load(scope, PROJECTION, 1))?.lastSeq).toBe(3);
      expect((await store.load(other, PROJECTION, 1))?.lastSeq).toBe(5);
    });

    it('files a snapshot under the scoped project, not the one it carries', async () => {
      // A projection carrying another project's id must not be filed under it.
      const saved = await store.save(scope, at(other, 2, { spoofed: true }));
      expect(saved.projectId).toBe(scope.projectId);
      expect(await store.load(other, PROJECTION, 1)).toBeNull();
    });

    it('lists only the scoped project, ordered by projection then version', async () => {
      // Deliberately saved out of order, and across two projection names: one
      // adapter orders in SQL and the other in JavaScript, and an ordering they
      // disagree on is exactly the kind of difference that only shows up as a
      // confusing diff much later.
      await store.save(scope, at(scope, 1, { a: 1 }, 2));
      await store.save(scope, { ...at(scope, 1, { a: 1 }, 1), projection: `${PROJECTION}Z` });
      await store.save(scope, at(scope, 1, { a: 1 }, 1));
      await store.save(scope, { ...at(scope, 1, { a: 1 }, 1), projection: `${PROJECTION}A` });
      await store.save(other, at(other, 1, { a: 1 }, 1));

      const rows = await store.list(scope);
      expect(rows.every((r) => r.projectId === scope.projectId)).toBe(true);
      expect(rows.map((r) => `${r.projection}@${r.version}`)).toEqual([
        `${PROJECTION}@1`,
        `${PROJECTION}@2`,
        `${PROJECTION}A@1`,
        `${PROJECTION}Z@1`,
      ]);
    });

    it('accepts an unchanged re-save at the same sequence', async () => {
      const projection = at(scope, 4, { stable: true });
      const first = await store.save(scope, projection);
      const second = await store.save(scope, projection);
      expect(second.digest).toBe(first.digest);
    });

    it('accepts a snapshot that has moved forward', async () => {
      await store.save(scope, at(scope, 4, { n: 1 }));
      const advanced = await store.save(scope, at(scope, 9, { n: 2 }));
      expect(advanced.lastSeq).toBe(9);
    });

    it('refuses a snapshot that would move backwards', async () => {
      await store.save(scope, at(scope, 9, { n: 2 }));
      await expect(store.save(scope, at(scope, 4, { n: 1 }))).rejects.toThrow(SequenceConflictError);
      expect((await store.load(scope, PROJECTION, 1))?.lastSeq).toBe(9);
    });

    it('refuses two different states at the same sequence', async () => {
      await store.save(scope, at(scope, 4, { n: 1 }));
      await expect(store.save(scope, at(scope, 4, { n: 2 }))).rejects.toThrow(
        ProjectionDivergenceError,
      );
    });

    it('drops a snapshot, and says whether there was one', async () => {
      await store.save(scope, at(scope, 2, { n: 1 }));
      expect(await store.drop(scope, PROJECTION, 1)).toBe(true);
      expect(await store.load(scope, PROJECTION, 1)).toBeNull();
      expect(await store.drop(scope, PROJECTION, 1)).toBe(false);
    });

    it('does not drop another project’s snapshot', async () => {
      await store.save(scope, at(scope, 2, { n: 1 }));
      expect(await store.drop(other, PROJECTION, 1)).toBe(false);
      expect(await store.load(scope, PROJECTION, 1)).not.toBeNull();
    });

    it('does not hand out state a caller can mutate', async () => {
      const projection = at(scope, 1, { nested: { value: 1 } });
      await store.save(scope, projection);

      const first = await store.load(scope, PROJECTION, 1);
      const mutable = first?.state as { nested: { value: number } };
      mutable.nested.value = 999;

      const second = await store.load(scope, PROJECTION, 1);
      expect(canonicalJson(second?.state)).toBe(canonicalJson(projection.state));
    });

    it('can be closed more than once', async () => {
      await store.close();
      await store.close();
    });
  });
}
