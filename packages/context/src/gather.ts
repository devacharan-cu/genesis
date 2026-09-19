/**
 * Gathering candidates from the stores (SPEC-01 §11.1, ADR-0017 rule 3).
 *
 * The one part of this package that reads a store, and it can do nothing else:
 * it takes narrow, read-only views of the memory and graph ports — `query`,
 * `getNode`, `impactSet` — not the ports themselves, so no code path here can
 * write, even by mistake.
 *
 * Cognitive state and the self model are passed in rather than read: they are
 * projections the caller already holds, caught up to a known ledger position.
 */

import type { CognitionState } from '@genesis/cognition';
import { type ProjectScope, ValidationError } from '@genesis/core-types';
import { type GraphNode, type GraphStore, type ImpactEntry, rankImpact } from '@genesis/graph';
import type { MemoryRecord, MemoryStore } from '@genesis/memory';
import type { SelfModelState } from '@genesis/projections';
import {
  type ApplicablePolicy,
  cognitionCandidates,
  graphCandidates,
  knownFailureCandidates,
  memoryCandidates,
  policyCandidates,
} from './candidates.js';
import { type ContextCandidate, ContextRequest, parseOrRefuse } from './model.js';

/** What the gatherer may do with the stores: read, and only read. */
export interface ContextSources {
  readonly memory: Pick<MemoryStore, 'query'>;
  readonly graph: Pick<GraphStore, 'getNode' | 'impactSet'>;
}

export interface GatherInput {
  readonly cognition: CognitionState;
  readonly selfModel: SelfModelState;
  readonly policies?: readonly ApplicablePolicy[];
  /** How far impact is followed from each task node. Defaults to the graph's own default. */
  readonly impactDepth?: number;
  /** At most this many memory records per node. Default 20. */
  readonly memoryPerNode?: number;
}

export interface GatheredContext {
  readonly candidates: readonly ContextCandidate[];
  /** The impact set used, recorded so the context is explainable later (ADR-0016 rule 5). */
  readonly impact: readonly ImpactEntry[];
}

/**
 * Collects every candidate for a task: cognition, matching known failures,
 * applicable policies, the task's graph impact set, and the memory records
 * related to the task's nodes and their impact set, as of the request's time.
 */
export async function gatherCandidates(
  sources: ContextSources,
  scope: ProjectScope,
  request: ContextRequest,
  input: GatherInput,
): Promise<GatheredContext> {
  const req = parseOrRefuse(ContextRequest, request, 'context request');
  const impactOptions = input.impactDepth === undefined ? {} : { maxDepth: input.impactDepth };
  const taskNodeIds = [...new Set(req.task.nodeIds)].sort();

  // A node the graph does not hold is refused, not skipped: a task about a
  // node nobody recorded is the caller's bug, and a context silently missing
  // it would hide that.
  const nodeOf = async (id: string): Promise<GraphNode> => {
    const node = await sources.graph.getNode(scope, id as GraphNode['id']);
    if (node === null) throw new ValidationError(`the graph holds no node ${id}`, { nodeId: id });
    return node;
  };
  const taskNodes = await Promise.all(taskNodeIds.map(nodeOf));

  // The impact set of every task node, merged: nearest depth wins, then ranked
  // the graph's own way so the recorded set has a stable order.
  const merged = new Map<string, ImpactEntry>();
  for (const node of taskNodes) {
    for (const entry of await sources.graph.impactSet(scope, node.id, impactOptions)) {
      const known = merged.get(entry.nodeId);
      if (known === undefined || entry.depth < known.depth) merged.set(entry.nodeId, entry);
    }
  }
  const impact = rankImpact([...merged.values()].filter((e) => !taskNodeIds.includes(e.nodeId)));
  const nodes = [...taskNodes, ...(await Promise.all(impact.map((e) => nodeOf(e.nodeId))))];

  const records = new Map<string, MemoryRecord>();
  for (const node of nodes) {
    const page = await sources.memory.query(scope, {
      relatedEntity: { nodeType: node.type, nodeId: node.id },
      validAt: req.asOf,
      limit: input.memoryPerNode ?? 20,
    });
    for (const record of page.items) records.set(record.id, record);
  }

  return {
    candidates: [
      ...policyCandidates(input.policies ?? []),
      ...cognitionCandidates(input.cognition, req, impact),
      ...knownFailureCandidates(input.selfModel, req),
      ...graphCandidates(nodes, impact),
      ...memoryCandidates([...records.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), req, impact),
    ],
    impact,
  };
}
