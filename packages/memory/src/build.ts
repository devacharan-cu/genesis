/**
 * Record construction: validation, scoping, versioning and the authority
 * policy, in one place.
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1), because it is the only path by which a record
 * acquires its effective authority.
 *
 * Adapters call `buildRecord` and then persist the result. If each adapter did
 * this itself they would eventually disagree, and a store that clamps correctly
 * on SQLite but not on DynamoDB would be worse than one that never clamped —
 * the failure would be invisible until it mattered.
 */

import {
  type MemoryId,
  newMemoryId,
  type ProjectScope,
  ValidationError,
} from '@genesis/core-types';
import { decideAuthority, neverPromotes } from './authority-policy.js';
import type { WriteContext } from './port.js';
import { MemoryRecord, NewMemoryRecord } from './record.js';

export interface BuildRecordOptions {
  /** Set when writing a new version of an existing logical record. */
  readonly previous?:
    | { readonly logicalId: MemoryId; readonly id: MemoryId; readonly version: number }
    | undefined;
  /**
   * The authority policy to apply. Defaults to `decideAuthority`.
   *
   * Injectable for one reason: the guard below refuses a policy that PROMOTES
   * an authority, and a guard that cannot be triggered is decoration rather
   * than defence. A test injects a deliberately broken policy to prove the
   * guard fires. Production callers never pass this.
   */
  readonly policy?: typeof decideAuthority | undefined;
}

export function buildRecord(
  scope: ProjectScope,
  input: unknown,
  ctx: WriteContext,
  options: BuildRecordOptions = {},
): MemoryRecord {
  const parsed = NewMemoryRecord.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError('invalid memory record', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  const value = parsed.data;

  const decide = options.policy ?? decideAuthority;
  const decision = decide({
    requested: value.authorityRequested,
    actorKind: ctx.actorKind,
    sourceRefs: value.sourceRefs,
    evidenceRefs: value.evidenceRefs,
    relatedEntities: value.relatedEntities,
  });

  // The policy must never raise an authority. Asserting it here rather than
  // trusting it costs nothing and turns the worst possible bug in the knowledge
  // layer into a loud failure instead of a quiet promotion.
  if (!neverPromotes(value.authorityRequested, decision.authority)) {
    throw new ValidationError(
      'authority policy returned a higher authority than was requested; refusing the write',
      { requested: value.authorityRequested, decided: decision.authority },
    );
  }

  const now = (ctx.now ?? ((): Date => new Date()))();
  const timestamp = now.toISOString();
  const mintId = ctx.newId ?? newMemoryId;
  const id = mintId();

  const record = {
    id,
    // Version 1 is its own logical root; later versions inherit it.
    logicalId: options.previous?.logicalId ?? id,
    projectId: scope.projectId,
    class: value.class,
    type: value.type,
    content: value.content,
    authority: decision.authority,
    authorityRequested: value.authorityRequested,
    authorityClamps: [...decision.clamps],
    status: 'ACTIVE' as const,
    createdAt: timestamp,
    updatedAt: timestamp,
    validFrom: value.validFrom ?? timestamp,
    validUntil: value.validUntil,
    version: options.previous === undefined ? 1 : options.previous.version + 1,
    previousVersion: options.previous?.id ?? null,
    sourceRefs: value.sourceRefs,
    relatedEntities: value.relatedEntities,
    evidenceRefs: value.evidenceRefs,
    tags: value.tags,
    producedByCycle: value.producedByCycle,
    producedByAgent: value.producedByAgent,
    confidence: value.confidence,
    statusCause: null,
  };

  const validated = MemoryRecord.safeParse(record);
  if (!validated.success) {
    throw new ValidationError('constructed memory record failed its own schema', {
      issues: validated.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return validated.data;
}
