/**
 * The cognition projection (ADR-0014 rule 1, ADR-0013).
 *
 * One fold over all four record families, because the rules cross them: a goal
 * cannot be satisfied while an uncertainty blocks it, and a contradiction marks
 * beliefs and opens uncertainties. Four separate projections would each be
 * checked against a partial view.
 *
 * This is an ordinary ADR-0013 projector, which is the point: replay, snapshot
 * and equivalence come from the projections package and its conformance suite,
 * not from anything written here.
 */

import { emptyObservations, noteUnhandled, parseProjectionState, type Projector } from '@genesis/projections';
import { beliefFold } from './beliefs.js';
import { contradictionFold } from './contradictions.js';
import { goalFold } from './goals.js';
import { CognitionState } from './records.js';
import { uncertaintyFold } from './uncertainties.js';

export const COGNITION_PROJECTION = 'cognition';
export const COGNITION_VERSION = 1;

const HANDLERS = { ...goalFold, ...beliefFold, ...uncertaintyFold, ...contradictionFold };

/** Every event type this projection interprets. Everything else is counted as unhandled. */
export const COGNITION_EVENT_TYPES: readonly string[] = Object.keys(HANDLERS).sort();

export const emptyCognitionState = (): CognitionState => ({
  goals: {},
  beliefs: {},
  uncertainties: {},
  contradictions: {},
  observations: emptyObservations(),
});

export const cognitionProjector: Projector<CognitionState> = {
  name: COGNITION_PROJECTION,
  version: COGNITION_VERSION,
  initial: emptyCognitionState,
  apply(state, event) {
    const handler = HANDLERS[event.type];
    return handler === undefined
      ? { ...state, observations: noteUnhandled(state.observations, event) }
      : handler(state, event);
  },
  parse: (value) => parseProjectionState(CognitionState, value, COGNITION_PROJECTION),
  observationsOf: (state) => state.observations,
};
