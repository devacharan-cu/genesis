/**
 * Registration, and the conformance proof SPEC-04 §6 calls for.
 *
 * The negative half of this file is the point. ADR-0006's central claim is that
 * an agent cannot write canonical state; §"cannot reach state" proves it three
 * ways at once — by the package graph, by what an agent is handed, and by what
 * it can return.
 */

import { newAgentId, newMessageId, newTaskId } from '@genesis/core-types';
import { AgentManifest, type TaskAssignmentBody, type TaskFraming } from '@genesis/protocol';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { BaseAgent } from '../src/base.js';
import type { Agent, AgentServices } from '../src/contract.js';
import { AgentRegistrationError, AgentRegistry, type RegistryPolicy } from '../src/registry.js';
import { PlannerAgent, VerifierAgent } from '../src/roles.js';

const POLICY: RegistryPolicy = {
  proposalKinds: ['RECORD_BELIEF', 'RECORD_UNCERTAINTY', 'DRAFT_QUESTION', 'RECORD_CONTRADICTION'],
  permissions: ['workspace:READ'],
  tools: ['search'],
  reasoningProviders: ['mock'],
};

const manifest = (over: Record<string, unknown> = {}): AgentManifest =>
  AgentManifest.parse({
    id: newAgentId(),
    role: 'PLANNER',
    version: '1.0.0',
    capabilities: ['decompose-goal'],
    maxContextTokens: 4000,
    timeoutMs: 5000,
    proposalKinds: ['RECORD_BELIEF'],
    reasoningProvider: 'mock',
    ...over,
  });

describe('registration', () => {
  test('admits an agent that asks for nothing it may not have', () => {
    const registry = new AgentRegistry(POLICY);
    const registered = registry.register(new PlannerAgent(manifest()));
    expect(registered.proposalKinds).toEqual(['RECORD_BELIEF']);
    expect(registry.forRole('PLANNER')).toBe(registered);
  });

  test('refuses a proposal kind the core has no schema for, at registration', () => {
    const registry = new AgentRegistry(POLICY);
    expect(() => registry.register(new PlannerAgent(manifest({ proposalKinds: ['TRANSITION_BELIEF'] })))).toThrow(
      AgentRegistrationError,
    );
  });

  test('refuses a provider this deployment does not have', () => {
    const registry = new AgentRegistry(POLICY);
    try {
      registry.register(new PlannerAgent(manifest({ reasoningProvider: 'gpt-hypothetical' })));
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentRegistrationError);
      expect((error as AgentRegistrationError).issues[0]).toContain('gpt-hypothetical');
    }
  });

  test('admits a deterministic agent, which needs no provider', () => {
    const registry = new AgentRegistry(POLICY);
    const registered = registry.register(
      new VerifierAgent(manifest({ role: 'VERIFIER', reasoningProvider: null, proposalKinds: [] })),
    );
    expect(registered.proposalKinds).toEqual([]);
  });

  test('refuses a second agent for a role, because routing would be a coin toss', () => {
    const registry = new AgentRegistry(POLICY);
    const first = manifest();
    registry.register(new PlannerAgent(first));
    try {
      registry.register(new PlannerAgent(manifest()));
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as AgentRegistrationError).issues[0]).toContain(first.id);
    }
  });

  test('reports every reason at once rather than one round at a time', () => {
    const registry = new AgentRegistry(POLICY);
    try {
      registry.register(
        new PlannerAgent(
          manifest({
            proposalKinds: ['DEPLOY'],
            requiredTools: ['shell'],
            permissions: [{ scope: 'production', level: 'WRITE' }],
          }),
        ),
      );
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as AgentRegistrationError).issues).toHaveLength(3);
    }
  });

  test('a refused agent is not on the roster afterwards', () => {
    const registry = new AgentRegistry(POLICY);
    expect(() => registry.register(new PlannerAgent(manifest({ proposalKinds: ['DEPLOY'] })))).toThrow();
    expect(registry.forRole('PLANNER')).toBeNull();
    expect(registry.all()).toEqual([]);
  });

  test('an unfilled role answers null rather than throwing', () => {
    expect(new AgentRegistry(POLICY).forRole('BUILDER')).toBeNull();
  });

  test('lists agents in a stable order, so a listing does not change between runs', () => {
    const registry = new AgentRegistry(POLICY);
    registry.register(new VerifierAgent(manifest({ role: 'VERIFIER', reasoningProvider: null, proposalKinds: [] })));
    registry.register(new PlannerAgent(manifest()));
    registry.register(new PlannerAgent(manifest({ role: 'ARCHITECT' })));
    expect(registry.all().map((r) => r.manifest.role)).toEqual(['ARCHITECT', 'PLANNER', 'VERIFIER']);
  });
});

describe('mayPropose', () => {
  test('is true only for a kind the agent declared and the core permits', () => {
    const registry = new AgentRegistry(POLICY);
    registry.register(new PlannerAgent(manifest({ proposalKinds: ['RECORD_BELIEF'] })));
    expect(registry.mayPropose('PLANNER', 'RECORD_BELIEF')).toBe(true);
    expect(registry.mayPropose('PLANNER', 'DRAFT_QUESTION')).toBe(false);
  });

  test('is false for a role nobody fills, rather than throwing', () => {
    expect(new AgentRegistry(POLICY).mayPropose('REPAIR', 'RECORD_BELIEF')).toBe(false);
  });

  test('narrows when the core narrows, without the manifest changing', () => {
    const narrow = new AgentRegistry({ ...POLICY, proposalKinds: ['DRAFT_QUESTION'] });
    expect(() => narrow.register(new PlannerAgent(manifest({ proposalKinds: ['RECORD_BELIEF'] })))).toThrow();
  });
});

describe('an agent cannot reach state', () => {
  test('the package declares no dependency that can write', () => {
    // The first of the three enforcements (ADR-0006). `check-boundaries.mjs`
    // proves this over the whole repository on every run; asserting it here
    // means a change to this package's manifest fails its own suite too.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@genesis/core-types', '@genesis/protocol', 'zod']);
  });

  test('no source file imports anything that can write', () => {
    const forbidden = ['ledger', 'memory', 'graph', 'cognition', 'context', 'core', 'experiment', 'verification', 'reasoning'];
    for (const file of ['contract.ts', 'base.ts', 'registry.ts', 'roles.ts', 'index.ts']) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
      for (const name of forbidden) {
        expect(source, `${file} imports @genesis/${name}`).not.toContain(`@genesis/${name}'`);
      }
    }
  });

  test('the services an agent is handed carry nothing that writes', async () => {
    let seen: AgentServices | null = null;
    class Spy extends BaseAgent {
      frame(): TaskFraming | null {
        return null;
      }
      override async handle(a: TaskAssignmentBody, s: AgentServices): ReturnType<Agent['handle']> {
        seen = s;
        return super.handle(a, s);
      }
    }
    const assignment: TaskAssignmentBody = {
      taskId: newTaskId(),
      attempt: 1,
      role: 'PLANNER',
      kind: 'PLANNER_TASK',
      instruction: 'do the work',
      contributesTo: ['goal-1'],
      context: [],
      budget: { maxOutputTokens: 100, timeoutMs: 100 },
      deadline: '2026-09-19T10:05:00.000Z',
    };
    await new Spy(manifest()).handle(assignment, {
      run: null,
      now: () => '2026-09-19T10:00:00.000Z',
      newMessageId: () => newMessageId(),
      signal: new AbortController().signal,
    });
    const handed: AgentServices | null = seen;
    expect(handed).not.toBeNull();
    // Exactly four things, none of which is a store, an engine or a provider.
    expect(Object.keys(handed ?? {}).sort()).toEqual(['newMessageId', 'now', 'run', 'signal']);
  });

  test('an agent can only return messages, never an effect', async () => {
    const assignment: TaskAssignmentBody = {
      taskId: newTaskId(),
      attempt: 1,
      role: 'VERIFIER',
      kind: 'VERIFIER_TASK',
      instruction: 'judge the evidence',
      contributesTo: ['goal-1'],
      context: [],
      budget: { maxOutputTokens: 100, timeoutMs: 100 },
      deadline: '2026-09-19T10:05:00.000Z',
    };
    const outcome = await new VerifierAgent(manifest({ role: 'VERIFIER', reasoningProvider: null })).handle(assignment, {
      run: null,
      now: () => '2026-09-19T10:00:00.000Z',
      newMessageId: () => newMessageId(),
      signal: new AbortController().signal,
    });
    expect(Object.keys(outcome).sort()).toEqual(['messages', 'reached']);
    for (const message of outcome.messages) {
      expect(typeof message).toBe('object');
      // Data, not a closure: an envelope with a function on it would be a way
      // to hand the runtime something that runs.
      expect(JSON.parse(JSON.stringify(message))).toEqual(message);
    }
  });
});
