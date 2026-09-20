/**
 * Impact leases, and the staleness they exist to detect.
 *
 * Nothing contends for a lease today, because stages are serialised. The
 * staleness path is therefore exercised deliberately — by appending an event
 * that touches a leased node between the lease and its check — so it is tested
 * even though nothing in production provokes it (ADR-0021 mitigations).
 */

import { newNodeId, newProjectId, projectScope, type ProjectScope } from '@genesis/core-types';
import { InMemoryGraphStore } from '@genesis/graph';
import { InMemoryEventLedger } from '@genesis/ledger';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkLease, leasePayload, leasesOverlap, takeLease } from '../src/leases.js';

let ledger: InMemoryEventLedger;
let graph: InMemoryGraphStore;
let scope: ProjectScope;

beforeEach(() => {
  ledger = new InMemoryEventLedger();
  graph = new InMemoryGraphStore();
  scope = projectScope(newProjectId());
});

const source = () => ({ graph, ledger });

/** An event about a node, which is what can invalidate a lease. */
const touch = (nodeId: string) =>
  ledger.append(scope, {
    type: 'COMPONENT_CHANGED',
    actor: { kind: 'SYSTEM', id: 'test' },
    authority: 'VERIFIED_SYSTEM_STATE',
    subject: { nodeType: 'COMPONENT', nodeId },
    payload: null,
  });

/** An event about nothing in particular, which cannot. */
const noise = () =>
  ledger.append(scope, {
    type: 'TASK_STARTED',
    actor: { kind: 'SYSTEM', id: 'test' },
    authority: 'VERIFIED_SYSTEM_STATE',
    payload: { taskId: 'task_x' },
  });

describe('taking a lease', () => {
  it('records where the ledger stood', async () => {
    await noise();
    await noise();
    const lease = await takeLease(source(), scope, []);
    expect(lease.asOfSeq).toBe(2);
  });

  it('covers the origin and everything the graph says it affects', async () => {
    const a = await graph.addNode(scope, { type: 'COMPONENT', label: 'a' });
    const b = await graph.addNode(scope, { type: 'COMPONENT', label: 'b' });
    await graph.addEdge(scope, { type: 'DEPENDS_ON', from: b.id, to: a.id, authority: 'EVIDENCE' });
    const lease = await takeLease(source(), scope, [a.id]);
    expect(lease.nodes).toContain(a.id);
    expect(lease.nodes).toContain(b.id);
  });

  it('is sorted, so two runs over the same graph produce the same lease', async () => {
    const a = await graph.addNode(scope, { type: 'COMPONENT', label: 'a' });
    const b = await graph.addNode(scope, { type: 'COMPONENT', label: 'b' });
    await graph.addEdge(scope, { type: 'DEPENDS_ON', from: b.id, to: a.id, authority: 'EVIDENCE' });
    const first = await takeLease(source(), scope, [a.id]);
    const second = await takeLease(source(), scope, [a.id]);
    expect(first).toEqual(second);
    expect([...first.nodes]).toEqual([...first.nodes].sort());
  });

  it('with no origins is empty, which is the honest answer', async () => {
    const lease = await takeLease(source(), scope, []);
    expect(lease.nodes).toEqual([]);
    expect(lease.origins).toEqual([]);
  });

  it('serialises to what goes on the ledger', async () => {
    const lease = await takeLease(source(), scope, []);
    expect(leasePayload(lease)).toEqual({ nodes: [], asOfSeq: 0, origins: [] });
  });
});

describe('staleness', () => {
  it('an empty lease is never stale: it is about nothing', async () => {
    const lease = await takeLease(source(), scope, []);
    await touch(newNodeId());
    expect(await checkLease(ledger, scope, lease)).toEqual({ stale: false });
  });

  it('a lease is not stale when nothing has happened', async () => {
    const a = await graph.addNode(scope, { type: 'COMPONENT', label: 'a' });
    const lease = await takeLease(source(), scope, [a.id]);
    expect(await checkLease(ledger, scope, lease)).toEqual({ stale: false });
  });

  it('a lease is not stale when what happened touched nothing it covers', async () => {
    const a = await graph.addNode(scope, { type: 'COMPONENT', label: 'a' });
    const lease = await takeLease(source(), scope, [a.id]);
    await touch(newNodeId());
    await noise();
    expect(await checkLease(ledger, scope, lease)).toEqual({ stale: false });
  });

  it('a lease is stale when a leased node was touched, and says which', async () => {
    const a = await graph.addNode(scope, { type: 'COMPONENT', label: 'a' });
    const lease = await takeLease(source(), scope, [a.id]);
    await touch(a.id);
    const checked = await checkLease(ledger, scope, lease);
    expect(checked.stale).toBe(true);
    if (!checked.stale) return;
    expect(checked.touched).toEqual([a.id]);
    expect(checked.reason).toContain('1 leased node');
  });

  it('an event with no subject cannot invalidate a lease', async () => {
    const a = await graph.addNode(scope, { type: 'COMPONENT', label: 'a' });
    const lease = await takeLease(source(), scope, [a.id]);
    await noise();
    expect((await checkLease(ledger, scope, lease)).stale).toBe(false);
  });

  it('staleness reads only what happened after the lease', async () => {
    const a = await graph.addNode(scope, { type: 'COMPONENT', label: 'a' });
    // Touched BEFORE the lease: the stage read the world as it already was.
    await touch(a.id);
    const lease = await takeLease(source(), scope, [a.id]);
    expect((await checkLease(ledger, scope, lease)).stale).toBe(false);
  });

  it('reports every touched node, sorted', async () => {
    const a = await graph.addNode(scope, { type: 'COMPONENT', label: 'a' });
    const b = await graph.addNode(scope, { type: 'COMPONENT', label: 'b' });
    await graph.addEdge(scope, { type: 'DEPENDS_ON', from: b.id, to: a.id, authority: 'EVIDENCE' });
    const lease = await takeLease(source(), scope, [a.id]);
    await touch(b.id);
    await touch(a.id);
    const checked = await checkLease(ledger, scope, lease);
    if (!checked.stale) throw new Error('expected staleness');
    expect([...checked.touched]).toEqual([...checked.touched].sort());
    expect(checked.touched).toHaveLength(2);
  });
});

describe('overlap, the seam concurrency would use', () => {
  it('is empty for leases about different things', async () => {
    const a = await graph.addNode(scope, { type: 'COMPONENT', label: 'a' });
    const b = await graph.addNode(scope, { type: 'COMPONENT', label: 'b' });
    const first = await takeLease(source(), scope, [a.id]);
    const second = await takeLease(source(), scope, [b.id]);
    expect(leasesOverlap(first, second)).toEqual([]);
  });

  it('names the shared nodes when two leases touch the same region', async () => {
    const a = await graph.addNode(scope, { type: 'COMPONENT', label: 'a' });
    const b = await graph.addNode(scope, { type: 'COMPONENT', label: 'b' });
    await graph.addEdge(scope, { type: 'DEPENDS_ON', from: b.id, to: a.id, authority: 'EVIDENCE' });
    const first = await takeLease(source(), scope, [a.id]);
    const second = await takeLease(source(), scope, [b.id]);
    // b depends on a, so a change to a reaches b: the leases share b.
    expect(leasesOverlap(first, second)).toContain(b.id);
  });

  it('is symmetric', async () => {
    const a = await graph.addNode(scope, { type: 'COMPONENT', label: 'a' });
    const first = await takeLease(source(), scope, [a.id]);
    const second = await takeLease(source(), scope, [a.id]);
    expect(leasesOverlap(first, second)).toEqual(leasesOverlap(second, first));
  });
});

describe('project isolation', () => {
  it('a lease in one project is not disturbed by another project', async () => {
    const other = projectScope(newProjectId());
    const a = await graph.addNode(scope, { type: 'COMPONENT', label: 'a' });
    const lease = await takeLease(source(), scope, [a.id]);
    await ledger.append(other, {
      type: 'COMPONENT_CHANGED',
      actor: { kind: 'SYSTEM', id: 'test' },
      authority: 'VERIFIED_SYSTEM_STATE',
      subject: { nodeType: 'COMPONENT', nodeId: a.id },
      payload: null,
    });
    expect((await checkLease(ledger, scope, lease)).stale).toBe(false);
  });
});
