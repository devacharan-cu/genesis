/**
 * The record of an assembly (SPEC-01 §11.2, ADR-0017 rule 6).
 *
 * "Weights live in configuration and are recorded in the event for each
 * assembly, so a later cycle can explain why a given fact was or was not in
 * context." This builds that event. Appending it is the orchestrator's job; the
 * context package never writes (ADR-0016).
 */

import { type EventActor, type EventInput, type JsonValue, ValidationError } from '@genesis/core-types';
import type { ContextManifest } from './assemble.js';

export const CONTEXT_ASSEMBLED = 'CONTEXT_ASSEMBLED';

/**
 * The event input recording an assembly. Only the core assembles context, so
 * only a SYSTEM actor may record one: an agent receives a context, it does not
 * get to say what it was given.
 */
export function contextAssembledEvent(manifest: ContextManifest, actor: EventActor, timestamp: string): EventInput {
  if (actor.kind !== 'SYSTEM') {
    throw new ValidationError(`context assembly is recorded by the system, not by ${actor.kind}`, { actor: actor.id });
  }
  return {
    type: CONTEXT_ASSEMBLED,
    actor,
    authority: 'VERIFIED_SYSTEM_STATE',
    subject: null,
    // A manifest is plain data by construction: strings, numbers, booleans,
    // nulls, arrays and objects of them.
    payload: manifest as unknown as JsonValue,
    timestamp,
  };
}
