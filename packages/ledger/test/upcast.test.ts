/**
 * Upcasting is safety-critical (SPEC-00 section 8.1): a wrong upcast silently
 * rewrites history. The stored bytes stay correct and the hash chain still
 * verifies, because the chain covers what was STORED, not how it is read.
 * Nothing else would catch it.
 *
 * v1 is currently the only shipped version, so in production this is an
 * identity pass. The mechanism is exercised here with synthetic legacy
 * versions, because the first real migration is the worst possible moment to
 * discover that the upcaster machinery does not work.
 */

import { UnsupportedSchemaVersionError } from '@genesis/core-types';
import { defaultUpcastRegistry, UpcastRegistry, type Upcaster } from '@genesis/ledger';
import { describe, expect, it } from 'vitest';

describe('UpcastRegistry', () => {
  it('returns a current-version event unchanged', () => {
    const registry = new UpcastRegistry(1);
    const raw = { schemaVersion: 1, type: 'OBSERVATION_RECORDED' };
    expect(registry.upcast(raw)).toEqual(raw);
  });

  it('does not mutate the input', () => {
    const registry = new UpcastRegistry(2);
    registry.register(1, (raw) => ({ ...raw, added: true }));
    const raw = { schemaVersion: 1 };
    registry.upcast(raw);
    expect(raw).toEqual({ schemaVersion: 1 });
  });

  it('applies a single upcasting step', () => {
    const registry = new UpcastRegistry(2);
    registry.register(1, (raw) => ({ ...raw, renamed: raw['legacyField'] }));

    const result = registry.upcast({ schemaVersion: 1, legacyField: 'value' });
    expect(result['renamed']).toBe('value');
    expect(result['schemaVersion']).toBe(2);
  });

  it('walks several versions in order', () => {
    const order: number[] = [];
    const step =
      (from: number): Upcaster =>
      (raw) => {
        order.push(from);
        return { ...raw, [`v${from + 1}`]: true };
      };

    const registry = new UpcastRegistry(4);
    registry.register(1, step(1)).register(2, step(2)).register(3, step(3));

    const result = registry.upcast({ schemaVersion: 1 });
    expect(order).toEqual([1, 2, 3]);
    expect(result['schemaVersion']).toBe(4);
    expect(result['v2']).toBe(true);
    expect(result['v4']).toBe(true);
  });

  it('starts from the stored version, not from 1', () => {
    const applied: number[] = [];
    const registry = new UpcastRegistry(3);
    registry.register(1, (raw) => {
      applied.push(1);
      return raw;
    });
    registry.register(2, (raw) => {
      applied.push(2);
      return raw;
    });

    registry.upcast({ schemaVersion: 2 });
    expect(applied).toEqual([2]);
  });

  it('owns the version number, so an upcaster that forgets to bump cannot loop', () => {
    const registry = new UpcastRegistry(3);
    // Neither step touches schemaVersion.
    registry.register(1, (raw) => ({ ...raw }));
    registry.register(2, (raw) => ({ ...raw }));
    expect(registry.upcast({ schemaVersion: 1 })['schemaVersion']).toBe(3);
  });

  it('refuses when a step in the chain is missing', () => {
    const registry = new UpcastRegistry(3);
    registry.register(1, (raw) => raw);
    expect(() => registry.upcast({ schemaVersion: 1 })).toThrow(UnsupportedSchemaVersionError);
    expect(() => registry.upcast({ schemaVersion: 1 })).toThrow(/from event schema version 2 to 3/);
  });

  it('refuses to downcast an event written by a newer build', () => {
    const registry = new UpcastRegistry(1);
    expect(() => registry.upcast({ schemaVersion: 2 })).toThrow(/refusing to downcast/);
  });

  it('refuses an event with no usable schemaVersion', () => {
    const registry = new UpcastRegistry(1);
    for (const bad of [undefined, null, 'one', 0, -1, 1.5]) {
      expect(() => registry.upcast({ schemaVersion: bad }), String(bad)).toThrow(
        /no usable schemaVersion/,
      );
    }
  });

  it('rejects registering a duplicate step', () => {
    const registry = new UpcastRegistry(3);
    registry.register(1, (raw) => raw);
    expect(() => registry.register(1, (raw) => raw)).toThrow(/already registered/);
  });

  it('rejects an invalid source version', () => {
    const registry = new UpcastRegistry(3);
    expect(() => registry.register(0, (raw) => raw)).toThrow(/positive integer/);
    expect(() => registry.register(1.5, (raw) => raw)).toThrow(/positive integer/);
    expect(() => registry.register(-2, (raw) => raw)).toThrow(/positive integer/);
  });

  it('exposes its target version', () => {
    expect(new UpcastRegistry(7).targetVersion).toBe(7);
  });

  it('defaults its target to the current event schema version', () => {
    expect(new UpcastRegistry().targetVersion).toBe(1);
  });
});

describe('defaultUpcastRegistry', () => {
  it('is an identity pass while v1 is the only shipped version', () => {
    const raw = { schemaVersion: 1, type: 'OBSERVATION_RECORDED' };
    expect(defaultUpcastRegistry.upcast(raw)).toEqual(raw);
  });
});
