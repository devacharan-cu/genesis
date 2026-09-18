/**
 * Event schemas (SPEC-00 section 7).
 *
 * Two shapes, deliberately distinct:
 *
 *   EventInput   what a caller supplies
 *   GenesisEvent what the ledger stored, after it assigned seq and the hashes
 *
 * `EventInput` is `.strict()`, so a caller that tries to supply `seq`,
 * `payloadHash` or `prevHash` gets a validation error rather than having its
 * values quietly ignored. Those fields belong to the ledger alone
 * (ADR-0009 rule 1).
 */

import { z } from 'zod';
import { ACTOR_KINDS } from './actor.js';
import { AUTHORITY_LEVELS, NODE_TYPES } from './enums.js';
import { CycleId, EventId, NodeId, ProjectId, Sha256Hex } from './ids.js';
import { JsonValue } from './json.js';

/** The only event schema version that exists. Upcasting handles older ones. */
export const CURRENT_EVENT_SCHEMA_VERSION = 1;

export const EventActor = z
  .object({
    kind: z.enum(ACTOR_KINDS),
    id: z.string().min(1),
    /** Present only for AGENT actors; identifies which agent role acted. */
    agentRole: z.string().min(1).optional(),
  })
  .strict();
export type EventActor = z.infer<typeof EventActor>;

export const EventSubject = z
  .object({
    nodeType: z.enum(NODE_TYPES),
    nodeId: NodeId,
  })
  .strict();
export type EventSubject = z.infer<typeof EventSubject>;

/**
 * Event types are SCREAMING_SNAKE_CASE, e.g. REQUIREMENT_CHANGED.
 *
 * Not an enum: event types accumulate as the system grows, and a closed enum
 * here would mean every new event type is a change to core-types. The shape is
 * constrained so the vocabulary stays consistent.
 */
export const EventType = z.string().regex(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/, {
  message: 'event type must be SCREAMING_SNAKE_CASE',
});
export type EventType = z.infer<typeof EventType>;

export const EventInput = z
  .object({
    type: EventType,
    actor: EventActor,
    /** The thing this event is about. Null for events with no single subject. */
    subject: EventSubject.nullable().default(null),
    /** Prior value, for change events. */
    before: JsonValue.nullable().default(null),
    /** New value, for change events. */
    after: JsonValue.nullable().default(null),
    /** The event that caused this one, if any. */
    cause: EventId.nullable().default(null),
    /** The cognitive cycle this event belongs to, if any. */
    cycleId: CycleId.nullable().default(null),
    authority: z.enum(AUTHORITY_LEVELS),
    /** Additional structured detail. */
    payload: JsonValue.nullable().default(null),
    /**
     * Occurrence time. Supplied by the caller because the event may describe
     * something that happened before it was recorded. Defaults to now.
     */
    timestamp: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type EventInput = z.input<typeof EventInput>;
export type ParsedEventInput = z.output<typeof EventInput>;

export const GenesisEvent = z
  .object({
    id: EventId,
    projectId: ProjectId,
    /** Per-project, gapless, starting at 1. Assigned by the ledger (ADR-0009). */
    seq: z.number().int().positive(),
    schemaVersion: z.number().int().positive(),
    type: EventType,
    actor: EventActor,
    subject: EventSubject.nullable(),
    before: JsonValue.nullable(),
    after: JsonValue.nullable(),
    cause: EventId.nullable(),
    cycleId: CycleId.nullable(),
    authority: z.enum(AUTHORITY_LEVELS),
    payload: JsonValue.nullable(),
    timestamp: z.string(),
    /** sha-256 over this event's canonical serialisation. */
    payloadHash: Sha256Hex,
    /** payloadHash of event seq-1 in the same project; null at seq 1. */
    prevHash: Sha256Hex.nullable(),
  })
  .strict();
export type GenesisEvent = z.infer<typeof GenesisEvent>;

/**
 * The fields covered by `payloadHash`: everything except the digest itself.
 *
 * `prevHash` IS covered. That is what makes this a chain rather than a set of
 * independent digests: each event's hash commits to its predecessor's, so
 * rewriting one event undetectably requires rewriting every event after it.
 */
export type HashableEvent = Omit<GenesisEvent, 'payloadHash'>;
