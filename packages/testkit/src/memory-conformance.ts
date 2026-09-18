/**
 * MemoryStore conformance suite.
 *
 * Written against the PORT, never against an adapter (ADR-0003). If a test here
 * needs to know which adapter it is running against, the port is
 * underspecified and the port should be fixed — not the test.
 *
 * The properties this suite defends, in order of how much damage their failure
 * would do:
 *   1. An agent cannot promote its own claims above AI_ASSUMPTION.
 *   2. Contradictory records are preserved, never merged or deleted.
 *   3. Project isolation holds.
 */

import {
  type ActorKind,
  newAgentId,
  newNodeId,
  newProjectId,
  type ProjectScope,
  projectScope,
  ScopeMismatchError,
} from '@genesis/core-types';
import type { MemoryStore, NewMemoryRecord, WriteContext } from '@genesis/memory';
import { beforeEach, describe, expect, it } from 'vitest';

export interface MemoryStoreHarness {
  readonly name: string;
  create(): Promise<MemoryStore>;
}

const ctx = (actorKind: ActorKind = 'HUMAN', actorId = 'dev'): WriteContext => ({
  actorKind,
  actorId,
});

/** A record with human provenance and no grounding beyond the human. */
const humanRecord = (overrides: Partial<NewMemoryRecord> = {}): NewMemoryRecord =>
  ({
    class: 'SEMANTIC',
    type: 'api-behaviour',
    content: { statement: 'the booking API rejects overlapping slots' },
    authorityRequested: 'HUMAN_DECISION',
    sourceRefs: [{ kind: 'HUMAN', id: 'dev' }],
    ...overrides,
  }) as NewMemoryRecord;

/** A record an agent produced from a reasoning call. */
const agentRecord = (overrides: Partial<NewMemoryRecord> = {}): NewMemoryRecord =>
  ({
    class: 'SEMANTIC',
    type: 'api-behaviour',
    content: { statement: 'this service probably uses optimistic locking' },
    authorityRequested: 'AI_ASSUMPTION',
    sourceRefs: [{ kind: 'MODEL', id: 'claude-opus-5' }],
    ...overrides,
  }) as NewMemoryRecord;

export function describeMemoryStoreConformance(harness: MemoryStoreHarness): void {
  describe(`MemoryStore conformance: ${harness.name}`, () => {
    let store: MemoryStore;
    let scope: ProjectScope;
    let other: ProjectScope;

    beforeEach(async () => {
      store = await harness.create();
      scope = projectScope(newProjectId());
      other = projectScope(newProjectId());
    });

    // ------------------------------------------------------------- writing

    describe('put', () => {
      it('writes version 1 as its own logical root', async () => {
        const record = await store.put(scope, humanRecord(), ctx());
        expect(record.version).toBe(1);
        expect(record.logicalId).toBe(record.id);
        expect(record.previousVersion).toBeNull();
        expect(record.status).toBe('ACTIVE');
      });

      it('stamps the projectId from the scope, not from the caller', async () => {
        const record = await store.put(scope, humanRecord(), ctx());
        expect(record.projectId).toBe(scope.projectId);
      });

      it('refuses a caller-supplied projectId', async () => {
        await expect(
          store.put(scope, { ...humanRecord(), projectId: other.projectId } as never, ctx()),
        ).rejects.toThrow(/invalid memory record/i);
      });

      it('refuses a caller-supplied status, version or effective authority', async () => {
        for (const field of [
          { status: 'ARCHIVED' },
          { version: 5 },
          { authority: 'HUMAN_DECISION' },
          { id: 'mem_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
        ]) {
          await expect(
            store.put(scope, { ...humanRecord(), ...field } as never, ctx()),
            JSON.stringify(field),
          ).rejects.toThrow(/invalid memory record/i);
        }
      });

      it('requires at least one source ref', async () => {
        await expect(
          store.put(scope, { ...humanRecord(), sourceRefs: [] }, ctx()),
        ).rejects.toThrow(/invalid memory record/i);
      });

      it('requires a non-empty statement', async () => {
        await expect(
          store.put(scope, { ...humanRecord(), content: { statement: '' } }, ctx()),
        ).rejects.toThrow(/invalid memory record/i);
      });

      it('defaults validFrom to the write time and validUntil to null', async () => {
        const record = await store.put(scope, humanRecord(), ctx());
        expect(Number.isNaN(Date.parse(record.validFrom))).toBe(false);
        expect(record.validUntil).toBeNull();
      });
    });

    // ------------------------------------------ the guarantee that matters

    describe('an agent cannot promote its own claims (ADR-0011)', () => {
      it('clamps a model-sourced claim to AI_ASSUMPTION however high it reaches', async () => {
        for (const requested of [
          'HUMAN_DECISION',
          'VERIFIED_SYSTEM_STATE',
          'ACTIVE_REQUIREMENT',
          'EVIDENCE',
          'HISTORICAL',
        ] as const) {
          const record = await store.put(
            scope,
            agentRecord({ authorityRequested: requested }),
            ctx('AGENT', 'agt-1'),
          );
          expect(record.authority, requested).toBe('AI_ASSUMPTION');
        }
      });

      it('clamps a model-sourced claim even when the actor presents as HUMAN', async () => {
        // Provenance beats the claimed actor. An agent cannot launder its own
        // output by asserting a different actor kind.
        const record = await store.put(
          scope,
          agentRecord({ authorityRequested: 'HUMAN_DECISION' }),
          ctx('HUMAN', 'dev'),
        );
        expect(record.authority).toBe('AI_ASSUMPTION');
        expect(record.authorityClamps).toContain('MODEL_SOURCED');
      });

      it('clamps a model-sourced claim even when evidence is attached', async () => {
        const evidence = await store.put(
          scope,
          humanRecord({ class: 'EVIDENCE', authorityRequested: 'HUMAN_DECISION' }),
          ctx(),
        );
        const record = await store.put(
          scope,
          agentRecord({ authorityRequested: 'EVIDENCE', evidenceRefs: [evidence.id] }),
          ctx('AGENT', 'agt-1'),
        );
        expect(record.authority).toBe('AI_ASSUMPTION');
      });

      it('caps an agent at EVIDENCE even without model provenance', async () => {
        const evidence = await store.put(scope, humanRecord({ class: 'EVIDENCE' }), ctx());
        const record = await store.put(
          scope,
          humanRecord({
            authorityRequested: 'HUMAN_DECISION',
            sourceRefs: [{ kind: 'TOOL', id: 'runner' }],
            evidenceRefs: [evidence.id],
          }),
          ctx('AGENT', 'agt-1'),
        );
        expect(record.authority).toBe('EVIDENCE');
        expect(record.authorityClamps).toContain('ACTOR_CEILING');
      });

      it('records what was requested and why it was reduced', async () => {
        const record = await store.put(
          scope,
          agentRecord({ authorityRequested: 'HUMAN_DECISION' }),
          ctx('AGENT', 'agt-1'),
        );
        expect(record.authorityRequested).toBe('HUMAN_DECISION');
        expect(record.authority).toBe('AI_ASSUMPTION');
        expect(record.authorityClamps.length).toBeGreaterThan(0);
      });

      it('leaves an honest claim untouched, with no clamp recorded', async () => {
        const record = await store.put(scope, humanRecord(), ctx());
        expect(record.authority).toBe('HUMAN_DECISION');
        expect(record.authorityClamps).toEqual([]);
      });

      it('clamps EVIDENCE with no evidence refs down to the floor', async () => {
        const record = await store.put(
          scope,
          humanRecord({
            authorityRequested: 'EVIDENCE',
            sourceRefs: [{ kind: 'TOOL', id: 'runner' }],
          }),
          ctx('SYSTEM', 'probe'),
        );
        // UNGROUNDED, not AI_ASSUMPTION: no model produced this, so calling it
        // an AI assumption would say something false (ADR-0012).
        expect(record.authority).toBe('UNGROUNDED');
        expect(record.authorityClamps).toContain('NO_EVIDENCE');
      });

      it('stops at HISTORICAL when the claim says when it stopped being current', async () => {
        const record = await store.put(
          scope,
          humanRecord({
            authorityRequested: 'EVIDENCE',
            sourceRefs: [{ kind: 'TOOL', id: 'runner' }],
            validUntil: '2020-06-01T00:00:00.000Z',
          }),
          ctx('SYSTEM', 'probe'),
        );
        expect(record.authority).toBe('HISTORICAL');
      });

      it('clamps ACTIVE_REQUIREMENT with no linked requirement', async () => {
        const record = await store.put(
          scope,
          humanRecord({ authorityRequested: 'ACTIVE_REQUIREMENT' }),
          ctx(),
        );
        expect(record.authority).toBe('UNGROUNDED');
        expect(record.authorityClamps).toContain('NO_REQUIREMENT_LINK');
      });

      it('allows ACTIVE_REQUIREMENT when a requirement is linked', async () => {
        const record = await store.put(
          scope,
          humanRecord({
            authorityRequested: 'ACTIVE_REQUIREMENT',
            relatedEntities: [{ nodeType: 'REQUIREMENT', nodeId: newNodeId() }],
          }),
          ctx(),
        );
        expect(record.authority).toBe('ACTIVE_REQUIREMENT');
      });

      it('never returns an authority above what was requested, for any actor', async () => {
        const kinds: ActorKind[] = ['HUMAN', 'SYSTEM', 'AGENT'];
        for (const kind of kinds) {
          const record = await store.put(
            scope,
            agentRecord({ authorityRequested: 'AI_ASSUMPTION' }),
            ctx(kind, 'x'),
          );
          expect(record.authority, kind).toBe('AI_ASSUMPTION');
        }
      });

      it('lands an unsupported claim on UNGROUNDED rather than mislabelling it', async () => {
        // A human asserting something with no evidence, no requirement, no end
        // date and no model behind it. Naming that an AI assumption would be
        // false about its provenance (ADR-0012).
        const record = await store.put(
          scope,
          humanRecord({ authorityRequested: 'AI_ASSUMPTION' }),
          ctx(),
        );
        expect(record.authority).toBe('UNGROUNDED');
        expect(record.authorityClamps).toContain('NO_MODEL_SOURCE');
      });
    });

    // ------------------------------------------------ contradiction handling

    describe('contradiction preservation (SPEC-02 §5)', () => {
      it('keeps BOTH records when authority settles it', async () => {
        const human = await store.put(scope, humanRecord(), ctx());
        const agent = await store.put(scope, agentRecord(), ctx('AGENT', 'agt-1'));

        const outcome = await store.link(scope, human.id, agent.id, 'CONTRADICTS');
        expect(outcome.resolution.outcome).toBe('GOVERNED_BY_AUTHORITY');
        expect(outcome.resolution.governing).toBe(human.id);

        // Neither is gone.
        expect(await store.get(scope, human.id)).not.toBeNull();
        expect(await store.get(scope, agent.id)).not.toBeNull();
      });

      it('demotes only the lower-authority side', async () => {
        const human = await store.put(scope, humanRecord(), ctx());
        const agent = await store.put(scope, agentRecord(), ctx('AGENT', 'agt-1'));
        await store.link(scope, human.id, agent.id, 'CONTRADICTS');

        expect((await store.get(scope, agent.id))?.status).toBe('SUPERSEDED_BY_AUTHORITY');
        // The governing record is NOT marked: a weak claim must not taint a
        // human decision simply by disagreeing with it.
        expect((await store.get(scope, human.id))?.status).toBe('ACTIVE');
      });

      it('resolves the same way regardless of argument order', async () => {
        const human = await store.put(scope, humanRecord(), ctx());
        const agent = await store.put(scope, agentRecord(), ctx('AGENT', 'agt-1'));
        const outcome = await store.link(scope, agent.id, human.id, 'CONTRADICTS');
        expect(outcome.resolution.governing).toBe(human.id);
        expect(outcome.resolution.superseded).toBe(agent.id);
      });

      it('leaves BOTH standing and owes a question when authority is equal', async () => {
        const a = await store.put(scope, humanRecord(), ctx());
        const b = await store.put(
          scope,
          humanRecord({ content: { statement: 'the booking API allows overlapping slots' } }),
          ctx(),
        );

        const outcome = await store.link(scope, a.id, b.id, 'CONTRADICTS');
        expect(outcome.resolution.outcome).toBe('UNRESOLVED');
        expect(outcome.resolution.governing).toBeNull();
        expect(outcome.resolution.owesUncertainty).toBe(true);

        expect((await store.get(scope, a.id))?.status).toBe('CONTRADICTED');
        expect((await store.get(scope, b.id))?.status).toBe('CONTRADICTED');
      });

      it('keeps unresolved contradictions VISIBLE to default queries', async () => {
        const a = await store.put(scope, humanRecord(), ctx());
        const b = await store.put(
          scope,
          humanRecord({ content: { statement: 'the opposite is true' } }),
          ctx(),
        );
        await store.link(scope, a.id, b.id, 'CONTRADICTS');

        const page = await store.query(scope);
        const ids = page.items.map((r) => r.id);
        // Hiding these would be the silent overwrite SPEC-02 §5 forbids.
        expect(ids).toContain(a.id);
        expect(ids).toContain(b.id);
      });

      it('hides the authority-superseded side from default queries but keeps it readable', async () => {
        const human = await store.put(scope, humanRecord(), ctx());
        const agent = await store.put(scope, agentRecord(), ctx('AGENT', 'agt-1'));
        await store.link(scope, human.id, agent.id, 'CONTRADICTS');

        const visible = await store.query(scope);
        expect(visible.items.map((r) => r.id)).not.toContain(agent.id);

        const all = await store.query(scope, { includeNonActive: true });
        expect(all.items.map((r) => r.id)).toContain(agent.id);
        expect(await store.get(scope, agent.id)).not.toBeNull();
      });

      it('writes the CONTRADICTS link symmetrically', async () => {
        const a = await store.put(scope, humanRecord(), ctx());
        const b = await store.put(scope, humanRecord(), ctx());
        const outcome = await store.link(scope, a.id, b.id, 'CONTRADICTS');
        expect(outcome.reciprocal).not.toBeNull();

        const fromA = await store.links(scope, a.id);
        const fromB = await store.links(scope, b.id);
        expect(fromA.some((l) => l.from === a.id && l.to === b.id)).toBe(true);
        expect(fromB.some((l) => l.from === b.id && l.to === a.id)).toBe(true);
      });

      it('marks the superseded side on a SUPERSEDES link without deleting it', async () => {
        const older = await store.put(scope, humanRecord(), ctx());
        const newer = await store.put(scope, humanRecord(), ctx());
        const outcome = await store.link(scope, newer.id, older.id, 'SUPERSEDES');

        expect(outcome.reciprocal).toBeNull();
        expect((await store.get(scope, older.id))?.status).toBe('SUPERSEDED');
        expect(await store.get(scope, older.id)).not.toBeNull();
      });

      it('refuses to link a record to itself', async () => {
        const a = await store.put(scope, humanRecord(), ctx());
        await expect(store.link(scope, a.id, a.id, 'CONTRADICTS')).rejects.toThrow(/itself/i);
      });

      it('refuses to link across projects', async () => {
        const mine = await store.put(scope, humanRecord(), ctx());
        const theirs = await store.put(other, humanRecord(), ctx());
        await expect(store.link(scope, mine.id, theirs.id, 'CONTRADICTS')).rejects.toThrow(
          ScopeMismatchError,
        );
      });

      it('exposes no method that could delete a record', () => {
        for (const forbidden of ['delete', 'remove', 'destroy', 'merge', 'overwrite', 'purge']) {
          expect(
            (store as unknown as Record<string, unknown>)[forbidden],
            `MemoryStore must not expose "${forbidden}"`,
          ).toBeUndefined();
        }
      });
    });

    // --------------------------------------------------------- versioning

    describe('versioning', () => {
      it('supersedes the previous version without destroying it', async () => {
        const v1 = await store.put(scope, humanRecord(), ctx());
        const v2 = await store.putVersion(
          scope,
          v1.logicalId,
          humanRecord({ content: { statement: 'revised statement' } }),
          ctx(),
        );

        expect(v2.version).toBe(2);
        expect(v2.logicalId).toBe(v1.logicalId);
        expect(v2.previousVersion).toBe(v1.id);
        expect((await store.get(scope, v1.id))?.status).toBe('SUPERSEDED');
        expect((await store.get(scope, v1.id))?.content.statement).toBe(
          'the booking API rejects overlapping slots',
        );
      });

      it('returns the latest version from current()', async () => {
        const v1 = await store.put(scope, humanRecord(), ctx());
        const v2 = await store.putVersion(scope, v1.logicalId, humanRecord(), ctx());
        expect((await store.current(scope, v1.logicalId))?.id).toBe(v2.id);
      });

      it('returns every version from history(), oldest first', async () => {
        const v1 = await store.put(scope, humanRecord(), ctx());
        await store.putVersion(scope, v1.logicalId, humanRecord(), ctx());
        await store.putVersion(scope, v1.logicalId, humanRecord(), ctx());
        const history = await store.history(scope, v1.logicalId);
        expect(history.map((r) => r.version)).toEqual([1, 2, 3]);
      });

      it('shows only the latest version in a default query', async () => {
        const v1 = await store.put(scope, humanRecord(), ctx());
        const v2 = await store.putVersion(scope, v1.logicalId, humanRecord(), ctx());
        const ids = (await store.query(scope)).items.map((r) => r.id);
        expect(ids).toContain(v2.id);
        expect(ids).not.toContain(v1.id);
      });

      it('shows every version when asked', async () => {
        const v1 = await store.put(scope, humanRecord(), ctx());
        await store.putVersion(scope, v1.logicalId, humanRecord(), ctx());
        const page = await store.query(scope, {
          includeAllVersions: true,
          includeNonActive: true,
        });
        expect(page.items.length).toBe(2);
      });

      it('rejects a version of a logical record that does not exist', async () => {
        await expect(
          store.putVersion(scope, 'mem_01ARZ3NDEKTSV4RRFFQ69G5FAV' as never, humanRecord(), ctx()),
        ).rejects.toThrow(/no memory record/i);
      });

      it('re-applies the authority policy to each new version', async () => {
        const v1 = await store.put(scope, humanRecord(), ctx());
        const v2 = await store.putVersion(
          scope,
          v1.logicalId,
          agentRecord({ authorityRequested: 'HUMAN_DECISION' }),
          ctx('AGENT', 'agt-1'),
        );
        // A new version cannot be used to smuggle in a higher authority.
        expect(v2.authority).toBe('AI_ASSUMPTION');
      });
    });

    // ------------------------------------------------------ project scoping

    describe('project isolation (ADR-0008)', () => {
      it('does not leak records between projects', async () => {
        await store.put(scope, humanRecord(), ctx());
        await store.put(other, humanRecord(), ctx());
        expect((await store.query(scope)).total).toBe(1);
        expect((await store.query(other)).total).toBe(1);
      });

      it('THROWS rather than returning null for a foreign record', async () => {
        const foreign = await store.put(other, humanRecord(), ctx());
        await expect(store.get(scope, foreign.id)).rejects.toThrow(ScopeMismatchError);
      });

      it('returns null for an id that exists nowhere', async () => {
        expect(await store.get(scope, 'mem_01ARZ3NDEKTSV4RRFFQ69G5FAV' as never)).toBeNull();
      });

      it('keeps history and current scoped', async () => {
        const foreign = await store.put(other, humanRecord(), ctx());
        expect(await store.current(scope, foreign.logicalId)).toBeNull();
        expect(await store.history(scope, foreign.logicalId)).toEqual([]);
      });
    });

    // ------------------------------------------------------------ querying

    describe('querying', () => {
      beforeEach(async () => {
        await store.put(
          scope,
          humanRecord({ class: 'DECISION', type: 'adr', tags: ['architecture'] }),
          ctx(),
        );
        await store.put(
          scope,
          humanRecord({
            class: 'SEMANTIC',
            type: 'api-behaviour',
            content: { statement: 'timeouts are 12 hours' },
            tags: ['runtime'],
          }),
          ctx(),
        );
        await store.put(scope, agentRecord(), ctx('AGENT', 'agt-1'));
      });

      it('filters by class', async () => {
        const page = await store.query(scope, { class: ['DECISION'] });
        expect(page.items.every((r) => r.class === 'DECISION')).toBe(true);
        expect(page.total).toBe(1);
      });

      it('filters by type', async () => {
        expect((await store.query(scope, { type: ['adr'] })).total).toBe(1);
      });

      it('filters by authority range', async () => {
        const authoritative = await store.query(scope, { minAuthority: 'ACTIVE_REQUIREMENT' });
        expect(authoritative.items.every((r) => r.authority === 'HUMAN_DECISION')).toBe(true);

        const weak = await store.query(scope, { maxAuthority: 'AI_ASSUMPTION' });
        expect(weak.items.every((r) => r.authority === 'AI_ASSUMPTION')).toBe(true);
      });

      it('filters by tag', async () => {
        expect((await store.query(scope, { tags: ['runtime'] })).total).toBe(1);
      });

      it('filters by substring of the statement', async () => {
        const page = await store.query(scope, { text: '12 HOURS' });
        expect(page.total).toBe(1);
      });

      it('filters by related entity', async () => {
        const nodeId = newNodeId();
        await store.put(
          scope,
          humanRecord({ relatedEntities: [{ nodeType: 'REQUIREMENT', nodeId }] }),
          ctx(),
        );
        const page = await store.query(scope, {
          relatedEntity: { nodeType: 'REQUIREMENT', nodeId },
        });
        expect(page.total).toBe(1);
      });

      it('filters by validity window', async () => {
        await store.put(
          scope,
          humanRecord({
            content: { statement: 'expired fact' },
            validFrom: '2020-01-01T00:00:00.000Z',
            validUntil: '2020-06-01T00:00:00.000Z',
          }),
          ctx(),
        );
        const during = await store.query(scope, { validAt: '2020-03-01T00:00:00.000Z' });
        expect(during.items.some((r) => r.content.statement === 'expired fact')).toBe(true);

        const after = await store.query(scope, { validAt: '2021-01-01T00:00:00.000Z' });
        expect(after.items.some((r) => r.content.statement === 'expired fact')).toBe(false);
      });

      it('pages with a limit and reports the next offset', async () => {
        const first = await store.query(scope, { limit: 2 });
        expect(first.items.length).toBe(2);
        expect(first.total).toBe(3);
        expect(first.nextOffset).toBe(2);

        const second = await store.query(scope, { limit: 2, offset: 2 });
        expect(second.items.length).toBe(1);
        expect(second.nextOffset).toBeNull();
      });

      it('does not return the same record on consecutive pages', async () => {
        const first = await store.query(scope, { limit: 2 });
        const second = await store.query(scope, { limit: 2, offset: 2 });
        const overlap = first.items.filter((a) => second.items.some((b) => b.id === a.id));
        expect(overlap).toEqual([]);
      });

      it('excludes archived and retracted records by default', async () => {
        const record = await store.put(scope, humanRecord(), ctx());
        await store.transition(scope, record.id, 'ARCHIVED', null);
        const ids = (await store.query(scope)).items.map((r) => r.id);
        expect(ids).not.toContain(record.id);
      });
    });

    // ---------------------------------------------------------- transitions

    describe('transitions', () => {
      it('moves a record to a new status and records the cause', async () => {
        const record = await store.put(scope, humanRecord(), ctx());
        const updated = await store.transition(
          scope,
          record.id,
          'RETRACTED',
          'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV' as never,
        );
        expect(updated.status).toBe('RETRACTED');
        expect(updated.statusCause).toBe('evt_01ARZ3NDEKTSV4RRFFQ69G5FAV');
      });

      it('keeps the record readable after retraction', async () => {
        const record = await store.put(scope, humanRecord(), ctx());
        await store.transition(scope, record.id, 'RETRACTED', null);
        expect(await store.get(scope, record.id)).not.toBeNull();
      });

      it('refuses to transition a foreign record', async () => {
        const foreign = await store.put(other, humanRecord(), ctx());
        await expect(store.transition(scope, foreign.id, 'ARCHIVED', null)).rejects.toThrow(
          ScopeMismatchError,
        );
      });
    });

    // ------------------------------------------------------------ lifecycle

    describe('lifecycle', () => {
      it('returns copies, so a caller cannot mutate stored state', async () => {
        const record = await store.put(scope, humanRecord(), ctx());
        (record as unknown as { type: string }).type = 'TAMPERED';
        expect((await store.get(scope, record.id))?.type).toBe('api-behaviour');
      });

      it('carries producedByAgent through', async () => {
        const agentId = newAgentId();
        const record = await store.put(
          scope,
          agentRecord({ producedByAgent: agentId }),
          ctx('AGENT', 'agt-1'),
        );
        expect(record.producedByAgent).toBe(agentId);
      });

      it('rejects use after close', async () => {
        await store.close();
        await expect(store.put(scope, humanRecord(), ctx())).rejects.toThrow(/closed/i);
      });

      it('tolerates being closed twice', async () => {
        await store.close();
        await expect(store.close()).resolves.toBeUndefined();
      });
    });
  });
}
