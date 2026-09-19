#!/usr/bin/env node
/**
 * Enforces the package dependency rules from ADR-0001.
 *
 * WHY THIS EXISTS
 *
 * The architecture's central safety property — "agents cannot write canonical
 * state" (ADR-0006) — is enforced three ways: package boundaries, the type
 * system, and a conformance test. This tool is the first of those. Without it,
 * the boundary is a comment in an ADR, and the first time somebody needs "just
 * one read" from the store the import gets added and the guarantee is gone,
 * silently.
 *
 * WHAT IT CHECKS
 *   1. Every workspace import a package makes is declared in its package.json.
 *   2. Every workspace import is permitted by the rules below.
 *   3. Restricted external modules are imported only where allowed
 *      (node:sqlite lives in adapters-sqlite alone — ADR-0010 constraint 1).
 *   4. No production file imports its own package by name, which hides cycles.
 *
 * PRODUCTION CODE vs TESTS
 *
 * The boundary that matters is what PRODUCTION code can reach: an agent that
 * cannot import a store cannot write to one. Test files are held to a looser
 * rule — they may import their own package by name (which is how a package is
 * tested through its public surface) and they may import the conformance
 * suites. A test handing an agent a store handle to prove the write is refused
 * is the conformance test ADR-0006 calls for, not a violation of it.
 *
 * Restricted externals are enforced everywhere, tests included.
 *
 * WHAT IT DOES NOT CHECK
 *   Runtime behaviour. A package that is *allowed* to import the store can
 *   still misuse it; that is what the conformance tests are for.
 *
 * Usage:  node tools/check-boundaries.mjs
 * Exit:   0 = all boundaries respected, 1 = at least one violation.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = join(ROOT, 'packages');

/**
 * Which workspace packages each package may depend on.
 *
 * The rule that matters most is the `agents` entry: it may depend on the
 * protocol and the shared types, and on NOTHING that can write state. That is
 * what makes "an agent cannot mutate canonical state" a property of the
 * package graph rather than a promise.
 */
const ALLOWED_WORKSPACE_DEPS = {
  'core-types': [],
  protocol: [],
  ledger: ['core-types'],
  memory: ['core-types'],
  graph: ['core-types'],
  // Projections fold ledger events. No stores: a projector that could read
  // one would depend on something other than the ledger (ADR-0013 rule 6).
  projections: ['core-types', 'ledger'],
  // Cognitive primitives are deciders over the ledger (ADR-0014). No stores:
  // a decider that read a second store would have a second input.
  cognition: ['core-types', 'ledger', 'projections'],
  'adapters-sqlite': ['core-types', 'ledger', 'memory', 'graph', 'projections'],
  'adapters-aws': ['core-types', 'ledger', 'memory', 'graph', 'projections'],
  reasoning: ['core-types'],
  sandbox: ['core-types'],
  core: [
      'core-types',
      'protocol',
      'ledger',
      'memory',
      'graph',
      'projections',
      'cognition',
      'reasoning',
      'sandbox',
    ],
  testkit: ['core-types', 'protocol', 'ledger', 'memory', 'graph', 'projections', 'cognition'],
  // Agents get the protocol and the types. No stores, no core, no adapters.
  agents: ['core-types', 'protocol', 'testkit'],
};

/** External modules that may only be imported from specific packages. */
const RESTRICTED_EXTERNALS = {
  'node:sqlite': ['adapters-sqlite'],
};

const violations = [];
const notes = [];

function listPackages() {
  if (!existsSync(PACKAGES_DIR)) return [];
  return readdirSync(PACKAGES_DIR).filter((name) =>
    statSync(join(PACKAGES_DIR, name)).isDirectory(),
  );
}

function sourceFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts') || entry.endsWith('.mts')) out.push(full);
  }
  return out;
}

/**
 * Extracts module specifiers.
 *
 * Regex rather than a parser: this runs on every commit and must not need a
 * dependency of its own. It deliberately over-matches rather than under-matches
 * — a false positive is a visible failure someone investigates, a false
 * negative is a boundary that quietly stopped being enforced.
 */
function importedSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g, // import ... from 'x'  /  export ... from 'x'
    /\bimport\s+['"]([^'"]+)['"]/g, // import 'x'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import('x')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require('x')
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) specifiers.add(match[1]);
  }
  return [...specifiers];
}

const packages = listPackages();
const known = new Set(packages);

if (packages.length === 0) {
  console.error('no packages found under packages/ — nothing to check');
  process.exit(1);
}

for (const pkg of packages) {
  const pkgDir = join(PACKAGES_DIR, pkg);
  const manifestPath = join(pkgDir, 'package.json');

  if (!existsSync(manifestPath)) {
    violations.push({ pkg, message: 'has no package.json' });
    continue;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const declared = new Set(
    [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]
      .filter((name) => name.startsWith('@genesis/'))
      .map((name) => name.slice('@genesis/'.length)),
  );

  const allowed = ALLOWED_WORKSPACE_DEPS[pkg];
  if (allowed === undefined) {
    violations.push({
      pkg,
      message: `is not listed in ALLOWED_WORKSPACE_DEPS. Add it with an explicit rule — a new package must state what it may depend on before it may depend on anything.`,
    });
    continue;
  }
  const allowedSet = new Set(allowed);
  // Test files may additionally reach the package's own public surface and the
  // shared conformance suites. See the header note.
  const testAllowedSet = new Set([...allowed, pkg, 'testkit']);

  // Declared but not permitted: caught even if no file imports it yet.
  // Manifests cannot distinguish production from test use, so the declaration
  // check uses the looser set; a test-only dependency reaching production code
  // is still caught per-file below.
  for (const dep of declared) {
    if (!testAllowedSet.has(dep)) {
      violations.push({
        pkg,
        message: `declares a dependency on @genesis/${dep}, which ADR-0001 does not permit (allowed: ${allowed.length > 0 ? allowed.map((d) => `@genesis/${d}`).join(', ') : 'none'})`,
      });
    }
  }

  const files = sourceFiles(pkgDir);
  for (const file of files) {
    const rel = relative(ROOT, file).split('\\').join('/');
    const isTest = /(^|\/)test\//.test(rel) || rel.endsWith('.test.ts');
    const applicable = isTest ? testAllowedSet : allowedSet;
    const source = readFileSync(file, 'utf8');

    for (const specifier of importedSpecifiers(source)) {
      const restrictedTo = RESTRICTED_EXTERNALS[specifier];
      if (restrictedTo !== undefined && !restrictedTo.includes(pkg)) {
        violations.push({
          pkg,
          message: `${rel} imports "${specifier}", which is restricted to: ${restrictedTo.join(', ')}`,
        });
      }

      if (!specifier.startsWith('@genesis/')) continue;

      const target = specifier.slice('@genesis/'.length).split('/')[0];

      if (target === pkg) {
        // Production code importing itself by name hides a cycle. A test doing
        // it is exercising the public surface, which is the point.
        if (!isTest) {
          violations.push({ pkg, message: `${rel} imports its own package by name` });
        }
        continue;
      }
      if (!known.has(target)) {
        violations.push({ pkg, message: `${rel} imports unknown workspace package "${specifier}"` });
        continue;
      }
      if (!applicable.has(target)) {
        violations.push({
          pkg,
          message: `${rel} imports @genesis/${target}, which ADR-0001 does not permit for this package`,
        });
        continue;
      }
      if (!declared.has(target)) {
        violations.push({
          pkg,
          message: `${rel} imports @genesis/${target} but package.json does not declare it`,
        });
      }
    }
  }

  notes.push(`${pkg}: ${files.length} source file(s), ${declared.size} workspace dep(s)`);
}

console.log('GENESIS package boundary check');
console.log('─'.repeat(60));
console.log(`packages checked : ${packages.length}`);
for (const note of notes) console.log(`  · ${note}`);
console.log('─'.repeat(60));

if (violations.length === 0) {
  console.log('PASS — every package import respects ADR-0001.');
  process.exit(0);
}

for (const violation of violations) {
  console.error(`  ✗ [${violation.pkg}] ${violation.message}`);
}
console.error(`\nFAIL — ${violations.length} boundary violation(s).`);
process.exit(1);
