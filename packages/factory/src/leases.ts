/**
 * Impact leases: what a stage's work depended on, and whether that still holds
 * (ADR-0021 §2).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). A stage reaches a conclusion about a world.
 * A lease records which part of that world it read and where the ledger stood
 * when it read it, so "was this conclusion reached against a world that still
 * holds?" is a comparison rather than an assumption.
 *
 * A lease is deliberately **not** a lock. Nothing contends for one today,
 * because one project runs one stage at a time. It exists because staleness is
 * the failure that would otherwise be silent, and because admission control
 * over leases is the seam concurrency would use — a data structure that already
 * exists rather than a redesign.
 */

import { type NodeId, type ProjectScope } from '@genesis/core-types';
import type { GraphStore } from '@genesis/graph';
import type { EventLedger } from '@genesis/ledger';

export interface ImpactLease {
  /** The nodes this stage's work depends on, ranked by the graph's own order. */
  readonly nodes: readonly string[];
  /** Where the ledger stood when the lease was taken. */
  readonly asOfSeq: number;
  /** The nodes the lease was computed from. */
  readonly origins: readonly string[];
}

export interface LeaseSource {
  readonly graph: Pick<GraphStore, 'impactSet'>;
  readonly ledger: Pick<EventLedger, 'count'>;
}

/**
 * Computes a lease over the nodes a change touches.
 *
 * The impact set is the core's, from the graph, ranked by the graph's own
 * stable ordering — never a claim an agent made about what it affects
 * (SPEC-05 §3.2). With no origins the lease is empty and cannot go stale, which
 * is the honest answer for a stage that depends on no recorded node.
 */
export async function takeLease(
  source: LeaseSource,
  scope: ProjectScope,
  origins: readonly string[],
): Promise<ImpactLease> {
  const asOfSeq = await source.ledger.count(scope);
  const nodes = new Set<string>();
  for (const origin of origins) {
    nodes.add(origin);
    for (const entry of await source.graph.impactSet(scope, origin as NodeId)) {
      nodes.add(entry.nodeId);
    }
  }
  // Sorted, so two runs over the same graph produce the same lease and a
  // recorded lease can be compared across replays.
  return { nodes: [...nodes].sort(), asOfSeq, origins: [...origins].sort() };
}

export type Staleness =
  | { readonly stale: false }
  | { readonly stale: true; readonly reason: string; readonly touched: readonly string[] };

/**
 * Whether anything appended since the lease touched a node the lease covers.
 *
 * Events name the nodes they concern in `subject.nodeId`, so an event with no
 * subject cannot invalidate a lease — it changed nothing the lease is about.
 * An empty lease is never stale, for the same reason.
 */
export async function checkLease(
  ledger: Pick<EventLedger, 'read'>,
  scope: ProjectScope,
  lease: ImpactLease,
): Promise<Staleness> {
  if (lease.nodes.length === 0) return { stale: false };
  const since = await ledger.read(scope, { fromSeq: lease.asOfSeq + 1 });
  const covered = new Set(lease.nodes);
  const touched = new Set<string>();
  for (const event of since) {
    const nodeId = event.subject?.nodeId;
    if (nodeId !== undefined && covered.has(nodeId)) touched.add(nodeId);
  }
  if (touched.size === 0) return { stale: false };
  const nodes = [...touched].sort();
  return {
    stale: true,
    reason: `the ledger moved from ${lease.asOfSeq} and touched ${nodes.length} leased node(s): ${nodes.slice(0, 5).join(', ')}`,
    touched: nodes,
  };
}

/**
 * Whether two leases overlap.
 *
 * Nothing calls this in anger today, because stages are serialised. It is the
 * admission test concurrency would need, written and tested now so that the
 * decision to allow concurrency is about policy rather than about writing this
 * (ADR-0021 §4).
 */
export function leasesOverlap(a: ImpactLease, b: ImpactLease): readonly string[] {
  const other = new Set(b.nodes);
  return a.nodes.filter((node) => other.has(node));
}

/** A lease as it goes on the ledger. */
export const leasePayload = (lease: ImpactLease): Record<string, unknown> => ({
  nodes: [...lease.nodes],
  asOfSeq: lease.asOfSeq,
  origins: [...lease.origins],
});
