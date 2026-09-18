/**
 * Memory record schema (SPEC-02 §3).
 *
 * Two shapes, deliberately distinct, for the same reason the ledger has two:
 *
 *   NewMemoryRecord  what a caller supplies
 *   MemoryRecord     what the store wrote, after scoping, versioning and the
 *                    write-time authority policy
 *
 * `NewMemoryRecord` is `.strict()` and carries no `projectId`, no `authority`
 * (only `authorityRequested`), no `version` and no `status`. Those belong to
 * the store. A caller that tries to supply one gets a validation error rather
 * than having its value quietly ignored.
 */

import { z } from 'zod';
import {
  AUTHORITY_LEVELS,
  JsonValue,
  MEMORY_CLASSES,
  MemoryId,
  NODE_TYPES,
  NodeId,
  ProjectId,
  CycleId,
  AgentId,
  EventId,
} from '@genesis/core-types';

/**
 * Record lifecycle status (SPEC-02 §6).
 *
 * `CONTRADICTED` is NOT a hidden state: see VISIBLE_BY_DEFAULT below.
 */
export const MEMORY_STATUSES = [
  'ACTIVE',
  'SUPERSEDED',
  'SUPERSEDED_BY_AUTHORITY',
  'CONTRADICTED',
  'ARCHIVED',
  'RETRACTED',
] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/**
 * Statuses a default query returns (SPEC-02 §7).
 *
 * `CONTRADICTED` is here on purpose. The conflict is unresolved and both sides
 * still stand, so hiding them would be exactly the silent overwrite that
 * SPEC-02 §5 exists to prevent. Superseded records are hidden because something
 * else now governs; contradicted ones are hidden by nothing, because nothing
 * won.
 */
export const VISIBLE_BY_DEFAULT: readonly MemoryStatus[] = ['ACTIVE', 'CONTRADICTED'];

/** Where a claim came from. `MODEL` is load-bearing — see authority-policy.ts. */
export const SOURCE_KINDS = ['HUMAN', 'TOOL', 'EXPERIMENT', 'FILE', 'EXTERNAL', 'MODEL'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SourceRef = z
  .object({
    kind: z.enum(SOURCE_KINDS),
    id: z.string().min(1),
    uri: z.string().min(1).optional(),
    hash: z.string().min(1).optional(),
  })
  .strict();
export type SourceRef = z.infer<typeof SourceRef>;

export const EntityRef = z
  .object({
    nodeType: z.enum(NODE_TYPES),
    nodeId: NodeId,
  })
  .strict();
export type EntityRef = z.infer<typeof EntityRef>;

/** Why an authority was reduced at write time (SPEC-02 §4.2, ADR-0011). */
export const CLAMP_REASONS = [
  'ACTOR_CEILING',
  'MODEL_SOURCED',
  'NO_EVIDENCE',
  'NO_REQUIREMENT_LINK',
] as const;
export type ClampReason = (typeof CLAMP_REASONS)[number];

export const MemoryContent = z
  .object({
    statement: z.string().min(1),
    body: JsonValue.nullable().default(null),
  })
  .strict();
export type MemoryContent = z.infer<typeof MemoryContent>;

export const MEMORY_LINK_KINDS = ['CONTRADICTS', 'SUPERSEDES'] as const;
export type MemoryLinkKind = (typeof MEMORY_LINK_KINDS)[number];

export const MemoryLink = z
  .object({
    projectId: ProjectId,
    from: MemoryId,
    to: MemoryId,
    kind: z.enum(MEMORY_LINK_KINDS),
    createdAt: z.string(),
  })
  .strict();
export type MemoryLink = z.infer<typeof MemoryLink>;

export const NewMemoryRecord = z
  .object({
    class: z.enum(MEMORY_CLASSES),
    type: z.string().min(1),
    content: MemoryContent,
    /**
     * What the writer asks for. The effective authority is decided by the
     * write-time policy and may be lower (ADR-0011).
     */
    authorityRequested: z.enum(AUTHORITY_LEVELS),
    /**
     * Mandatory and non-empty (SPEC-02 §3): a record with no source cannot be
     * written. Provenance is what the authority policy reads.
     */
    sourceRefs: z.array(SourceRef).min(1),
    relatedEntities: z.array(EntityRef).default([]),
    /** EVIDENCE-class records supporting this one. */
    evidenceRefs: z.array(MemoryId).default([]),
    tags: z.array(z.string().min(1)).default([]),
    validFrom: z.string().datetime({ offset: true }).optional(),
    validUntil: z.string().datetime({ offset: true }).nullable().default(null),
    producedByCycle: CycleId.nullable().default(null),
    producedByAgent: AgentId.nullable().default(null),
    /** Diagnostic only. Nothing in the system branches on it (ADR-0005). */
    confidence: z.number().min(0).max(1).nullable().default(null),
  })
  .strict();
export type NewMemoryRecord = z.input<typeof NewMemoryRecord>;
export type ParsedNewMemoryRecord = z.output<typeof NewMemoryRecord>;

export const MemoryRecord = z
  .object({
    id: MemoryId,
    /** Stable across versions; equals `id` at version 1. */
    logicalId: MemoryId,
    projectId: ProjectId,
    class: z.enum(MEMORY_CLASSES),
    type: z.string().min(1),
    content: MemoryContent,
    /** Effective authority, after the write-time policy. */
    authority: z.enum(AUTHORITY_LEVELS),
    /** What the writer asked for, before clamping. */
    authorityRequested: z.enum(AUTHORITY_LEVELS),
    /** Empty when nothing was clamped. */
    authorityClamps: z.array(z.enum(CLAMP_REASONS)),
    status: z.enum(MEMORY_STATUSES),
    createdAt: z.string(),
    updatedAt: z.string(),
    validFrom: z.string(),
    validUntil: z.string().nullable(),
    version: z.number().int().positive(),
    previousVersion: MemoryId.nullable(),
    sourceRefs: z.array(SourceRef).min(1),
    relatedEntities: z.array(EntityRef),
    evidenceRefs: z.array(MemoryId),
    tags: z.array(z.string()),
    producedByCycle: CycleId.nullable(),
    producedByAgent: AgentId.nullable(),
    confidence: z.number().nullable(),
    /** The event that caused the current status, when there was one. */
    statusCause: EventId.nullable(),
  })
  .strict();
export type MemoryRecord = z.infer<typeof MemoryRecord>;

/** True when the write-time policy reduced this record's authority. */
export function wasClamped(record: MemoryRecord): boolean {
  return record.authority !== record.authorityRequested;
}
