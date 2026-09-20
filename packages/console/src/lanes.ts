/**
 * Which part of the system an event belongs to.
 *
 * A console has to answer "who did this?" for every event, and the ledger does
 * not always say directly: `AGENT_TASK_STATE_CHANGED` carries a task id and no
 * role, `REASONING_RESPONDED` carries a call id and no task. The answer is
 * derived by remembering what earlier events said, never by guessing from the
 * event type alone — which is the difference between a timeline a person can
 * trust and one that merely looks busy.
 *
 * A lane is a presentation concept and nothing else. Nothing in the system
 * branches on it, nothing is stored under it, and a wrong lane misleads a
 * reader without changing what the system believes.
 */

import { type AgentRole, type FactoryStage } from '@genesis/core-types';

/**
 * The lanes a console shows.
 *
 * Every agent role is a lane, plus three that are not agents: the human who
 * asked, the core that recorded, and the artifact that came out. `VERIFIER` is
 * a lane with no agent behind it — verification is the engine's, from evidence
 * (ADR-0023 §5), and showing it as an agent would suggest something decided it.
 */
export const LANES = [
  'HUMAN',
  'PLANNER',
  'ARCHITECT',
  'RESEARCHER',
  'BUILDER',
  'QA',
  'SECURITY',
  'REPAIR',
  'VERIFIER',
  'ARTIFACT',
  'SYSTEM',
] as const;
export type Lane = (typeof LANES)[number];

/** The lanes that are agent roles, in pipeline order. The console draws these. */
export const AGENT_LANES: readonly Lane[] = ['PLANNER', 'ARCHITECT', 'BUILDER', 'QA', 'SECURITY', 'REPAIR', 'VERIFIER'];

/**
 * Which lane owns a stage when no agent role is available.
 *
 * Taken from what the factory actually assigns, not from the stage's name:
 * `DIAGNOSE` runs the Repair agent and `REPAIR` runs the Builder, because
 * diagnosing is reasoning about a failure and repairing is producing an
 * artifact. A mapping that read `REPAIR → REPAIR` would be tidier and wrong.
 */
export const STAGE_LANES: Readonly<Record<FactoryStage, Lane>> = {
  PLAN: 'PLANNER',
  ARCHITECT: 'ARCHITECT',
  BUILD: 'BUILDER',
  TEST: 'QA',
  SECURITY_REVIEW: 'SECURITY',
  DIAGNOSE: 'REPAIR',
  REPAIR: 'BUILDER',
  VERIFY: 'VERIFIER',
};

/** An agent role is its own lane. Every role in the roster has one. */
export const laneOfRole = (role: AgentRole | string): Lane =>
  (LANES as readonly string[]).includes(role) ? (role as Lane) : 'SYSTEM';

/** What a stage is called in a sentence a person reads. */
export const STAGE_LABELS: Readonly<Record<FactoryStage, string>> = {
  PLAN: 'Plan',
  ARCHITECT: 'Architect',
  BUILD: 'Build',
  TEST: 'Test',
  SECURITY_REVIEW: 'Security review',
  DIAGNOSE: 'Diagnose',
  REPAIR: 'Repair',
  VERIFY: 'Verify',
};

export const LANE_LABELS: Readonly<Record<Lane, string>> = {
  HUMAN: 'Human',
  PLANNER: 'Planner',
  ARCHITECT: 'Architect',
  RESEARCHER: 'Researcher',
  BUILDER: 'Builder',
  QA: 'QA',
  SECURITY: 'Security',
  REPAIR: 'Repair',
  VERIFIER: 'Verifier',
  ARTIFACT: 'Artifact',
  SYSTEM: 'Core',
};
