/**
 * The MemoryStore port (SPEC-02 §7).
 *
 * The core depends on this, never on a database.
 *
 * Note what is ABSENT: there is no `delete`, no `overwrite`, no `merge`. A
 * contradicted claim is marked, never replaced; a superseded one is marked,
 * never removed. SPEC-02 §5 ends with "there is no code path that deletes the
 * losing record", and the absence of the method is how that is guaranteed
 * rather than merely intended.
 *
 * Every method takes a `ProjectScope` first, so an unscoped read is not
 * expressible (ADR-0008).
 */

import type { ActorKind, EventId, MemoryId, ProjectScope } from '@genesis/core-types';
import type { ContradictionResolution } from './contradiction.js';
import type {
  MemoryLink,
  MemoryLinkKind,
  MemoryRecord,
  MemoryStatus,
  NewMemoryRecord,
} from './record.js';
import type { MemoryQuery, Page } from './query.js';

/**
 * Who is writing, and on whose behalf.
 *
 * Supplied by the caller rather than inferred from the record, because the
 * authority policy must key on the actor and a record cannot be trusted to
 * describe its own writer.
 */
export interface WriteContext {
  readonly actorKind: ActorKind;
  readonly actorId: string;
  /** Injectable clock, for deterministic tests. */
  readonly now?: (() => Date) | undefined;
  /** Injectable id source, for deterministic tests. */
  readonly newId?: (() => MemoryId) | undefined;
}

export interface LinkOutcome {
  readonly link: MemoryLink;
  /** The reciprocal link, for CONTRADICTS, which is symmetric. */
  readonly reciprocal: MemoryLink | null;
  readonly resolution: ContradictionResolution;
}

export interface MemoryStore {
  /** Writes version 1 of a new logical record. */
  put(scope: ProjectScope, record: NewMemoryRecord, ctx: WriteContext): Promise<MemoryRecord>;

  /**
   * Writes a new version of an existing logical record.
   *
   * The previous version is marked `SUPERSEDED`; it is not modified beyond its
   * status and is still returned by `history`.
   */
  putVersion(
    scope: ProjectScope,
    logicalId: MemoryId,
    record: NewMemoryRecord,
    ctx: WriteContext,
  ): Promise<MemoryRecord>;

  /** Fetches one version by its id. Throws on a cross-project id (ADR-0008). */
  get(scope: ProjectScope, id: MemoryId): Promise<MemoryRecord | null>;

  /** The latest version of a logical record. */
  current(scope: ProjectScope, logicalId: MemoryId): Promise<MemoryRecord | null>;

  /** Every version, oldest first. Includes superseded ones — that is the point. */
  history(scope: ProjectScope, logicalId: MemoryId): Promise<MemoryRecord[]>;

  query(scope: ProjectScope, q?: MemoryQuery): Promise<Page<MemoryRecord>>;

  /**
   * Links two records and applies the resulting status changes.
   *
   * `CONTRADICTS` is written symmetrically (SPEC-02 §5 step 2) and resolved by
   * authority; `SUPERSEDES` marks the superseded side. Returns what happened,
   * so a caller can tell a settled conflict from an open one without re-reading
   * both records.
   */
  link(
    scope: ProjectScope,
    a: MemoryId,
    b: MemoryId,
    kind: MemoryLinkKind,
  ): Promise<LinkOutcome>;

  /** Every link touching this record, in either direction. */
  links(scope: ProjectScope, id: MemoryId): Promise<MemoryLink[]>;

  /** Moves a record to a new status, recording the causing event when there is one. */
  transition(
    scope: ProjectScope,
    id: MemoryId,
    status: MemoryStatus,
    cause: EventId | null,
  ): Promise<MemoryRecord>;

  close(): Promise<void>;
}
