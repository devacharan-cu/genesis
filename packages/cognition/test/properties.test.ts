/**
 * Property tests: random command streams, every invariant checked after every
 * accepted command.
 *
 * The rule tests show each rule refuses what it should. These show something
 * the rule tests cannot: that no SEQUENCE of legal-looking commands, from any
 * mix of actors, reaches a state the rules forbid — and that whatever state is
 * reached is exactly what replaying the ledger rebuilds.
 *
 * Seeded, so a failure reproduces: the seed is in the test name.
 */

import { AUTHORITY_LEVELS, CognitiveRuleViolationError, type EventActor, outranks, projectScope } from '@genesis/core-types';
import { CognitiveEngine, type CognitionState, cognitionProjector } from '@genesis/cognition';
import { InMemoryEventLedger } from '@genesis/ledger';
import { projectionDigest, replayProjection } from '@genesis/projections';
import { describe, expect, it } from 'vitest';
import { AGENT, countingIds, HUMAN, PROJECT, SYSTEM, tickingClock } from './support.js';

/** Park–Miller: tiny, seedable, and the same on every machine. */
function prng(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const ACTORS = [HUMAN, SYSTEM, AGENT] as const;
const BELIEF_STATES = ['UNKNOWN', 'ASSUMED', 'SUPPORTED', 'TESTED', 'VERIFIED'] as const;

function generator(random: () => number) {
  const pick = <T>(items: readonly T[]): T | undefined => items[Math.floor(random() * items.length)];
  const chance = (p: number) => random() < p;

  return (state: CognitionState): { actor: EventActor; command: Record<string, unknown> } => {
    const actor = pick(ACTORS) ?? HUMAN;
    const goals = Object.values(state.goals);
    const beliefs = Object.values(state.beliefs);
    const uncertainties = Object.values(state.uncertainties);
    const contradictions = Object.values(state.contradictions);
    const goal = pick(goals);
    const belief = pick(beliefs);
    const u = pick(uncertainties);
    const reason = chance(0.8) ? 'because' : undefined;
    const evidenceDescriptor = () => ({
      evidenceId: `ev-${Math.floor(random() * 1e9)}`,
      kind: pick(['OBSERVATION', 'TEST', 'EXPERIMENT', 'DOCUMENT', 'HUMAN_STATEMENT'] as const),
      producedBy: pick(['call-1', 'ci-1', 'ci-2'] as const),
      environment: pick(['TARGET', 'SANDBOX', 'NONE'] as const),
      couldFalsify: chance(0.6),
    });
    const side = () =>
      belief !== undefined && chance(0.6)
        ? { kind: 'BELIEF', beliefId: pick(beliefs)?.id }
        : { kind: 'EXTERNAL', id: `ext-${Math.floor(random() * 6)}`, claim: 'c', authority: pick(AUTHORITY_LEVELS) };

    const commands: Array<() => Record<string, unknown>> = [
      () => ({
        kind: 'PROPOSE_GOAL',
        description: 'g',
        priority: Math.floor(random() * 101),
        ...(goal !== undefined && chance(0.4) ? { parentId: goal.id } : {}),
        ...(chance(0.7)
          ? { successCriteria: [{ statement: 's', checkKind: pick(['TEST', 'EVIDENCE', 'HUMAN_CONFIRMATION'] as const), ...(chance(0.6) ? { checkRef: 't' } : {}) }] }
          : {}),
      }),
      () => ({ kind: 'ADD_SUCCESS_CRITERION', goalId: goal?.id ?? 'goal-0', statement: 's', checkKind: 'TEST', checkRef: 't' }),
      () => ({ kind: 'ACTIVATE_GOAL', goalId: goal?.id ?? 'goal-0' }),
      () => ({ kind: 'BLOCK_GOAL', goalId: goal?.id ?? 'goal-0', reason }),
      () => ({ kind: 'SATISFY_GOAL', goalId: goal?.id ?? 'goal-0' }),
      () => ({ kind: 'ABANDON_GOAL', goalId: goal?.id ?? 'goal-0', reason }),
      () => ({
        kind: 'MARK_CRITERION_MET',
        goalId: goal?.id ?? 'goal-0',
        criterionId: pick(goal?.successCriteria ?? [])?.id ?? 'crit-0',
        ...(chance(0.7) ? { evidenceRef: 'e' } : {}),
      }),
      () => ({
        kind: 'RECORD_BELIEF',
        statement: 'b',
        ...(chance(0.5) ? { state: 'ASSUMED', rationale: 'r' } : {}),
        authority: pick(AUTHORITY_LEVELS),
        ...(chance(0.5) ? { reasoningCallId: 'call-1' } : {}),
      }),
      () => ({
        kind: 'ADD_BELIEF_EVIDENCE',
        beliefId: belief?.id ?? 'bel-0',
        polarity: chance(0.75) ? 'SUPPORTING' : 'CONTRADICTING',
        evidence: evidenceDescriptor(),
      }),
      () => ({ kind: 'TRANSITION_BELIEF', beliefId: belief?.id ?? 'bel-0', to: pick(BELIEF_STATES), reason }),
      () => ({
        kind: 'DISMISS_CONTRADICTING_EVIDENCE',
        beliefId: belief?.id ?? 'bel-0',
        evidenceId: pick(belief?.contradictingEvidence ?? [])?.evidenceId ?? 'none',
        reason,
      }),
      () => ({
        kind: 'RECORD_UNCERTAINTY',
        statement: 's',
        whatBreaksIfWrong: 'w',
        risk: pick(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const),
        resolution: pick(['ASK_HUMAN', 'SEARCH', 'EXPERIMENT'] as const),
        ...(goal !== undefined && chance(0.4) ? { blocksGoalIds: [goal.id] } : {}),
      }),
      () => ({ kind: 'START_RESOLVING', uncertaintyId: u?.id ?? 'unc-0' }),
      () => ({ kind: 'RESOLVE_UNCERTAINTY', uncertaintyId: u?.id ?? 'unc-0', evidence: chance(0.8) ? ['a'] : [] }),
      () => ({ kind: 'ACCEPT_UNCERTAINTY', uncertaintyId: u?.id ?? 'unc-0', reason }),
      () => ({ kind: 'MARK_UNCERTAINTY_OBSOLETE', uncertaintyId: u?.id ?? 'unc-0', reason }),
      () => ({
        kind: 'RECORD_CONTRADICTION',
        contradictionKind: pick(['REQUIREMENT_TEST', 'BELIEF_EVIDENCE'] as const),
        sides: [side(), side()],
      }),
      () => ({
        kind: 'RESOLVE_CONTRADICTION',
        contradictionId: pick(contradictions)?.id ?? 'ctr-0',
        governingSide: chance(0.5) ? 0 : 1,
        reason,
      }),
    ];
    const make = pick(commands) ?? commands[0];
    return { actor, command: make ? make() : {} };
  };
}

const rank = (a: (typeof AUTHORITY_LEVELS)[number]) => AUTHORITY_LEVELS.indexOf(a);

/** Every invariant the rules exist to guarantee. */
function assertInvariants(state: CognitionState): void {
  expect(state.observations.anomalies, 'a decider produced an event the fold refused').toEqual([]);

  for (const g of Object.values(state.goals)) {
    if (g.parentId !== null) expect(state.goals[g.parentId], `parent of ${g.id}`).toBeDefined();
    if (g.status === 'SATISFIED') {
      expect(g.successCriteria.length).toBeGreaterThan(0);
      expect(g.successCriteria.every((c) => c.met), `${g.id} satisfied with unmet criteria`).toBe(true);
      const openChildren = Object.values(state.goals).filter(
        (c) => c.parentId === g.id && (c.status === 'ACTIVE' || c.status === 'BLOCKED'),
      );
      expect(openChildren, `${g.id} satisfied with open children`).toEqual([]);
    }
    if (g.status === 'ACTIVE' || g.status === 'BLOCKED' || g.status === 'SATISFIED') {
      expect(
        g.successCriteria.some((c) => c.checkKind === 'HUMAN_CONFIRMATION' || c.checkRef !== null),
        `${g.id} active without a checkable criterion`,
      ).toBe(true);
    }
  }

  for (const b of Object.values(state.beliefs)) {
    if (b.createdBy.actorKind === 'AGENT') {
      expect(rank(b.authority), `agent belief ${b.id} above AI_ASSUMPTION`).toBeGreaterThanOrEqual(rank('AI_ASSUMPTION'));
    }
    for (const t of b.history) {
      if (t.to === 'TESTED' || t.to === 'VERIFIED') {
        const forward = BELIEF_STATES.indexOf(t.to as never) > BELIEF_STATES.indexOf(t.from as never);
        if (forward) expect(t.by, `agent moved ${b.id} to ${t.to}`).not.toBe(AGENT.id);
      }
    }
    if (b.state === 'VERIFIED') {
      expect(b.contradictingEvidence.filter((e) => e.status === 'OPEN'), `${b.id} VERIFIED with open contradiction`).toEqual([]);
    }
  }

  for (const c of Object.values(state.contradictions)) {
    expect(c.sides).toHaveLength(2);
    if (c.status === 'ESCALATED') {
      expect(c.uncertaintyId).not.toBeNull();
      expect(state.uncertainties[c.uncertaintyId ?? '']).toBeDefined();
    }
    if (c.status === 'RESOLVED_BY_HUMAN') expect(c.resolution?.by).toBe(HUMAN.id);
    if (c.status === 'RESOLVED_BY_AUTHORITY') {
      const [a, b] = c.sides;
      const winner = c.governingSide === 0 ? a : b;
      const loser = c.governingSide === 0 ? b : a;
      expect(outranks(winner.authority, loser.authority), `${c.id} governed without higher authority`).toBe(true);
    }
  }

  for (const u of Object.values(state.uncertainties)) {
    if (u.source === 'CONTRADICTION' && u.status === 'RESOLVED') {
      expect(state.contradictions[u.sourceRef ?? '']?.status, `${u.id} resolved apart from its contradiction`).toBe(
        'RESOLVED_BY_HUMAN',
      );
    }
    if (u.status === 'ACCEPTED') expect(u.history.at(-1)?.by).toBe(HUMAN.id);
  }
}

describe('cognitive invariants under random command streams', () => {
  for (const seed of [1, 7, 42, 99, 314, 2718, 31337, 65535]) {
    it(`holds every invariant, and replays exactly (seed ${seed})`, async () => {
      const ledger = new InMemoryEventLedger();
      const scope = projectScope(PROJECT);
      const engine = new CognitiveEngine(ledger, { ids: countingIds(), now: tickingClock() });
      const next = generator(prng(seed));

      let accepted = 0;
      let refused = 0;
      for (let step = 0; step < 250; step++) {
        const { state } = await engine.state(scope);
        const { actor, command } = next(state);
        try {
          const result = await engine.execute(scope, actor, command);
          accepted += 1;
          assertInvariants(result.projection.state);
        } catch (error) {
          // Refusals are the rules working. Anything else is a bug.
          if (!(error instanceof CognitiveRuleViolationError)) throw error;
          refused += 1;
        }
      }

      // The stream must actually exercise both paths, or it proves nothing.
      expect(accepted).toBeGreaterThan(40);
      expect(refused).toBeGreaterThan(20);

      const live = await engine.state(scope);
      const replayed = await replayProjection(cognitionProjector, scope, ledger);
      expect(projectionDigest(replayed.projection)).toBe(projectionDigest(live));
      expect(replayed.summary.verification?.ok).toBe(true);
    });
  }
});
