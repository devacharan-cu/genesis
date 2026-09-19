/**
 * The record of an assembly (SPEC-01 §11.2, ADR-0017 rule 6).
 *
 * "Weights live in configuration and are recorded in the event for each
 * assembly, so a later cycle can explain why a given fact was or was not in
 * context." This builds that event. Appending it is the orchestrator's job; the
 * context package never writes (ADR-0016).
 */

import { type EventActor, type EventInput, type JsonValue, ValidationError } from '@genesis/core-types';
import type { ImpactEntry } from '@genesis/graph';
import type { ContextManifest } from './assemble.js';

export const CONTEXT_ASSEMBLED = 'CONTEXT_ASSEMBLED';

/**
 * Where an assembly's inputs came from, recorded with it so it stays
 * explainable after the stores move on (ADR-0016 rule 5): the ledger position
 * of the cognitive state it read, and the graph impact set it used.
 */
export interface AssemblyProvenance {
  readonly asOfSeq: number;
  readonly impact: readonly ImpactEntry[];
}

/**
 * The event input recording an assembly. Only the core assembles context, so
 * only a SYSTEM actor may record one: an agent receives a context, it does not
 * get to say what it was given.
 */
export function contextAssembledEvent(
  manifest: ContextManifest,
  provenance: AssemblyProvenance,
  actor: EventActor,
  timestamp: string,
): EventInput {
  if (actor.kind !== 'SYSTEM') {
    throw new ValidationError(`context assembly is recorded by the system, not by ${actor.kind}`, { actor: actor.id });
  }
  return {
    type: CONTEXT_ASSEMBLED,
    actor,
    authority: 'VERIFIED_SYSTEM_STATE',
    subject: null,
    // A manifest and an impact set are plain data by construction: strings,
    // numbers, booleans, nulls, arrays and objects of them.
    payload: {
      manifest: manifest as unknown as JsonValue,
      asOfSeq: provenance.asOfSeq,
      impact: provenance.impact.map((e) => ({
        nodeId: e.nodeId,
        depth: e.depth,
        weakestAuthorityRank: e.weakestAuthorityRank,
      })),
    },
    timestamp,
  };
}
