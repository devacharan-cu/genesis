/**
 * Node and edge schemas (SPEC-03 §2, §3).
 *
 * As everywhere else, the shape a caller supplies is distinct from the shape
 * the store wrote. `NewNode` and `NewEdge` are `.strict()` and carry no
 * `projectId`, no `id`, no `version` and no `status` — those belong to the
 * store, and a caller that tries to supply one gets a validation error rather
 * than having its value quietly ignored.
 */

import { z } from 'zod';
import {
  AUTHORITY_LEVELS,
  CycleId,
  EDGE_TYPES,
  EdgeId,
  EventId,
  JsonValue,
  MemoryId,
  NODE_TYPES,
  NodeId,
  ProjectId,
} from '@genesis/core-types';

export const NODE_STATUSES = ['ACTIVE', 'SUPERSEDED', 'ARCHIVED', 'DELETED_LOGICALLY'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export const EDGE_STATUSES = ['ACTIVE', 'SUPERSEDED', 'RETRACTED'] as const;
export type EdgeStatus = (typeof EDGE_STATUSES)[number];

/**
 * Statuses a traversal follows by default.
 *
 * A `DELETED_LOGICALLY` node is still readable by id — nothing is ever hard
 * deleted (G10) — but it is not walked through, because a deleted thing should
 * not carry impact to its neighbours.
 */
export const TRAVERSABLE_NODE_STATUSES: readonly NodeStatus[] = ['ACTIVE', 'SUPERSEDED'];
export const TRAVERSABLE_EDGE_STATUSES: readonly EdgeStatus[] = ['ACTIVE'];

export const NewNode = z
  .object({
    type: z.enum(NODE_TYPES),
    label: z.string().min(1),
    /** Pointer to the authoritative record; the graph stores structure, not content. */
    recordRef: z.union([MemoryId, EventId]).nullable().default(null),
    attrs: z.record(JsonValue).default({}),
  })
  .strict();
export type NewNode = z.input<typeof NewNode>;

export const GraphNode = z
  .object({
    id: NodeId,
    projectId: ProjectId,
    type: z.enum(NODE_TYPES),
    label: z.string().min(1),
    recordRef: z.union([MemoryId, EventId]).nullable(),
    status: z.enum(NODE_STATUSES),
    attrs: z.record(JsonValue),
    createdAt: z.string(),
    updatedAt: z.string(),
    version: z.number().int().positive(),
    statusCause: EventId.nullable(),
  })
  .strict();
export type GraphNode = z.infer<typeof GraphNode>;

export const NewEdge = z
  .object({
    type: z.enum(EDGE_TYPES),
    from: NodeId,
    to: NodeId,
    /**
     * How well established the relationship is. A relationship the reasoning
     * provider guessed at ("this probably calls that") is not the same claim as
     * one a parser extracted, and traversal weights them differently.
     */
    authority: z.enum(AUTHORITY_LEVELS),
    evidenceRefs: z.array(MemoryId).default([]),
    weight: z.number().finite().nullable().default(null),
    createdByCycle: CycleId.nullable().default(null),
  })
  .strict();
export type NewEdge = z.input<typeof NewEdge>;

export const GraphEdge = z
  .object({
    id: EdgeId,
    projectId: ProjectId,
    type: z.enum(EDGE_TYPES),
    from: NodeId,
    to: NodeId,
    authority: z.enum(AUTHORITY_LEVELS),
    evidenceRefs: z.array(MemoryId),
    weight: z.number().nullable(),
    status: z.enum(EDGE_STATUSES),
    createdAt: z.string(),
    updatedAt: z.string(),
    version: z.number().int().positive(),
    createdByCycle: CycleId.nullable(),
    /**
     * Set on the edge the store wrote automatically to keep CONTRADICTS
     * symmetric (G4). It exists so auto-repair is visible rather than looking
     * like something a caller did.
     */
    reciprocalOf: EdgeId.nullable(),
  })
  .strict();
export type GraphEdge = z.infer<typeof GraphEdge>;

export interface Subgraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** True when the result hit `limit` and more was available. */
  readonly truncated: boolean;
}

export interface GraphPath {
  readonly nodes: readonly NodeId[];
  readonly edges: readonly EdgeId[];
}
