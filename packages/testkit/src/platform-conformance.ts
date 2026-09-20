/**
 * Conformance suites for the three platform ports (ADR-0026 §1).
 *
 * Written against the PORT, never against an adapter. The in-memory
 * implementation and the S3, Cognito and Secrets Manager adapters run these
 * identical suites, which is how "interchangeable" stays proven rather than
 * asserted (ADR-0003).
 *
 * If a test here needs to know which adapter it is running against, the port is
 * underspecified and the port should be fixed — not the test.
 */

import { newProjectId, type ProjectScope, projectScope, ValidationError } from '@genesis/core-types';
import {
  type BlobRef,
  type BlobStore,
  type CorruptibleBlobStore,
  digestOf,
  readEvidence,
  refFor,
} from '@genesis/blob';
import { AuthenticationError, type IdentityProvider, isCurrent } from '@genesis/identity';
import { type SecretRef, SecretResolutionError, type SecretResolver, SecretValue } from '@genesis/secrets';
import { beforeEach, describe, expect, it } from 'vitest';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (raw: Uint8Array): string => new TextDecoder().decode(raw);

// ------------------------------------------------------------------- blobs

export type BlobStoreUnderTest = BlobStore & CorruptibleBlobStore;

export interface BlobStoreHarness {
  readonly name: string;
  create(): Promise<BlobStoreUnderTest>;
}

export function describeBlobStoreConformance(harness: BlobStoreHarness): void {
  describe(`BlobStore conformance: ${harness.name}`, () => {
    let store: BlobStoreUnderTest;
    let scope: ProjectScope;
    let other: ProjectScope;

    beforeEach(async () => {
      store = await harness.create();
      scope = projectScope(newProjectId());
      other = projectScope(newProjectId());
    });

    describe('storing and reading', () => {
      it('files bytes under their own digest', async () => {
        const stored = await store.put(scope, 'EVIDENCE', bytes('the suite passed'));
        expect(stored.digest).toBe(digestOf(bytes('the suite passed')));
        expect(stored.kind).toBe('EVIDENCE');
        expect(stored.bytes).toBe(16);
        expect(stored.projectId).toBe(scope.projectId);
      });

      it('returns exactly the bytes it was given', async () => {
        const ref = await store.put(scope, 'ARTIFACT', bytes('export const add = 1;'));
        expect(text((await store.get(scope, ref)) as Uint8Array)).toBe('export const add = 1;');
      });

      it('handles empty content, which is a real observation', async () => {
        const ref = await store.put(scope, 'LOG', bytes(''));
        expect(ref.bytes).toBe(0);
        expect((await store.get(scope, ref))?.length).toBe(0);
        expect(await store.verify(scope, ref)).toBe(true);
      });

      it('handles bytes that are not text', async () => {
        const raw = new Uint8Array([0, 1, 2, 250, 255, 0]);
        const ref = await store.put(scope, 'ARTIFACT', raw);
        expect([...((await store.get(scope, ref)) as Uint8Array)]).toEqual([...raw]);
      });

      it('answers null for something never stored', async () => {
        const absent: BlobRef = refFor('EVIDENCE', bytes('never written'));
        expect(await store.get(scope, absent)).toBeNull();
        expect(await store.head(scope, absent)).toBeNull();
        expect(await store.verify(scope, absent)).toBe(false);
      });

      it('records what it knows without reading the bytes', async () => {
        const stored = await store.put(scope, 'EVIDENCE', bytes('x'), { contentType: 'text/plain' });
        const head = await store.head(scope, stored);
        expect(head).toMatchObject({ digest: stored.digest, bytes: 1, contentType: 'text/plain' });
      });

      it('defaults the content type rather than guessing one', async () => {
        const stored = await store.put(scope, 'EVIDENCE', bytes('x'));
        expect(stored.contentType).toBe('application/octet-stream');
      });
    });

    describe('immutability', () => {
      it('accepts the same bytes twice, and keeps the original record', async () => {
        const first = await store.put(scope, 'EVIDENCE', bytes('same'));
        const second = await store.put(scope, 'EVIDENCE', bytes('same'));
        expect(second.digest).toBe(first.digest);
        expect(second.storedAt).toBe(first.storedAt);
      });

      it('stores the same bytes separately per kind', async () => {
        const evidence = await store.put(scope, 'EVIDENCE', bytes('same'));
        const artifact = await store.put(scope, 'ARTIFACT', bytes('same'));
        expect(artifact.digest).toBe(evidence.digest);
        expect(await store.list(scope, 'EVIDENCE')).toHaveLength(1);
        expect(await store.list(scope, 'ARTIFACT')).toHaveLength(1);
      });

      it('has no way to overwrite: the port offers none', () => {
        expect((store as unknown as Record<string, unknown>)['overwrite']).toBeUndefined();
        expect((store as unknown as Record<string, unknown>)['update']).toBeUndefined();
      });
    });

    describe('integrity', () => {
      it('verifies bytes that are intact', async () => {
        const ref = await store.put(scope, 'EVIDENCE', bytes('coverage: src/add.ts 100%'));
        expect(await store.verify(scope, ref)).toBe(true);
      });

      it('detects bytes corrupted past the put path', async () => {
        const ref = await store.put(scope, 'EVIDENCE', bytes('the suite passed'));
        await store.unsafeCorrupt(scope.projectId, ref, bytes('the suite failed'));
        expect(await store.verify(scope, ref)).toBe(false);
      });

      it('reads evidence that is present and intact', async () => {
        const ref = await store.put(scope, 'EVIDENCE', bytes('real output'));
        expect(text(await readEvidence(store, scope, ref, scope.projectId))).toBe('real output');
      });

      it('refuses evidence whose bytes are absent', async () => {
        const absent = refFor('EVIDENCE', bytes('claimed but never stored'));
        await expect(readEvidence(store, scope, absent, scope.projectId)).rejects.toThrow(/not in the blob store/);
      });

      it('refuses evidence that does not hash to its reference', async () => {
        const ref = await store.put(scope, 'EVIDENCE', bytes('real output'));
        await store.unsafeCorrupt(scope.projectId, ref, bytes('substituted'));
        await expect(readEvidence(store, scope, ref, scope.projectId)).rejects.toThrow(/does not hash/);
      });

      it('refuses evidence belonging to another project', async () => {
        const ref = await store.put(scope, 'EVIDENCE', bytes('real output'));
        await expect(readEvidence(store, scope, ref, other.projectId)).rejects.toThrow();
      });
    });

    describe('listing and removal', () => {
      it('lists a kind by digest ascending, so the order is stable', async () => {
        for (const content of ['c', 'a', 'b']) await store.put(scope, 'EVIDENCE', bytes(content));
        const listed = await store.list(scope, 'EVIDENCE');
        expect(listed).toHaveLength(3);
        expect(listed.map((b) => b.digest)).toEqual([...listed.map((b) => b.digest)].sort());
      });

      it('lists only the kind asked for', async () => {
        await store.put(scope, 'EVIDENCE', bytes('e'));
        await store.put(scope, 'LOG', bytes('l'));
        expect(await store.list(scope, 'EVIDENCE')).toHaveLength(1);
        expect((await store.list(scope, 'LOG'))[0]?.kind).toBe('LOG');
      });

      it('removes a blob, and says when there was nothing to remove', async () => {
        const ref = await store.put(scope, 'ARTIFACT', bytes('temporary'));
        expect(await store.delete(scope, ref)).toBe(true);
        expect(await store.get(scope, ref)).toBeNull();
        expect(await store.delete(scope, ref)).toBe(false);
      });
    });

    describe('project isolation', () => {
      it('does not return one project’s blob to another', async () => {
        const ref = await store.put(scope, 'EVIDENCE', bytes('private to this project'));
        expect(await store.get(other, ref)).toBeNull();
        expect(await store.head(other, ref)).toBeNull();
        expect(await store.verify(other, ref)).toBe(false);
      });

      it('lists nothing of another project’s', async () => {
        await store.put(scope, 'EVIDENCE', bytes('mine'));
        expect(await store.list(other, 'EVIDENCE')).toEqual([]);
      });

      it('lets two projects hold identical bytes independently', async () => {
        const mine = await store.put(scope, 'EVIDENCE', bytes('identical'));
        const theirs = await store.put(other, 'EVIDENCE', bytes('identical'));
        expect(theirs.digest).toBe(mine.digest);
        await store.delete(scope, mine);
        expect(await store.get(other, theirs)).not.toBeNull();
      });
    });

    describe('after closing', () => {
      it('refuses further work rather than answering wrongly', async () => {
        await store.close();
        await expect(store.put(scope, 'EVIDENCE', bytes('late'))).rejects.toThrow(ValidationError);
      });

      it('is safe to close twice', async () => {
        await store.close();
        await expect(store.close()).resolves.toBeUndefined();
      });
    });
  });
}

// ---------------------------------------------------------------- identity

export interface IdentityHarness {
  readonly name: string;
  /** A provider that accepts `validToken` for `expectedSubject`, and nothing else. */
  create(): Promise<{ provider: IdentityProvider; validToken: string; expectedSubject: string }>;
}

export function describeIdentityConformance(harness: IdentityHarness): void {
  describe(`IdentityProvider conformance: ${harness.name}`, () => {
    let provider: IdentityProvider;
    let validToken: string;
    let expectedSubject: string;

    beforeEach(async () => {
      ({ provider, validToken, expectedSubject } = await harness.create());
    });

    it('returns a verified subject for a token it accepts', async () => {
      const subject = await provider.authenticate(validToken);
      expect(subject.subject).toBe(expectedSubject);
      expect(subject.subject.length).toBeGreaterThan(0);
    });

    it('returns an assertion that is current when issued', async () => {
      const subject = await provider.authenticate(validToken);
      expect(isCurrent(subject, new Date(Date.parse(subject.issuedAt)))).toBe(true);
      expect(Date.parse(subject.expiresAt)).toBeGreaterThan(Date.parse(subject.issuedAt));
    });

    it('refuses an unknown token', async () => {
      await expect(provider.authenticate('not-a-token-this-provider-knows')).rejects.toThrow(AuthenticationError);
    });

    it('refuses an empty token', async () => {
      await expect(provider.authenticate('')).rejects.toThrow(AuthenticationError);
      await expect(provider.authenticate('   ')).rejects.toThrow(AuthenticationError);
    });

    it('never returns an anonymous subject: refusal is an exception', async () => {
      const outcome = await provider.authenticate('nope').then(
        (s) => s,
        (e: unknown) => e,
      );
      expect(outcome).toBeInstanceOf(AuthenticationError);
    });

    it('does not say whether a refused token nearly matched', async () => {
      const failure = await provider
        .authenticate(`${validToken}x`)
        .then(() => null, (e: unknown) => e as AuthenticationError);
      expect(failure).toBeInstanceOf(AuthenticationError);
      if (failure === null) return;
      // An error that distinguished "no such subject" from "wrong secret" would
      // be an enumeration oracle (SPEC-06 §2).
      expect(failure.message).not.toContain(validToken);
      expect(failure.message).not.toContain(expectedSubject);
    });

    it('refuses after closing rather than answering', async () => {
      await provider.close();
      await expect(provider.authenticate(validToken)).rejects.toThrow(AuthenticationError);
    });
  });
}

// ----------------------------------------------------------------- secrets

export interface SecretsHarness {
  readonly name: string;
  /**
   * A resolver holding one plain secret and one JSON secret with a `password`
   * field, under the refs it returns.
   */
  create(): Promise<{
    resolver: SecretResolver;
    plain: SecretRef;
    plainValue: string;
    keyed: SecretRef;
    keyedValue: string;
    absent: SecretRef;
  }>;
}

export function describeSecretResolverConformance(harness: SecretsHarness): void {
  describe(`SecretResolver conformance: ${harness.name}`, () => {
    let h: Awaited<ReturnType<SecretsHarness['create']>>;

    beforeEach(async () => {
      h = await harness.create();
    });

    it('resolves a plain secret', async () => {
      expect((await h.resolver.resolve(h.plain)).reveal()).toBe(h.plainValue);
    });

    it('resolves one field of a structured secret', async () => {
      expect((await h.resolver.resolve(h.keyed)).reveal()).toBe(h.keyedValue);
    });

    it('refuses a reference to nothing', async () => {
      await expect(h.resolver.resolve(h.absent)).rejects.toThrow(SecretResolutionError);
    });

    it('returns a value that does not leak when logged', async () => {
      const value = await h.resolver.resolve(h.plain);
      expect(String(value)).toBe('[redacted]');
      expect(`${value}`).toBe('[redacted]');
      expect(JSON.stringify({ value })).not.toContain(h.plainValue);
      expect(JSON.stringify(value)).toBe('"[redacted]"');
    });

    it('returns a value whose length is readable without revealing it', async () => {
      expect((await h.resolver.resolve(h.plain)).length).toBe(h.plainValue.length);
    });

    it('reveals only when asked in so many words', async () => {
      const value = await h.resolver.resolve(h.plain);
      expect(value).toBeInstanceOf(SecretValue);
      expect(value.reveal()).toBe(h.plainValue);
    });

    it('offers no way to enumerate what it holds', () => {
      const surface = h.resolver as unknown as Record<string, unknown>;
      for (const forbidden of ['list', 'getAll', 'keys', 'entries', 'put', 'set', 'write']) {
        expect(surface[forbidden], forbidden).toBeUndefined();
      }
    });

    it('refuses after closing', async () => {
      await h.resolver.close();
      await expect(h.resolver.resolve(h.plain)).rejects.toThrow(SecretResolutionError);
    });
  });
}
