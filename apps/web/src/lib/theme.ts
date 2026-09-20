/**
 * One colour and one label per lane, derived from the console's own vocabulary.
 *
 * The lane list comes from `@genesis/console`, so a lane the fold can produce
 * always has somewhere to appear. Nothing here invents a category.
 */

import { LANE_LABELS, type Lane } from '@genesis/console';

export interface LaneStyle {
  /** The CSS variable holding this lane's colour. */
  readonly colour: string;
  readonly label: string;
  /** One line explaining the mandate, shown on selection. */
  readonly mandate: string;
}

export const LANE_STYLES: Readonly<Record<Lane, LaneStyle>> = {
  HUMAN: { colour: 'var(--lane-human)', label: LANE_LABELS.HUMAN, mandate: 'States intent and answers what only a person can answer.' },
  PLANNER: { colour: 'var(--lane-planner)', label: LANE_LABELS.PLANNER, mandate: 'Decomposes a goal into work. Proposes; never decides.' },
  ARCHITECT: { colour: 'var(--lane-architect)', label: LANE_LABELS.ARCHITECT, mandate: 'Shapes the change and records the constraints it must respect.' },
  RESEARCHER: { colour: 'var(--lane-system)', label: LANE_LABELS.RESEARCHER, mandate: 'Gathers evidence for questions the system cannot answer alone.' },
  BUILDER: { colour: 'var(--lane-builder)', label: LANE_LABELS.BUILDER, mandate: 'Produces artifacts. Its output is an assumption until tested.' },
  QA: { colour: 'var(--lane-qa)', label: LANE_LABELS.QA, mandate: 'Runs the tests in a sandbox and submits what actually happened.' },
  SECURITY: { colour: 'var(--lane-security)', label: LANE_LABELS.SECURITY, mandate: 'Applies deterministic checks. A blocking finding stops the change.' },
  REPAIR: { colour: 'var(--lane-repair)', label: LANE_LABELS.REPAIR, mandate: 'Diagnoses a real failure and proposes an approach to fix it.' },
  VERIFIER: { colour: 'var(--lane-verifier)', label: LANE_LABELS.VERIFIER, mandate: 'Rules on evidence. Not an agent: no model can make something verified.' },
  ARTIFACT: { colour: 'var(--lane-artifact)', label: LANE_LABELS.ARTIFACT, mandate: 'What came out, with the hash and the evidence behind it.' },
  SYSTEM: { colour: 'var(--lane-system)', label: LANE_LABELS.SYSTEM, mandate: 'The core: it records, it decides, and it is the only thing that can.' },
};

export const SEVERITY_COLOUR: Readonly<Record<string, string>> = {
  SUCCESS: 'var(--ok)',
  FAILURE: 'var(--bad)',
  WARN: 'var(--warn)',
  ACTIVE: 'var(--live)',
  INFO: 'var(--lane-system)',
};

/** How far a verification state is along the ladder, for a progress read-out. */
export const VERIFICATION_LADDER = [
  'GENERATED',
  'STATIC_CHECKED',
  'UNIT_TESTED',
  'INTEGRATION_TESTED',
  'E2E_TESTED',
  'DEPLOYED',
  'PRODUCTION_VERIFIED',
] as const;

export const ladderIndex = (state: string): number => {
  const at = (VERIFICATION_LADDER as readonly string[]).indexOf(state);
  return at < 0 ? 0 : at;
};
