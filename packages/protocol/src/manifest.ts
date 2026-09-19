/**
 * The agent manifest: what an agent declares about itself, statically
 * (SPEC-04 §2, ADR-0020 §3).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). The manifest is the input to every
 * registration and capability decision, so a manifest that can claim more than
 * it should is a permission system that does nothing.
 *
 * The manifest can only ever *narrow*. `proposalKinds` is intersected with what
 * the core permits; a manifest naming something the core does not allow is
 * refused at registration rather than at use, because a capability that only
 * fails when exercised has already shipped.
 *
 * `reasoningProvider: null` is a real and useful answer. The Verifier is
 * deterministic: it reads evidence and applies rules. An agent that does not
 * reason is an agent whose output does not need a mock to be tested.
 */

import { AGENT_ROLES, AgentId, type AgentRole } from '@genesis/core-types';
import { z } from 'zod';

const Id = z.string().trim().min(1);

/** A permission an agent asks for, in the form SPEC-06 grants them. */
export const PermissionRequest = z
  .object({ scope: Id, level: z.enum(['READ', 'WRITE', 'EXECUTE']) })
  .strict();
export type PermissionRequest = z.infer<typeof PermissionRequest>;

export const AgentManifest = z
  .object({
    id: AgentId,
    role: z.enum(AGENT_ROLES),
    version: z.string().trim().min(1),
    /** What this agent says it can do, for routing and for the self model. */
    capabilities: z.array(Id).min(1).max(50),
    requiredTools: z.array(Id).max(50).default([]),
    permissions: z.array(PermissionRequest).max(50).default([]),
    maxContextTokens: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
    /**
     * The proposal kinds this agent may use. Intersected with the core's
     * permitted set, never added to it.
     */
    proposalKinds: z.array(Id).max(20).default([]),
    /**
     * Which reasoning provider this agent's work comes from, or null when the
     * agent is deterministic. Null is not a lesser answer.
     */
    reasoningProvider: Id.nullable().default(null),
    /** Bounded, and bounded here rather than wherever a retry happens to run. */
    maxAttempts: z.number().int().min(1).max(5).default(1),
  })
  .strict();
export type AgentManifest = z.infer<typeof AgentManifest>;

export type ManifestCheck =
  | { readonly ok: true; readonly manifest: AgentManifest }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * Checks a manifest against what the deployment actually permits.
 *
 * Three refusals, all at registration:
 *
 *   - a proposal kind the core does not have a schema for;
 *   - a permission policy does not grant;
 *   - a tool the deployment does not have.
 *
 * Each names what was asked for and what is available, because "permission
 * denied" without the pair is a message that costs an afternoon.
 */
export function checkManifest(
  value: unknown,
  permitted: {
    readonly proposalKinds: readonly string[];
    readonly permissions: readonly string[];
    readonly tools: readonly string[];
  },
): ManifestCheck {
  const parsed = AgentManifest.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    };
  }
  const manifest = parsed.data;
  const issues: string[] = [];

  for (const kind of manifest.proposalKinds) {
    if (!permitted.proposalKinds.includes(kind)) {
      issues.push(`proposalKinds: ${kind} is not a kind the core permits (${permitted.proposalKinds.join(', ')})`);
    }
  }
  for (const permission of manifest.permissions) {
    const asked = `${permission.scope}:${permission.level}`;
    if (!permitted.permissions.includes(asked)) {
      issues.push(`permissions: ${asked} is not granted by policy`);
    }
  }
  for (const tool of manifest.requiredTools) {
    if (!permitted.tools.includes(tool)) {
      issues.push(`requiredTools: ${tool} is not available`);
    }
  }
  return issues.length === 0 ? { ok: true, manifest } : { ok: false, issues };
}

/**
 * The proposal kinds this agent may actually use: its own, narrowed by the
 * core's. Written as an intersection rather than a check so that widening is
 * not merely refused, it is unrepresentable.
 */
export const effectiveProposalKinds = (
  manifest: AgentManifest,
  permitted: readonly string[],
): readonly string[] => manifest.proposalKinds.filter((kind) => permitted.includes(kind));

/** True when this agent's output came from a model, and so must be clamped as such. */
export const reasons = (manifest: AgentManifest): boolean => manifest.reasoningProvider !== null;

/** The roster, for a router that must know a role exists before one is registered. */
export const isAgentRole = (value: string): value is AgentRole =>
  (AGENT_ROLES as readonly string[]).includes(value);
