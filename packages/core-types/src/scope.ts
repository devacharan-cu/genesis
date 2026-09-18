/**
 * Project scoping (ADR-0008).
 *
 * SAFETY-CRITICAL (SPEC-00 section 8.1). A failure here lets one project's data
 * appear in another project's context, and the system would then reason
 * confidently about the wrong project.
 *
 * The mechanism is small on purpose: a `ProjectScope` is a required first
 * argument on every store read, so an unscoped query cannot be written. The
 * runtime check below exists for the boundary where an id arrives from outside
 * the type system.
 */

import { ProjectId } from './ids.js';
import { ScopeMismatchError, ValidationError } from './errors.js';

export interface ProjectScope {
  readonly projectId: ProjectId;
}

/** Constructs a scope, validating the id shape at the boundary. */
export function projectScope(projectId: ProjectId | string): ProjectScope {
  const parsed = ProjectId.safeParse(projectId);
  if (!parsed.success) {
    throw new ValidationError('invalid project id', {
      projectId,
      issues: parsed.error.issues.map((i) => i.message),
    });
  }
  return Object.freeze({ projectId: parsed.data });
}

/**
 * Asserts that a record belongs to the scoped project.
 *
 * Throws rather than returning a boolean so that the caller cannot forget to
 * check the result — an ignored boolean is the failure mode this guards against.
 */
export function assertInScope(
  scope: ProjectScope,
  recordProjectId: ProjectId,
  subject: string,
): void {
  if (scope.projectId !== recordProjectId) {
    throw new ScopeMismatchError({
      expected: scope.projectId,
      actual: recordProjectId,
      subject,
    });
  }
}

/** Non-throwing variant, for filtering collections rather than validating one record. */
export function isInScope(scope: ProjectScope, recordProjectId: ProjectId): boolean {
  return scope.projectId === recordProjectId;
}

/** True when two scopes address the same project. */
export function sameScope(a: ProjectScope, b: ProjectScope): boolean {
  return a.projectId === b.projectId;
}
