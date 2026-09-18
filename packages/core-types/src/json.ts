/**
 * JSON value type.
 *
 * Event payloads are restricted to plain JSON rather than `unknown` because the
 * hash chain (ADR-0009) requires a deterministic serialisation. A `Date`, a
 * `Map`, a class instance or an `undefined` inside a payload would serialise
 * inconsistently across adapters, and the chain would fail verification for a
 * reason that had nothing to do with tampering.
 */

import { z } from 'zod';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    // Rejects NaN and Infinity: neither survives a JSON round trip, so a hash
    // computed over them would not be reproducible.
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(JsonValue),
  ]),
);

export const JsonObject = z.record(JsonValue);
export type JsonObject = Record<string, JsonValue>;
