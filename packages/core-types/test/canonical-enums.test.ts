/**
 * The specification is the source of truth for canonical enumerations
 * (SPEC-00 section 4). This test parses the ```canonical:<Name>``` blocks out of
 * the markdown and asserts the TypeScript arrays match exactly, in order.
 *
 * Without this, the docs checker would keep the *documents* consistent with
 * each other while the code silently drifted away from both.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CANONICAL_ENUMS } from '@genesis/core-types';

const SPEC_PATH = fileURLToPath(
  new URL('../../../docs/architecture/00-MASTER-SPEC.md', import.meta.url),
);

function canonicalBlocksFromSpec(): Map<string, string[]> {
  const markdown = readFileSync(SPEC_PATH, 'utf8');
  const blocks = new Map<string, string[]>();
  const pattern = /```canonical:([A-Za-z][A-Za-z0-9_]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const name = match[1];
    const body = match[2];
    if (name === undefined || body === undefined) continue;
    blocks.set(
      name,
      body
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
  }
  return blocks;
}

describe('canonical enumerations match the specification', () => {
  const specBlocks = canonicalBlocksFromSpec();

  it('finds canonical blocks in the master spec', () => {
    expect(specBlocks.size).toBeGreaterThan(0);
  });

  it('declares a TypeScript array for every canonical block in the spec', () => {
    const specNames = [...specBlocks.keys()].sort();
    const codeNames = Object.keys(CANONICAL_ENUMS).sort();
    expect(codeNames).toEqual(specNames);
  });

  for (const [name, values] of Object.entries(CANONICAL_ENUMS)) {
    it(`${name} matches the spec exactly, including order`, () => {
      const fromSpec = specBlocks.get(name);
      expect(fromSpec, `no canonical:${name} block in the master spec`).toBeDefined();
      expect([...values]).toEqual(fromSpec);
    });
  }
});
