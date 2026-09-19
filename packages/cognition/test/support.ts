/**
 * Shared fixtures for the cognition tests.
 *
 * `Mind` runs deciders and the fold together WITHOUT a ledger, turning each
 * decided event input into a synthetic stored event. That isolates the rules
 * from storage: a failure here is a rule or fold bug, never an adapter one.
 * The engine tests then run the same flows through real ledgers.
 */

import { type EventActor, type GenesisEvent } from '@genesis/core-types';
import {
  type CognitionState,
  cognitionProjector,
  type CognitiveEventInput,
  decide,
  type DecisionContext,
  emptyCognitionState,
  type IdSource,
} from '@genesis/cognition';
import { expect } from 'vitest';

export const HUMAN: EventActor = { kind: 'HUMAN', id: 'dev' };
export const SYSTEM: EventActor = { kind: 'SYSTEM', id: 'runner' };
export const AGENT: EventActor = { kind: 'AGENT', id: 'agt-1', agentRole: 'IMPLEMENTER' };

export const PROJECT = 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV';

/** Ids that count up per kind: goal-1, goal-2, crit-1 ... Deterministic by construction. */
export function countingIds(): IdSource {
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

/** A clock that ticks one second per call, from a fixed start. */
export function tickingClock(start = Date.UTC(2026, 0, 1)): () => string {
  let t = start;
  return () => {
    const now = new Date(t).toISOString();
    t += 1000;
    return now;
  };
}

export class Mind {
  state: CognitionState = emptyCognitionState();
  seq = 0;
  readonly ids = countingIds();
  readonly now = tickingClock();

  ctx(actor: EventActor): DecisionContext {
    return { actor, now: this.now(), ids: this.ids };
  }

  /** Decides and folds. Throws exactly what the decider throws. */
  run(actor: EventActor, command: unknown): CognitiveEventInput[] {
    const inputs = decide(this.state, command, this.ctx(actor));
    for (const input of inputs) this.state = cognitionProjector.apply(this.state, this.stored(input));
    return inputs;
  }

  /** Folds a hand-made event, for driving the fold's defensive paths. */
  fold(input: Omit<CognitiveEventInput, 'type'> & { readonly type: string }): void {
    this.state = cognitionProjector.apply(this.state, this.stored(input));
  }

  stored(input: Omit<CognitiveEventInput, 'type'> & { readonly type: string }): GenesisEvent {
    this.seq += 1;
    return {
      id: `evt_${String(this.seq).padStart(26, '0')}`,
      projectId: PROJECT,
      seq: this.seq,
      schemaVersion: 1,
      type: input.type,
      actor: input.actor,
      subject: null,
      before: null,
      after: null,
      cause: null,
      cycleId: null,
      authority: input.authority,
      payload: input.payload,
      timestamp: input.timestamp,
      payloadHash: 'a'.repeat(64),
      prevHash: null,
    } as GenesisEvent;
  }

  /** The id of the record the last run created, by kind. */
  lastId(kind: 'goal' | 'belief' | 'uncertainty' | 'contradiction'): string {
    const records = {
      goal: this.state.goals,
      belief: this.state.beliefs,
      uncertainty: this.state.uncertainties,
      contradiction: this.state.contradictions,
    }[kind];
    const ids = Object.keys(records).sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]));
    const last = ids.at(-1);
    if (last === undefined) throw new Error(`no ${kind} yet`);
    return last;
  }

  anomalies(): string[] {
    return this.state.observations.anomalies.map((a) => `${a.kind}: ${a.detail}`);
  }
}

/** Asserts `fn` is refused under `rule`, and that the state did not move. */
export function expectRefused(mind: Mind, rule: string, fn: () => unknown): void {
  const before = JSON.stringify(mind.state);
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected rule ${rule} to refuse`).toBeDefined();
  expect((caught as { rule?: string }).rule).toBe(rule);
  expect(JSON.stringify(mind.state), 'a refused command must change nothing').toBe(before);
}

/** A checkable TEST criterion, which lets a goal become ACTIVE. */
export const testCriterion = (statement = 'the suite passes') => ({
  statement,
  checkKind: 'TEST' as const,
  checkRef: 'test:suite',
});

export const evidence = (id: string, over: Record<string, unknown> = {}) => ({
  evidenceId: id,
  kind: 'TEST',
  producedBy: 'run-1',
  environment: 'TARGET',
  couldFalsify: true,
  ...over,
});
