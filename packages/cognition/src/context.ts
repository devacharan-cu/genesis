/**
 * What a decider is given besides the state and the command (ADR-0014 rule 2).
 *
 * Deciders are pure: the only inputs are the projected state, the command, and
 * this context. Record ids and timestamps come from here rather than from a
 * clock or a random source inside the decider, so the same inputs always yield
 * the same events. Replay never calls a decider at all — the ids and times are
 * already in the events.
 */

import {
  type Authority,
  CognitiveRuleViolationError,
  type EventActor,
  type GenesisEvent,
  type JsonValue,
  newBeliefId,
  newContradictionId,
  newCriterionId,
  newGoalId,
  newUncertaintyId,
} from '@genesis/core-types';
import { noteAnomaly, type AnomalyKind } from '@genesis/projections';
import type { z } from 'zod';
import type { CognitionEventType, CognitionState, RecordedBy, Transition } from './records.js';

/** Where new record ids come from. Injectable so tests are deterministic. */
export interface IdSource {
  goal(): string;
  criterion(): string;
  belief(): string;
  uncertainty(): string;
  contradiction(): string;
}

export const defaultIdSource: IdSource = {
  goal: () => newGoalId(),
  criterion: () => newCriterionId(),
  belief: () => newBeliefId(),
  uncertainty: () => newUncertaintyId(),
  contradiction: () => newContradictionId(),
};

export interface DecisionContext {
  /** Who is asking. Every rule that depends on the actor reads it from here. */
  readonly actor: EventActor;
  /** ISO timestamp recorded on the events and on the records they create. */
  readonly now: string;
  readonly ids: IdSource;
}

/** The event inputs a decision produces, ready for `ledger.appendMany`. */
export interface CognitiveEventInput {
  readonly type: CognitionEventType;
  readonly actor: EventActor;
  readonly authority: Authority;
  readonly subject: null;
  readonly payload: JsonValue;
  readonly timestamp: string;
}

/**
 * The authority an event recording an ACTION carries.
 *
 * The event says "this actor did this", so its authority is that of the actor
 * doing it: a human's act is a decision; the system's is an observed fact about
 * what the system did; an agent's is model-driven, so it is an assumption. A
 * belief event carries the belief's own authority instead (beliefs.ts).
 */
export function actionAuthority(actor: EventActor): Authority {
  switch (actor.kind) {
    case 'HUMAN':
      return 'HUMAN_DECISION';
    case 'SYSTEM':
      return 'VERIFIED_SYSTEM_STATE';
    case 'AGENT':
      return 'AI_ASSUMPTION';
  }
}

export function recordedBy(ctx: DecisionContext): RecordedBy {
  return { actorKind: ctx.actor.kind, actorId: ctx.actor.id };
}

export function cognitiveEvent(
  ctx: DecisionContext,
  type: CognitionEventType,
  payload: JsonValue,
  authority: Authority = actionAuthority(ctx.actor),
): CognitiveEventInput {
  return { type, actor: ctx.actor, authority, subject: null, payload, timestamp: ctx.now };
}

/** Refuses a command. Nothing is appended (ADR-0014 rule 3). */
export function violation(
  rule: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new CognitiveRuleViolationError(rule, message, details);
}

/** A reason is required for anything that closes, downgrades or overrides. */
export function requireReason(reason: string | undefined, rule: string, what: string): string {
  const trimmed = reason?.trim() ?? '';
  if (trimmed.length === 0) violation(rule, `${what} requires a stated reason`);
  return trimmed;
}

/**
 * Records in ascending id order.
 *
 * Every listing a decider or selector returns goes through here, so two runs
 * over one state list things identically. The default string sort compares by
 * UTF-16 code unit — the same order the canonical serialiser uses — and never
 * by locale, which would vary between machines.
 */
export function sortById<T extends { readonly id: string }>(items: readonly T[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  // Every key came from `items`, so every lookup succeeds.
  return [...byId.keys()].sort().map((id) => byId.get(id) as T);
}

// ------------------------------------------------------------------ the fold

/** Records something the fold could not apply, and leaves state unchanged otherwise. */
export function anomaly(
  state: CognitionState,
  event: GenesisEvent,
  kind: AnomalyKind,
  detail: string,
): CognitionState {
  return { ...state, observations: noteAnomaly(state.observations, event, kind, detail) };
}

/**
 * Parses an event's payload and applies it, or records the event as malformed.
 *
 * Every fold handler goes through here, so "a malformed event changes nothing
 * and is recorded" is one rule rather than fourteen copies of it.
 */
export function withPayload<T>(
  state: CognitionState,
  event: GenesisEvent,
  schema: z.ZodType<T>,
  apply: (payload: T) => CognitionState,
): CognitionState {
  const parsed = schema.safeParse(event.payload);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return anomaly(state, event, 'MALFORMED_PAYLOAD', `payload: ${issues}`);
  }
  return apply(parsed.data);
}

/** The transition record for a status change applied by `event`. */
export function transitionOf(
  event: GenesisEvent,
  from: string,
  to: string,
  reason: string | null,
): Transition {
  return { seq: event.seq, from, to, at: event.timestamp, by: event.actor.id, reason };
}
