/**
 * The negative ADR-0022 §4 promises: no model-specific behaviour in the domain.
 *
 * P6 kept prompts out of `packages/agents` by giving a role nothing to write
 * one with. P7 lets a role vary what it asks for, which is exactly the change
 * that could have let wording back in — so the rule is a test over the source
 * of both domain packages rather than a convention.
 *
 * Read the source rather than the module surface, because the thing being
 * excluded is a string constant nobody exports.
 */

import { REASONING_PURPOSES } from '@genesis/core-types';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * Comments removed before scanning.
 *
 * The rule is about code. A comment saying "no temperature, no model id" is the
 * rule being documented, not broken, and a test that could not tell the
 * difference would push the explanation out of the source to stay green.
 */
const codeOnly = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Source files of a package, production only: tests may name anything. */
const sourcesOf = (pkg: string): { path: string; text: string }[] => {
  const dir = fileURLToPath(new URL(`../../${pkg}/src/`, import.meta.url));
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ path: `${pkg}/src/${name}`, text: codeOnly(readFileSync(dir + name, 'utf8')) }));
};

const DOMAIN = [...sourcesOf('agents'), ...sourcesOf('protocol')];

describe('the domain packages name no model', () => {
  const vendors = ['claude', 'gpt-', 'bedrock', 'anthropic', 'openai', 'llama', 'mistral', 'titan'];

  for (const vendor of vendors) {
    test(`no source mentions ${vendor}`, () => {
      for (const file of DOMAIN) {
        expect(file.text.toLowerCase(), file.path).not.toContain(vendor);
      }
    });
  }
});

describe('the domain packages carry no sampling parameter', () => {
  const knobs = ['temperature', 'top_p', 'topP', 'top_k', 'topK', 'presence_penalty', 'frequency_penalty', 'stopSequences'];

  for (const knob of knobs) {
    test(`no source declares ${knob}`, () => {
      for (const file of DOMAIN) {
        expect(file.text, file.path).not.toContain(knob);
      }
    });
  }
});

describe('the domain packages hold no system prompt', () => {
  /**
   * A prompt is recognisable: it addresses the model in the second person. A
   * role that wanted to steer a model would have to write one of these.
   */
  const promptShapes = [/\bYou are the\b/, /\bYou must\b/, /\bYou may propose\b/, /\bsystem:\s*['"`]/, /\bsystemPrompt\b/];

  for (const shape of promptShapes) {
    test(`no source contains ${String(shape)}`, () => {
      for (const file of DOMAIN) {
        expect(shape.test(file.text), `${file.path} matches ${String(shape)}`).toBe(false);
      }
    });
  }

  test('a role names a purpose instead, and only a canonical one', () => {
    const roles = DOMAIN.find((f) => f.path === 'agents/src/factory-roles.ts');
    expect(roles).toBeDefined();
    const named = REASONING_PURPOSES.filter((p) => roles?.text.includes(`'${p}'`));
    expect(named.length).toBeGreaterThan(0);
    // Every purpose it names is one the canonical set declares, by construction
    // of the filter — and it names no string in a `purpose:` position that is
    // not one of them.
    const positions = [...(roles?.text.matchAll(/purpose:\s*'([^']+)'/g) ?? [])].map((m) => m[1]);
    expect(positions.length).toBeGreaterThan(0);
    for (const position of positions) {
      expect(REASONING_PURPOSES, `purpose: '${String(position)}'`).toContain(position);
    }
  });
});

describe('the domain packages reach nothing that writes', () => {
  const forbidden = ['ledger', 'memory', 'graph', 'cognition', 'context', 'core', 'experiment', 'verification', 'reasoning', 'factory'];

  test('no agents source imports a package that can write or call a model', () => {
    for (const file of sourcesOf('agents')) {
      for (const name of forbidden) {
        expect(file.text, `${file.path} imports @genesis/${name}`).not.toContain(`@genesis/${name}'`);
      }
    }
  });

  test('protocol imports only the shared vocabulary', () => {
    for (const file of sourcesOf('protocol')) {
      const imports = [...file.text.matchAll(/from '(@genesis\/[^']+)'/g)].map((m) => m[1]);
      for (const imported of imports) {
        expect(imported, file.path).toBe('@genesis/core-types');
      }
    }
  });
});
