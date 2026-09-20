/**
 * A factory run's record on the ledger (ADR-0023 §1).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). A factory run spans many agent tasks, and
 * each of those is already recorded by the runtime and the orchestrator. These
 * events add only what those cannot say: which stage a run is in, what lease
 * that stage took, what it concluded, and how the run ended.
 *
 * Nothing here duplicates a task's record. A stage names the task it ran, and a
 * reader follows the id rather than reading a second copy that could disagree.
 */

import { FACTORY_STAGES, SEVERITIES, VERIFICATION_STATES } from '@genesis/core-types';
import { z } from 'zod';
import { FACTORY_OUTCOMES } from './pipeline.js';

export const FACTORY_EVENTS = {
  FACTORY_RUN_STARTED: 'FACTORY_RUN_STARTED',
  FACTORY_STAGE_ENTERED: 'FACTORY_STAGE_ENTERED',
  FACTORY_STAGE_SETTLED: 'FACTORY_STAGE_SETTLED',
  FACTORY_LEASE_STALE: 'FACTORY_LEASE_STALE',
  FACTORY_CHANGE_BLOCKED: 'FACTORY_CHANGE_BLOCKED',
  FACTORY_ARTIFACT_VERIFIED: 'FACTORY_ARTIFACT_VERIFIED',
  FACTORY_RUN_FINISHED: 'FACTORY_RUN_FINISHED',
} as const;
export type FactoryEventType = (typeof FACTORY_EVENTS)[keyof typeof FACTORY_EVENTS];

const Id = z.string().min(1);

export const FactoryRunStartedPayload = z
  .object({
    runId: Id,
    goalId: Id,
    title: z.string().min(1),
    /** The bound on repair attempts this run will honour (ADR-0023 §6). */
    maxRepairAttempts: z.number().int().positive(),
  })
  .strict();

export const FactoryStageEnteredPayload = z
  .object({
    runId: Id,
    stage: z.enum(FACTORY_STAGES),
    /** Which pass through this stage: 1 the first time, higher after a repair. */
    pass: z.number().int().positive(),
    lease: z
      .object({ nodes: z.array(Id), asOfSeq: z.number().int().nonnegative(), origins: z.array(Id) })
      .strict(),
  })
  .strict();

export const STAGE_RESULTS = ['PASSED', 'FAILED', 'SKIPPED'] as const;
export type StageResult = (typeof STAGE_RESULTS)[number];

export const FactoryStageSettledPayload = z
  .object({
    runId: Id,
    stage: z.enum(FACTORY_STAGES),
    pass: z.number().int().positive(),
    result: z.enum(STAGE_RESULTS),
    /** The agent task this stage ran, when it ran one. */
    taskId: Id.nullable(),
    /** Why, in one line. Always present: a stage that settled with no reason is unreadable. */
    detail: z.string().min(1),
  })
  .strict();

export const FactoryLeaseStalePayload = z
  .object({
    runId: Id,
    stage: z.enum(FACTORY_STAGES),
    pass: z.number().int().positive(),
    reason: z.string().min(1),
    touched: z.array(Id),
    /** Whether the stage will be run again. A second staleness blocks instead. */
    willRerun: z.boolean(),
  })
  .strict();

export const FactoryChangeBlockedPayload = z
  .object({
    runId: Id,
    stage: z.enum(FACTORY_STAGES),
    reason: z.string().min(1),
    /** Blocking security findings, when that is what stopped it. */
    blocking: z
      .array(z.object({ rule: Id, severity: z.enum(SEVERITIES), artifactId: Id, detail: z.string() }).strict())
      .default([]),
  })
  .strict();

/**
 * The verification engine's ruling on one artifact. The state is the engine's,
 * from evidence; the factory records what it was told (ADR-0023 §5).
 */
export const FactoryArtifactVerifiedPayload = z
  .object({
    runId: Id,
    artifactId: Id,
    path: Id,
    contentHash: Id,
    state: z.enum(VERIFICATION_STATES),
    evidenceCount: z.number().int().nonnegative(),
  })
  .strict();

export const FactoryRunFinishedPayload = z
  .object({
    runId: Id,
    outcome: z.enum(FACTORY_OUTCOMES),
    stagesRun: z.number().int().nonnegative(),
    repairAttempts: z.number().int().nonnegative(),
    /** The highest state any artifact in the run reached. */
    highestState: z.enum(VERIFICATION_STATES),
    summary: z.string().min(1),
  })
  .strict();

export const FACTORY_EVENT_PAYLOADS = {
  FACTORY_RUN_STARTED: FactoryRunStartedPayload,
  FACTORY_STAGE_ENTERED: FactoryStageEnteredPayload,
  FACTORY_STAGE_SETTLED: FactoryStageSettledPayload,
  FACTORY_LEASE_STALE: FactoryLeaseStalePayload,
  FACTORY_CHANGE_BLOCKED: FactoryChangeBlockedPayload,
  FACTORY_ARTIFACT_VERIFIED: FactoryArtifactVerifiedPayload,
  FACTORY_RUN_FINISHED: FactoryRunFinishedPayload,
} as const satisfies Record<FactoryEventType, z.ZodTypeAny>;
