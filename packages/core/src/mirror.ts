/**
 * The graph mirror of cognitive records (ADR-0016, ADR-0018 §4).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). The graph is where impact analysis and
 * traversal look; if a cognitive record there disagreed with the ledger, the
 * system would reason over a fact that was never committed.
 *
 * So the mirror is split in two:
 *
 *   `mirrorOf(projectId, state)` — PURE. The nodes and edges a cognition state
 *   implies, with ids derived from the project and record ids. Same state,
 *   same graph, on any machine.
 *
 *   `GraphMirror.reconcile(scope, state)` — idempotent writes that bring the
 *   graph to `mirrorOf`. It adds what is missing and transitions statuses that
 *   differ. It never deletes, never reads a fact from the graph to decide
 *   anything, and refuses — MirrorDivergenceError — when a node or edge under a
 *   mirror id is not what the record says it is: something other than the
 *   mirror wrote it, and overwriting would hide that.
 *
 * The canonical state is the input; the graph is the output. That is what
 * makes the graph rebuildable: drop it, reconcile a replayed state, and the
 * same structure comes back.
 */

import { createHash } from 'node:crypto';
import {
  actionAuthority,
  type CognitionState,
  isTerminalGoal,
  isTerminalQuestion,
  isTerminalUncertainty,
  type RecordedBy,
  sortById,
} from '@genesis/cognition';
import {
  type Authority,
  EdgeId,
  type EdgeType,
  MirrorDivergenceError,
  NodeId,
  type NodeType,
  type ProjectScope,
} from '@genesis/core-types';
import type { EdgeStatus, GraphEdge, GraphNode, GraphStore, NodeStatus } from '@genesis/graph';
import { canonicalJson } from '@genesis/ledger';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A ULID-shaped id derived from a key: the first 128 bits of its SHA-256, in
 * Crockford base 32. Deterministic, and scoped by the project so the same
 * record id in two projects never names the same graph element.
 */
function derivedUlid(key: string): string {
  let n = BigInt(`0x${createHash('sha256').update(key).digest('hex').slice(0, 32)}`);
  let out = '';
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD.charAt(Number(n % 32n)) + out;
    n /= 32n;
  }
  return out;
}

export const mirrorNodeId = (projectId: string, recordId: string): NodeId =>
  NodeId.parse(`node_${derivedUlid(`${projectId}|node|${recordId}`)}`);

export const mirrorEdgeId = (projectId: string, key: string): EdgeId =>
  EdgeId.parse(`edge_${derivedUlid(`${projectId}|edge|${key}`)}`);

export type MirroredRecordKind = 'GOAL' | 'BELIEF' | 'UNCERTAINTY' | 'QUESTION';

export interface MirroredNode {
  readonly id: NodeId;
  readonly type: NodeType;
  readonly label: string;
  readonly status: NodeStatus;
  readonly attrs: { readonly mirrorOf: 'cognition'; readonly recordKind: MirroredRecordKind; readonly recordId: string };
}

export interface MirroredEdge {
  readonly id: EdgeId;
  /** The id the store gives the reciprocal of a symmetric edge (G4). */
  readonly reciprocalId: EdgeId;
  readonly type: EdgeType;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly authority: Authority;
  readonly status: EdgeStatus;
}

export interface MirrorPlan {
  readonly nodes: readonly MirroredNode[];
  readonly edges: readonly MirroredEdge[];
}

/** An edge between records is as established as the act of the one who made the link. */
const madeBy = (by: RecordedBy): Authority => actionAuthority({ kind: by.actorKind, id: by.actorId });

const byRecordId = <T extends { readonly id: string }>(records: Record<string, T>): T[] => sortById(Object.values(records));

/** The graph a cognition state implies. Pure. */
export function mirrorOf(projectId: string, state: CognitionState): MirrorPlan {
  const node = (recordKind: MirroredRecordKind, type: NodeType, recordId: string, label: string, status: NodeStatus): MirroredNode => ({
    id: mirrorNodeId(projectId, recordId),
    type,
    label,
    status,
    attrs: { mirrorOf: 'cognition', recordKind, recordId },
  });
  const edge = (type: EdgeType, from: string, to: string, authority: Authority, status: EdgeStatus): MirroredEdge => {
    const key = `${type}|${from}|${to}`;
    return {
      id: mirrorEdgeId(projectId, key),
      reciprocalId: mirrorEdgeId(projectId, `${key}|reciprocal`),
      type,
      from: mirrorNodeId(projectId, from),
      to: mirrorNodeId(projectId, to),
      authority,
      status,
    };
  };

  const goals = byRecordId(state.goals);
  const beliefs = byRecordId(state.beliefs);
  const uncertainties = byRecordId(state.uncertainties);
  const questions = byRecordId(state.questions);

  const nodes: MirroredNode[] = [
    ...goals.map((g) => node('GOAL', 'GOAL', g.id, g.description, isTerminalGoal(g.status) ? 'ARCHIVED' : 'ACTIVE')),
    ...beliefs.map((b) => node('BELIEF', 'BELIEF', b.id, b.statement, b.supersededBy.length > 0 ? 'SUPERSEDED' : 'ACTIVE')),
    ...uncertainties.map((u) =>
      node('UNCERTAINTY', 'UNCERTAINTY', u.id, u.statement, isTerminalUncertainty(u.status) ? 'ARCHIVED' : 'ACTIVE'),
    ),
    ...questions.map((q) => node('QUESTION', 'QUESTION', q.id, q.text, isTerminalQuestion(q.status) ? 'ARCHIVED' : 'ACTIVE')),
  ];

  const edges: MirroredEdge[] = [
    // A parent goal requires its children.
    ...goals.flatMap((g) => (g.parentId === null ? [] : [edge('REQUIRES', g.parentId, g.id, madeBy(g.createdBy), 'ACTIVE')])),
    // An uncertainty blocks its goals while it is open; the edge is retracted when it closes.
    ...uncertainties.flatMap((u) =>
      u.blocksGoalIds.map((goalId) =>
        edge('BLOCKS', u.id, goalId, madeBy(u.openedBy), isTerminalUncertainty(u.status) ? 'RETRACTED' : 'ACTIVE'),
      ),
    ),
    // Two beliefs in contradiction. A side that is not a belief has no node to link.
    ...byRecordId(state.contradictions).flatMap((c) => {
      const [a, b] = c.sides;
      return a.ref.kind === 'BELIEF' && b.ref.kind === 'BELIEF'
        ? [edge('CONTRADICTS', a.ref.id, b.ref.id, madeBy(c.detectedBy), 'ACTIVE')]
        : [];
    }),
    // A question is asked because of its uncertainty.
    ...questions.map((q) => edge('DERIVED_FROM', q.id, q.uncertaintyId, madeBy(q.createdBy), 'ACTIVE')),
  ];

  return { nodes, edges };
}

export interface MirrorReport {
  readonly nodesAdded: number;
  readonly nodesTransitioned: number;
  readonly edgesAdded: number;
  readonly edgesTransitioned: number;
}

export interface GraphMirrorOptions {
  /** The time recorded on graph writes. The graph's clock, not the records'. */
  readonly now?: () => Date;
}

export class GraphMirror {
  readonly #graph: GraphStore;
  readonly #now: () => Date;

  constructor(graph: GraphStore, options: GraphMirrorOptions = {}) {
    this.#graph = graph;
    this.#now = options.now ?? ((): Date => new Date());
  }

  /** Brings the graph to what `state` implies. Idempotent. */
  async reconcile(scope: ProjectScope, state: CognitionState): Promise<MirrorReport> {
    const plan = mirrorOf(scope.projectId, state);
    let nodesAdded = 0;
    let nodesTransitioned = 0;
    let edgesAdded = 0;
    let edgesTransitioned = 0;

    // Nodes first: an edge needs both of its endpoints.
    for (const wanted of plan.nodes) {
      const existing = await this.#graph.getNode(scope, wanted.id);
      if (existing === null) {
        await this.#graph.addNode(
          scope,
          { type: wanted.type, label: wanted.label, attrs: { ...wanted.attrs } },
          { newNodeId: () => wanted.id, now: this.#now },
        );
        nodesAdded += 1;
      } else {
        assertSameNode(existing, wanted);
      }
      if ((existing?.status ?? 'ACTIVE') !== wanted.status) {
        await this.#graph.transitionNode(scope, wanted.id, wanted.status, null);
        nodesTransitioned += 1;
      }
    }

    for (const wanted of plan.edges) {
      const existing = await this.#graph.getEdge(scope, wanted.id);
      if (existing === null) {
        // The store mints a second id for the reciprocal of a symmetric edge.
        let minted = 0;
        await this.#graph.addEdge(
          scope,
          { type: wanted.type, from: wanted.from, to: wanted.to, authority: wanted.authority },
          { newEdgeId: () => (minted++ === 0 ? wanted.id : wanted.reciprocalId), now: this.#now },
        );
        edgesAdded += 1;
      } else {
        assertSameEdge(existing, wanted);
      }
      if ((existing?.status ?? 'ACTIVE') !== wanted.status) {
        await this.#graph.transitionEdge(scope, wanted.id, wanted.status, null);
        edgesTransitioned += 1;
      }
    }

    return { nodesAdded, nodesTransitioned, edgesAdded, edgesTransitioned };
  }
}

function assertSameNode(existing: GraphNode, wanted: MirroredNode): void {
  if (
    existing.type !== wanted.type ||
    existing.label !== wanted.label ||
    canonicalJson(existing.attrs) !== canonicalJson(wanted.attrs)
  ) {
    throw new MirrorDivergenceError(`graph node ${wanted.id} does not match ${wanted.attrs.recordKind} ${wanted.attrs.recordId}`, {
      nodeId: wanted.id,
      recordId: wanted.attrs.recordId,
    });
  }
}

function assertSameEdge(existing: GraphEdge, wanted: MirroredEdge): void {
  if (
    existing.type !== wanted.type ||
    existing.from !== wanted.from ||
    existing.to !== wanted.to ||
    existing.authority !== wanted.authority
  ) {
    throw new MirrorDivergenceError(`graph edge ${wanted.id} does not match the ${wanted.type} it mirrors`, {
      edgeId: wanted.id,
    });
  }
}
