/**
 * The put rule and the corruption hook, which the shared suite cannot reach.
 *
 * `checkPut` is the one place every adapter decides whether a write may
 * proceed, and the case it exists for — different bytes arriving under a digest
 * that is already taken — cannot happen through the port. It can only be
 * constructed directly, which is what this does.
 */

import { ValidationError } from '@genesis/core-types';
import { describe, expect, it } from 'vitest';
import { blobKey, checkPut, digestOf, InMemoryBlobStore, refFor } from '../src/in-memory.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('deciding whether a put may proceed', () => {
  it('allows bytes nobody has stored', () => {
    expect(checkPut('EVIDENCE', bytes('new'), null)).toEqual(refFor('EVIDENCE', bytes('new')));
  });

  it('allows an identical re-put, which is how idempotency works', () => {
    expect(checkPut('EVIDENCE', bytes('same'), bytes('same')).digest).toBe(digestOf(bytes('same')));
  });

  it('refuses different bytes under a digest that is taken', () => {
    // Either a SHA-256 collision or a caller writing through a digest it did
    // not compute. Both are worth stopping for.
    expect(() => checkPut('EVIDENCE', bytes('the suite passed'), bytes('the suite failed'))).toThrow(ValidationError);
  });

  it('refuses bytes of the same length that differ', () => {
    expect(() => checkPut('EVIDENCE', bytes('aaaa'), bytes('aaab'))).toThrow(/different blob is already stored/);
  });

  it('refuses bytes of a different length', () => {
    expect(() => checkPut('EVIDENCE', bytes('short'), bytes('much longer content'))).toThrow(ValidationError);
  });

  it('says how big each side was, without saying what either contained', () => {
    try {
      checkPut('EVIDENCE', bytes('abc'), bytes('wxyz'));
      expect.unreachable();
    } catch (error) {
      const details = (error as ValidationError).details;
      expect(details).toMatchObject({ kind: 'EVIDENCE', storedBytes: 4, incomingBytes: 3 });
      expect(JSON.stringify(details)).not.toContain('wxyz');
    }
  });

  it('treats empty content as content, not as absence', () => {
    expect(() => checkPut('LOG', bytes(''), bytes(''))).not.toThrow();
    expect(() => checkPut('LOG', bytes(''), bytes('x'))).toThrow(ValidationError);
  });
});

describe('the storage key', () => {
  it('puts the project first, so isolation is the key and not a filter', () => {
    const ref = refFor('EVIDENCE', bytes('x'));
    expect(blobKey('prj-1', ref)).toBe(`prj-1/EVIDENCE/${ref.digest}`);
  });

  it('separates kinds, so identical bytes of two kinds do not collide', () => {
    expect(blobKey('prj-1', refFor('EVIDENCE', bytes('x')))).not.toBe(blobKey('prj-1', refFor('LOG', bytes('x'))));
  });
});

describe('the corruption hook', () => {
  it('refuses to corrupt something that was never stored', async () => {
    const store = new InMemoryBlobStore();
    const absent = refFor('EVIDENCE', bytes('never written'));
    await expect(store.unsafeCorrupt('prj-1', absent, bytes('x'))).rejects.toThrow(/nothing stored to corrupt/);
  });
});
