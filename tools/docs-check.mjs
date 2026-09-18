#!/usr/bin/env node
/**
 * GENESIS documentation consistency checker.
 *
 * WHAT THIS CHECKS
 *   1. Every required document exists.
 *   2. Every required section heading is present in each document.
 *   3. Canonical enumerations (```canonical:Name blocks) are byte-identical
 *      everywhere they appear, and every one is declared in the master spec.
 *   4. Internal markdown links resolve — file targets and heading anchors.
 *   5. Every ADR file is listed in the ADR index.
 *   6. The honesty sections required by SPEC-00 §1.1 are present.
 *
 * WHAT THIS DOES NOT CHECK
 *   Whether the architecture is correct, coherent in substance, or a good idea.
 *   This is a consistency checker, not a reviewer. Passing it means the
 *   documents do not contradict each other mechanically. It means nothing
 *   about whether they are right.
 *
 * Usage:  node tools/docs-check.mjs
 * Exit:   0 = all checks passed, 1 = at least one failure.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ARCH = 'docs/architecture';
const ADR = 'docs/adr';
const AUDIT = 'docs/audit';

/** Documents that must exist, with the section headings each must contain. */
const REQUIRED_DOCS = {
  'README.md': ['What it does not claim', 'Documentation', 'Roadmap'],
  [`${ARCH}/00-MASTER-SPEC.md`]: [
    'Honesty constraints',
    'Architectural principle',
    'The core cognitive loop',
    'Canonical enumerations',
    'Canonical project state',
    'Project tree',
    'Event ledger',
    'Phasing',
    'Glossary',
  ],
  [`${ARCH}/01-COGNITIVE-ARCHITECTURE.md`]: [
    'The cycle',
    'World model',
    'Self model',
    'Goal system',
    'Belief system',
    'Uncertainty engine',
    'Contradiction engine',
    'Question engine',
    'Experiment engine',
    'Context assembly',
  ],
  [`${ARCH}/02-MEMORY-ARCHITECTURE.md`]: [
    'Memory classes',
    'Record schema',
    'Authority hierarchy',
    'Contradiction handling',
    'Lifecycle',
    'Store interface',
    'Storage mapping',
  ],
  [`${ARCH}/03-GRAPH-ARCHITECTURE.md`]: [
    'Node types',
    'Edge types',
    'Invariants',
    'Query surface',
    'Storage mapping',
  ],
  [`${ARCH}/04-AGENT-ARCHITECTURE.md`]: [
    'Agent roster',
    'Message protocol',
    'Proposal protocol',
    'Agent execution environment',
  ],
  [`${ARCH}/05-VERIFICATION-ARCHITECTURE.md`]: [
    'Verification states',
    'Change lifecycle',
    'Evidence rules',
    'Test taxonomy',
  ],
  [`${ARCH}/06-SECURITY-ARCHITECTURE.md`]: [
    'Threat model',
    'Permission model',
    'Sandboxing',
    'Secret handling',
    'Authorization gates',
  ],
  [`${ARCH}/07-AWS-ARCHITECTURE.md`]: [
    'Service responsibilities',
    'adapter mapping',
    'Services considered and rejected',
  ],
  [`${ADR}/README.md`]: ['Index'],
  [`${AUDIT}/PRE-BUILD-ARCHITECTURE-AUDIT.md`]: [
    'Files created',
    'Architecture decisions',
    'Contradictions found',
    'Risks',
    'Missing decisions',
    'Recommended next implementation milestone',
  ],
};

/** The document that is the authoritative source of canonical enumerations. */
const ENUM_SOURCE = `${ARCH}/00-MASTER-SPEC.md`;

const failures = [];
const notes = [];
const fail = (check, msg) => failures.push({ check, msg });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listMarkdownFiles(dir) {
  const out = [];
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs)) {
    const full = join(abs, entry);
    if (statSync(full).isDirectory()) out.push(...listMarkdownFiles(join(dir, entry)));
    else if (entry.endsWith('.md')) out.push(join(dir, entry).split('\\').join('/'));
  }
  return out;
}

function allDocs() {
  const set = new Set(['README.md', ...listMarkdownFiles('docs')]);
  return [...set].filter((p) => existsSync(join(ROOT, p))).sort();
}

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/** Strip fenced code blocks so their contents never match headings or links. */
function stripFences(text) {
  return text.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, ' '));
}

function headings(text) {
  const out = [];
  for (const line of stripFences(text).split('\n')) {
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (m) out.push(m[2]);
  }
  return out;
}

/** GitHub-style anchor slug. */
function slug(heading) {
  return heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/[^\p{L}\p{N} \-_]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

function canonicalBlocks(text) {
  const out = [];
  const re = /```canonical:([A-Za-z][A-Za-z0-9_]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({
      name: m[1],
      values: m[2].split('\n').map((l) => l.trim()).filter(Boolean),
    });
  }
  return out;
}

function markdownLinks(text) {
  const out = [];
  const re = /\[[^\]]*\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(stripFences(text))) !== null) out.push(m[1]);
  return out;
}

// ---------------------------------------------------------------------------
// Check 1 & 2 — required documents and sections
// ---------------------------------------------------------------------------

for (const [doc, sections] of Object.entries(REQUIRED_DOCS)) {
  if (!existsSync(join(ROOT, doc))) {
    fail('required-docs', `missing required document: ${doc}`);
    continue;
  }
  const hs = headings(read(doc)).map((h) => h.toLowerCase());
  for (const section of sections) {
    if (!hs.some((h) => h.includes(section.toLowerCase()))) {
      fail('required-sections', `${doc}: no heading containing "${section}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Check 3 — canonical enumerations
// ---------------------------------------------------------------------------

const docs = allDocs();
/** name -> [{ doc, values }] */
const enums = new Map();

for (const doc of docs) {
  for (const block of canonicalBlocks(read(doc))) {
    if (!enums.has(block.name)) enums.set(block.name, []);
    enums.get(block.name).push({ doc, values: block.values });
  }
}

if (enums.size === 0) fail('canonical-enums', 'no canonical enumeration blocks found at all');

const sourceEnumNames = new Set(
  existsSync(join(ROOT, ENUM_SOURCE)) ? canonicalBlocks(read(ENUM_SOURCE)).map((b) => b.name) : [],
);

for (const [name, occurrences] of enums) {
  if (!sourceEnumNames.has(name)) {
    fail('canonical-enums', `enum "${name}" is used but not declared in ${ENUM_SOURCE}`);
  }
  const reference = occurrences[0];
  for (const occ of occurrences.slice(1)) {
    if (occ.values.join('|') !== reference.values.join('|')) {
      fail(
        'canonical-enums',
        `enum "${name}" differs between ${reference.doc} and ${occ.doc}\n` +
          `      ${reference.doc}: [${reference.values.join(', ')}]\n` +
          `      ${occ.doc}: [${occ.values.join(', ')}]`,
      );
    }
  }
  notes.push(
    `enum ${name}: ${reference.values.length} values, ${occurrences.length} occurrence(s) — consistent`,
  );
}

// ---------------------------------------------------------------------------
// Check 4 — internal links resolve (files and anchors)
// ---------------------------------------------------------------------------

const anchorCache = new Map();
function anchorsOf(relPath) {
  if (!anchorCache.has(relPath)) {
    anchorCache.set(relPath, new Set(headings(read(relPath)).map(slug)));
  }
  return anchorCache.get(relPath);
}

let linkCount = 0;
for (const doc of docs) {
  const base = dirname(join(ROOT, doc));
  for (const link of markdownLinks(read(doc))) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue; // external scheme
    linkCount++;

    const [targetRaw, anchor] = link.split('#');
    if (targetRaw === '') {
      // same-document anchor
      if (anchor && !anchorsOf(doc).has(anchor)) {
        fail('links', `${doc}: anchor "#${anchor}" not found in this document`);
      }
      continue;
    }

    const targetAbs = resolve(base, targetRaw);
    if (!existsSync(targetAbs)) {
      fail('links', `${doc}: broken link "${link}" -> ${relative(ROOT, targetAbs)}`);
      continue;
    }
    if (anchor && targetAbs.endsWith('.md')) {
      const targetRel = relative(ROOT, targetAbs).split('\\').join('/');
      if (!anchorsOf(targetRel).has(anchor)) {
        fail('links', `${doc}: link "${link}" resolves, but anchor "#${anchor}" is not a heading in ${targetRel}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Check 5 — ADR index completeness
// ---------------------------------------------------------------------------

const adrIndexPath = `${ADR}/README.md`;
if (existsSync(join(ROOT, adrIndexPath))) {
  const index = read(adrIndexPath);
  const adrFiles = listMarkdownFiles(ADR)
    .map((p) => p.split('/').pop())
    .filter((f) => f !== 'README.md');
  for (const file of adrFiles) {
    if (!index.includes(file)) fail('adr-index', `${adrIndexPath} does not link ${file}`);
  }
  if (adrFiles.length === 0) fail('adr-index', 'no ADR files found');
  notes.push(`ADRs: ${adrFiles.length} indexed`);
}

// ---------------------------------------------------------------------------
// Check 6 — honesty statements present
// ---------------------------------------------------------------------------

const honesty = [
  [`${ARCH}/00-MASTER-SPEC.md`, 'Generation is not verification'],
  [`${ARCH}/00-MASTER-SPEC.md`, 'No fake functionality'],
  [`${ARCH}/05-VERIFICATION-ARCHITECTURE.md`, 'Generation is not verification'],
  ['README.md', 'not** conscious'],
];
for (const [doc, phrase] of honesty) {
  if (existsSync(join(ROOT, doc)) && !read(doc).includes(phrase)) {
    fail('honesty', `${doc}: required honesty statement missing ("${phrase}")`);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log('GENESIS documentation check');
console.log('─'.repeat(60));
console.log(`documents scanned : ${docs.length}`);
console.log(`internal links    : ${linkCount}`);
for (const n of notes) console.log(`  · ${n}`);
console.log('─'.repeat(60));

if (failures.length === 0) {
  console.log('PASS — no inconsistencies found.');
  console.log('(Consistency only. This says nothing about whether the architecture is correct.)');
  process.exit(0);
}

const byCheck = new Map();
for (const f of failures) {
  if (!byCheck.has(f.check)) byCheck.set(f.check, []);
  byCheck.get(f.check).push(f.msg);
}
for (const [check, msgs] of byCheck) {
  console.error(`\n[${check}] ${msgs.length} failure(s)`);
  for (const m of msgs) console.error(`  ✗ ${m}`);
}
console.error(`\nFAIL — ${failures.length} inconsistency/inconsistencies found.`);
process.exit(1);
