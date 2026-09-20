/**
 * The table's key names, as the deployment declares them.
 *
 * These are duplicated from the adapter's schema (ADR-0024 §1) on purpose, and
 * the duplication is not left to trust. `@genesis/infrastructure` may depend
 * only on `core-types` and `protocol`, because an infrastructure package that
 * imported an adapter would invert the dependency: the deployment would be
 * defined by the code that runs in it rather than the other way round.
 *
 * So the two declarations are kept separate and a test in `@genesis/cloud` —
 * the one package permitted to name both — asserts they are identical. A
 * rename in either place fails that test rather than producing a stack whose
 * table the adapter cannot query.
 *
 * The names themselves are opaque (`pk`, `sk`, `gsi1pk`) because a single-table
 * design puts unrelated entities in the same attributes, and a name like
 * `eventId` on the partition key would be a lie for five of the six item kinds.
 */

export const TABLE_KEYS = { partition: 'pk', sort: 'sk' } as const;
export const GSI1 = 'gsi1';
export const GSI2 = 'gsi2';

/** Every attribute the table's keys and indexes are built from. */
export const KEY_ATTRIBUTES = [TABLE_KEYS.partition, TABLE_KEYS.sort, 'gsi1pk', 'gsi1sk', 'gsi2pk', 'gsi2sk'] as const;
