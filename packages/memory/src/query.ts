/**
 * Query semantics (SPEC-02 §7).
 *
 * The matching logic lives here, shared by every adapter, so that "what a
 * default query returns" has exactly one definition. An adapter that
 * reimplemented this in SQL could drift, and the drift would show up as one
 * backend hiding a contradiction the other surfaced.
 */

import { type Authority, authorityRank, type MemoryClass, type NodeType } from '@genesis/core-types';
import {
  type MemoryRecord,
  type MemoryStatus,
  VISIBLE_BY_DEFAULT,
} from './record.js';

export const DEFAULT_QUERY_LIMIT = 100;
export const MAX_QUERY_LIMIT = 1_000;

export interface MemoryQuery {
  readonly class?: readonly MemoryClass[] | undefined;
  readonly type?: readonly string[] | undefined;
  /** At least this authoritative (by rank, inclusive). */
  readonly minAuthority?: Authority | undefined;
  /** At most this authoritative (by rank, inclusive). */
  readonly maxAuthority?: Authority | undefined;
  readonly status?: readonly MemoryStatus[] | undefined;
  readonly relatedEntity?: { readonly nodeType: NodeType; readonly nodeId: string } | undefined;
  readonly tags?: readonly string[] | undefined;
  /** ISO instant: matches records whose validity window contains it. */
  readonly validAt?: string | undefined;
  /**
   * Case-insensitive substring match on the statement.
   *
   * Deliberately naive. Real text search (FTS5 / an embedding store) is a P3
   * decision that needs a corpus to evaluate against; pretending this is that
   * would be the fake-functionality failure rule 2 forbids.
   */
  readonly text?: string | undefined;
  /**
   * Include superseded, archived and retracted records. Defaults to false.
   * Note that CONTRADICTED records are returned either way — see
   * VISIBLE_BY_DEFAULT.
   */
  readonly includeNonActive?: boolean | undefined;
  /** Include every version, not only the latest of each logical record. */
  readonly includeAllVersions?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly nextOffset: number | null;
}

/** True when a record satisfies every supplied filter. */
export function matchesQuery(record: MemoryRecord, q: MemoryQuery): boolean {
  if (q.includeNonActive !== true && !VISIBLE_BY_DEFAULT.includes(record.status)) return false;
  if (q.status !== undefined && !q.status.includes(record.status)) return false;
  if (q.class !== undefined && !q.class.includes(record.class)) return false;
  if (q.type !== undefined && !q.type.includes(record.type)) return false;

  if (q.minAuthority !== undefined && authorityRank(record.authority) > authorityRank(q.minAuthority)) {
    return false;
  }
  if (q.maxAuthority !== undefined && authorityRank(record.authority) < authorityRank(q.maxAuthority)) {
    return false;
  }

  if (q.relatedEntity !== undefined) {
    const wanted = q.relatedEntity;
    const found = record.relatedEntities.some(
      (entity) => entity.nodeType === wanted.nodeType && entity.nodeId === wanted.nodeId,
    );
    if (!found) return false;
  }

  if (q.tags !== undefined && !q.tags.every((tag) => record.tags.includes(tag))) return false;

  if (q.validAt !== undefined) {
    const at = Date.parse(q.validAt);
    if (Date.parse(record.validFrom) > at) return false;
    if (record.validUntil !== null && Date.parse(record.validUntil) <= at) return false;
  }

  if (q.text !== undefined) {
    const needle = q.text.toLowerCase();
    if (!record.content.statement.toLowerCase().includes(needle)) return false;
  }

  return true;
}

/** Clamps a requested limit into the permitted range. */
export function effectiveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_QUERY_LIMIT;
  if (limit < 1) return 1;
  return Math.min(limit, MAX_QUERY_LIMIT);
}

/**
 * Applies the "latest version only" rule, then sorts and pages.
 *
 * Sort order is `createdAt` descending, then `id` descending as a tiebreak, so
 * paging is stable when several records share a timestamp.
 */
export function finishQuery(
  matched: readonly MemoryRecord[],
  q: MemoryQuery,
): Page<MemoryRecord> {
  let rows = [...matched];

  if (q.includeAllVersions !== true) {
    const latest = new Map<string, MemoryRecord>();
    for (const record of rows) {
      const seen = latest.get(record.logicalId);
      if (seen === undefined || record.version > seen.version) latest.set(record.logicalId, record);
    }
    rows = [...latest.values()];
  }

  rows.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });

  const limit = effectiveLimit(q.limit);
  const offset = q.offset ?? 0;
  const items = rows.slice(offset, offset + limit);
  const consumed = offset + items.length;

  return {
    items,
    total: rows.length,
    nextOffset: consumed < rows.length ? consumed : null,
  };
}
