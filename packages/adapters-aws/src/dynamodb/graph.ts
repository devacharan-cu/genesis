/**
 * The DynamoDB GraphStore adapter (ADR-0024, ADR-0025 §1).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). This is the decision in ADR-0025 §1 made
 * concrete: the graph stays a rebuildable projection served from DynamoDB, and
 * Neptune is admitted only on measured need. It passes the identical
 * `GraphStore` conformance suite the in-memory and SQLite adapters pass, so
 * "swap in Neptune later" is a swap rather than a rewrite.
 *
 * It supplies storage and nothing else. Invariants G1–G13 and every traversal
 * are `GraphEngine`'s, so there is one definition of what an impact set is
 * rather than one per backend.
 *
 * Nodes and edges share one partition per project, because a traversal reads
 * many of both together and a single partition makes that a small number of
 * queries. Edges are additionally indexed from and to, so `edgesOf` and a
 * traversal step are O(degree) rather than O(edges in project).
 */

import type { EdgeId, NodeId, ProjectScope } from '@genesis/core-types';
import { GraphEdge, GraphEngine, GraphNode, type GraphStorage } from '@genesis/graph';
import { ValidationError } from '@genesis/core-types';
import { type DynamoDbClient, type DynamoItem, queryAll } from './client.js';
import {
  EDGE_PREFIX,
  edgeInPk,
  edgeOutPk,
  edgePointerPk,
  edgeSk,
  graphPk,
  NODE_PREFIX,
  nodePointerPk,
  nodeSk,
  POINTER_SK,
} from './schema.js';

export interface DynamoGraphOptions {
  readonly client: DynamoDbClient;
  readonly table: string;
}

const nodeItem = (node: GraphNode): DynamoItem => ({
  pk: graphPk(node.projectId),
  sk: nodeSk(node.id),
  entity: 'GRAPH_NODE',
  node,
});

const edgeItem = (edge: GraphEdge): DynamoItem => ({
  pk: graphPk(edge.projectId),
  sk: edgeSk(edge.id),
  gsi1pk: edgeOutPk(edge.projectId, edge.from),
  gsi1sk: edgeSk(edge.id),
  gsi2pk: edgeInPk(edge.projectId, edge.to),
  gsi2sk: edgeSk(edge.id),
  entity: 'GRAPH_EDGE',
  edge,
});

const pointerItem = (pk: string, projectId: string): DynamoItem => ({
  pk,
  sk: POINTER_SK,
  entity: 'ID_POINTER',
  projectId,
});

/** DynamoDB storage for the shared graph engine. Storage only, no rules. */
export class DynamoGraphStorage implements GraphStorage {
  constructor(private readonly options: DynamoGraphOptions) {}

  #parseNode(item: DynamoItem): GraphNode {
    const parsed = GraphNode.safeParse(item['node']);
    if (!parsed.success) {
      throw new ValidationError('stored graph node does not satisfy the current schema', {
        issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return parsed.data;
  }

  #parseEdge(item: DynamoItem): GraphEdge {
    const parsed = GraphEdge.safeParse(item['edge']);
    if (!parsed.success) {
      throw new ValidationError('stored graph edge does not satisfy the current schema', {
        issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return parsed.data;
  }

  async loadNodes(scope: ProjectScope): Promise<GraphNode[]> {
    const items = await queryAll(this.options.client, this.options.table, {
      keyCondition: '#pk = :pk AND begins_with(#sk, :prefix)',
      names: { '#pk': 'pk', '#sk': 'sk' },
      values: { ':pk': graphPk(scope.projectId), ':prefix': NODE_PREFIX },
      consistentRead: true,
    });
    return items.map((item) => this.#parseNode(item));
  }

  async loadEdges(scope: ProjectScope): Promise<GraphEdge[]> {
    const items = await queryAll(this.options.client, this.options.table, {
      keyCondition: '#pk = :pk AND begins_with(#sk, :prefix)',
      names: { '#pk': 'pk', '#sk': 'sk' },
      values: { ':pk': graphPk(scope.projectId), ':prefix': EDGE_PREFIX },
      consistentRead: true,
    });
    return items.map((item) => this.#parseEdge(item));
  }

  /** The project a pointer names, or null when nothing is filed under that id. */
  async #projectOf(pointerPk: string): Promise<string | null> {
    const pointer = await this.options.client.get(this.options.table, {
      key: { pk: pointerPk, sk: POINTER_SK },
      consistentRead: true,
    });
    return pointer === null ? null : String(pointer['projectId']);
  }

  async getNodeAnywhere(id: NodeId): Promise<GraphNode | null> {
    const projectId = await this.#projectOf(nodePointerPk(id));
    if (projectId === null) return null;
    const item = await this.options.client.get(this.options.table, {
      key: { pk: graphPk(projectId), sk: nodeSk(id) },
      consistentRead: true,
    });
    return item === null ? null : this.#parseNode(item);
  }

  async getEdgeAnywhere(id: EdgeId): Promise<GraphEdge | null> {
    const projectId = await this.#projectOf(edgePointerPk(id));
    if (projectId === null) return null;
    const item = await this.options.client.get(this.options.table, {
      key: { pk: graphPk(projectId), sk: edgeSk(id) },
      consistentRead: true,
    });
    return item === null ? null : this.#parseEdge(item);
  }

  async putNode(_scope: ProjectScope, node: GraphNode): Promise<void> {
    // The node and its pointer land together: a node without one would be
    // invisible to `getNode`, and a pointer without one would name nothing.
    await this.options.client.transactWrite(this.options.table, [
      { kind: 'Put', request: { item: nodeItem(node) } },
      { kind: 'Put', request: { item: pointerItem(nodePointerPk(node.id), node.projectId) } },
    ]);
  }

  async putEdge(_scope: ProjectScope, edge: GraphEdge): Promise<void> {
    await this.options.client.transactWrite(this.options.table, [
      { kind: 'Put', request: { item: edgeItem(edge) } },
      { kind: 'Put', request: { item: pointerItem(edgePointerPk(edge.id), edge.projectId) } },
    ]);
  }

  async close(): Promise<void> {
    // The client is shared across adapters, so it is the composition root's to
    // close. Closing it here would shut the ledger down with the graph.
  }
}

/**
 * Edges touching a node, read through the two edge indexes.
 *
 * The engine's `edgesOf` loads the project's edges, which is correct and is
 * what the conformance suite proves. This is the indexed path the same answer
 * comes from at scale, exported so the traversal cost claimed in ADR-0025 §1 is
 * something callable rather than something asserted.
 */
export async function edgesTouching(
  options: DynamoGraphOptions,
  scope: ProjectScope,
  id: NodeId,
): Promise<GraphEdge[]> {
  const [out, incoming] = await Promise.all([
    queryAll(options.client, options.table, {
      index: 'gsi1',
      keyCondition: '#pk = :pk',
      names: { '#pk': 'gsi1pk' },
      values: { ':pk': edgeOutPk(scope.projectId, id) },
    }),
    queryAll(options.client, options.table, {
      index: 'gsi2',
      keyCondition: '#pk = :pk',
      names: { '#pk': 'gsi2pk' },
      values: { ':pk': edgeInPk(scope.projectId, id) },
    }),
  ]);
  const byId = new Map<string, GraphEdge>();
  for (const item of [...out, ...incoming]) {
    const edge = GraphEdge.parse(item['edge']);
    byId.set(edge.id, edge);
  }
  return [...byId.values()];
}

/** The `GraphStore` a deployment wires in: the shared engine over DynamoDB. */
export const dynamoGraphStore = (options: DynamoGraphOptions): GraphEngine =>
  new GraphEngine(new DynamoGraphStorage(options));
