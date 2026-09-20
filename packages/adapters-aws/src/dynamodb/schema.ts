/**
 * The single-table key schema (ADR-0024 §1).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). Every key built here begins with the project,
 * so project isolation is a property of the key rather than of application code
 * that remembers to filter (ADR-0008 rule 7). A query that forgot to scope
 * would have to name another project's key explicitly rather than merely omit a
 * predicate.
 *
 * Sequences and versions are zero-padded because DynamoDB sorts sort keys
 * lexicographically. Without the padding, event 10 sorts before event 2 and a
 * range read returns history out of order — which would surface much later as a
 * hash-chain failure, with the cause nowhere near the symptom.
 */

import type { TableSchema } from './model.js';

export const TABLE_KEYS = { partition: 'pk', sort: 'sk' } as const;
export const GSI1 = 'gsi1';
export const GSI2 = 'gsi2';

/** The table as the adapters and the deployed stack both understand it. */
export const GENESIS_TABLE_SCHEMA: TableSchema = {
  keys: TABLE_KEYS,
  indexes: {
    [GSI1]: { partition: 'gsi1pk', sort: 'gsi1sk' },
    [GSI2]: { partition: 'gsi2pk', sort: 'gsi2sk' },
  },
};

/** Wide enough for any sequence a ledger will hold, and fixed so ordering is numeric. */
export const SEQ_WIDTH = 20;
export const VERSION_WIDTH = 10;

export const padSeq = (seq: number): string => String(seq).padStart(SEQ_WIDTH, '0');
export const padVersion = (version: number): string => String(version).padStart(VERSION_WIDTH, '0');

const project = (projectId: string): string => `PRJ#${projectId}`;

// ------------------------------------------------------------------ ledger

export const ledgerPk = (projectId: string): string => `${project(projectId)}#LEDGER`;
export const eventSk = (seq: number): string => `EVT#${padSeq(seq)}`;
export const HEAD_SK = 'HEAD';
/**
 * The by-id index is deliberately NOT project-scoped.
 *
 * `EventLedger.get` must throw on a cross-project id rather than answer null
 * (ADR-0008 rule 6), so the lookup has to find the event wherever it is and
 * then refuse it. A project-scoped index would turn that refusal into an empty
 * result, which is the failure mode the rule exists to prevent. The same
 * applies to the memory by-id index below.
 */
export const eventIdPk = (eventId: string): string => `EVTID#${eventId}`;
export const EVENT_ID_SK = 'EVT';

// ------------------------------------------------------------------ memory

export const memoryPk = (projectId: string, logicalId: string): string => `${project(projectId)}#MEM#${logicalId}`;
export const memoryVersionSk = (version: number): string => `VER#${padVersion(version)}`;
export const memoryIdPk = (id: string): string => `MEMID#${id}`;
export const MEMORY_ID_SK = 'MEM';
/** One partition per project's memory, so `query` can read the set it filters. */
export const memoryAllPk = (projectId: string): string => `${project(projectId)}#MEMALL`;
export const memoryAllSk = (createdAt: string, id: string): string => `${createdAt}#${id}`;

// ------------------------------------------------------------------- graph

/**
 * One partition per project's graph.
 *
 * Traversal reads many nodes and edges together, and a single partition makes
 * that a small number of queries rather than a fan-out. ADR-0024 §4 prices the
 * hot-partition ceiling this accepts, and ADR-0025 §1 says what happens when a
 * graph outgrows it.
 */
export const graphPk = (projectId: string): string => `${project(projectId)}#GRAPH`;
export const nodeSk = (nodeId: string): string => `NODE#${nodeId}`;
export const edgeSk = (edgeId: string): string => `EDGE#${edgeId}`;
export const NODE_PREFIX = 'NODE#';
export const EDGE_PREFIX = 'EDGE#';
/**
 * By-id pointers, in their own tiny partitions.
 *
 * A node or edge has to be findable by id alone, so that a cross-project id is
 * refused rather than answered null and so that G11 can tell a boundary
 * crossing from a missing endpoint. Only two indexes are available and the edge
 * already uses both, so the lookup is a pointer item holding the project rather
 * than a third index.
 */
export const nodePointerPk = (nodeId: string): string => `NODEID#${nodeId}`;
export const edgePointerPk = (edgeId: string): string => `EDGEID#${edgeId}`;
export const POINTER_SK = 'PTR';

/** Edges indexed both ways, so a traversal step is O(degree) (ADR-0024 §1). */
export const edgeOutPk = (projectId: string, from: string): string => `${project(projectId)}#OUT#${from}`;
export const edgeInPk = (projectId: string, to: string): string => `${project(projectId)}#IN#${to}`;

// --------------------------------------------------------------- snapshots

export const snapshotPk = (projectId: string): string => `${project(projectId)}#SNAP`;
export const snapshotSk = (projection: string, version: number): string => `${projection}#${padVersion(version)}`;

/** Every entity kind the table holds, for the deployed stack's documentation. */
export const ENTITY_KINDS = ['LEDGER_EVENT', 'LEDGER_HEAD', 'MEMORY_VERSION', 'GRAPH_NODE', 'GRAPH_EDGE', 'SNAPSHOT'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
