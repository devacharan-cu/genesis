/**
 * The registry: where an over-reaching manifest stops (ADR-0020 §3).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). Registration is the last moment at which a
 * misconfigured agent can be refused cheaply. After it, the agent is on the
 * roster and every refusal costs a failed task.
 *
 * So the checks are all here, and all at registration:
 *
 *   - the manifest must parse, and must ask for nothing policy does not grant;
 *   - its proposal kinds must all be kinds the core actually has;
 *   - a role is filled by at most one agent, because two agents answering to
 *     one role makes routing a coin toss;
 *   - an agent that declares a reasoning provider must be given one, and one
 *     that declares none must not be.
 *
 * The registry holds no task state. It maps a role to an agent and says what
 * that agent may do; where each task has got to is the runtime's record on the
 * ledger, not a field here.
 */

import type { AgentRole } from '@genesis/core-types';
import { checkManifest, effectiveProposalKinds, type AgentManifest, reasons } from '@genesis/protocol';
import type { Agent } from './contract.js';

/** What the deployment permits. The registry checks against this, never around it. */
export interface RegistryPolicy {
  /** The proposal kinds the core has schemas for. An agent cannot exceed these. */
  readonly proposalKinds: readonly string[];
  /** Granted permissions, as `scope:LEVEL`. */
  readonly permissions: readonly string[];
  /** Tools the deployment can actually provide. */
  readonly tools: readonly string[];
  /** Reasoning provider ids that exist. A manifest naming another is refused. */
  readonly reasoningProviders: readonly string[];
}

/** An agent on the roster, with what it was actually granted. */
export interface RegisteredAgent {
  readonly agent: Agent;
  readonly manifest: AgentManifest;
  /** Its declared kinds, narrowed by the core's. Never wider (ADR-0020 §3). */
  readonly proposalKinds: readonly string[];
}

export class AgentRegistrationError extends Error {
  constructor(
    readonly issues: readonly string[],
    message: string,
  ) {
    super(message);
    this.name = 'AgentRegistrationError';
  }
}

export class AgentRegistry {
  readonly #byRole = new Map<AgentRole, RegisteredAgent>();

  constructor(private readonly policy: RegistryPolicy) {}

  /**
   * Adds an agent, or refuses it with every reason at once. Refusing one reason
   * at a time turns a misconfiguration into several rounds of trial and error.
   */
  register(agent: Agent): RegisteredAgent {
    const checked = checkManifest(agent.manifest, this.policy);
    const issues: string[] = checked.ok ? [] : [...checked.issues];

    if (checked.ok) {
      const { manifest } = checked;
      const existing = this.#byRole.get(manifest.role);
      if (existing !== undefined) {
        issues.push(`role: ${manifest.role} is already filled by ${existing.manifest.id}`);
      }
      if (reasons(manifest) && !this.policy.reasoningProviders.includes(manifest.reasoningProvider as string)) {
        issues.push(`reasoningProvider: ${String(manifest.reasoningProvider)} is not a provider this deployment has`);
      }
      if (issues.length === 0) {
        const registered: RegisteredAgent = {
          agent,
          manifest,
          proposalKinds: effectiveProposalKinds(manifest, this.policy.proposalKinds),
        };
        this.#byRole.set(manifest.role, registered);
        return registered;
      }
    }
    throw new AgentRegistrationError(issues, `agent rejected at registration: ${issues.join('; ')}`);
  }

  /** The agent filling a role, or null. Null is an answer the caller must handle. */
  forRole(role: AgentRole): RegisteredAgent | null {
    return this.#byRole.get(role) ?? null;
  }

  /** Every registered agent, in role order, so a listing is stable across runs. */
  all(): readonly RegisteredAgent[] {
    return [...this.#byRole.values()].sort((a, b) => a.manifest.role.localeCompare(b.manifest.role));
  }

  /**
   * True when this agent may propose this kind. Asked per proposal, because the
   * answer is what stops a well-formed proposal of a kind the agent never
   * declared.
   */
  mayPropose(role: AgentRole, kind: string): boolean {
    return this.#byRole.get(role)?.proposalKinds.includes(kind) ?? false;
  }
}
