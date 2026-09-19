/**
 * The single entry point for a cognitive change (ADR-0014 rule 3).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). Every command is validated here before any
 * rule is checked, and routed to exactly one decider. A command that fails
 * validation is refused with INVALID_COMMAND and nothing is appended; a command
 * that breaks a rule is refused by its decider, likewise.
 *
 * Commands arrive as `unknown` on purpose. The core will receive them from
 * outside the type system — from an API, from an agent's proposal — and a
 * decider that trusted its argument's static type would be trusting the caller.
 */

import { z } from 'zod';
import { type CognitiveEventInput, type DecisionContext, violation } from './context.js';
import { BeliefCommand, decideBelief } from './beliefs.js';
import { ContradictionCommand, decideContradiction } from './contradictions.js';
import { decideGoal, GoalCommand } from './goals.js';
import type { CognitionState } from './records.js';
import { decideUncertainty, UncertaintyCommand } from './uncertainties.js';

export const CognitiveCommand = z.discriminatedUnion('kind', [
  ...GoalCommand.options,
  ...BeliefCommand.options,
  ...UncertaintyCommand.options,
  ...ContradictionCommand.options,
]);
export type CognitiveCommand = z.infer<typeof CognitiveCommand>;

const kindsOf = (union: { readonly options: readonly { readonly shape: { kind: z.ZodLiteral<string> } }[] }) =>
  new Set(union.options.map((option) => option.shape.kind.value));

const GOAL_KINDS = kindsOf(GoalCommand);
const BELIEF_KINDS = kindsOf(BeliefCommand);
const UNCERTAINTY_KINDS = kindsOf(UncertaintyCommand);

const isGoal = (c: CognitiveCommand): c is GoalCommand => GOAL_KINDS.has(c.kind);
const isBelief = (c: CognitiveCommand): c is BeliefCommand => BELIEF_KINDS.has(c.kind);
const isUncertainty = (c: CognitiveCommand): c is UncertaintyCommand => UNCERTAINTY_KINDS.has(c.kind);

/**
 * Decides a command against a state. Pure: the same state, command and context
 * always return the same events. Returns at least one event, or throws.
 */
export function decide(
  state: CognitionState,
  command: unknown,
  ctx: DecisionContext,
): CognitiveEventInput[] {
  const parsed = CognitiveCommand.safeParse(command);
  if (!parsed.success) {
    return violation('INVALID_COMMAND', 'the command is not a valid cognitive command', {
      issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    });
  }
  const valid = parsed.data;
  if (isGoal(valid)) return decideGoal(state, valid, ctx);
  if (isBelief(valid)) return decideBelief(state, valid, ctx);
  if (isUncertainty(valid)) return decideUncertainty(state, valid, ctx);
  return decideContradiction(state, valid, ctx);
}
