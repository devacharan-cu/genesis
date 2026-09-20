/**
 * The pipeline: which stage follows which, and what may not be skipped
 * (ADR-0023 §2).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). This is a table rather than a series of
 * conditionals, because the properties that matter have to be *provable* rather
 * than argued about:
 *
 *   - a repaired change re-enters at `TEST`, never at `VERIFY`, so a fix nobody
 *     checked cannot be verified;
 *   - `VERIFY` is reachable only from `SECURITY_REVIEW`, so nothing is verified
 *     that was not reviewed;
 *   - every stage is reachable from `PLAN`, so no stage is decoration.
 *
 * Each is asserted directly over this table, so adding a shortcut fails a test
 * rather than quietly widening what the factory will accept.
 */

import { FACTORY_STAGES, type FactoryStage } from '@genesis/core-types';

/** Where a stage may go when it succeeds. `null` means the run is done. */
export const ON_SUCCESS: Readonly<Record<FactoryStage, FactoryStage | null>> = {
  PLAN: 'ARCHITECT',
  ARCHITECT: 'BUILD',
  BUILD: 'TEST',
  TEST: 'SECURITY_REVIEW',
  SECURITY_REVIEW: 'VERIFY',
  DIAGNOSE: 'REPAIR',
  // The one that matters: a repair goes back through the checks, not past them.
  REPAIR: 'TEST',
  VERIFY: null,
};

/**
 * Where a stage goes when it fails.
 *
 * `null` means the failure is not repairable by this factory and the run is
 * blocked. Planning and architecture are not repaired by the Repair role: a
 * plan the model could not produce is not a defect with a root cause, it is a
 * task that needs a person.
 */
export const ON_FAILURE: Readonly<Record<FactoryStage, FactoryStage | null>> = {
  PLAN: null,
  ARCHITECT: null,
  BUILD: 'DIAGNOSE',
  TEST: 'DIAGNOSE',
  SECURITY_REVIEW: 'DIAGNOSE',
  DIAGNOSE: null,
  REPAIR: null,
  VERIFY: 'DIAGNOSE',
};

export const FIRST_STAGE: FactoryStage = 'PLAN';

/** The stages a repair cycle passes through. A repair that skipped one is a bug. */
export const REPAIR_CYCLE: readonly FactoryStage[] = ['DIAGNOSE', 'REPAIR', 'TEST', 'SECURITY_REVIEW', 'VERIFY'];

/** Stages that run an agent that reasons. The rest are deterministic. */
export const REASONING_STAGES: readonly FactoryStage[] = ['PLAN', 'ARCHITECT', 'BUILD', 'DIAGNOSE'];

/** True when this stage's work is decided by rules rather than by a model. */
export const isDeterministic = (stage: FactoryStage): boolean => !REASONING_STAGES.includes(stage);

/**
 * Every stage reachable from the first, by following both edges. Used to prove
 * the table has no orphan.
 */
export const reachableStages = (): readonly FactoryStage[] => {
  const seen = new Set<FactoryStage>([FIRST_STAGE]);
  const queue: FactoryStage[] = [FIRST_STAGE];
  for (let i = 0; i < queue.length; i += 1) {
    const stage = queue[i] as FactoryStage;
    for (const next of [ON_SUCCESS[stage], ON_FAILURE[stage]]) {
      if (next !== null && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return FACTORY_STAGES.filter((stage) => seen.has(stage));
};

/** Every stage that can lead to `VERIFY`, directly. */
export const stagesLeadingToVerify = (): readonly FactoryStage[] =>
  FACTORY_STAGES.filter((stage) => ON_SUCCESS[stage] === 'VERIFY' || ON_FAILURE[stage] === 'VERIFY');

export const FACTORY_OUTCOMES = ['VERIFIED', 'BLOCKED', 'FAILED', 'CANCELLED'] as const;
export type FactoryOutcomeKind = (typeof FACTORY_OUTCOMES)[number];

/**
 * How a run ends when a stage has nowhere to go.
 *
 * A stage that failed with no repair path leaves the run `BLOCKED`, not
 * `FAILED`: the work exists, it is recorded, and a person can pick it up. The
 * factory reserves `FAILED` for its own inability to run the stage at all.
 */
export const outcomeOfDeadEnd = (stage: FactoryStage): FactoryOutcomeKind =>
  stage === 'VERIFY' ? 'VERIFIED' : 'BLOCKED';
