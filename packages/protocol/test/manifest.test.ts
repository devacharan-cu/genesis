/**
 * Registration is where an over-reaching manifest stops (ADR-0020 §3).
 *
 * The property that matters is one-directional: a manifest can narrow what an
 * agent may do and can never widen it. Both halves are tested, because only
 * testing the refusal would leave "narrowing actually narrows" unproven.
 */

import { AGENT_ROLES, newAgentId } from '@genesis/core-types';
import { describe, expect, test } from 'vitest';
import {
  AgentManifest,
  checkManifest,
  effectiveProposalKinds,
  isAgentRole,
  reasons,
} from '../src/manifest.js';

const CORE_KINDS = ['RECORD_BELIEF', 'RECORD_UNCERTAINTY', 'DRAFT_QUESTION', 'RECORD_CONTRADICTION'];

const permitted = {
  proposalKinds: CORE_KINDS,
  permissions: ['workspace:READ', 'workspace:WRITE'],
  tools: ['search', 'read-file'],
};

const base = {
  id: newAgentId(),
  role: 'PLANNER',
  version: '1.0.0',
  capabilities: ['decompose-goal'],
  maxContextTokens: 8000,
  timeoutMs: 30_000,
  proposalKinds: ['RECORD_BELIEF', 'RECORD_UNCERTAINTY'],
  reasoningProvider: 'mock',
};

describe('checkManifest', () => {
  test('accepts a manifest that asks for nothing it may not have', () => {
    const checked = checkManifest(base, permitted);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.manifest.maxAttempts).toBe(1);
    expect(checked.manifest.requiredTools).toEqual([]);
    expect(checked.manifest.permissions).toEqual([]);
  });

  test('refuses a proposal kind the core has no schema for', () => {
    const checked = checkManifest({ ...base, proposalKinds: ['TRANSITION_BELIEF'] }, permitted);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.issues[0]).toContain('TRANSITION_BELIEF');
    // The message names what IS available, so the fix does not need the source.
    expect(checked.issues[0]).toContain('RECORD_BELIEF');
  });

  test('refuses a permission policy does not grant', () => {
    const checked = checkManifest({ ...base, permissions: [{ scope: 'production', level: 'WRITE' }] }, permitted);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.issues[0]).toContain('production:WRITE');
  });

  test('refuses a tool the deployment does not have', () => {
    const checked = checkManifest({ ...base, requiredTools: ['shell'] }, permitted);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.issues[0]).toContain('shell');
  });

  test('reports every refusal at once, not the first one', () => {
    const checked = checkManifest(
      {
        ...base,
        proposalKinds: ['DEPLOY'],
        permissions: [{ scope: 'production', level: 'EXECUTE' }],
        requiredTools: ['shell'],
      },
      permitted,
    );
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.issues).toHaveLength(3);
  });

  test('refuses a manifest that is not one', () => {
    const checked = checkManifest({ role: 'PLANNER' }, permitted);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.issues.length).toBeGreaterThan(0);
    expect(checked.issues.length).toBeLessThanOrEqual(5);
  });

  test('refuses an agent id that is not one', () => {
    expect(checkManifest({ ...base, id: 'planner' }, permitted).ok).toBe(false);
  });

  test('refuses an agent that claims no capability', () => {
    expect(checkManifest({ ...base, capabilities: [] }, permitted).ok).toBe(false);
  });

  test('refuses an unbounded retry count', () => {
    expect(checkManifest({ ...base, maxAttempts: 100 }, permitted).ok).toBe(false);
    expect(checkManifest({ ...base, maxAttempts: 0 }, permitted).ok).toBe(false);
  });

  test('refuses an undeclared field', () => {
    expect(checkManifest({ ...base, trusted: true }, permitted).ok).toBe(false);
  });

  test('accepts a deployment that permits nothing, by refusing everything asked', () => {
    const checked = checkManifest(base, { proposalKinds: [], permissions: [], tools: [] });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.issues).toHaveLength(2);
  });

  test('an agent that proposes nothing is valid', () => {
    const checked = checkManifest({ ...base, proposalKinds: [], reasoningProvider: null }, permitted);
    expect(checked.ok).toBe(true);
  });
});

describe('effectiveProposalKinds', () => {
  test('narrows the core set to what the agent declared', () => {
    const manifest = AgentManifest.parse(base);
    expect(effectiveProposalKinds(manifest, CORE_KINDS)).toEqual(['RECORD_BELIEF', 'RECORD_UNCERTAINTY']);
  });

  test('cannot widen past the core set, even if the manifest names more', () => {
    // A manifest that got past registration and was then edited in memory, or a
    // core that removed a kind. Either way the intersection is the answer.
    const manifest = AgentManifest.parse({ ...base, proposalKinds: [...CORE_KINDS, 'DEPLOY'] });
    expect(effectiveProposalKinds(manifest, ['RECORD_BELIEF'])).toEqual(['RECORD_BELIEF']);
  });

  test('an agent declaring nothing may propose nothing', () => {
    const manifest = AgentManifest.parse({ ...base, proposalKinds: [] });
    expect(effectiveProposalKinds(manifest, CORE_KINDS)).toEqual([]);
  });
});

describe('reasons', () => {
  test('true when the agent names a provider', () => {
    expect(reasons(AgentManifest.parse(base))).toBe(true);
  });

  test('false for a deterministic agent', () => {
    expect(reasons(AgentManifest.parse({ ...base, role: 'VERIFIER', reasoningProvider: null }))).toBe(false);
  });
});

describe('isAgentRole', () => {
  test('recognises every role on the roster', () => {
    for (const role of AGENT_ROLES) expect(isAgentRole(role)).toBe(true);
  });

  test('rejects anything else', () => {
    expect(isAgentRole('ORACLE')).toBe(false);
    expect(isAgentRole('planner')).toBe(false);
  });
});
