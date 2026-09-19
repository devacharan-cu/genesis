/**
 * The contradiction engine (SPEC-01 §8, ADR-0014).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). Silent overwrite of a conflicting claim is a
 * defect, not an optimisation. So on every contradiction, always:
 *
 *   1. Both sides are preserved. The record holds both claims, both
 *      authorities, and where each authority came from. Nothing is deleted.
 *   2. Authority decides — but only when it can be trusted. A side's authority
 *      read from state (a belief) is trustworthy; one supplied by the recorder
 *      is trustworthy only from a HUMAN or SYSTEM actor. Otherwise an agent
 *      could win any contradiction by declaring its side more authoritative.
 *   3. Strictly higher trusted authority governs. A losing belief is marked
 *      superseded-by-authority and stays readable, with its whole history.
 *   4. Equal or indeterminate authority is NOT broken by guessing. An
 *      uncertainty is opened, in the same atomic append, with resolution
 *      ASK_HUMAN — and only a human may resolve the contradiction.
 *
 * Steps 2, 4 and 6 of SPEC-01 §8.1 — the CONTRADICTS edge, the issue, blocking
 * proposals at POLICY_CHECK — need the graph and the proposal pipeline, and are
 * out of P2 (ADR-0014). The record carries `affectedRefs` for them.
 */

import {
  AUTHORITY_LEVELS,
  type GenesisEvent,
  NODE_TYPES,
  outranks,
  RISK_LEVELS,
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
  violation,
  withPayload,
} from './context.js';
import { isTerminalUncertainty, newUncertainty } from './uncertainties.js';
import {
  COGNITION_EVENTS,
  type CognitionState,
  type Contradiction,
  CONTRADICTION_KINDS,
  ContradictionRecordedPayload,
  ContradictionResolvedPayload,
  type ContradictionSide,
} from './records.js';

// ================================================================== commands

const Text = z.string().trim().min(1);
const SideIndex = z.union([z.literal(0), z.literal(1)]);

const SideInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('BELIEF'), beliefId: Text }).strict(),
  z
    .object({
      kind: z.literal('EXTERNAL'),
      id: Text,
      claim: Text,
      authority: z.enum(AUTHORITY_LEVELS),
    })
    .strict(),
]);
export type SideInput = z.infer<typeof SideInput>;

export const ContradictionCommand = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('RECORD_CONTRADICTION'),
      contradictionKind: z.enum(CONTRADICTION_KINDS),
      sides: z.tuple([SideInput, SideInput]),
      affectedRefs: z.array(z.object({ nodeType: z.enum(NODE_TYPES), nodeId: Text }).strict()).optional(),
      /** Risk of the uncertainty opened if authority cannot decide. Defaults to HIGH. */
      risk: z.enum(RISK_LEVELS).optional(),
      /** Goals the escalation uncertainty blocks, if authority cannot decide. */
      blocksGoalIds: z.array(Text).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('RESOLVE_CONTRADICTION'),
      contradictionId: Text,
      governingSide: SideIndex,
      reason: z.string().optional(),
    })
    .strict(),
]);
export type ContradictionCommand = z.infer<typeof ContradictionCommand>;

// ================================================================= selectors

const sideKey = (side: ContradictionSide): string => `${side.ref.kind}:${side.ref.id}`;

/** The pair of sides, order-free, so A-vs-B and B-vs-A are the same contradiction. */
const pairKey = (a: ContradictionSide, b: ContradictionSide): string => [sideKey(a), sideKey(b)].sort().join('|');

export const escalatedContradictions = (state: CognitionState): Contradiction[] =>
  sortById(Object.values(state.contradictions).filter((c) => c.status === 'ESCALATED'));

/** Contradictions a belief takes part in, on either side. */
export const contradictionsInvolving = (state: CognitionState, beliefId: string): Contradiction[] =>
  sortById(
    Object.values(state.contradictions).filter((c) =>
      c.sides.some((s) => s.ref.kind === 'BELIEF' && s.ref.id === beliefId),
    ),
  );

// ================================================================== decisions

function resolveSide(state: CognitionState, input: SideInput): ContradictionSide {
  if (input.kind === 'BELIEF') {
    const belief = state.beliefs[input.beliefId];
    if (belief === undefined) {
      return violation('BELIEF_NOT_FOUND', `no belief ${input.beliefId}`, { beliefId: input.beliefId });
    }
    return {
      ref: { kind: 'BELIEF', id: belief.id },
      claim: belief.statement,
      authority: belief.authority,
      authoritySource: 'STATE',
    };
  }
  return {
    ref: { kind: 'EXTERNAL', id: input.id },
    claim: input.claim,
    authority: input.authority,
    authoritySource: 'ACTOR',
  };
}

/**
 * Who governs, if anyone. See rule 2 above: an ACTOR-sourced authority from an
 * agent makes the whole determination indeterminate.
 */
export function determine(
  sides: readonly [ContradictionSide, ContradictionSide],
  actorKind: DecisionContext['actor']['kind'],
): Pick<Contradiction, 'determination' | 'governingSide'> {
  const trusted = (side: ContradictionSide): boolean =>
    side.authoritySource === 'STATE' || actorKind !== 'AGENT';
  const [a, b] = sides;
  if (!trusted(a) || !trusted(b)) return { determination: 'INDETERMINATE', governingSide: null };
  if (outranks(a.authority, b.authority)) return { determination: 'AUTHORITY', governingSide: 0 };
  if (outranks(b.authority, a.authority)) return { determination: 'AUTHORITY', governingSide: 1 };
  return { determination: 'EQUAL_AUTHORITY', governingSide: null };
}

function supersedeIfBelief(
  ctx: DecisionContext,
  contradictionId: string,
  loser: ContradictionSide,
): CognitiveEventInput[] {
  return loser.ref.kind === 'BELIEF'
    ? [
        cognitiveEvent(ctx, COGNITION_EVENTS.BELIEF_SUPERSEDED_BY_AUTHORITY, {
          beliefId: loser.ref.id,
          contradictionId,
        }),
      ]
    : [];
}

export function decideContradiction(
  state: CognitionState,
  command: ContradictionCommand,
  ctx: DecisionContext,
): CognitiveEventInput[] {
  switch (command.kind) {
    case 'RECORD_CONTRADICTION': {
      const sides: [ContradictionSide, ContradictionSide] = [
        resolveSide(state, command.sides[0]),
        resolveSide(state, command.sides[1]),
      ];
      if (sideKey(sides[0]) === sideKey(sides[1])) {
        violation('SAME_SIDE', 'a claim cannot contradict itself');
      }
      const key = pairKey(sides[0], sides[1]);
      const existing = Object.values(state.contradictions).find(
        (c) => c.kind === command.contradictionKind && pairKey(c.sides[0], c.sides[1]) === key,
      );
      if (existing !== undefined) {
        violation('DUPLICATE_CONTRADICTION', `contradiction ${existing.id} already records these two claims`, {
          contradictionId: existing.id,
        });
      }

      const id = ctx.ids.contradiction();
      const { determination, governingSide } = determine(sides, ctx.actor.kind);
      const affectedRefs = command.affectedRefs ?? [];
      const events: CognitiveEventInput[] = [];

      let uncertaintyId: string | null = null;
      if (governingSide === null) {
        // Rule 4: authority cannot decide, so nothing is decided. The question
        // is recorded, in the same atomic append as the contradiction itself.
        const uncertainty = newUncertainty(state, ctx, {
          statement: `Which holds: "${sides[0].claim}" or "${sides[1].claim}"?`,
          whatBreaksIfWrong: `Work built on the losing claim of contradiction ${id} would be wrong`,
          affectedRefs,
          risk: command.risk ?? 'HIGH',
          blocksGoalIds: command.blocksGoalIds ?? [],
          resolution: 'ASK_HUMAN',
          relatedBeliefs: sides.filter((s) => s.ref.kind === 'BELIEF').map((s) => s.ref.id),
          relatedQuestions: [],
          source: 'CONTRADICTION',
          sourceRef: id,
        });
        uncertaintyId = uncertainty.id;
        events.push(cognitiveEvent(ctx, COGNITION_EVENTS.UNCERTAINTY_RECORDED, { uncertainty }));
      }

      const contradiction: Contradiction = {
        id,
        kind: command.contradictionKind,
        sides,
        determination,
        governingSide,
        status: governingSide === null ? 'ESCALATED' : 'RESOLVED_BY_AUTHORITY',
        uncertaintyId,
        affectedRefs,
        detectedBy: recordedBy(ctx),
        detectedAt: ctx.now,
        resolution: null,
      };
      events.push(cognitiveEvent(ctx, COGNITION_EVENTS.CONTRADICTION_RECORDED, { contradiction }));
      if (governingSide !== null) {
        events.push(...supersedeIfBelief(ctx, id, sides[governingSide === 0 ? 1 : 0]));
      }
      return events;
    }

    case 'RESOLVE_CONTRADICTION': {
      const contradiction = state.contradictions[command.contradictionId];
      if (contradiction === undefined) {
        return violation('CONTRADICTION_NOT_FOUND', `no contradiction ${command.contradictionId}`);
      }
      if (ctx.actor.kind !== 'HUMAN') {
        violation('HUMAN_ONLY', 'only a human resolves a contradiction authority could not decide');
      }
      if (contradiction.status !== 'ESCALATED') {
        violation('NOT_ESCALATED', `contradiction ${contradiction.id} is ${contradiction.status}`);
      }
      const reason = requireReason(command.reason, 'REASON_REQUIRED', 'resolving a contradiction');
      const loser = contradiction.sides[command.governingSide === 0 ? 1 : 0];

      const events: CognitiveEventInput[] = [
        cognitiveEvent(ctx, COGNITION_EVENTS.CONTRADICTION_RESOLVED, {
          contradictionId: contradiction.id,
          governingSide: command.governingSide,
          reason,
        }),
        ...supersedeIfBelief(ctx, contradiction.id, loser),
      ];

      // The escalation uncertainty is settled with the contradiction, so the two
      // can never disagree. Found by what it IS — opened by this contradiction,
      // still open — rather than by the stored id: a human may already have
      // ACCEPTED it, and that record then stands untouched.
      const stillOpen = Object.values(state.uncertainties).filter(
        (u) => u.source === 'CONTRADICTION' && u.sourceRef === contradiction.id && !isTerminalUncertainty(u.status),
      );
      for (const uncertainty of stillOpen) {
        events.push(
          cognitiveEvent(ctx, COGNITION_EVENTS.UNCERTAINTY_STATUS_CHANGED, {
            uncertaintyId: uncertainty.id,
            from: uncertainty.status,
            to: 'RESOLVED',
            reason: `contradiction ${contradiction.id} resolved by human decision`,
            resolutionEvidence: [contradiction.id],
          }),
        );
      }
      return events;
    }
  }
}

// ======================================================================= fold

const putContradiction = (state: CognitionState, c: Contradiction): CognitionState => ({
  ...state,
  contradictions: { ...state.contradictions, [c.id]: c },
});

export const contradictionFold: Record<string, (s: CognitionState, e: GenesisEvent) => CognitionState> = {
  [COGNITION_EVENTS.CONTRADICTION_RECORDED]: (state, event) =>
    withPayload(state, event, ContradictionRecordedPayload, ({ contradiction: c }) => {
      if (state.contradictions[c.id] !== undefined) {
        return anomaly(state, event, 'STATE_MISMATCH', `contradiction ${c.id} already exists`);
      }
      const unknownBeliefs = c.sides
        .filter((s) => s.ref.kind === 'BELIEF' && state.beliefs[s.ref.id] === undefined)
        .map((s) => s.ref.id);
      if (unknownBeliefs.length > 0) {
        return anomaly(state, event, 'UNKNOWN_REFERENCE', `unknown beliefs: ${unknownBeliefs.join(', ')}`);
      }
      const decided = c.governingSide !== null;
      const consistent = decided
        ? c.determination === 'AUTHORITY' && c.status === 'RESOLVED_BY_AUTHORITY' && c.uncertaintyId === null
        : c.determination !== 'AUTHORITY' && c.status === 'ESCALATED' && c.uncertaintyId !== null;
      if (!consistent || c.resolution !== null) {
        return anomaly(state, event, 'STATE_MISMATCH', `contradiction ${c.id} is internally inconsistent`);
      }
      if (c.uncertaintyId !== null && state.uncertainties[c.uncertaintyId] === undefined) {
        return anomaly(state, event, 'UNKNOWN_REFERENCE', `no uncertainty ${c.uncertaintyId}`);
      }
      return putContradiction(state, c);
    }),

  [COGNITION_EVENTS.CONTRADICTION_RESOLVED]: (state, event) =>
    withPayload(state, event, ContradictionResolvedPayload, ({ contradictionId, governingSide, reason }) => {
      const c = state.contradictions[contradictionId];
      if (c === undefined) {
        return anomaly(state, event, 'UNKNOWN_REFERENCE', `no contradiction ${contradictionId}`);
      }
      if (c.status !== 'ESCALATED') {
        return anomaly(state, event, 'STATE_MISMATCH', `contradiction ${c.id} is ${c.status}`);
      }
      return putContradiction(state, {
        ...c,
        status: 'RESOLVED_BY_HUMAN',
        governingSide,
        resolution: { by: event.actor.id, at: event.timestamp, reason },
      });
    }),
};
