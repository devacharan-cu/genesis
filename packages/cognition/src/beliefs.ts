/**
 * The belief system (SPEC-01 §6, ADR-0014).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). A belief at the wrong state is the system
 * treating an assumption as a fact — the exact failure the state ladder exists
 * to prevent.
 *
 *     UNKNOWN ─▶ ASSUMED ─▶ SUPPORTED ─▶ TESTED ─▶ VERIFIED
 *
 * Forward moves are ONE step at a time, and each has an entry requirement that
 * is enforced, not advisory:
 *
 *   ASSUMED    a stated rationale
 *   SUPPORTED  evidence not produced by the reasoning call that created the belief
 *   TESTED     evidence from an executed test or experiment that could have
 *              falsified the belief, attached by a non-agent — and the actor is
 *              not an agent
 *   VERIFIED   as TESTED, from the real target environment, with no open
 *              contradicting evidence
 *
 * Downgrades may go to any lower state and need only a reason. A confidence
 * number never gates anything; it is carried as metadata and nothing reads it.
 *
 * Contradicting evidence against a VERIFIED belief downgrades it to TESTED in
 * the same decision. VERIFIED is defined as "no open contradicting evidence",
 * so leaving it VERIFIED would record a state its own definition rules out —
 * reality outranks bookkeeping (SPEC-00 §4.4).
 */

import {
  type Authority,
  BELIEF_STATES,
  type BeliefState,
  clampAuthority,
  type GenesisEvent,
  NODE_TYPES,
  outranks,
  AUTHORITY_LEVELS,
} from '@genesis/core-types';
import { z } from 'zod';
import {
  anomaly,
  cognitiveEvent,
  type CognitiveEventInput,
  type DecisionContext,
  recordedBy,
  requireReason,
  sortById,
  transitionOf,
  violation,
  withPayload,
} from './context.js';
import {
  type AuthorityClamp,
  type Belief,
  BeliefContradictingEvidenceDismissedPayload,
  BeliefEvidenceAddedPayload,
  BeliefRecordedPayload,
  BeliefStateChangedPayload,
  BeliefSupersededPayload,
  COGNITION_EVENTS,
  type CognitionState,
  type ContradictingEvidence,
  EvidenceRef,
  type HeldEvidence,
  type NewBelief,
} from './records.js';

// ================================================================== commands

const Text = z.string().trim().min(1);

export const BeliefCommand = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('RECORD_BELIEF'),
      statement: Text,
      state: z.enum(['UNKNOWN', 'ASSUMED']).optional(),
      rationale: z.string().optional(),
      authority: z.enum(AUTHORITY_LEVELS).optional(),
      confidence: z.number().min(0).max(1).optional(),
      subjectRefs: z
        .array(z.object({ nodeType: z.enum(NODE_TYPES), nodeId: Text }).strict())
        .optional(),
      reasoningCallId: Text.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('ADD_BELIEF_EVIDENCE'),
      beliefId: Text,
      polarity: z.enum(['SUPPORTING', 'CONTRADICTING']),
      evidence: EvidenceRef,
    })
    .strict(),
  z
    .object({
      kind: z.literal('TRANSITION_BELIEF'),
      beliefId: Text,
      to: z.enum(BELIEF_STATES),
      reason: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('DISMISS_CONTRADICTING_EVIDENCE'),
      beliefId: Text,
      evidenceId: Text,
      reason: z.string().optional(),
    })
    .strict(),
]);
export type BeliefCommand = z.infer<typeof BeliefCommand>;

// ================================================================= selectors

export const beliefRank = (state: BeliefState): number => BELIEF_STATES.indexOf(state);

export const openContradictingEvidence = (belief: Belief): ContradictingEvidence[] =>
  belief.contradictingEvidence.filter((e) => e.status === 'OPEN');

export const beliefsInState = (state: CognitionState, beliefState: BeliefState): Belief[] =>
  sortById(Object.values(state.beliefs).filter((b) => b.state === beliefState));

/**
 * A belief's effective authority (ADR-0014 rule 5, ADR-0011).
 *
 * An agent is capped at AI_ASSUMPTION — it can never promote its own claim
 * above an assumption. Anyone else is clamped to their actor ceiling. The
 * clamp is returned so it is recorded, not applied silently.
 */
export function beliefAuthority(
  actorKind: DecisionContext['actor']['kind'],
  requested: Authority,
): { readonly authority: Authority; readonly clamp: AuthorityClamp | null } {
  if (actorKind === 'AGENT' && outranks(requested, 'AI_ASSUMPTION')) {
    return { authority: 'AI_ASSUMPTION', clamp: 'AGENT_ASSUMPTION_CAP' };
  }
  const clamped = clampAuthority(actorKind, requested);
  return clamped === requested
    ? { authority: requested, clamp: null }
    : { authority: clamped, clamp: 'ACTOR_CEILING' };
}

/** Evidence the TESTED and VERIFIED rules may count: executed, falsifying, not agent-attached. */
const isFalsifyingTest = (e: HeldEvidence): boolean =>
  (e.kind === 'TEST' || e.kind === 'EXPERIMENT') && e.couldFalsify && e.addedBy.actorKind !== 'AGENT';

// ================================================================== decisions

function requireBelief(state: CognitionState, beliefId: string): Belief {
  const belief = state.beliefs[beliefId];
  if (belief === undefined) return violation('BELIEF_NOT_FOUND', `no belief ${beliefId}`, { beliefId });
  return belief;
}

function stateChange(
  ctx: DecisionContext,
  belief: Belief,
  to: BeliefState,
  reason: string | null,
): CognitiveEventInput {
  return cognitiveEvent(ctx, COGNITION_EVENTS.BELIEF_STATE_CHANGED, {
    beliefId: belief.id,
    from: belief.state,
    to,
    reason,
  });
}

/** A state that can be moved INTO by a forward step. UNKNOWN is the bottom, so never. */
type ForwardState = Exclude<BeliefState, 'UNKNOWN'>;

type EntryCheck = (ctx: DecisionContext, belief: Belief, reason: string | null) => void;

/** TESTED and VERIFIED share their first two requirements; returns the qualifying tests. */
function requireExecutedTest(ctx: DecisionContext, belief: Belief, to: ForwardState): HeldEvidence[] {
  if (ctx.actor.kind === 'AGENT') {
    violation('AGENT_CANNOT_TEST', `an agent cannot move a belief to ${to}; that needs an executed test`);
  }
  const tests = belief.supportingEvidence.filter(isFalsifyingTest);
  if (tests.length === 0) {
    violation(
      'NEEDS_FALSIFYING_TEST',
      `${to} requires evidence from an executed test or experiment that could have falsified the belief`,
    );
  }
  return tests;
}

/**
 * The entry requirement for each forward target — SPEC-01 §6.1's table, as code.
 *
 * A table rather than a switch because UNKNOWN can never be a forward target,
 * and a switch would need a case for it that no input can reach.
 */
const ENTRY: Record<ForwardState, EntryCheck> = {
  ASSUMED: (_ctx, _belief, reason) => {
    if (reason === null) violation('RATIONALE_REQUIRED', 'ASSUMED requires a stated rationale');
  },
  SUPPORTED: (_ctx, belief) => {
    const independent = belief.supportingEvidence.some(
      (e) => belief.reasoningCallId === null || e.producedBy !== belief.reasoningCallId,
    );
    if (!independent) {
      violation(
        'NEEDS_INDEPENDENT_EVIDENCE',
        'SUPPORTED requires evidence not produced by the reasoning call that created the belief',
      );
    }
  },
  TESTED: (ctx, belief) => {
    requireExecutedTest(ctx, belief, 'TESTED');
  },
  VERIFIED: (ctx, belief) => {
    const tests = requireExecutedTest(ctx, belief, 'VERIFIED');
    if (!tests.some((e) => e.environment === 'TARGET')) {
      violation('NEEDS_TARGET_EVIDENCE', 'VERIFIED requires test evidence from the real target environment');
    }
    const open = openContradictingEvidence(belief);
    if (open.length > 0) {
      violation('OPEN_CONTRADICTING_EVIDENCE', `belief ${belief.id} has open contradicting evidence`, {
        evidence: open.map((e) => e.evidenceId),
      });
    }
  },
};

export function decideBelief(
  state: CognitionState,
  command: BeliefCommand,
  ctx: DecisionContext,
): CognitiveEventInput[] {
  switch (command.kind) {
    case 'RECORD_BELIEF': {
      const initial = command.state ?? 'UNKNOWN';
      const rationale = command.rationale?.trim() || null;
      if (initial === 'ASSUMED' && rationale === null) {
        violation('RATIONALE_REQUIRED', 'a belief recorded as ASSUMED requires a stated rationale');
      }
      const requested = command.authority ?? 'AI_ASSUMPTION';
      const { authority, clamp } = beliefAuthority(ctx.actor.kind, requested);
      const belief: NewBelief = {
        id: ctx.ids.belief(),
        statement: command.statement,
        state: initial,
        authority,
        authorityRequested: requested,
        authorityClamp: clamp,
        rationale,
        supportingEvidence: [],
        contradictingEvidence: [],
        confidence: command.confidence ?? null,
        subjectRefs: command.subjectRefs ?? [],
        createdBy: recordedBy(ctx),
        reasoningCallId: command.reasoningCallId ?? null,
        createdAt: ctx.now,
        lastTransitionAt: ctx.now,
        supersededBy: [],
      };
      // The one belief event that carries the belief's own authority.
      return [cognitiveEvent(ctx, COGNITION_EVENTS.BELIEF_RECORDED, { belief }, authority)];
    }

    case 'ADD_BELIEF_EVIDENCE': {
      const belief = requireBelief(state, command.beliefId);
      const id = command.evidence.evidenceId;
      const known =
        belief.supportingEvidence.some((e) => e.evidenceId === id) ||
        belief.contradictingEvidence.some((e) => e.evidenceId === id);
      if (known) violation('EVIDENCE_ALREADY_RECORDED', `evidence ${id} is already on belief ${belief.id}`);

      const events = [
        cognitiveEvent(ctx, COGNITION_EVENTS.BELIEF_EVIDENCE_ADDED, {
          beliefId: belief.id,
          polarity: command.polarity,
          evidence: command.evidence,
        }),
      ];
      if (command.polarity === 'CONTRADICTING' && belief.state === 'VERIFIED') {
        events.push(stateChange(ctx, belief, 'TESTED', `contradicting evidence ${id}`));
      }
      return events;
    }

    case 'TRANSITION_BELIEF': {
      const belief = requireBelief(state, command.beliefId);
      const from = beliefRank(belief.state);
      const to = beliefRank(command.to);
      const reason = command.reason?.trim() || null;
      if (to === from) violation('NO_CHANGE', `belief ${belief.id} is already ${belief.state}`);
      if (to < from) {
        return [stateChange(ctx, belief, command.to, requireReason(command.reason, 'REASON_REQUIRED', 'a downgrade'))];
      }
      if (to > from + 1) {
        violation('SKIPPED_STATE', `belief ${belief.id} is ${belief.state}; it can only move to the next state`, {
          from: belief.state,
          to: command.to,
        });
      }
      if (belief.supersededBy.length > 0) {
        violation('BELIEF_SUPERSEDED', `belief ${belief.id} lost a contradiction on authority and cannot advance`, {
          beliefId: belief.id,
          supersededBy: belief.supersededBy,
        });
      }
      // `to > from` and UNKNOWN has rank 0, so the target here is never UNKNOWN.
      ENTRY[command.to as ForwardState](ctx, belief, reason);
      return [stateChange(ctx, belief, command.to, reason)];
    }

    case 'DISMISS_CONTRADICTING_EVIDENCE': {
      const belief = requireBelief(state, command.beliefId);
      if (ctx.actor.kind === 'AGENT') {
        violation('AGENT_CANNOT_DISMISS', 'an agent cannot dismiss evidence against a belief');
      }
      const evidence = belief.contradictingEvidence.find((e) => e.evidenceId === command.evidenceId);
      if (evidence === undefined || evidence.status !== 'OPEN') {
        violation('NO_OPEN_EVIDENCE', `belief ${belief.id} has no open contradicting evidence ${command.evidenceId}`);
      }
      const reason = requireReason(command.reason, 'REASON_REQUIRED', 'dismissing evidence');
      return [
        cognitiveEvent(ctx, COGNITION_EVENTS.BELIEF_CONTRADICTING_EVIDENCE_DISMISSED, {
          beliefId: belief.id,
          evidenceId: command.evidenceId,
          reason,
        }),
      ];
    }
  }
}

// ======================================================================= fold

function withBelief(
  state: CognitionState,
  event: GenesisEvent,
  beliefId: string,
  apply: (belief: Belief) => CognitionState,
): CognitionState {
  const belief = state.beliefs[beliefId];
  if (belief === undefined) return anomaly(state, event, 'UNKNOWN_REFERENCE', `no belief ${beliefId}`);
  return apply(belief);
}

const putBelief = (state: CognitionState, belief: Belief): CognitionState => ({
  ...state,
  beliefs: { ...state.beliefs, [belief.id]: belief },
});

export const beliefFold: Record<string, (s: CognitionState, e: GenesisEvent) => CognitionState> = {
  [COGNITION_EVENTS.BELIEF_RECORDED]: (state, event) =>
    withPayload(state, event, BeliefRecordedPayload, ({ belief }) => {
      if (state.beliefs[belief.id] !== undefined) {
        return anomaly(state, event, 'STATE_MISMATCH', `belief ${belief.id} already exists`);
      }
      if (belief.state !== 'UNKNOWN' && belief.state !== 'ASSUMED') {
        return anomaly(state, event, 'STATE_MISMATCH', `a belief is born UNKNOWN or ASSUMED, not ${belief.state}`);
      }
      return putBelief(state, { ...belief, history: [] });
    }),

  [COGNITION_EVENTS.BELIEF_EVIDENCE_ADDED]: (state, event) =>
    withPayload(state, event, BeliefEvidenceAddedPayload, ({ beliefId, polarity, evidence }) =>
      withBelief(state, event, beliefId, (belief) => {
        const id = evidence.evidenceId;
        if (
          belief.supportingEvidence.some((e) => e.evidenceId === id) ||
          belief.contradictingEvidence.some((e) => e.evidenceId === id)
        ) {
          return anomaly(state, event, 'STATE_MISMATCH', `evidence ${id} already on belief ${belief.id}`);
        }
        const held: HeldEvidence = {
          ...evidence,
          addedBy: { actorKind: event.actor.kind, actorId: event.actor.id },
          addedAt: event.timestamp,
        };
        return putBelief(
          state,
          polarity === 'SUPPORTING'
            ? { ...belief, supportingEvidence: [...belief.supportingEvidence, held] }
            : {
                ...belief,
                contradictingEvidence: [
                  ...belief.contradictingEvidence,
                  { ...held, status: 'OPEN', dismissedReason: null },
                ],
              },
        );
      }),
    ),

  [COGNITION_EVENTS.BELIEF_STATE_CHANGED]: (state, event) =>
    withPayload(state, event, BeliefStateChangedPayload, ({ beliefId, from, to, reason }) =>
      withBelief(state, event, beliefId, (belief) => {
        if (belief.state !== from) {
          return anomaly(state, event, 'STATE_MISMATCH', `belief ${belief.id} is ${belief.state}, not ${from}`);
        }
        const step = beliefRank(to) - beliefRank(from);
        if (step === 0 || step > 1) {
          return anomaly(state, event, 'STATE_MISMATCH', `no decider moves a belief from ${from} to ${to}`);
        }
        return putBelief(state, {
          ...belief,
          state: to,
          // Only the forward move INTO ASSUMED states a rationale. A downgrade to
          // ASSUMED carries a reason for the downgrade, which is not one.
          rationale: step === 1 && to === 'ASSUMED' ? reason : belief.rationale,
          lastTransitionAt: event.timestamp,
          history: [...belief.history, transitionOf(event, from, to, reason)],
        });
      }),
    ),

  [COGNITION_EVENTS.BELIEF_CONTRADICTING_EVIDENCE_DISMISSED]: (state, event) =>
    withPayload(state, event, BeliefContradictingEvidenceDismissedPayload, ({ beliefId, evidenceId, reason }) =>
      withBelief(state, event, beliefId, (belief) => {
        const target = belief.contradictingEvidence.find((e) => e.evidenceId === evidenceId);
        if (target === undefined || target.status !== 'OPEN') {
          return anomaly(state, event, 'STATE_MISMATCH', `no open contradicting evidence ${evidenceId}`);
        }
        return putBelief(state, {
          ...belief,
          contradictingEvidence: belief.contradictingEvidence.map((e) =>
            e.evidenceId === evidenceId ? { ...e, status: 'DISMISSED', dismissedReason: reason } : e,
          ),
        });
      }),
    ),

  [COGNITION_EVENTS.BELIEF_SUPERSEDED_BY_AUTHORITY]: (state, event) =>
    withPayload(state, event, BeliefSupersededPayload, ({ beliefId, contradictionId }) =>
      withBelief(state, event, beliefId, (belief) => {
        if (state.contradictions[contradictionId] === undefined) {
          return anomaly(state, event, 'UNKNOWN_REFERENCE', `no contradiction ${contradictionId}`);
        }
        if (belief.supersededBy.includes(contradictionId)) {
          return anomaly(state, event, 'STATE_MISMATCH', `belief ${belief.id} already superseded by ${contradictionId}`);
        }
        return putBelief(state, { ...belief, supersededBy: [...belief.supersededBy, contradictionId] });
      }),
    ),
};
