/**
 * The goal system (SPEC-01 §5, ADR-0014).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). A silent failure here lets the system believe
 * a goal is done when it is not — and every later decision about what to work on
 * inherits that belief.
 *
 * The rules, each enforced in exactly one place below:
 *   - A goal cannot be ACTIVE without at least one CHECKABLE success criterion:
 *     human-confirmable, or machine-checkable with a named check (§5.1).
 *   - A goal cannot be SATISFIED while a criterion is unmet, while a child is
 *     ACTIVE or BLOCKED (§5), or while an open uncertainty blocks it.
 *   - SATISFIED and ABANDONED are terminal. Nothing reopens them; a new goal is
 *     a new record.
 *   - Abandoning a parent never cascades silently to its children: an open
 *     child must be closed first, by an event of its own.
 *   - A human-confirmation criterion is met only by a human; a test criterion is
 *     never met on an agent's say-so.
 *
 * Goals form a tree by `parentId`. The parent is fixed at creation, so a cycle
 * cannot be constructed: a goal can only name a parent that already exists.
 */

import { type GenesisEvent, type GoalStatus, SUCCESS_CHECK_KINDS } from '@genesis/core-types';
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
  COGNITION_EVENTS,
  type CognitionState,
  type Goal,
  GoalCriterionAddedPayload,
  GoalCriterionMetPayload,
  GoalPrioritySetPayload,
  GoalProposedPayload,
  GoalStatusChangedPayload,
  type NewGoal,
  type SuccessCriterion,
} from './records.js';

// ================================================================== commands

const Text = z.string().trim().min(1);
const Priority = z.number().int().min(0).max(100);

const CriterionInput = z
  .object({
    statement: Text,
    checkKind: z.enum(SUCCESS_CHECK_KINDS),
    checkRef: Text.optional(),
  })
  .strict();
export type CriterionInput = z.input<typeof CriterionInput>;

export const GoalCommand = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('PROPOSE_GOAL'),
      description: Text,
      priority: Priority,
      parentId: Text.optional(),
      successCriteria: z.array(CriterionInput).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('ADD_SUCCESS_CRITERION'),
      goalId: Text,
      statement: Text,
      checkKind: z.enum(SUCCESS_CHECK_KINDS),
      checkRef: Text.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('SET_GOAL_PRIORITY'), goalId: Text, priority: Priority }).strict(),
  z.object({ kind: z.literal('ACTIVATE_GOAL'), goalId: Text, reason: z.string().optional() }).strict(),
  z.object({ kind: z.literal('BLOCK_GOAL'), goalId: Text, reason: z.string().optional() }).strict(),
  z
    .object({
      kind: z.literal('MARK_CRITERION_MET'),
      goalId: Text,
      criterionId: Text,
      evidenceRef: Text.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('SATISFY_GOAL'), goalId: Text, reason: z.string().optional() }).strict(),
  z.object({ kind: z.literal('ABANDON_GOAL'), goalId: Text, reason: z.string().optional() }).strict(),
]);
export type GoalCommand = z.infer<typeof GoalCommand>;

// ================================================================= selectors

const TERMINAL: ReadonlySet<GoalStatus> = new Set<GoalStatus>(['SATISFIED', 'ABANDONED']);
const OPEN_FOR_CHILDREN: ReadonlySet<GoalStatus> = new Set<GoalStatus>(['ACTIVE', 'BLOCKED']);

export const isTerminalGoal = (status: GoalStatus): boolean => TERMINAL.has(status);

/** A criterion that can actually be checked: SPEC-01 §5.1. */
export const isCheckable = (criterion: SuccessCriterion): boolean =>
  criterion.checkKind === 'HUMAN_CONFIRMATION' || criterion.checkRef !== null;

export function childGoals(state: CognitionState, goalId: string): Goal[] {
  return sortById(Object.values(state.goals).filter((goal) => goal.parentId === goalId));
}

/** Uncertainties that are still open and name this goal as blocked. */
export function blockingUncertainties(state: CognitionState, goalId: string): string[] {
  return Object.values(state.uncertainties)
    .filter(
      (u) => (u.status === 'OPEN' || u.status === 'IN_PROGRESS') && u.blocksGoalIds.includes(goalId),
    )
    .map((u) => u.id)
    .sort();
}

export type ContributionCheck =
  | { readonly drift: false }
  | {
      readonly drift: true;
      readonly reason: 'NO_CONTRIBUTION' | 'NO_ACTIVE_GOAL';
      readonly unknownGoals: readonly string[];
    };

/**
 * Goal-drift conditions 1 and 2 (SPEC-01 §5.2): an action must contribute to at
 * least one ACTIVE goal. Condition 3 — no criterion advanced for N cycles —
 * needs cycle history and belongs to the loop (ADR-0014, out of P2).
 */
export function checkContribution(
  state: CognitionState,
  contributesTo: readonly string[],
): ContributionCheck {
  if (contributesTo.length === 0) {
    return { drift: true, reason: 'NO_CONTRIBUTION', unknownGoals: [] };
  }
  const unknownGoals = contributesTo.filter((id) => state.goals[id] === undefined);
  const anyActive = contributesTo.some((id) => state.goals[id]?.status === 'ACTIVE');
  return anyActive ? { drift: false } : { drift: true, reason: 'NO_ACTIVE_GOAL', unknownGoals };
}

// ================================================================== decisions

function requireGoal(state: CognitionState, goalId: string): Goal {
  const goal = state.goals[goalId];
  if (goal === undefined) return violation('GOAL_NOT_FOUND', `no goal ${goalId}`, { goalId });
  return goal;
}

function requireOpen(goal: Goal, action: string): void {
  if (isTerminalGoal(goal.status)) {
    violation('GOAL_CLOSED', `cannot ${action}: goal ${goal.id} is ${goal.status}`, {
      goalId: goal.id,
      status: goal.status,
    });
  }
}

function newCriterion(ctx: DecisionContext, input: z.output<typeof CriterionInput>): SuccessCriterion {
  return {
    id: ctx.ids.criterion(),
    statement: input.statement,
    checkKind: input.checkKind,
    checkRef: input.checkRef ?? null,
    met: false,
    metAt: null,
    metBy: null,
    evidenceRef: null,
  };
}

function statusChange(
  ctx: DecisionContext,
  goal: Goal,
  to: GoalStatus,
  reason: string | null,
): CognitiveEventInput {
  return cognitiveEvent(ctx, COGNITION_EVENTS.GOAL_STATUS_CHANGED, {
    goalId: goal.id,
    from: goal.status,
    to,
    reason,
  });
}

function refuseWithOpenChildren(state: CognitionState, goal: Goal, action: string): void {
  const open = childGoals(state, goal.id).filter((child) => OPEN_FOR_CHILDREN.has(child.status));
  if (open.length > 0) {
    violation('OPEN_CHILDREN', `cannot ${action} goal ${goal.id}: children still open`, {
      goalId: goal.id,
      openChildren: open.map((child) => child.id),
    });
  }
}

export function decideGoal(
  state: CognitionState,
  command: GoalCommand,
  ctx: DecisionContext,
): CognitiveEventInput[] {
  switch (command.kind) {
    case 'PROPOSE_GOAL': {
      const parentId = command.parentId ?? null;
      if (parentId !== null) {
        const parent = state.goals[parentId];
        if (parent === undefined) {
          violation('PARENT_NOT_FOUND', `no parent goal ${parentId}`, { parentId });
        }
        requireOpen(parent, 'add a child to it');
      }
      const goal: NewGoal = {
        id: ctx.ids.goal(),
        description: command.description,
        priority: command.priority,
        status: 'PROPOSED',
        parentId,
        successCriteria: (command.successCriteria ?? []).map((c) => newCriterion(ctx, c)),
        createdBy: recordedBy(ctx),
        createdAt: ctx.now,
        closedAt: null,
      };
      return [cognitiveEvent(ctx, COGNITION_EVENTS.GOAL_PROPOSED, { goal })];
    }

    case 'ADD_SUCCESS_CRITERION': {
      const goal = requireGoal(state, command.goalId);
      requireOpen(goal, 'add a criterion');
      const criterion = newCriterion(ctx, command);
      return [cognitiveEvent(ctx, COGNITION_EVENTS.GOAL_CRITERION_ADDED, { goalId: goal.id, criterion })];
    }

    case 'SET_GOAL_PRIORITY': {
      const goal = requireGoal(state, command.goalId);
      requireOpen(goal, 'change its priority');
      if (goal.priority === command.priority) {
        violation('NO_CHANGE', `goal ${goal.id} already has priority ${goal.priority}`);
      }
      return [
        cognitiveEvent(ctx, COGNITION_EVENTS.GOAL_PRIORITY_SET, {
          goalId: goal.id,
          from: goal.priority,
          to: command.priority,
        }),
      ];
    }

    case 'ACTIVATE_GOAL': {
      const goal = requireGoal(state, command.goalId);
      if (goal.status !== 'PROPOSED' && goal.status !== 'BLOCKED') {
        violation('GOAL_NOT_ACTIVATABLE', `goal ${goal.id} is ${goal.status}`, {
          goalId: goal.id,
          status: goal.status,
        });
      }
      if (!goal.successCriteria.some(isCheckable)) {
        violation(
          'NO_CHECKABLE_CRITERION',
          `goal ${goal.id} has no checkable success criterion, so it could never be closed`,
          { goalId: goal.id },
        );
      }
      if (goal.parentId !== null) {
        // Existence is guaranteed: the fold only admits a goal whose parent exists.
        const parent = requireGoal(state, goal.parentId);
        if (isTerminalGoal(parent.status)) {
          violation('PARENT_CLOSED', `parent goal ${parent.id} is ${parent.status}`, {
            goalId: goal.id,
            parentId: parent.id,
          });
        }
      }
      return [statusChange(ctx, goal, 'ACTIVE', command.reason?.trim() || null)];
    }

    case 'BLOCK_GOAL': {
      const goal = requireGoal(state, command.goalId);
      if (goal.status !== 'ACTIVE') {
        violation('GOAL_NOT_ACTIVE', `only an ACTIVE goal can be blocked; ${goal.id} is ${goal.status}`);
      }
      const reason = requireReason(command.reason, 'REASON_REQUIRED', 'blocking a goal');
      return [statusChange(ctx, goal, 'BLOCKED', reason)];
    }

    case 'MARK_CRITERION_MET': {
      const goal = requireGoal(state, command.goalId);
      if (goal.status !== 'ACTIVE' && goal.status !== 'BLOCKED') {
        violation('GOAL_NOT_ACTIVE', `criteria are met on ACTIVE or BLOCKED goals; ${goal.id} is ${goal.status}`);
      }
      const criterion = goal.successCriteria.find((c) => c.id === command.criterionId);
      if (criterion === undefined) {
        return violation('CRITERION_NOT_FOUND', `goal ${goal.id} has no criterion ${command.criterionId}`);
      }
      if (criterion.met) {
        violation('CRITERION_ALREADY_MET', `criterion ${criterion.id} is already met`);
      }
      const evidenceRef = command.evidenceRef ?? null;
      if (criterion.checkKind === 'HUMAN_CONFIRMATION') {
        if (ctx.actor.kind !== 'HUMAN') {
          violation('CRITERION_NEEDS_HUMAN', `criterion ${criterion.id} is met only by human confirmation`);
        }
      } else {
        if (evidenceRef === null) {
          violation('CRITERION_NEEDS_EVIDENCE', `criterion ${criterion.id} needs an evidence reference`);
        }
        if (criterion.checkKind === 'TEST' && ctx.actor.kind === 'AGENT') {
          violation(
            'AGENT_CANNOT_CONFIRM_TEST',
            'a test criterion is met by an executed test, not by an agent reporting one',
          );
        }
      }
      return [
        cognitiveEvent(ctx, COGNITION_EVENTS.GOAL_CRITERION_MET, {
          goalId: goal.id,
          criterionId: criterion.id,
          evidenceRef,
        }),
      ];
    }

    case 'SATISFY_GOAL': {
      const goal = requireGoal(state, command.goalId);
      if (goal.status !== 'ACTIVE') {
        violation('GOAL_NOT_ACTIVE', `only an ACTIVE goal can be satisfied; ${goal.id} is ${goal.status}`);
      }
      const unmet = goal.successCriteria.filter((c) => !c.met).map((c) => c.id);
      if (unmet.length > 0) {
        violation('UNMET_CRITERIA', `goal ${goal.id} has unmet criteria`, { unmet });
      }
      refuseWithOpenChildren(state, goal, 'satisfy');
      const blockers = blockingUncertainties(state, goal.id);
      if (blockers.length > 0) {
        violation('BLOCKED_BY_UNCERTAINTY', `goal ${goal.id} is blocked by open uncertainties`, {
          blockers,
        });
      }
      return [statusChange(ctx, goal, 'SATISFIED', command.reason?.trim() || null)];
    }

    case 'ABANDON_GOAL': {
      const goal = requireGoal(state, command.goalId);
      requireOpen(goal, 'abandon it');
      const reason = requireReason(command.reason, 'REASON_REQUIRED', 'abandoning a goal');
      refuseWithOpenChildren(state, goal, 'abandon');
      return [statusChange(ctx, goal, 'ABANDONED', reason)];
    }
  }
}

// ======================================================================= fold

function withGoal(
  state: CognitionState,
  event: GenesisEvent,
  goalId: string,
  apply: (goal: Goal) => CognitionState,
): CognitionState {
  const goal = state.goals[goalId];
  if (goal === undefined) return anomaly(state, event, 'UNKNOWN_REFERENCE', `no goal ${goalId}`);
  return apply(goal);
}

const putGoal = (state: CognitionState, goal: Goal): CognitionState => ({
  ...state,
  goals: { ...state.goals, [goal.id]: goal },
});

export const goalFold: Record<string, (s: CognitionState, e: GenesisEvent) => CognitionState> = {
  [COGNITION_EVENTS.GOAL_PROPOSED]: (state, event) =>
    withPayload(state, event, GoalProposedPayload, ({ goal }) => {
      if (state.goals[goal.id] !== undefined) {
        return anomaly(state, event, 'STATE_MISMATCH', `goal ${goal.id} already exists`);
      }
      if (goal.status !== 'PROPOSED') {
        return anomaly(state, event, 'STATE_MISMATCH', `a goal is born PROPOSED, not ${goal.status}`);
      }
      if (goal.parentId !== null && state.goals[goal.parentId] === undefined) {
        return anomaly(state, event, 'UNKNOWN_REFERENCE', `no parent goal ${goal.parentId}`);
      }
      return putGoal(state, { ...goal, history: [] });
    }),

  [COGNITION_EVENTS.GOAL_CRITERION_ADDED]: (state, event) =>
    withPayload(state, event, GoalCriterionAddedPayload, ({ goalId, criterion }) =>
      withGoal(state, event, goalId, (goal) => {
        if (isTerminalGoal(goal.status)) {
          return anomaly(state, event, 'STATE_MISMATCH', `goal ${goal.id} is ${goal.status}`);
        }
        if (goal.successCriteria.some((c) => c.id === criterion.id)) {
          return anomaly(state, event, 'STATE_MISMATCH', `criterion ${criterion.id} already exists`);
        }
        return putGoal(state, { ...goal, successCriteria: [...goal.successCriteria, criterion] });
      }),
    ),

  [COGNITION_EVENTS.GOAL_CRITERION_MET]: (state, event) =>
    withPayload(state, event, GoalCriterionMetPayload, ({ goalId, criterionId, evidenceRef }) =>
      withGoal(state, event, goalId, (goal) => {
        const criterion = goal.successCriteria.find((c) => c.id === criterionId);
        if (criterion === undefined) {
          return anomaly(state, event, 'UNKNOWN_REFERENCE', `no criterion ${criterionId}`);
        }
        if (criterion.met) {
          return anomaly(state, event, 'STATE_MISMATCH', `criterion ${criterionId} already met`);
        }
        const met: SuccessCriterion = {
          ...criterion,
          met: true,
          metAt: event.timestamp,
          metBy: event.actor.id,
          evidenceRef,
        };
        return putGoal(state, {
          ...goal,
          successCriteria: goal.successCriteria.map((c) => (c.id === criterionId ? met : c)),
        });
      }),
    ),

  [COGNITION_EVENTS.GOAL_PRIORITY_SET]: (state, event) =>
    withPayload(state, event, GoalPrioritySetPayload, ({ goalId, from, to }) =>
      withGoal(state, event, goalId, (goal) =>
        goal.priority === from
          ? putGoal(state, { ...goal, priority: to })
          : anomaly(state, event, 'STATE_MISMATCH', `goal ${goal.id} priority is ${goal.priority}, not ${from}`),
      ),
    ),

  [COGNITION_EVENTS.GOAL_STATUS_CHANGED]: (state, event) =>
    withPayload(state, event, GoalStatusChangedPayload, ({ goalId, from, to, reason }) =>
      withGoal(state, event, goalId, (goal) => {
        if (goal.status !== from) {
          return anomaly(state, event, 'STATE_MISMATCH', `goal ${goal.id} is ${goal.status}, not ${from}`);
        }
        if (isTerminalGoal(from)) {
          // No decider emits this; seeing it means tampering or a bug upstream.
          return anomaly(state, event, 'STATE_MISMATCH', `goal ${goal.id} is ${from}, which is terminal`);
        }
        return putGoal(state, {
          ...goal,
          status: to,
          closedAt: isTerminalGoal(to) ? event.timestamp : goal.closedAt,
          history: [...goal.history, transitionOf(event, from, to, reason)],
        });
      }),
    ),
};
