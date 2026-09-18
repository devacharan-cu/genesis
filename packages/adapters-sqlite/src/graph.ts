/**
 * SQLite GraphStore adapter (ADR-0003, ADR-0010).
 *
 * Traversal is done with RECURSIVE CTEs, and `project_id` is bound as a
 * parameter in EVERY recursive step — not only in the anchor. That is what
 * makes G12 structural: a walk cannot leave its project even if the seed were
 * wrong, because every join it takes is filtered by the scoped project.
 *
 * What is NOT reimplemented in SQL: the invariant rules and the impact ranking.
 * Those come from @genesis/graph so there is exactly one definition of each.
 * A second implementation in SQL would eventually drift, and the drift would
 * appear as one backend permitting an edge the other rejects — which is the
 * failure the shared conformance suite exists to make impossible.
 *
 * Every index leads with `project_id` (ADR-0008 rule 7).
 */

import { createRequire } from 'node:module';
import type * as NodeSqlite from 'node:sqlite';
import {
  assertInScope,
  AUTHORITY_LEVELS,
  type EdgeId,
  type EventId,
  newEdgeId,
  newNodeId,
  type NodeId,
  type ProjectScope,
  ValidationError,
} from '@genesis/core-types';
import {
  type AddEdgeResult,
  checkEdgeWrite,
  checkStructuralGaps,
  clampDepth,
  clampLimit,
  DEFAULT_IMPACT_DEPTH,
  DEFAULT_NEIGHBOURHOOD_DEPTH,
  type EdgeStatus,
  type EdgeWriteContext,
  GraphEdge,
  GraphNode,
  type GraphPath,
  type GraphStore,
  type GraphWriteContext,
  type ImpactEntry,
  type ImpactOptions,
  InvariantViolationError,
  MAX_IMPACT_DEPTH,
  MAX_TRAVERSAL_DEPTH,
  needsReciprocal,
  type NeighbourhoodOptions,
  NewEdge,
  NewNode,
  type NodeStatus,
  type OrphanCriteria,
  type OrphanFinding,
  type PathOptions,
  rankImpact,
  rejections,
  type Subgraph,
} from '@genesis/graph';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof NodeSqlite;

type Database = NodeSqlite.DatabaseSync;
type StatementSync = NodeSqlite.StatementSync;

const TRAVERSABLE = "('ACTIVE','SUPERSEDED')";

/**
 * Authority → rank, generated from the canonical enum so it cannot drift from
 * it. Hand-writing this CASE would be a second source of truth for the
 * ordering, and ADR-0005 depends on there being one.
 */
const AUTHORITY_RANK_CASE = `CASE e.authority ${AUTHORITY_LEVELS.map(
  (level, index) => `WHEN '${level}' THEN ${index + 1}`,
).join(' ')} ELSE ${AUTHORITY_LEVELS.length + 1} END`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS graph_nodes (
  project_id   TEXT    NOT NULL,
  id           TEXT    NOT NULL,
  type         TEXT    NOT NULL,
  label        TEXT    NOT NULL,
  record_ref   TEXT,
  status       TEXT    NOT NULL,
  attrs        TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  version      INTEGER NOT NULL,
  status_cause TEXT,
  PRIMARY KEY (project_id, id)
) STRICT;

CREATE INDEX IF NOT EXISTS graph_nodes_type_idx ON graph_nodes (project_id, type, status);
CREATE INDEX IF NOT EXISTS graph_nodes_id_idx   ON graph_nodes (id);

CREATE TABLE IF NOT EXISTS graph_edges (
  project_id      TEXT    NOT NULL,
  id              TEXT    NOT NULL,
  type            TEXT    NOT NULL,
  from_id         TEXT    NOT NULL,
  to_id           TEXT    NOT NULL,
  authority       TEXT    NOT NULL,
  evidence_refs   TEXT    NOT NULL,
  weight          REAL,
  status          TEXT    NOT NULL,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  version         INTEGER NOT NULL,
  created_by_cycle TEXT,
  reciprocal_of   TEXT,
  PRIMARY KEY (project_id, id)
) STRICT;

CREATE INDEX IF NOT EXISTS graph_edges_out_idx ON graph_edges (project_id, from_id, type, status);
CREATE INDEX IF NOT EXISTS graph_edges_in_idx  ON graph_edges (project_id, to_id, type, status);
CREATE INDEX IF NOT EXISTS graph_edges_id_idx  ON graph_edges (id);
`;

interface NodeRow {
  readonly project_id: string;
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly record_ref: string | null;
  readonly status: string;
  readonly attrs: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly version: number;
  readonly status_cause: string | null;
}

interface EdgeRow {
  readonly project_id: string;
  readonly id: string;
  readonly type: string;
  readonly from_id: string;
  readonly to_id: string;
  readonly authority: string;
  readonly evidence_refs: string;
  readonly weight: number | null;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly version: number;
  readonly created_by_cycle: string | null;
  readonly reciprocal_of: string | null;
}

export interface SqliteGraphStoreOptions {
  readonly location?: string | undefined;
}

export class SqliteGraphStore implements GraphStore {
  readonly #db: Database;
  #closed = false;

  readonly #insertNode: StatementSync;
  readonly #insertEdge: StatementSync;
  readonly #selectNodeById: StatementSync;
  readonly #selectEdgeById: StatementSync;
  readonly #selectEdgesOf: StatementSync;
  readonly #selectNodesIn: StatementSync;
  readonly #selectEdgesIn: StatementSync;
  readonly #updateNodeStatus: StatementSync;
  readonly #updateEdgeStatus: StatementSync;
  readonly #selectContainsParent: StatementSync;
  readonly #selectReciprocal: StatementSync;

  constructor(options: SqliteGraphStoreOptions = {}) {
    this.#db = new DatabaseSync(options.location ?? ':memory:');
    this.#db.exec('PRAGMA foreign_keys = ON;');
    this.#db.exec(SCHEMA);

    this.#insertNode = this.#db.prepare(
      `INSERT INTO graph_nodes
         (project_id, id, type, label, record_ref, status, attrs, created_at, updated_at, version, status_cause)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    this.#insertEdge = this.#db.prepare(
      `INSERT INTO graph_edges
         (project_id, id, type, from_id, to_id, authority, evidence_refs, weight, status,
          created_at, updated_at, version, created_by_cycle, reciprocal_of)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    this.#selectNodeById = this.#db.prepare('SELECT * FROM graph_nodes WHERE id = ?');
    this.#selectEdgeById = this.#db.prepare('SELECT * FROM graph_edges WHERE id = ?');
    this.#selectEdgesOf = this.#db.prepare(
      'SELECT * FROM graph_edges WHERE project_id = ? AND (from_id = ? OR to_id = ?)',
    );
    this.#selectNodesIn = this.#db.prepare('SELECT * FROM graph_nodes WHERE project_id = ?');
    this.#selectEdgesIn = this.#db.prepare(
      "SELECT * FROM graph_edges WHERE project_id = ? AND status = 'ACTIVE'",
    );
    this.#updateNodeStatus = this.#db.prepare(
      `UPDATE graph_nodes SET status = ?, status_cause = ?, updated_at = ?, version = version + 1
       WHERE project_id = ? AND id = ?`,
    );
    this.#updateEdgeStatus = this.#db.prepare(
      `UPDATE graph_edges SET status = ?, updated_at = ?, version = version + 1
       WHERE project_id = ? AND id = ?`,
    );
    this.#selectContainsParent = this.#db.prepare(
      `SELECT from_id FROM graph_edges
        WHERE project_id = ? AND to_id = ? AND type = 'CONTAINS' AND status = 'ACTIVE' LIMIT 1`,
    );
    this.#selectReciprocal = this.#db.prepare(
      'SELECT id FROM graph_edges WHERE project_id = ? AND type = ? AND from_id = ? AND to_id = ? LIMIT 1',
    );
  }

  #assertOpen(): void {
    if (this.#closed) throw new ValidationError('graph store is closed');
  }

  #toNode(row: NodeRow): GraphNode {
    const parsed = GraphNode.safeParse({
      id: row.id,
      projectId: row.project_id,
      type: row.type,
      label: row.label,
      recordRef: row.record_ref,
      status: row.status,
      attrs: JSON.parse(row.attrs) as unknown,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version,
      statusCause: row.status_cause,
    });
    if (!parsed.success) {
      throw new ValidationError('stored graph node does not satisfy the current schema', {
        id: row.id,
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return parsed.data;
  }

  #toEdge(row: EdgeRow): GraphEdge {
    const parsed = GraphEdge.safeParse({
      id: row.id,
      projectId: row.project_id,
      type: row.type,
      from: row.from_id,
      to: row.to_id,
      authority: row.authority,
      evidenceRefs: JSON.parse(row.evidence_refs) as unknown,
      weight: row.weight,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version,
      createdByCycle: row.created_by_cycle,
      reciprocalOf: row.reciprocal_of,
    });
    if (!parsed.success) {
      throw new ValidationError('stored graph edge does not satisfy the current schema', {
        id: row.id,
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return parsed.data;
  }

  #storeEdge(edge: GraphEdge): void {
    this.#insertEdge.run(
      edge.projectId,
      edge.id,
      edge.type,
      edge.from,
      edge.to,
      edge.authority,
      JSON.stringify(edge.evidenceRefs),
      edge.weight,
      edge.status,
      edge.createdAt,
      edge.updatedAt,
      edge.version,
      edge.createdByCycle,
      edge.reciprocalOf,
    );
  }

  async addNode(
    scope: ProjectScope,
    node: NewNode,
    ctx: GraphWriteContext = {},
  ): Promise<GraphNode> {
    this.#assertOpen();
    const parsed = NewNode.safeParse(node);
    if (!parsed.success) {
      throw new ValidationError('invalid graph node', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const at = (ctx.now ?? ((): Date => new Date()))().toISOString();
    const built = GraphNode.parse({
      id: (ctx.newNodeId ?? newNodeId)(),
      projectId: scope.projectId,
      type: parsed.data.type,
      label: parsed.data.label,
      recordRef: parsed.data.recordRef,
      status: 'ACTIVE',
      attrs: parsed.data.attrs,
      createdAt: at,
      updatedAt: at,
      version: 1,
      statusCause: null,
    });
    this.#insertNode.run(
      built.projectId,
      built.id,
      built.type,
      built.label,
      built.recordRef,
      built.status,
      JSON.stringify(built.attrs),
      built.createdAt,
      built.updatedAt,
      built.version,
      built.statusCause,
    );
    return built;
  }

  /**
   * Does a path already run from `from` to `to` along edges of `type`?
   *
   * Recursive CTE. `project_id` is bound in the recursive term as well as the
   * anchor, so the cycle search cannot wander into another project's edges.
   */
  #hasPath(scope: ProjectScope, from: string, to: string, type: string): boolean {
    const row = this.#db
      .prepare(
        `WITH RECURSIVE reach(node_id) AS (
           SELECT ?
           UNION
           SELECT e.to_id
             FROM reach r
             JOIN graph_edges e
               ON e.project_id = ?
              AND e.status = 'ACTIVE'
              AND e.type = ?
              AND e.from_id = r.node_id
         )
         SELECT 1 AS hit FROM reach WHERE node_id = ? LIMIT 1`,
      )
      .get(from, scope.projectId, type, to) as { hit: number } | undefined;
    return row !== undefined;
  }

  async addEdge(
    scope: ProjectScope,
    edge: NewEdge,
    ctx: GraphWriteContext = {},
  ): Promise<AddEdgeResult> {
    this.#assertOpen();
    const parsed = NewEdge.safeParse(edge);
    if (!parsed.success) {
      throw new ValidationError('invalid graph edge', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const value = parsed.data;

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const fromRow = this.#selectNodeById.get(value.from) as NodeRow | undefined;
      const toRow = this.#selectNodeById.get(value.to) as NodeRow | undefined;
      const from = fromRow === undefined ? null : this.#toNode(fromRow);
      const to = toRow === undefined ? null : this.#toNode(toRow);

      const parentRow =
        value.type === 'CONTAINS'
          ? (this.#selectContainsParent.get(scope.projectId, value.to) as
              | { from_id: string }
              | undefined)
          : undefined;

      const wouldCreateCycle =
        from !== null && to !== null && this.#hasPath(scope, value.to, value.from, value.type);

      const reciprocalExists =
        this.#selectReciprocal.get(scope.projectId, value.type, value.to, value.from) !== undefined;

      const context: EdgeWriteContext = {
        projectId: scope.projectId,
        from,
        to,
        existingContainsParent: (parentRow?.from_id ?? null) as EdgeWriteContext['existingContainsParent'],
        wouldCreateCycle,
        reciprocalExists,
      };

      const violations = checkEdgeWrite(value, context);
      const blocking = rejections(violations);
      if (blocking.length > 0) {
        throw new InvariantViolationError(blocking[0] as (typeof blocking)[number]);
      }

      const at = (ctx.now ?? ((): Date => new Date()))().toISOString();
      const mintEdgeId = ctx.newEdgeId ?? newEdgeId;

      const built = GraphEdge.parse({
        id: mintEdgeId(),
        projectId: scope.projectId,
        type: value.type,
        from: value.from,
        to: value.to,
        authority: value.authority,
        evidenceRefs: value.evidenceRefs,
        weight: value.weight,
        status: 'ACTIVE',
        createdAt: at,
        updatedAt: at,
        version: 1,
        createdByCycle: value.createdByCycle,
        reciprocalOf: null,
      });
      this.#storeEdge(built);

      let reciprocal: GraphEdge | null = null;
      if (needsReciprocal(value.type, { reciprocalExists })) {
        reciprocal = GraphEdge.parse({
          ...built,
          id: mintEdgeId(),
          from: value.to,
          to: value.from,
          reciprocalOf: built.id,
        });
        this.#storeEdge(reciprocal);
      }

      this.#db.exec('COMMIT');
      return {
        edge: built,
        reciprocal,
        observations: violations.filter((v) => v.disposition !== 'REJECT'),
      };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async getNode(scope: ProjectScope, id: NodeId): Promise<GraphNode | null> {
    this.#assertOpen();
    const row = this.#selectNodeById.get(id) as NodeRow | undefined;
    if (row === undefined) return null;
    assertInScope(scope, row.project_id as ProjectScope['projectId'], `graph node ${id}`);
    return this.#toNode(row);
  }

  async getEdge(scope: ProjectScope, id: EdgeId): Promise<GraphEdge | null> {
    this.#assertOpen();
    const row = this.#selectEdgeById.get(id) as EdgeRow | undefined;
    if (row === undefined) return null;
    assertInScope(scope, row.project_id as ProjectScope['projectId'], `graph edge ${id}`);
    return this.#toEdge(row);
  }

  async #requireNode(scope: ProjectScope, id: NodeId): Promise<GraphNode> {
    const node = await this.getNode(scope, id);
    if (node === null) throw new ValidationError(`no graph node ${id}`, { id });
    return node;
  }

  async edgesOf(scope: ProjectScope, id: NodeId): Promise<GraphEdge[]> {
    this.#assertOpen();
    await this.#requireNode(scope, id);
    const rows = this.#selectEdgesOf.all(scope.projectId, id, id) as EdgeRow[];
    return rows.map((row) => this.#toEdge(row));
  }

  async neighbourhood(
    scope: ProjectScope,
    id: NodeId,
    options: NeighbourhoodOptions,
  ): Promise<Subgraph> {
    this.#assertOpen();
    const origin = await this.#requireNode(scope, id);
    const depth = clampDepth(options.depth, DEFAULT_NEIGHBOURHOOD_DEPTH, MAX_TRAVERSAL_DEPTH);
    const limit = clampLimit(options.limit, options.limit);
    const direction = options.direction ?? 'both';

    const typeFilter =
      options.edgeTypes === undefined
        ? ''
        : `AND e.type IN (${options.edgeTypes.map((t) => `'${t}'`).join(',')})`;
    const authorityFilter =
      options.minAuthority === undefined
        ? ''
        : `AND (${AUTHORITY_RANK_CASE}) <= ${AUTHORITY_LEVELS.indexOf(options.minAuthority) + 1}`;

    const outward = direction !== 'in' ? 'e.from_id = w.node_id' : '0';
    const inward = direction !== 'out' ? 'e.to_id = w.node_id' : '0';

    // `project_id = ?` appears on BOTH joins inside the recursive term, so
    // every hop is re-scoped. That is G12 expressed in SQL rather than trusted.
    const rows = this.#db
      .prepare(
        `WITH RECURSIVE walk(node_id, depth) AS (
           SELECT ?, 0
           UNION
           SELECT n.id, w.depth + 1
             FROM walk w
             JOIN graph_edges e
               ON e.project_id = ?
              AND e.status = 'ACTIVE'
              AND (${outward} OR ${inward})
              ${typeFilter}
              ${authorityFilter}
             JOIN graph_nodes n
               ON n.project_id = ?
              AND n.id = CASE WHEN e.from_id = w.node_id THEN e.to_id ELSE e.from_id END
              AND n.status IN ${TRAVERSABLE}
            WHERE w.depth < ?
         )
         SELECT DISTINCT node_id FROM walk`,
      )
      .all(id, scope.projectId, scope.projectId, depth) as { node_id: string }[];

    const reachable = new Set(rows.map((r) => r.node_id));
    reachable.add(origin.id);

    // The limit is applied after reachability so it bounds what is RETURNED
    // rather than silently pruning the walk, which would make the result
    // depend on row order.
    const ordered = [...reachable].sort();
    const truncated = ordered.length > limit;
    const kept = new Set(ordered.slice(0, limit));

    const nodes = (this.#selectNodesIn.all(scope.projectId) as NodeRow[])
      .filter((row) => kept.has(row.id))
      .map((row) => this.#toNode(row));

    const edges = (this.#selectEdgesIn.all(scope.projectId) as EdgeRow[])
      .filter((row) => kept.has(row.from_id) && kept.has(row.to_id))
      .map((row) => this.#toEdge(row))
      .filter(
        (edge) =>
          (options.edgeTypes === undefined || options.edgeTypes.includes(edge.type)) &&
          (options.minAuthority === undefined ||
            AUTHORITY_LEVELS.indexOf(edge.authority) <=
              AUTHORITY_LEVELS.indexOf(options.minAuthority)),
      );

    return { nodes, edges, truncated };
  }

  async impactSet(
    scope: ProjectScope,
    id: NodeId,
    options: ImpactOptions = {},
  ): Promise<ImpactEntry[]> {
    this.#assertOpen();
    await this.#requireNode(scope, id);
    const maxDepth = clampDepth(options.maxDepth, DEFAULT_IMPACT_DEPTH, MAX_IMPACT_DEPTH);
    const limit = clampLimit(options.limit, 1_000);

    const outbound = `'${['AFFECTS'].join("','")}'`;
    const inbound = `'${['DEPENDS_ON', 'CALLS', 'READS', 'WRITES', 'IMPLEMENTS'].join("','")}'`;

    // Impact propagates outward along AFFECTS and inward along the dependency
    // family (SPEC-03 §5.1). `weakest` carries the rank of the least
    // established edge on the path: a chain is only as well established as its
    // weakest step. project_id is bound in both joins of the recursive term.
    const rows = this.#db
      .prepare(
        `WITH RECURSIVE imp(node_id, depth, weakest) AS (
           SELECT ?, 0, 0
           UNION ALL
           SELECT n.id,
                  i.depth + 1,
                  MAX(i.weakest, ${AUTHORITY_RANK_CASE})
             FROM imp i
             JOIN graph_edges e
               ON e.project_id = ?
              AND e.status = 'ACTIVE'
              AND (
                    (e.from_id = i.node_id AND e.type IN (${outbound}))
                 OR (e.to_id   = i.node_id AND e.type IN (${inbound}))
              )
             JOIN graph_nodes n
               ON n.project_id = ?
              AND n.id = CASE WHEN e.from_id = i.node_id THEN e.to_id ELSE e.from_id END
              AND n.status IN ${TRAVERSABLE}
            WHERE i.depth < ?
         )
         SELECT node_id, MIN(depth) AS depth, MIN(weakest) AS weakest
           FROM imp
          WHERE depth > 0 AND node_id <> ?
          GROUP BY node_id`,
      )
      .all(id, scope.projectId, scope.projectId, maxDepth, id) as {
      node_id: string;
      depth: number;
      weakest: number;
    }[];

    // Ranking uses the shared module, so both adapters order identically.
    return rankImpact(
      rows.map((row) => ({
        nodeId: row.node_id as NodeId,
        depth: row.depth,
        weakestAuthorityRank: row.weakest,
      })),
    ).slice(0, limit);
  }

  async paths(
    scope: ProjectScope,
    from: NodeId,
    to: NodeId,
    options: PathOptions,
  ): Promise<GraphPath[]> {
    this.#assertOpen();
    await this.#requireNode(scope, from);
    await this.#requireNode(scope, to);
    const maxDepth = clampDepth(options.maxDepth, MAX_TRAVERSAL_DEPTH, MAX_TRAVERSAL_DEPTH);
    const limit = clampLimit(options.limit, 100);

    const typeFilter =
      options.edgeTypes === undefined
        ? ''
        : `AND e.type IN (${options.edgeTypes.map((t) => `'${t}'`).join(',')})`;

    // Paths accumulate as delimited strings, the standard SQLite technique.
    // `instr(...) = 0` prevents revisiting a node, which both bounds the search
    // and matches the in-memory adapter's "no revisits" rule.
    const rows = this.#db
      .prepare(
        `WITH RECURSIVE p(node_id, path_nodes, path_edges, depth) AS (
           SELECT ?, ?, '', 0
           UNION ALL
           SELECT e.to_id,
                  p.path_nodes || ',' || e.to_id,
                  CASE WHEN p.path_edges = '' THEN e.id ELSE p.path_edges || ',' || e.id END,
                  p.depth + 1
             FROM p
             JOIN graph_edges e
               ON e.project_id = ?
              AND e.status = 'ACTIVE'
              AND e.from_id = p.node_id
              ${typeFilter}
             JOIN graph_nodes n
               ON n.project_id = ?
              AND n.id = e.to_id
              AND n.status IN ${TRAVERSABLE}
            WHERE p.depth < ?
              AND instr(p.path_nodes, e.to_id) = 0
         )
         SELECT path_nodes, path_edges FROM p WHERE node_id = ? AND depth > 0 LIMIT ?`,
      )
      .all(from, from, scope.projectId, scope.projectId, maxDepth, to, limit) as {
      path_nodes: string;
      path_edges: string;
    }[];

    return rows.map((row) => ({
      nodes: row.path_nodes.split(',') as NodeId[],
      edges: row.path_edges === '' ? [] : (row.path_edges.split(',') as EdgeId[]),
    }));
  }

  async findOrphans(
    scope: ProjectScope,
    criteria: OrphanCriteria = {},
  ): Promise<OrphanFinding[]> {
    this.#assertOpen();
    const wanted = criteria.invariants ?? ['G8', 'G9', 'G13'];
    const limit = clampLimit(criteria.limit, 1_000);

    const nodes = (this.#selectNodesIn.all(scope.projectId) as NodeRow[]).map((row) =>
      this.#toNode(row),
    );
    const edges = (this.#selectEdgesIn.all(scope.projectId) as EdgeRow[]).map((row) =>
      this.#toEdge(row),
    );

    const findings: OrphanFinding[] = [];
    for (const node of nodes) {
      if (node.status !== 'ACTIVE') continue;
      if (criteria.nodeTypes !== undefined && !criteria.nodeTypes.includes(node.type)) continue;

      const violations = checkStructuralGaps({
        node,
        inboundTypes: edges.filter((e) => e.to === node.id).map((e) => e.type),
        outboundTypes: edges.filter((e) => e.from === node.id).map((e) => e.type),
      });
      for (const violation of violations) {
        if (!wanted.includes(violation.invariant as 'G8' | 'G9' | 'G13')) continue;
        findings.push({ node, violation });
        if (findings.length >= limit) return findings;
      }
    }
    return findings;
  }

  async transitionNode(
    scope: ProjectScope,
    id: NodeId,
    status: NodeStatus,
    cause: EventId | null,
  ): Promise<GraphNode> {
    this.#assertOpen();
    await this.#requireNode(scope, id);
    this.#updateNodeStatus.run(status, cause, new Date().toISOString(), scope.projectId, id);
    return this.#requireNode(scope, id);
  }

  async transitionEdge(
    scope: ProjectScope,
    id: EdgeId,
    status: EdgeStatus,
    cause: EventId | null,
  ): Promise<GraphEdge> {
    this.#assertOpen();
    const edge = await this.getEdge(scope, id);
    if (edge === null) throw new ValidationError(`no graph edge ${id}`, { id });
    void cause;
    this.#updateEdgeStatus.run(status, new Date().toISOString(), scope.projectId, id);
    const updated = await this.getEdge(scope, id);
    if (updated === null) throw new ValidationError(`no graph edge ${id}`, { id });
    return updated;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
