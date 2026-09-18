/**
 * The self model projection (SPEC-01 section 4, ADR-0013).
 *
 * The self model holds facts about GENESIS itself, so the system can reason
 * about what it is and is not able to do right now. SPEC-01 gives it two rules
 * with teeth, and both are enforced here rather than assumed:
 *
 *   1. **Capabilities are evidence-backed.** `AVAILABLE` requires either a real
 *      evidence reference or a human declaring it. An event claiming
 *      `AVAILABLE` with neither is recorded as `UNAVAILABLE` and the over-claim
 *      is logged as an anomaly. The system does not get to believe it can do
 *      something because an event said so.
 *
 *   2. **`knownFailures` comes from real failures only**, keyed by a normalised
 *      signature so repeats are counted rather than duplicated.
 *
 * What is deliberately absent: nothing here infers a capability from success at
 * something else, and nothing decays a capability on a timer. Freshness windows
 * belong to the component that reads this state and knows what "recent" means
 * for the capability in question; baking a clock into the fold would make the
 * projection depend on when it was run, which is precisely what ADR-0013
 * forbids.
 */

import { type GenesisEvent } from '@genesis/core-types';
import { z } from 'zod';
import { emptyObservations, noteAnomaly, noteUnhandled, ObservationLog } from './observations.js';
import { parseProjectionState } from './parse.js';
import { type Projector } from './projector.js';

export const CAPABILITY_STATUSES = ['AVAILABLE', 'DEGRADED', 'UNAVAILABLE'] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export const LIMITATION_SOURCES = ['DECLARED', 'OBSERVED'] as const;
export type LimitationSource = (typeof LIMITATION_SOURCES)[number];

export const SelfCapability = z
  .object({
    id: z.string().min(1),
    description: z.string(),
    status: z.enum(CAPABILITY_STATUSES),
    evidenceRef: z.string().nullable(),
    /** When it entered this status. Unchanged while the status is unchanged. */
    since: z.string().min(1),
    seq: z.number().int().positive(),
  })
  .strict();
export type SelfCapability = z.infer<typeof SelfCapability>;

export const SelfLimitation = z
  .object({
    id: z.string().min(1),
    description: z.string(),
    source: z.enum(LIMITATION_SOURCES),
    since: z.string().min(1),
  })
  .strict();
export type SelfLimitation = z.infer<typeof SelfLimitation>;

export const KnownFailure = z
  .object({
    signature: z.string().min(1),
    occurrences: z.number().int().positive(),
    firstSeen: z.string().min(1),
    lastSeen: z.string().min(1),
    mitigation: z.string().nullable(),
  })
  .strict();
export type KnownFailure = z.infer<typeof KnownFailure>;

export const SelfModelState = z
  .object({
    capabilities: z.record(SelfCapability),
    limitations: z.record(SelfLimitation),
    knownFailures: z.record(KnownFailure),
    /** Belief ids at ASSUMED that are in play. Sorted, so set-equal is digest-equal. */
    assumptions: z.array(z.string()),
    /** Open uncertainty ids. Sorted, for the same reason. */
    uncertainties: z.array(z.string()),
    currentTask: z.string().nullable(),
    currentGoal: z.string().nullable(),
    lastEventAt: z.string().nullable(),
    observations: ObservationLog,
  })
  .strict();
export type SelfModelState = z.infer<typeof SelfModelState>;

export const SELF_MODEL_PROJECTION = 'selfModel';
export const SELF_MODEL_VERSION = 1;

const CapabilityPayload = z
  .object({
    id: z.string().min(1),
    description: z.string().default(''),
    status: z.enum(CAPABILITY_STATUSES),
    evidenceRef: z.string().min(1).nullish(),
  })
  .strict();

const LimitationPayload = z
  .object({
    id: z.string().min(1),
    description: z.string().default(''),
    source: z.enum(LIMITATION_SOURCES),
  })
  .strict();

const TaskPayload = z.object({ taskId: z.string().min(1) }).strict();
const GoalPayload = z.object({ goalId: z.string().min(1) }).strict();
const BeliefPayload = z.object({ beliefId: z.string().min(1) }).strict();
const UncertaintyPayload = z.object({ uncertaintyId: z.string().min(1) }).strict();
const FailurePayload = z
  .object({
    signature: z.string().min(1),
    mitigation: z.string().min(1).nullish(),
  })
  .strict();

const issuesOf = (error: z.ZodError): string =>
  error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');

const malformed = (state: SelfModelState, event: GenesisEvent, error: z.ZodError): SelfModelState => ({
  ...state,
  observations: noteAnomaly(
    state.observations,
    event,
    'MALFORMED_PAYLOAD',
    `payload: ${issuesOf(error)}`,
  ),
});

const withMember = (list: readonly string[], id: string): string[] =>
  [...new Set([...list, id])].sort();

function capability(state: SelfModelState, event: GenesisEvent): SelfModelState {
  const parsed = CapabilityPayload.safeParse(event.payload);
  if (!parsed.success) return malformed(state, event, parsed.error);

  const evidenceRef = parsed.data.evidenceRef ?? null;
  const declaredByHuman = event.actor.kind === 'HUMAN';
  const overclaimed = parsed.data.status === 'AVAILABLE' && evidenceRef === null && !declaredByHuman;

  // SPEC-01 section 4 rule 1. An unevidenced AVAILABLE is not downgraded as a
  // punishment; it is downgraded because the claim has nothing behind it, and a
  // self model that believes it can act when it cannot is the specific failure
  // this rule exists to prevent.
  const status: CapabilityStatus = overclaimed ? 'UNAVAILABLE' : parsed.data.status;

  const existing = state.capabilities[parsed.data.id];
  const since =
    existing !== undefined && existing.status === status ? existing.since : event.timestamp;

  const next: SelfCapability = {
    id: parsed.data.id,
    description: parsed.data.description,
    status,
    evidenceRef,
    since,
    seq: event.seq,
  };

  return {
    ...state,
    capabilities: { ...state.capabilities, [next.id]: next },
    observations: overclaimed
      ? noteAnomaly(
          state.observations,
          event,
          'FORBIDDEN_VALUE',
          `capability ${next.id} claimed AVAILABLE with no evidence and no human declaring it; recorded UNAVAILABLE`,
        )
      : state.observations,
  };
}

function limitation(state: SelfModelState, event: GenesisEvent): SelfModelState {
  const parsed = LimitationPayload.safeParse(event.payload);
  if (!parsed.success) return malformed(state, event, parsed.error);

  const existing = state.limitations[parsed.data.id];
  const next: SelfLimitation = {
    id: parsed.data.id,
    description: parsed.data.description,
    source: parsed.data.source,
    since: existing === undefined ? event.timestamp : existing.since,
  };
  return { ...state, limitations: { ...state.limitations, [next.id]: next } };
}

function taskStarted(state: SelfModelState, event: GenesisEvent): SelfModelState {
  const parsed = TaskPayload.safeParse(event.payload);
  if (!parsed.success) return malformed(state, event, parsed.error);

  // The ledger says the new task started, so the state follows it. The overlap
  // is recorded rather than resolved: refusing the event would make the self
  // model disagree with history, and picking a winner would be an invention.
  const observations =
    state.currentTask === null || state.currentTask === parsed.data.taskId
      ? state.observations
      : noteAnomaly(
          state.observations,
          event,
          'STATE_MISMATCH',
          `task ${parsed.data.taskId} started while ${state.currentTask} was still current`,
        );

  return { ...state, currentTask: parsed.data.taskId, observations };
}

function taskFinished(state: SelfModelState, event: GenesisEvent): SelfModelState {
  const parsed = TaskPayload.safeParse(event.payload);
  if (!parsed.success) return malformed(state, event, parsed.error);

  if (state.currentTask !== parsed.data.taskId) {
    return {
      ...state,
      observations: noteAnomaly(
        state.observations,
        event,
        'STATE_MISMATCH',
        `task ${parsed.data.taskId} finished but the current task is ${state.currentTask ?? 'none'}`,
      ),
    };
  }
  return { ...state, currentTask: null };
}

function goalActivated(state: SelfModelState, event: GenesisEvent): SelfModelState {
  const parsed = GoalPayload.safeParse(event.payload);
  if (!parsed.success) return malformed(state, event, parsed.error);

  const observations =
    state.currentGoal === null || state.currentGoal === parsed.data.goalId
      ? state.observations
      : noteAnomaly(
          state.observations,
          event,
          'STATE_MISMATCH',
          `goal ${parsed.data.goalId} activated while ${state.currentGoal} was still active`,
        );

  return { ...state, currentGoal: parsed.data.goalId, observations };
}

function goalClosed(state: SelfModelState, event: GenesisEvent): SelfModelState {
  const parsed = GoalPayload.safeParse(event.payload);
  if (!parsed.success) return malformed(state, event, parsed.error);

  if (state.currentGoal !== parsed.data.goalId) {
    return {
      ...state,
      observations: noteAnomaly(
        state.observations,
        event,
        'STATE_MISMATCH',
        `goal ${parsed.data.goalId} closed but the active goal is ${state.currentGoal ?? 'none'}`,
      ),
    };
  }
  return { ...state, currentGoal: null };
}

function executionFailed(state: SelfModelState, event: GenesisEvent): SelfModelState {
  const parsed = FailurePayload.safeParse(event.payload);
  if (!parsed.success) return malformed(state, event, parsed.error);

  const existing = state.knownFailures[parsed.data.signature];
  const mitigation = parsed.data.mitigation ?? null;
  const next: KnownFailure =
    existing === undefined
      ? {
          signature: parsed.data.signature,
          occurrences: 1,
          firstSeen: event.timestamp,
          lastSeen: event.timestamp,
          mitigation,
        }
      : {
          signature: existing.signature,
          occurrences: existing.occurrences + 1,
          firstSeen: existing.firstSeen,
          lastSeen: event.timestamp,
          // A later event that names no mitigation does not erase one that was
          // recorded earlier; it simply says nothing about it.
          mitigation: mitigation ?? existing.mitigation,
        };

  return { ...state, knownFailures: { ...state.knownFailures, [next.signature]: next } };
}

function assumptionAdded(state: SelfModelState, event: GenesisEvent): SelfModelState {
  const parsed = BeliefPayload.safeParse(event.payload);
  if (!parsed.success) return malformed(state, event, parsed.error);
  return { ...state, assumptions: withMember(state.assumptions, parsed.data.beliefId) };
}

function assumptionDropped(state: SelfModelState, event: GenesisEvent): SelfModelState {
  const parsed = BeliefPayload.safeParse(event.payload);
  if (!parsed.success) return malformed(state, event, parsed.error);

  if (!state.assumptions.includes(parsed.data.beliefId)) {
    return {
      ...state,
      observations: noteAnomaly(
        state.observations,
        event,
        'UNKNOWN_REFERENCE',
        `assumption ${parsed.data.beliefId} was not in play`,
      ),
    };
  }
  return { ...state, assumptions: state.assumptions.filter((id) => id !== parsed.data.beliefId) };
}

function uncertaintyOpened(state: SelfModelState, event: GenesisEvent): SelfModelState {
  const parsed = UncertaintyPayload.safeParse(event.payload);
  if (!parsed.success) return malformed(state, event, parsed.error);
  return { ...state, uncertainties: withMember(state.uncertainties, parsed.data.uncertaintyId) };
}

function uncertaintyResolved(state: SelfModelState, event: GenesisEvent): SelfModelState {
  const parsed = UncertaintyPayload.safeParse(event.payload);
  if (!parsed.success) return malformed(state, event, parsed.error);

  if (!state.uncertainties.includes(parsed.data.uncertaintyId)) {
    return {
      ...state,
      observations: noteAnomaly(
        state.observations,
        event,
        'UNKNOWN_REFERENCE',
        `uncertainty ${parsed.data.uncertaintyId} was not open`,
      ),
    };
  }
  return {
    ...state,
    uncertainties: state.uncertainties.filter((id) => id !== parsed.data.uncertaintyId),
  };
}

const HANDLERS: Record<string, (s: SelfModelState, e: GenesisEvent) => SelfModelState> = {
  CAPABILITY_OBSERVED: capability,
  LIMITATION_DECLARED: limitation,
  TASK_STARTED: taskStarted,
  TASK_FINISHED: taskFinished,
  GOAL_ACTIVATED: goalActivated,
  GOAL_CLOSED: goalClosed,
  EXECUTION_FAILED: executionFailed,
  ASSUMPTION_ADDED: assumptionAdded,
  ASSUMPTION_DROPPED: assumptionDropped,
  UNCERTAINTY_OPENED: uncertaintyOpened,
  UNCERTAINTY_RESOLVED: uncertaintyResolved,
};

export const selfModelProjector: Projector<SelfModelState> = {
  name: SELF_MODEL_PROJECTION,
  version: SELF_MODEL_VERSION,

  initial: (): SelfModelState => ({
    capabilities: {},
    limitations: {},
    knownFailures: {},
    assumptions: [],
    uncertainties: [],
    currentTask: null,
    currentGoal: null,
    lastEventAt: null,
    observations: emptyObservations(),
  }),

  apply(state, event) {
    const handler = HANDLERS[event.type];
    const next =
      handler === undefined
        ? { ...state, observations: noteUnhandled(state.observations, event) }
        : handler(state, event);
    return { ...next, lastEventAt: event.timestamp };
  },

  parse: (value) => parseProjectionState(SelfModelState, value, SELF_MODEL_PROJECTION),

  observationsOf: (state) => state.observations,
};

// --------------------------------------------------------------- selectors

export function capabilitiesByStatus(
  state: SelfModelState,
  status: CapabilityStatus,
): SelfCapability[] {
  return Object.values(state.capabilities).filter((c) => c.status === status);
}

/**
 * True when the system is in a position to say "I cannot determine this".
 *
 * SPEC-01 section 4 rule 2 requires that state to be REPRESENTABLE, not merely
 * describable in prose. This is the predicate that makes it checkable: an open
 * uncertainty exists, so a surface reporting status has something honest to
 * render instead of a guess.
 */
export function hasOpenUncertainty(state: SelfModelState): boolean {
  return state.uncertainties.length > 0;
}
