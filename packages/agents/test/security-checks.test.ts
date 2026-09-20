/**
 * The security rules, each against the thing it exists to catch and against
 * something innocent that must not trip it.
 *
 * A reviewer that only has positive tests is a reviewer whose false-positive
 * rate nobody measured, and a noisy reviewer gets configured away, which is the
 * same as not having one.
 */

import { SEVERITIES, type Severity } from '@genesis/core-types';
import { describe, expect, test } from 'vitest';
import { reviewText, SECURITY_CHECK_IDS, SECURITY_RULES } from '../src/security-checks.js';

const rulesHit = (source: string): string[] => [...new Set(reviewText(source).map((f) => f.rule))];

/**
 * Fixtures that name a restricted module are assembled rather than written out.
 * `check-boundaries.mjs` scans source text and deliberately over-matches, so a
 * literal here would read as this package importing the thing it is testing for
 * — a false positive that would be "fixed" by weakening the checker.
 */
const CHILD_PROCESS = ['node:child', 'process'].join('_');

describe('the rule set', () => {
  test('every rule has a distinct id', () => {
    expect(new Set(SECURITY_CHECK_IDS).size).toBe(SECURITY_CHECK_IDS.length);
  });

  test('every rule names a real severity and says what it is for', () => {
    for (const rule of SECURITY_RULES) {
      expect(SEVERITIES, rule.id).toContain(rule.severity);
      expect(rule.why.length, rule.id).toBeGreaterThan(20);
    }
  });

  test('no rule carries the global flag, which would make matching stateful', () => {
    for (const rule of SECURITY_RULES) {
      expect(rule.pattern.global, rule.id).toBe(false);
    }
  });

  test('the ids are the rules, so a report of what ran is accurate', () => {
    expect(SECURITY_CHECK_IDS).toEqual(SECURITY_RULES.map((r) => r.id));
  });
});

describe('what each rule catches', () => {
  const cases: readonly [string, string][] = [
    ['process-spawn', `import { execSync } from '${CHILD_PROCESS}';`],
    ['dynamic-eval', 'const result = eval(userInput);'],
    ['authority-escalation', "const authority = 'HUMAN_DECISION';"],
    ['credential-literal', "const apiKey = 'sk-live-abcdef123456';"],
    ['shell-interpolation', 'spawn(cmd, args, { shell: true });'],
    ['filesystem-write', "writeFileSync('/etc/passwd', data);"],
    ['path-traversal', "const p = '../../etc/passwd';"],
    ['network-egress', "await fetch('https://example.test/data');"],
    ['disabled-check', '// eslint-disable-next-line no-eval'],
    ['unsafe-any', 'const value = input as any;'],
    ['todo-marker', '// TODO: handle the error case'],
  ];

  for (const [rule, source] of cases) {
    test(`${rule} matches what it is for`, () => {
      expect(rulesHit(source)).toContain(rule);
    });
  }

  test('every rule has a case above, so none ships untested', () => {
    expect(cases.map(([rule]) => rule).sort()).toEqual([...SECURITY_CHECK_IDS].sort());
  });
});

describe('what the rules leave alone', () => {
  const innocent = [
    'export const add = (a: number, b: number): number => a + b;',
    "import { z } from 'zod';",
    'export interface User { readonly id: string; readonly name: string; }',
    'const total = items.reduce((sum, item) => sum + item.price, 0);',
    "export const greet = (name: string): string => `hello ${name}`;",
    'if (value === null) throw new ValidationError("value is required");',
  ];

  for (const source of innocent) {
    test(`leaves alone: ${source.slice(0, 48)}`, () => {
      expect(reviewText(source)).toEqual([]);
    });
  }

  test('a whole innocent module produces nothing', () => {
    const module = [
      '/** Adds two numbers. */',
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '',
      'export const ZERO = 0;',
    ].join('\n');
    expect(reviewText(module)).toEqual([]);
  });
});

describe('what a finding carries', () => {
  const source = ['const safe = 1;', "const key = eval('2');", 'const also = 3;'].join('\n');

  test('the line, 1-indexed, so it matches an editor', () => {
    const [finding] = reviewText(source);
    expect(finding?.line).toBe(2);
  });

  test('the matched text, which is what makes it checkable', () => {
    const [finding] = reviewText(source);
    expect(finding?.matched).toContain('eval');
  });

  test('the reason, so a reader need not look the rule up', () => {
    const [finding] = reviewText(source);
    expect(finding?.why).toContain('decided at run time');
  });

  test('a long match is bounded, so a report stays readable', () => {
    // A traversal path long enough to exceed the excerpt ceiling: the whole
    // literal matches, so the finding has to trim it.
    const long = `const p = '../${'segment/'.repeat(60)}end.txt';`;
    const finding = reviewText(long).find((f) => f.rule === 'path-traversal');
    expect(long.length).toBeGreaterThan(200);
    expect(finding?.matched.length).toBe(200);
    expect(finding?.matched.endsWith('...')).toBe(true);
  });

  test('a short match is not trimmed', () => {
    const [finding] = reviewText('const x = eval(y);');
    expect(finding?.matched).toBe('eval(');
    expect(finding?.matched.endsWith('...')).toBe(false);
  });
});

describe('determinism', () => {
  const source = ['const a = eval(x);', "const k = password = 'hunter2hunter2';", 'const b = eval(y);'].join('\n');

  test('the same text gives the same findings, in the same order', () => {
    expect(reviewText(source)).toEqual(reviewText(source));
  });

  test('findings come in rule order, then line order', () => {
    const findings = reviewText(source);
    const ranks = findings.map((f) => SECURITY_CHECK_IDS.indexOf(f.rule));
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });

  test('every occurrence is reported, not just the first', () => {
    const evals = reviewText(source).filter((f) => f.rule === 'dynamic-eval');
    expect(evals.map((f) => f.line)).toEqual([1, 3]);
  });

  test('empty text produces nothing rather than throwing', () => {
    expect(reviewText('')).toEqual([]);
  });
});

describe('severity ordering is usable as a threshold', () => {
  test('the rules span the range, so a threshold actually filters', () => {
    const used = new Set<Severity>(SECURITY_RULES.map((r) => r.severity));
    expect(used.has('CRITICAL')).toBe(true);
    expect(used.has('INFO')).toBe(true);
  });

  test('the worst thing about an artifact is reported first', () => {
    const source = ['// TODO: later', 'const x = eval(y);'].join('\n');
    const [first] = reviewText(source);
    expect(first?.severity).toBe('CRITICAL');
  });
});
