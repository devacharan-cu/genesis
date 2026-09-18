/**
 * The world model projection (SPEC-01 section 3, ADR-0013).
 *
 * The world model holds facts about everything EXTERNAL to GENESIS. SPEC-01
 * states it "is a projection over Semantic Memory and the graph. It can be
 * rebuilt from the event ledger." This module is that sentence, implemented.
 *
 * The rule that shapes everything here is SPEC-01's: **world facts are never
 * overwritten**. A superseding fact is a new fact, linked; contradictory facts
 * are both retained and linked. So the fold only ever adds a fact or changes a
 * fact's status — it never edits a statement, and it never removes one.
 *
 * What this projection does NOT do, stated plainly: it does not decide which of
 * two contradicting facts is right. That is the contradiction engine's job
 * (SPEC-01 section 8) and it needs the authority hierarchy and, sometimes, a
 * human. A projection that picked a winner here would be inventing a decision
 * and recording it as history.
 */

import { AUTHORITY_LEVELS, type GenesisEvent, NODE_TYPES, type NodeType } from '@genesis/core-types';
import { z } from 'zod';
import { emptyObservations, noteAnomaly, noteUnhandled, ObservationLog } from './observations.js';
import { parseProjectionState } from './parse.js';
import { type Projector } from './projector.js';

export const WORLD_FACT_STATUSES = ['ACTIVE', 'SUPERSEDED', 'CONTRADICTED'] as const;
export type WorldFactStatus = (typeof WORLD_FACT_STATUSES)[number];

export const WorldFact = z
  .object({
    /** The id of the observation event. A fact IS an observation, so they share one. */
    id: z.string().min(1),
    statement: z.string().min(1),
    subjectType: z.enum(NODE_TYPES),
    subjectId: z.string().min(1),
    authority: z.enum(AUTHORITY_LEVELS),
    beliefId: z.string().nullable(),
    observedAt: z.string().min(1),
    /** Actor id from the event. Who, not what kind — the kind is in the ledger. */
    observedBy: z.string().min(1),
    sourceRefs: z.array(z.string()),
    status: z.enum(WORLD_FACT_STATUSES),
    supersededBy: z.string().nullable(),
    /** Ids of facts this one is in contradiction with, sorted. */
    contradicts: z.array(z.string()),
    seq: z.number().int().positive(),
  })
  .strict();
export type WorldFact = z.infer<typeof WorldFact>;

export const WorldModelState = z
  .object({
    facts: z.record(WorldFact),
    /** "<NODE_TYPE>:<nodeId>" -> fact ids, in observation order. */
    bySubject: z.record(z.array(z.string())),
    lastEventAt: z.string().nullable(),
    observations: ObservationLog,
  })
  .strict();
export type WorldModelState = z.infer<typeof WorldModelState>;

export const WORLD_MODEL_PROJECTION = 'worldModel';
export const WORLD_MODEL_VERSION = 1;

/** The `after` payload of a WORLD_FACT_OBSERVED event. */
const ObservedPayload = z
  .object({
    statement: z.string().min(1),
    beliefId: z.string().min(1).nullish(),
    sourceRefs: z.array(z.string().min(1)).optional(),
  })
  .strict();

/** The `payload` of a WORLD_FACT_SUPERSEDED event. */
const SupersededPayload = z
  .object({
    factId: z.string().min(1),
    /** The fact that replaces it, when there is one. */
    supersededBy: z.string().min(1).nullish(),
  })
  .strict();

/** The `payload` of a WORLD_FACT_CONTRADICTED event. */
const ContradictedPayload = z
  .object({
    factIds: z.array(z.string().min(1)).min(2),
  })
  .strict();

export const subjectKey = (type: NodeType, id: string): string => `${type}:${id}`;

const issuesOf = (error: z.ZodError): string =>
  error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');

function observe(state: WorldModelState, event: GenesisEvent): WorldModelState {
  if (event.subject === null) {
    return {
      ...state,
      observations: noteAnomaly(
        state.observations,
        event,
        'MISSING_SUBJECT',
        'WORLD_FACT_OBSERVED needs a subject to attach the fact to',
      ),
    };
  }

  const parsed = ObservedPayload.safeParse(event.after);
  if (!parsed.success) {
    return {
      ...state,
      observations: noteAnomaly(
        state.observations,
        event,
        'MALFORMED_PAYLOAD',
        `after: ${issuesOf(parsed.error)}`,
      ),
    };
  }

  if (state.facts[event.id] !== undefined) {
    return {
      ...state,
      observations: noteAnomaly(
        state.observations,
        event,
        'STATE_MISMATCH',
        `a fact with id ${event.id} was already observed`,
      ),
    };
  }

  const fact: WorldFact = {
    id: event.id,
    statement: parsed.data.statement,
    subjectType: event.subject.nodeType,
    subjectId: event.subject.nodeId,
    authority: event.authority,
    beliefId: parsed.data.beliefId ?? null,
    observedAt: event.timestamp,
    observedBy: event.actor.id,
    sourceRefs: [...(parsed.data.sourceRefs ?? [])],
    status: 'ACTIVE',
    supersededBy: null,
    contradicts: [],
    seq: event.seq,
  };

  const key = subjectKey(fact.subjectType, fact.subjectId);
  return {
    ...state,
    facts: { ...state.facts, [fact.id]: fact },
    bySubject: { ...state.bySubject, [key]: [...(state.bySubject[key] ?? []), fact.id] },
  };
}

function supersede(state: WorldModelState, event: GenesisEvent): WorldModelState {
  const parsed = SupersededPayload.safeParse(event.payload);
  if (!parsed.success) {
    return {
      ...state,
      observations: noteAnomaly(
        state.observations,
        event,
        'MALFORMED_PAYLOAD',
        `payload: ${issuesOf(parsed.error)}`,
      ),
    };
  }

  const target = state.facts[parsed.data.factId];
  if (target === undefined) {
    return {
      ...state,
      observations: noteAnomaly(
        state.observations,
        event,
        'UNKNOWN_REFERENCE',
        `no fact ${parsed.data.factId} has been observed`,
      ),
    };
  }

  const replacement = parsed.data.supersededBy ?? null;
  // A fact may only be superseded by one this projection has actually seen.
  // Accepting a dangling pointer would let the world model claim a replacement
  // exists when nothing in history says what it is.
  if (replacement !== null && state.facts[replacement] === undefined) {
    return {
      ...state,
      observations: noteAnomaly(
        state.observations,
        event,
        'UNKNOWN_REFERENCE',
        `superseding fact ${replacement} has not been observed`,
      ),
    };
  }

  return {
    ...state,
    facts: {
      ...state.facts,
      [target.id]: { ...target, status: 'SUPERSEDED', supersededBy: replacement },
    },
  };
}

function contradict(state: WorldModelState, event: GenesisEvent): WorldModelState {
  const parsed = ContradictedPayload.safeParse(event.payload);
  if (!parsed.success) {
    return {
      ...state,
      observations: noteAnomaly(
        state.observations,
        event,
        'MALFORMED_PAYLOAD',
        `payload: ${issuesOf(parsed.error)}`,
      ),
    };
  }

  const ids = [...new Set(parsed.data.factIds)].sort();
  // Partitioned in ONE pass, keeping each fact beside its id. Looking the id up
  // a second time inside the update loop would need an `undefined` branch that
  // cannot be reached, and an unreachable branch in a module held to full
  // branch coverage is a sign the code models a case the problem does not have.
  const known: Array<readonly [string, WorldFact]> = [];
  const missing: string[] = [];
  for (const id of ids) {
    const fact = state.facts[id];
    if (fact === undefined) missing.push(id);
    else known.push([id, fact]);
  }

  // A contradiction needs two sides. One side plus a dangling reference is not
  // a contradiction this projection can represent, so nothing is marked.
  if (known.length < 2) {
    return {
      ...state,
      observations: noteAnomaly(
        state.observations,
        event,
        'UNKNOWN_REFERENCE',
        `a contradiction needs two observed facts; unknown: ${missing.join(', ')}`,
      ),
    };
  }

  const knownIds = known.map(([id]) => id);
  const facts = { ...state.facts };
  for (const [id, fact] of known) {
    const others = knownIds.filter((other) => other !== id);
    facts[id] = {
      ...fact,
      status: 'CONTRADICTED',
      contradicts: [...new Set([...fact.contradicts, ...others])].sort(),
    };
  }

  const observations =
    missing.length === 0
      ? state.observations
      : noteAnomaly(
          state.observations,
          event,
          'UNKNOWN_REFERENCE',
          `contradiction refers to unobserved facts: ${missing.join(', ')}`,
        );

  return { ...state, facts, observations };
}

const HANDLERS: Record<string, (s: WorldModelState, e: GenesisEvent) => WorldModelState> = {
  WORLD_FACT_OBSERVED: observe,
  WORLD_FACT_SUPERSEDED: supersede,
  WORLD_FACT_CONTRADICTED: contradict,
};

export const worldModelProjector: Projector<WorldModelState> = {
  name: WORLD_MODEL_PROJECTION,
  version: WORLD_MODEL_VERSION,

  initial: (): WorldModelState => ({
    facts: {},
    bySubject: {},
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

  parse: (value) => parseProjectionState(WorldModelState, value, WORLD_MODEL_PROJECTION),

  observationsOf: (state) => state.observations,
};

// --------------------------------------------------------------- selectors
//
// Derived rather than stored. A counter kept in the state is a second copy of
// the truth, and the two drift; a function over the facts cannot.

export function worldFactsForSubject(
  state: WorldModelState,
  type: NodeType,
  id: string,
): WorldFact[] {
  const ids = state.bySubject[subjectKey(type, id)] ?? [];
  return ids.flatMap((factId) => {
    const fact = state.facts[factId];
    return fact === undefined ? [] : [fact];
  });
}

export function worldFactsByStatus(state: WorldModelState, status: WorldFactStatus): WorldFact[] {
  return Object.values(state.facts).filter((fact) => fact.status === status);
}

/**
 * Rebuilds `bySubject` from `facts`.
 *
 * Exported so the tests can assert the fold-maintained index agrees with the
 * facts it indexes. An index that silently disagrees with its source is a hard
 * bug to find from the outside.
 */
export function rebuildSubjectIndex(state: WorldModelState): Record<string, string[]> {
  const index: Record<string, string[]> = {};
  const ordered = Object.values(state.facts).sort((a, b) => a.seq - b.seq);
  for (const fact of ordered) {
    const key = subjectKey(fact.subjectType, fact.subjectId);
    index[key] = [...(index[key] ?? []), fact.id];
  }
  return index;
}
