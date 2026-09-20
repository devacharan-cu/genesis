/**
 * The ledger fan-out (ADR-0025 §4).
 *
 * Two properties matter here, and neither is "the bus works". The first is that
 * a payload never leaves the ledger: what goes on the bus is coordinates, so a
 * consumer reads history from the system of record under the ledger's own
 * access control. The second is that publication cannot fail an append: the
 * event is already durable and already the truth before anything is published.
 */

import { newProjectId, projectScope } from '@genesis/core-types';
import { buildEvent } from '@genesis/ledger';
import { describe, expect, it } from 'vitest';
import {
  EventBusModel,
  type EventBusEntry,
  entryFor,
  GENESIS_EVENT_SOURCE,
  LedgerEventPublisher,
  MAX_ENTRIES_PER_PUT,
} from '../src/eventbridge.js';

const BUS_ARN = 'arn:aws:events:eu-west-1:123456789012:event-bus/genesis';
const scope = projectScope(newProjectId());

const events = (count: number, overrides: Record<string, unknown> = {}) => {
  const built = [];
  let head = null;
  for (let i = 0; i < count; i += 1) {
    const event = buildEvent(
      scope,
      {
        type: 'OBSERVATION_RECORDED',
        actor: { kind: 'AGENT', id: 'agt-1', agentRole: 'Researcher' },
        authority: 'EVIDENCE',
        after: { secret: 'the payload nobody should see on a bus' },
        ...overrides,
      },
      head,
      { now: () => new Date('2026-09-20T12:00:00.000Z') },
    );
    built.push(event);
    head = { seq: event.seq, hash: event.payloadHash };
  }
  return built;
};

const publisher = (client: EventBusModel, onFailure?: (failed: number, entries: readonly EventBusEntry[]) => void) =>
  new LedgerEventPublisher({ client, busName: 'genesis', onFailure });

describe('what goes on the bus', () => {
  it('carries the coordinates of an event, not its payload', () => {
    const [event] = events(1);
    const entry = entryFor(event!, BUS_ARN);
    expect(entry.source).toBe(GENESIS_EVENT_SOURCE);
    expect(entry.detailType).toBe('OBSERVATION_RECORDED');
    expect(entry.resources).toEqual([BUS_ARN]);
    expect(JSON.parse(entry.detail)).toEqual({
      projectId: scope.projectId,
      seq: 1,
      eventId: event!.id,
      type: 'OBSERVATION_RECORDED',
      actorKind: 'AGENT',
      authority: 'EVIDENCE',
      cycleId: event!.cycleId,
      timestamp: event!.timestamp,
    });
  });

  it('never copies the event body onto the bus', () => {
    const [event] = events(1);
    const entry = entryFor(event!, BUS_ARN);
    expect(entry.detail).not.toContain('the payload nobody should see on a bus');
    expect(entry.detail).not.toContain('secret');
    // The hash stays behind too: it is only meaningful against the chain it
    // belongs to, and a consumer reads that from the ledger.
    expect(entry.detail).not.toContain(event!.payloadHash);
  });

  it('names the project, so a rule can be scoped to one', () => {
    const [event] = events(1);
    expect(JSON.parse(entryFor(event!, BUS_ARN).detail).projectId).toBe(scope.projectId);
  });

  it('routes on the event type, so a consumer subscribes to what it cares about', () => {
    const [human] = events(1, {
      type: 'REQUIREMENT_CHANGED',
      actor: { kind: 'HUMAN', id: 'dev' },
      authority: 'HUMAN_DECISION',
    });
    const entry = entryFor(human!, BUS_ARN);
    expect(entry.detailType).toBe('REQUIREMENT_CHANGED');
    expect(JSON.parse(entry.detail).actorKind).toBe('HUMAN');
    expect(JSON.parse(entry.detail).authority).toBe('HUMAN_DECISION');
  });
});

describe('publishing', () => {
  it('publishes every event of a batch', async () => {
    const bus = new EventBusModel();
    expect(await publisher(bus).publish(events(3), BUS_ARN)).toBe(0);
    expect(bus.published).toHaveLength(3);
    expect(bus.published.map((e) => JSON.parse(e.detail).seq)).toEqual([1, 2, 3]);
  });

  it('does not call the failure handler when nothing failed', async () => {
    let called = false;
    const bus = new EventBusModel();
    await publisher(bus, () => {
      called = true;
    }).publish(events(3), BUS_ARN);
    expect(called).toBe(false);
    expect(bus.published).toHaveLength(3);
  });

  it('publishes nothing for an empty batch, rather than an empty call', async () => {
    const bus = new EventBusModel();
    expect(await publisher(bus).publish([], BUS_ARN)).toBe(0);
    expect(bus.published).toEqual([]);
  });

  it('chunks to the service’s own cap', async () => {
    const calls: number[] = [];
    const counting = new (class extends EventBusModel {
      override async putEvents(name: string, entries: readonly EventBusEntry[]): Promise<number> {
        calls.push(entries.length);
        return super.putEvents(name, entries);
      }
    })();
    await publisher(counting).publish(events(23), BUS_ARN);
    expect(calls).toEqual([MAX_ENTRIES_PER_PUT, MAX_ENTRIES_PER_PUT, 3]);
    expect(counting.published).toHaveLength(23);
  });
});

describe('when the bus will not take them', () => {
  it('reports refused entries rather than throwing, because the append already happened', async () => {
    const bus = new EventBusModel(2);
    const refused = await publisher(bus).publish(events(5), BUS_ARN);
    expect(refused).toBe(2);
    expect(bus.published).toHaveLength(3);
  });

  it('reports an unreachable bus as a whole chunk refused, not as a failure', async () => {
    const bus = new EventBusModel(0, true);
    await expect(publisher(bus).publish(events(4), BUS_ARN)).resolves.toBe(4);
  });

  it('tells the caller what was not published, so it can be alerted on', async () => {
    const seen: Array<{ failed: number; seqs: number[] }> = [];
    const bus = new EventBusModel(0, true);
    await publisher(bus, (failed, entries) => {
      seen.push({ failed, seqs: entries.map((e) => JSON.parse(e.detail).seq) });
    }).publish(events(12), BUS_ARN);
    expect(seen).toEqual([
      { failed: 10, seqs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
      { failed: 2, seqs: [11, 12] },
    ]);
  });

  it('tells the caller which entries the bus itself refused', async () => {
    const seen: number[] = [];
    const bus = new EventBusModel(2);
    const refused = await publisher(bus, (failed) => seen.push(failed)).publish(events(5), BUS_ARN);
    expect(refused).toBe(2);
    expect(seen).toEqual([2]);
  });

  it('carries on to the next chunk after one is refused', async () => {
    const bus = new EventBusModel(1);
    expect(await publisher(bus).publish(events(12), BUS_ARN)).toBe(2);
    expect(bus.published).toHaveLength(10);
  });

  it('needs no failure handler: reporting is optional, dropping is not silent', async () => {
    const bus = new EventBusModel(0, true);
    await expect(publisher(bus).publish(events(1), BUS_ARN)).resolves.toBe(1);
  });
});

describe('what this is not', () => {
  it('offers no way to read history back', () => {
    const surface = publisher(new EventBusModel()) as unknown as Record<string, unknown>;
    for (const forbidden of ['read', 'get', 'head', 'append', 'verify']) {
      expect(surface[forbidden], forbidden).toBeUndefined();
    }
  });

  it('releases the client when closed', async () => {
    let closed = false;
    const client = new (class extends EventBusModel {
      override async close(): Promise<void> {
        closed = true;
      }
    })();
    await publisher(client).close();
    expect(closed).toBe(true);
  });
});
