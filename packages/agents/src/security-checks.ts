/**
 * The deterministic checks the Security role applies (ADR-0023 §4).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). This is the only thing in the factory that
 * can block a change on a judgement rather than on an execution result, so what
 * it claims has to be exactly what it checked.
 *
 * **What this is.** A pattern-based reviewer over the text of the artifacts in
 * one change. Every rule is a regular expression with a stated reason, and
 * every finding carries the line and the matched text, so a finding can be
 * checked rather than believed.
 *
 * **What this is not**, stated here rather than discovered later: there is no
 * dataflow analysis, no taint tracking, no dependency or CVE lookup, and no
 * sight of anything outside the artifacts under review. A clean result means
 * *these rules did not match*, which is a smaller claim than "this is safe",
 * and the report says so in those words.
 *
 * Two properties make the rules honest:
 *
 *   - **Every rule names what it is for.** A rule whose `why` does not describe
 *     a real failure is a rule that should not exist.
 *   - **Comments and strings are not exempt.** A reviewer that skipped them
 *     would miss a credential in a comment, which is where credentials
 *     habitually are.
 */

import { type Severity } from '@genesis/core-types';

export interface SecurityRule {
  readonly id: string;
  readonly severity: Severity;
  readonly pattern: RegExp;
  readonly why: string;
}

/**
 * The rules, in the order they are reported. Ordered by severity first so the
 * worst thing about an artifact is the first thing said about it.
 *
 * Each pattern is written without the global flag: matching is done per line,
 * which keeps a rule from carrying state between artifacts.
 */
export const SECURITY_RULES: readonly SecurityRule[] = [
  {
    id: 'process-spawn',
    severity: 'CRITICAL',
    pattern: /\b(?:child_process|execSync|spawnSync|\bexec\s*\(|\bspawn\s*\()/,
    why: 'starts a process, which is reach outside the sandbox that generated code has no reason to need',
  },
  {
    id: 'dynamic-eval',
    severity: 'CRITICAL',
    pattern: /(?:\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.runIn)/,
    why: 'evaluates code decided at run time, so what this artifact does cannot be read from what it says',
  },
  {
    id: 'authority-escalation',
    severity: 'CRITICAL',
    pattern: /['"`](?:HUMAN_DECISION|VERIFIED_SYSTEM_STATE)['"`]/,
    why: 'names an authority no generated artifact may assert; an agent tops out at EVIDENCE (ADR-0005)',
  },
  {
    id: 'credential-literal',
    severity: 'HIGH',
    pattern: /\b(?:api[_-]?key|secret|password|passwd|token|private[_-]?key|aws_secret)\b\s*[:=]\s*['"`][^'"`\s]{8,}/i,
    why: 'a credential-shaped literal; a real one in source is a leak and a fake one teaches the pattern',
  },
  {
    id: 'shell-interpolation',
    severity: 'HIGH',
    pattern: /(?:shell\s*:\s*true|`[^`]*\$\{[^}]*\}[^`]*`\s*\)\s*;?\s*$)/,
    why: 'builds a command from interpolated text, which is an injection waiting for an argument with a space in it',
  },
  {
    id: 'filesystem-write',
    severity: 'HIGH',
    pattern: /\b(?:writeFileSync|writeFile|appendFileSync|rmSync|unlinkSync|createWriteStream)\s*\(/,
    why: 'writes the filesystem directly, outside the sandbox and outside the core',
  },
  {
    id: 'path-traversal',
    severity: 'HIGH',
    pattern: /['"`][^'"`]*\.\.[/\\][^'"`]*['"`]/,
    why: 'a path that walks upward; containment must be decided after resolution, never by rewriting',
  },
  {
    id: 'network-egress',
    severity: 'MEDIUM',
    pattern: /\b(?:fetch\s*\(|https?\.request|new\s+WebSocket|axios\.)/,
    why: 'reaches the network, which is deny-by-default for generated code (SPEC-06)',
  },
  {
    id: 'disabled-check',
    severity: 'MEDIUM',
    pattern: /(?:eslint-disable|@ts-ignore|@ts-nocheck|istanbul\s+ignore|c8\s+ignore|v8\s+ignore)/,
    why: 'turns off a check rather than satisfying it, which is how a defect becomes invisible',
  },
  {
    id: 'unsafe-any',
    severity: 'LOW',
    pattern: /\bas\s+any\b|\bas\s+unknown\s+as\b|:\s*any\b/,
    why: 'asserts past the type system, which is where a wrong assumption stops being caught (ADR-0002)',
  },
  {
    id: 'todo-marker',
    severity: 'INFO',
    pattern: /\b(?:TODO|FIXME|XXX|HACK)\b/,
    why: 'unfinished work left in an artifact that is about to be proposed as done',
  },
];

/** The ids, for a report that has to say which checks actually ran. */
export const SECURITY_CHECK_IDS: readonly string[] = SECURITY_RULES.map((rule) => rule.id);

export interface RawFinding {
  readonly rule: string;
  readonly severity: Severity;
  readonly line: number;
  readonly matched: string;
  readonly why: string;
}

/** A match's text, trimmed and bounded, so a finding stays readable in a report. */
const excerpt = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length <= 200 ? trimmed : `${trimmed.slice(0, 197)}...`;
};

/**
 * Every rule that matches, line by line, in rule order then line order.
 *
 * Deterministic and total: the same text gives the same findings in the same
 * sequence, which is what lets a factory run be replayed and compared.
 */
export function reviewText(contents: string): readonly RawFinding[] {
  const lines = contents.split('\n');
  const findings: RawFinding[] = [];
  for (const rule of SECURITY_RULES) {
    for (const [index, line] of lines.entries()) {
      const match = rule.pattern.exec(line);
      if (match === null) continue;
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        line: index + 1,
        matched: excerpt(match[0]),
        why: rule.why,
      });
    }
  }
  return findings;
}
