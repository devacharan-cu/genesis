/**
 * Event schema upcasting (ADR-0004).
 *
 * SAFETY-CRITICAL (SPEC-00 section 8.1). A wrong upcast silently rewrites
 * history: the stored bytes are correct, but what the system *reads* is not
 * what happened. That is undetectable by the hash chain, because the chain
 * verifies the stored form, not the interpretation of it.
 *
 * The ledger is append-only and permanent, so old event shapes stay readable
 * forever. Every read passes through this registry, which walks an event from
 * its stored version up to the current one, one step at a time.
 *
 * v1 is currently the only shipped version, so in production this is an
 * identity pass. The mechanism is exercised in tests with synthetic legacy
 * versions — it has to work the first time a real migration happens, and the
 * first time is exactly when it is least safe to be discovering bugs.
 */

import { CURRENT_EVENT_SCHEMA_VERSION, UnsupportedSchemaVersionError } from '@genesis/core-types';

/** Transforms a raw stored event from version N to version N+1. */
export type Upcaster = (raw: Readonly<Record<string, unknown>>) => Record<string, unknown>;

export class UpcastRegistry {
  readonly #upcasters = new Map<number, Upcaster>();
  readonly #targetVersion: number;

  constructor(targetVersion: number = CURRENT_EVENT_SCHEMA_VERSION) {
    this.#targetVersion = targetVersion;
  }

  get targetVersion(): number {
    return this.#targetVersion;
  }

  /** Registers the step from `fromVersion` to `fromVersion + 1`. */
  register(fromVersion: number, upcaster: Upcaster): this {
    if (!Number.isInteger(fromVersion) || fromVersion < 1) {
      throw new UnsupportedSchemaVersionError(
        `upcaster source version must be a positive integer, got ${fromVersion}`,
        { fromVersion },
      );
    }
    if (this.#upcasters.has(fromVersion)) {
      throw new UnsupportedSchemaVersionError(
        `an upcaster from version ${fromVersion} is already registered`,
        { fromVersion },
      );
    }
    this.#upcasters.set(fromVersion, upcaster);
    return this;
  }

  /**
   * Walks a raw stored event up to the target version.
   *
   * Returns the input unchanged when it is already current, which is the
   * common case and deliberately cheap.
   */
  upcast(raw: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const stored = raw['schemaVersion'];
    if (typeof stored !== 'number' || !Number.isInteger(stored) || stored < 1) {
      throw new UnsupportedSchemaVersionError(
        'stored event has no usable schemaVersion; it cannot be interpreted safely',
        { schemaVersion: stored },
      );
    }

    if (stored > this.#targetVersion) {
      // Written by a newer build than this one. Guessing at a downcast would
      // mean inventing what the fields used to mean, so it refuses.
      throw new UnsupportedSchemaVersionError(
        `event schema version ${stored} is newer than this build understands (${this.#targetVersion}); refusing to downcast`,
        { stored, target: this.#targetVersion },
      );
    }

    let current: Record<string, unknown> = { ...raw };
    let version = stored;

    while (version < this.#targetVersion) {
      const step = this.#upcasters.get(version);
      if (step === undefined) {
        throw new UnsupportedSchemaVersionError(
          `no upcaster registered from event schema version ${version} to ${version + 1}`,
          { from: version, to: version + 1 },
        );
      }
      current = step(current);
      version += 1;
      // The upcaster is responsible for the content; the registry owns the
      // version number, so a step that forgets to bump it cannot cause a loop.
      current['schemaVersion'] = version;
    }

    return current;
  }
}

/**
 * The registry used by adapters by default.
 *
 * Empty because v1 is the only version that has ever existed. When v2 arrives,
 * its upcaster is registered here and every stored v1 event keeps working.
 */
export const defaultUpcastRegistry = new UpcastRegistry();
