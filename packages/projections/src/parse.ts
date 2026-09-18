/**
 * Schema-checked restore of a stored projection state.
 *
 * A snapshot is bytes out of storage. Casting them into the state type would
 * trust whatever wrote them — a previous version of this code, a partial
 * write, or something else entirely — and the first symptom would be a
 * projection that is confidently wrong.
 */

import { type JsonValue, ValidationError } from '@genesis/core-types';
import type { z } from 'zod';

export function parseProjectionState<S extends JsonValue>(
  schema: z.ZodType<S>,
  value: unknown,
  projection: string,
): S {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(`stored state is not a valid ${projection} state`, {
      projection,
      issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  return parsed.data;
}
