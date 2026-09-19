/**
 * Cognitive engine conformance suite (ADR-0014).
 *
 * Written against the ledger PORT: every ledger adapter runs it, so "the goal
 * system, belief system, uncertainty engine and contradiction engine behave the
 * same on any storage" is demonstrated rather than assumed (ADR-0003).
 *
 * What it proves, beyond the rule tests in the cognition package:
 *   - an accepted command lands in the ledger exactly as returned; a refused
 *     one leaves the ledger untouched
 *   - the live projection equals a full replay of the ledger (requirement 6)
 *   - a second engine on the same ledger sees the first engine's writes
 *   - a decision made on a stale state is never written: it is re-made, and
 *     refused if the fresh state no longer allows it (ADR-0014 rule 4)
 *   - projects never see each other's cognitive state (ADR-0008)
 *   - the same commands on two fresh ledgers produce the same state
 */

import {
  type EventActor,
  type GenesisEvent,
  newProjectId,
  type ProjectScope,
  projectScope,
  ScopeMismatchError,
  SequenceConflictError,
  ValidationError,
} from '@genesis/core-types';
import {
  CognitiveEngine,
  cognitionProjector,
  type IdSource,
} from '@genesis/cognition';
import type {
  AppendOptions,
  EventLedger,
  ReadOptions,
  ReplayOptions,
  ReplaySummary,
  ReplayVisitor,
} from '@genesis/ledger';
import { applyEvent, projectionDigest, replayProjection } from '@genesis/projections';
import { beforeEach, describe, expect, it } from 'vitest';

export interface CognitionHarness {
  readonly name: string;
  /** A fresh, empty ledger. */
  createLedger(): Promise<EventLedger>;
}

const HUMAN: EventActor = { kind: 'HUMAN', id: 'dev' };
const SYSTEM: EventActor = { kind: 'SYSTEM', id: 'runner' };
const AGENT: EventActor = { kind: 'AGENT', id: 'agt-1', agentRole: 'IMPLEMENTER' };

/** Ids that count up per kind, so two engines given fresh sources mint the same ids. */
export function countingIdSource(): IdSource {
  const counters = new Map<string, number>();
  const next = (prefix: string) => (): string => {
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    return `${prefix}-${n}`;
  };
  return {
    goal: next('goal'),
    criterion: next('crit'),
    belief: next('bel'),
    uncertainty: next('unc'),
    contradiction: next('ctr'),
  };
}

/** A clock that ticks one second per call from a fixed start. */
export function fixedClock(start = Date.UTC(2026, 0, 1)): () => string {
  let t = start;
  return () => {
    const now = new Date(t).toISOString();
    t += 1000;
    return now;
  };
}

/**
 * A scenario touching all four primitives and most of their rules. Used as the
 * seed history for the cognition projector's conformance run, so replay,
 * snapshot-and-tail and determinism are proven over a realistic history.
 */
export async function seedCognition(engine: CognitiveEngine, scope: ProjectScope): Promise<void> {
  const run = (actor: EventActor, command: unknown) => engine.execute(scope, actor, command);

  await run(HUMAN, {
    kind: 'PROPOSE_GOAL',
    description: 'ship the P2 primitives',
    priority: 80,
    successCriteria: [{ statement: 'the suite passes', checkKind: 'TEST', checkRef: 'test:all' }],
  });
  const goal = 'goal-1';
  await run(HUMAN, { kind: 'PROPOSE_GOAL', description: 'write the ADR', priority: 60, parentId: goal });
  await run(HUMAN, { kind: 'ADD_SUCCESS_CRITERION', goalId: 'goal-2', statement: 'sign-off', checkKind: 'HUMAN_CONFIRMATION' });
  await run(HUMAN, { kind: 'ACTIVATE_GOAL', goalId: goal });

  await run(AGENT, { kind: 'RECORD_BELIEF', statement: 'the ledger is the only store', authority: 'EVIDENCE', reasoningCallId: 'call-1' });
  await run(AGENT, { kind: 'TRANSITION_BELIEF', beliefId: 'bel-1', to: 'ASSUMED', reason: 'ADR-0014 says so' });
  await run(SYSTEM, {
    kind: 'ADD_BELIEF_EVIDENCE',
    beliefId: 'bel-1',
    polarity: 'SUPPORTING',
    evidence: { evidenceId: 'run-7', kind: 'TEST', producedBy: 'ci-7', environment: 'TARGET', couldFalsify: true },
  });
  await run(SYSTEM, { kind: 'TRANSITION_BELIEF', beliefId: 'bel-1', to: 'SUPPORTED' });
  await run(SYSTEM, { kind: 'TRANSITION_BELIEF', beliefId: 'bel-1', to: 'TESTED' });

  await run(HUMAN, { kind: 'RECORD_BELIEF', statement: 'snapshots are required', authority: 'HUMAN_DECISION' });

  // An agent records the contradiction and supplies the README's authority
  // itself, so authority cannot decide it (ADR-0014 rule 5): it escalates, and
  // opens unc-1 with it.
  await run(AGENT, {
    kind: 'RECORD_CONTRADICTION',
    contradictionKind: 'DOCUMENTATION_IMPLEMENTATION',
    sides: [
      { kind: 'BELIEF', beliefId: 'bel-1' },
      { kind: 'EXTERNAL', id: 'doc:readme', claim: 'there is a second store', authority: 'EVIDENCE' },
    ],
  });
  await run(SYSTEM, {
    kind: 'RECORD_UNCERTAINTY',
    statement: 'which region?',
    whatBreaksIfWrong: 'deploys land in the wrong region',
    risk: 'HIGH',
    resolution: 'ASK_HUMAN',
    blocksGoalIds: [goal],
  });
  await run(HUMAN, { kind: 'RESOLVE_CONTRADICTION', contradictionId: 'ctr-1', governingSide: 0, reason: 'the README is stale' });
  await run(HUMAN, { kind: 'RESOLVE_UNCERTAINTY', uncertaintyId: 'unc-2', evidence: ['answer:eu-west-1'] });
  await run(SYSTEM, { kind: 'MARK_CRITERION_MET', goalId: goal, criterionId: 'crit-1', evidenceRef: 'run-7' });
  await run(HUMAN, { kind: 'SATISFY_GOAL', goalId: goal, reason: 'done' });
}

/**
 * A ledger that lets another writer slip in between an engine's catch-up and
 * its append, a given number of times. That is exactly the race the
 * conditional append exists to catch.
 */
class InterleavingLedger implements EventLedger {
  readonly #inner: EventLedger;
  readonly #interloper: () => unknown;
  #remaining: number;
  /** How many times the engine tried to append — i.e. how many attempts it made. */
  appendCalls = 0;

  constructor(inner: EventLedger, times: number, interloper: () => unknown) {
    this.#inner = inner;
    this.#remaining = times;
    this.#interloper = interloper;
  }

  async appendMany(scope: ProjectScope, inputs: readonly unknown[], options?: AppendOptions): Promise<GenesisEvent[]> {
    this.appendCalls += 1;
    if (this.#remaining > 0) {
      this.#remaining -= 1;
      await this.#inner.append(scope, this.#interloper());
    }
    return this.#inner.appendMany(scope, inputs, options);
  }

  append(scope: ProjectScope, input: unknown): Promise<GenesisEvent> {
    return this.#inner.append(scope, input);
  }
  get(scope: ProjectScope, id: GenesisEvent['id']): Promise<GenesisEvent | null> {
    return this.#inner.get(scope, id);
  }
  at(scope: ProjectScope, seq: number): Promise<GenesisEvent | null> {
    return this.#inner.at(scope, seq);
  }
  read(scope: ProjectScope, options?: ReadOptions): Promise<GenesisEvent[]> {
    return this.#inner.read(scope, options);
  }
  head(scope: ProjectScope): ReturnType<EventLedger['head']> {
    return this.#inner.head(scope);
  }
  count(scope: ProjectScope): Promise<number> {
    return this.#inner.count(scope);
  }
  verify(scope: ProjectScope, options?: ReadOptions): ReturnType<EventLedger['verify']> {
    return this.#inner.verify(scope, options);
  }
  replay(scope: ProjectScope, visit: ReplayVisitor, options?: ReplayOptions): Promise<ReplaySummary> {
    return this.#inner.replay(scope, visit, options);
  }
  close(): Promise<void> {
    return this.#inner.close();
  }
}

export function describeCognitionConformance(harness: CognitionHarness): void {
  describe(`cognitive engine conformance: ${harness.name}`, () => {
    let ledger: EventLedger;
    let scope: ProjectScope;
    let other: ProjectScope;

    const engineOn = (l: EventLedger, maxAttempts?: number): CognitiveEngine =>
      new CognitiveEngine(l, {
        ids: countingIdSource(),
        now: fixedClock(),
        ...(maxAttempts === undefined ? {} : { maxAttempts }),
      });

    const propose = { kind: 'PROPOSE_GOAL', description: 'g', priority: 10 };

    beforeEach(async () => {
      ledger = await harness.createLedger();
      scope = projectScope(newProjectId());
      other = projectScope(newProjectId());
    });

    it('appends exactly the events it returns, and folds them', async () => {
      const engine = engineOn(ledger);
      const result = await engine.execute(scope, HUMAN, propose);
      const stored = await ledger.read(scope);
      expect(stored.map((e) => e.id)).toEqual(result.events.map((e) => e.id));
      expect(result.projection.lastSeq).toBe(1);
      expect(result.projection.state.goals['goal-1']?.status).toBe('PROPOSED');
    });

    it('appends nothing for a refused command', async () => {
      const engine = engineOn(ledger);
      await expect(
        engine.execute(scope, HUMAN, { kind: 'ACTIVATE_GOAL', goalId: 'goal-404' }),
      ).rejects.toMatchObject({ code: 'COGNITIVE_RULE_VIOLATION', rule: 'GOAL_NOT_FOUND' });
      await expect(engine.execute(scope, HUMAN, { kind: 'NOT_A_COMMAND' })).rejects.toMatchObject({
        rule: 'INVALID_COMMAND',
      });
      expect(await ledger.count(scope)).toBe(0);
    });

    it('writes events the ledger accepts: authority within each actor’s ceiling', async () => {
      // The ledger asserts authority at its boundary; a rejected append here
      // would mean a decider stamped an authority the actor may not hold.
      await seedCognition(engineOn(ledger), scope);
      const events = await ledger.read(scope);
      expect(events.length).toBeGreaterThan(15);
      expect((await ledger.verify(scope)).ok).toBe(true);
    });

    it('keeps a live projection equal to a full replay of the ledger', async () => {
      const engine = engineOn(ledger);
      await seedCognition(engine, scope);
      const live = await engine.state(scope);
      const replayed = await replayProjection(cognitionProjector, scope, ledger);
      expect(projectionDigest(live)).toBe(projectionDigest(replayed.projection));
      expect(live.state.observations.anomalies).toEqual([]);
    });

    it('lets a second engine on the same ledger see the first engine’s writes', async () => {
      const first = engineOn(ledger);
      await first.execute(scope, HUMAN, propose);
      const second = new CognitiveEngine(ledger, { now: fixedClock(Date.UTC(2027, 0, 1)) });
      const seen = await second.state(scope);
      expect(Object.keys(seen.state.goals)).toEqual(['goal-1']);
    });

    it('re-decides after losing a race, and writes on top of the winner', async () => {
      // Another writer proposes a goal between this engine's catch-up and its append.
      const racing = new InterleavingLedger(ledger, 1, () => ({
        type: 'GOAL_PROPOSED',
        actor: HUMAN,
        authority: 'HUMAN_DECISION',
        payload: {
          goal: {
            id: 'goal-elsewhere',
            description: 'from another writer',
            priority: 1,
            status: 'PROPOSED',
            parentId: null,
            successCriteria: [],
            createdBy: { actorKind: 'HUMAN', actorId: 'other' },
            createdAt: '2026-01-01T00:00:00.000Z',
            closedAt: null,
          },
        },
      }));
      const engine = engineOn(racing);
      const result = await engine.execute(scope, HUMAN, propose);
      // Landed after the winner, decided against a state that includes it.
      expect(result.events[0]?.seq).toBe(2);
      const goals = Object.keys(result.projection.state.goals);
      expect(goals).toHaveLength(2);
      expect(goals).toContain('goal-elsewhere');
      expect(result.projection.state.observations.anomalies).toEqual([]);
    });

    it('refuses a command the winning writer made illegal, instead of writing it', async () => {
      const engine = engineOn(ledger);
      await engine.execute(scope, HUMAN, propose);
      // The interloper abandons the goal this engine is about to activate.
      const racing = new InterleavingLedger(ledger, 1, () => ({
        type: 'GOAL_STATUS_CHANGED',
        actor: HUMAN,
        authority: 'HUMAN_DECISION',
        payload: { goalId: 'goal-1', from: 'PROPOSED', to: 'ABANDONED', reason: 'descoped elsewhere' },
      }));
      const stale = engineOn(racing);
      await stale.state(scope);
      await stale.execute(scope, HUMAN, {
        kind: 'ADD_SUCCESS_CRITERION',
        goalId: 'goal-1',
        statement: 'x',
        checkKind: 'HUMAN_CONFIRMATION',
      }).then(
        () => expect.unreachable('the stale decision must not be written'),
        (error: unknown) => expect(error).toMatchObject({ rule: 'GOAL_CLOSED' }),
      );
      const events = await ledger.read(scope);
      expect(events.map((e) => e.type)).toEqual(['GOAL_PROPOSED', 'GOAL_STATUS_CHANGED']);
    });

    it('gives up after a bounded number of lost races, having written nothing of its own', async () => {
      const racing = new InterleavingLedger(ledger, 5, () => ({
        type: 'SOMETHING_ELSE_HAPPENED',
        actor: SYSTEM,
        authority: 'EVIDENCE',
      }));
      const engine = engineOn(racing, 2);
      await expect(engine.execute(scope, HUMAN, propose)).rejects.toThrow(SequenceConflictError);
      const types = (await ledger.read(scope)).map((e) => e.type);
      expect(types).toEqual(['SOMETHING_ELSE_HAPPENED', 'SOMETHING_ELSE_HAPPENED']);
    });

    it('does not retry an append failure that is not a lost race', async () => {
      // The append path fails for a reason that has nothing to do with the
      // head moving. Retrying would only repeat it; the engine must surface it
      // after exactly one attempt.
      const failing = new InterleavingLedger(ledger, 5, () => ({ not: 'an event' }));
      const engine = engineOn(failing);
      await expect(engine.execute(scope, HUMAN, propose)).rejects.toThrow(ValidationError);
      expect(failing.appendCalls).toBe(1);
      expect(await ledger.count(scope)).toBe(0);
    });

    it('surfaces a ledger that cannot be read at all', async () => {
      const engine = engineOn(ledger);
      await ledger.close();
      await expect(engine.execute(scope, HUMAN, propose)).rejects.toThrow(/closed/i);
    });

    it('serialises commands for one project, so they do not race each other', async () => {
      const engine = engineOn(ledger, 1);
      const results = await Promise.all([
        engine.execute(scope, HUMAN, propose),
        engine.execute(scope, HUMAN, propose),
        engine.execute(scope, HUMAN, propose),
      ]);
      expect(results.map((r) => r.events[0]?.seq)).toEqual([1, 2, 3]);
    });

    it('is not poisoned by a failed command', async () => {
      const engine = engineOn(ledger);
      await expect(engine.execute(scope, HUMAN, { kind: 'ACTIVATE_GOAL', goalId: 'goal-404' })).rejects.toThrow();
      const ok = await engine.execute(scope, HUMAN, propose);
      expect(ok.events).toHaveLength(1);
    });

    it('keeps projects apart', async () => {
      const engine = engineOn(ledger);
      await engine.execute(scope, HUMAN, propose);
      const elsewhere = await engine.state(other);
      expect(elsewhere.state.goals).toEqual({});
      expect(elsewhere.projectId).toBe(other.projectId);
      await expect(
        engine.execute(other, HUMAN, { kind: 'ACTIVATE_GOAL', goalId: 'goal-1' }),
      ).rejects.toMatchObject({ rule: 'GOAL_NOT_FOUND' });
    });

    it('never folds another project’s event into this one', async () => {
      const engine = engineOn(ledger);
      await engine.execute(scope, HUMAN, propose);
      const [event] = await ledger.read(scope);
      expect(event).toBeDefined();
      if (event === undefined) return;
      const elsewhere = await engine.state(other);
      // Scope is enforced by the projection runner (ADR-0013 rule 2), which the
      // engine folds through; an event from this project cannot enter that one.
      expect(() => applyEvent(cognitionProjector, elsewhere, event)).toThrow(ScopeMismatchError);
    });

    it('is deterministic: the same commands on two fresh ledgers give the same state', async () => {
      const a = engineOn(ledger);
      const bLedger = await harness.createLedger();
      const b = engineOn(bLedger);
      await seedCognition(a, scope);
      await seedCognition(b, scope);
      expect(projectionDigest(await a.state(scope))).toBe(projectionDigest(await b.state(scope)));
    });
  });
}
