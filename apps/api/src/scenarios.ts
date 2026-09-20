/**
 * The reasoning behind a demo run.
 *
 * GENESIS talks to a model through the `ReasoningProvider` port (ADR-0007). In
 * a deployment that is Bedrock; here it is the repository's own deterministic
 * provider, because a demo that needed cloud credentials would not run and a
 * demo that needed a live model would not be reproducible.
 *
 * What this is NOT is a simulation of the system. Nothing below fakes a stage,
 * a verdict, an event or a delay. Each scenario supplies only what a model
 * would supply — the text of an answer — and everything that follows is the
 * real factory: real agents, a real sandbox running real `node`, real evidence,
 * a real verification engine, and a real hash-chained ledger. Changing the
 * answers below changes what the system decides, exactly as a different model
 * would.
 *
 * Answers are keyed on the request's PURPOSE rather than on call order, so a
 * scenario keeps meaning the same thing if the pipeline's shape changes.
 */

import type { MockStep } from '@genesis/reasoning';

export const SCENARIOS = ['verified', 'repair', 'security'] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

export interface ScenarioInfo {
  readonly name: ScenarioName;
  readonly label: string;
  readonly description: string;
  /** What the run is expected to end as. The system decides; this is the intent. */
  readonly expected: 'VERIFIED' | 'BLOCKED';
}

export const SCENARIO_INFO: readonly ScenarioInfo[] = [
  {
    name: 'verified',
    label: 'Clean build',
    description: 'The builder gets it right first time. Tests pass, security finds nothing, the artifact is verified on evidence.',
    expected: 'VERIFIED',
  },
  {
    name: 'repair',
    label: 'Failure and repair',
    description: 'The builder ships a real bug. The test genuinely fails, the failure is diagnosed, a repair is built, and the checks run again before anything is verified.',
    expected: 'VERIFIED',
  },
  {
    name: 'security',
    label: 'Security block',
    description: 'The builder reaches for process execution. The security review finds it and the change is blocked, whatever the tests say.',
    expected: 'BLOCKED',
  },
];

/** A module name derived from what the person asked for. */
export function slugOf(intent: string): string {
  const slug = intent
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter((word) => !['a', 'an', 'the', 'for', 'to', 'of', 'build', 'small'].includes(word))
    .slice(0, 3)
    .join('-');
  return slug.length === 0 ? 'module' : slug;
}

export interface ScenarioPlan {
  /** Where the artifact is written, inside the sandbox working directory. */
  readonly path: string;
  /** The command the sandbox runs. Real `node`, exercising the real artifact. */
  readonly testCommand: readonly string[];
  /** Answers the model gives, by purpose. */
  readonly script: (purpose: string, call: number) => MockStep;
}

/**
 * The module a scenario builds.
 *
 * A small, genuinely testable unit: the point of the demo is the pipeline, and
 * a unit whose correctness a sandbox can settle in milliseconds is what lets
 * the verification be real rather than asserted.
 */
const moduleFor = (slug: string, correct: boolean): string =>
  correct
    ? `// ${slug}: capacity planning for the sessions a centre can run.\nexports.capacity = (rooms, hoursPerRoom) => rooms * hoursPerRoom;\n`
    : `// ${slug}: capacity planning for the sessions a centre can run.\nexports.capacity = (rooms, hoursPerRoom) => rooms + hoursPerRoom;\n`;

/** The unsafe variant. It is unsafe in the way the security rules actually look for. */
const unsafeModule = (slug: string): string => {
  // Assembled rather than written out: `check-boundaries.mjs` scans source text
  // and deliberately over-matches, so a literal module name here would read as
  // this app importing it.
  const restricted = ['node:child', 'process'].join('_');
  return `// ${slug}: capacity planning.\nconst { execSync } = require('${restricted}');\nexports.capacity = (rooms, hoursPerRoom) => rooms * hoursPerRoom;\n`;
};

const artifactStep = (path: string, contents: string): MockStep => ({ output: { artifacts: [{ path, contents }] } });

const NO_PROPOSALS: MockStep = { output: { proposals: [] } };

const DIAGNOSIS: MockStep = {
  output: {
    rootCause: 'capacity adds the two inputs instead of multiplying them',
    targetArtifacts: ['capacity'],
    approach: 'multiply rooms by hours per room',
    confidence: 0.82,
  },
};

/**
 * Builds the plan for a scenario.
 *
 * The test command requires the built module and asserts a property of it, so
 * the sandbox result is evidence about this artifact and nothing else — which
 * is what lets the verification engine attribute it (SPEC-05 §4).
 */
export function planFor(scenario: ScenarioName, intent: string): ScenarioPlan {
  const slug = slugOf(intent);
  const path = `src/${slug}.js`;
  const testCommand = [
    'node',
    '-e',
    `const m=require("./${path}");if(m.capacity(3,4)!==12){console.log("${path} failed: expected 12, got "+m.capacity(3,4));process.exit(1)}console.log("${path} ok")`,
  ];

  if (scenario === 'security') {
    return {
      path,
      testCommand,
      script: (purpose) => (purpose === 'PRODUCE_ARTIFACT' ? artifactStep(path, unsafeModule(slug)) : NO_PROPOSALS),
    };
  }

  if (scenario === 'repair') {
    let builds = 0;
    return {
      path,
      testCommand,
      script: (purpose) => {
        if (purpose === 'DIAGNOSE_FAILURE') return DIAGNOSIS;
        if (purpose !== 'PRODUCE_ARTIFACT') return NO_PROPOSALS;
        builds += 1;
        // The first build is genuinely wrong: the test below really fails on
        // it, and the repair really fixes it.
        return artifactStep(path, moduleFor(slug, builds > 1));
      },
    };
  }

  return {
    path,
    testCommand,
    script: (purpose) => (purpose === 'PRODUCE_ARTIFACT' ? artifactStep(path, moduleFor(slug, true)) : NO_PROPOSALS),
  };
}
