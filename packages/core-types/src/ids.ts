/**
 * Branded identifiers (ADR-0002 rule 2).
 *
 * Every id is `<prefix>_<ULID>` and carries a distinct nominal type, so a
 * `MemoryId` cannot be passed where a `NodeId` is expected. That class of
 * mistake would otherwise write a graph edge pointing at nothing, and the
 * graph would be quietly wrong rather than loudly broken.
 */

import { z } from 'zod';
import { ulid, ULID_LENGTH } from './ulid.js';

/** Crockford base32 alphabet, excluding I, L, O and U. */
const ULID_PATTERN = '[0-9A-HJKMNP-TV-Z]';

const idSchema = (prefix: string): z.ZodString =>
  z.string().regex(new RegExp(`^${prefix}_${ULID_PATTERN}{${ULID_LENGTH}}$`), {
    message: `expected an id of the form ${prefix}_<ULID>`,
  });

export const ID_PREFIXES = {
  ProjectId: 'prj',
  EventId: 'evt',
  MemoryId: 'mem',
  NodeId: 'node',
  EdgeId: 'edge',
  CycleId: 'cyc',
  GoalId: 'goal',
  ProposalId: 'prop',
  AgentId: 'agt',
  BeliefId: 'bel',
  UncertaintyId: 'unc',
  ContradictionId: 'ctr',
  CriterionId: 'crit',
  QuestionId: 'qst',
  ReasoningCallId: 'rsn',
  ExperimentId: 'exp',
  ObservationId: 'obs',
  MessageId: 'msg',
  TaskId: 'task',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export const ProjectId = idSchema(ID_PREFIXES.ProjectId).brand<'ProjectId'>();
export type ProjectId = z.infer<typeof ProjectId>;

export const EventId = idSchema(ID_PREFIXES.EventId).brand<'EventId'>();
export type EventId = z.infer<typeof EventId>;

export const MemoryId = idSchema(ID_PREFIXES.MemoryId).brand<'MemoryId'>();
export type MemoryId = z.infer<typeof MemoryId>;

export const NodeId = idSchema(ID_PREFIXES.NodeId).brand<'NodeId'>();
export type NodeId = z.infer<typeof NodeId>;

export const EdgeId = idSchema(ID_PREFIXES.EdgeId).brand<'EdgeId'>();
export type EdgeId = z.infer<typeof EdgeId>;

export const CycleId = idSchema(ID_PREFIXES.CycleId).brand<'CycleId'>();
export type CycleId = z.infer<typeof CycleId>;

export const GoalId = idSchema(ID_PREFIXES.GoalId).brand<'GoalId'>();
export type GoalId = z.infer<typeof GoalId>;

export const ProposalId = idSchema(ID_PREFIXES.ProposalId).brand<'ProposalId'>();
export type ProposalId = z.infer<typeof ProposalId>;

export const AgentId = idSchema(ID_PREFIXES.AgentId).brand<'AgentId'>();
export type AgentId = z.infer<typeof AgentId>;

export const BeliefId = idSchema(ID_PREFIXES.BeliefId).brand<'BeliefId'>();
export type BeliefId = z.infer<typeof BeliefId>;

export const UncertaintyId = idSchema(ID_PREFIXES.UncertaintyId).brand<'UncertaintyId'>();
export type UncertaintyId = z.infer<typeof UncertaintyId>;

export const ContradictionId = idSchema(ID_PREFIXES.ContradictionId).brand<'ContradictionId'>();
export type ContradictionId = z.infer<typeof ContradictionId>;

export const CriterionId = idSchema(ID_PREFIXES.CriterionId).brand<'CriterionId'>();
export type CriterionId = z.infer<typeof CriterionId>;

export const QuestionId = idSchema(ID_PREFIXES.QuestionId).brand<'QuestionId'>();
export type QuestionId = z.infer<typeof QuestionId>;

export const ReasoningCallId = idSchema(ID_PREFIXES.ReasoningCallId).brand<'ReasoningCallId'>();
export type ReasoningCallId = z.infer<typeof ReasoningCallId>;

export const ExperimentId = idSchema(ID_PREFIXES.ExperimentId).brand<'ExperimentId'>();
export type ExperimentId = z.infer<typeof ExperimentId>;

export const ObservationId = idSchema(ID_PREFIXES.ObservationId).brand<'ObservationId'>();
export type ObservationId = z.infer<typeof ObservationId>;

/** One protocol envelope (SPEC-04 §3). Handlers are idempotent on it. */
export const MessageId = idSchema(ID_PREFIXES.MessageId).brand<'MessageId'>();
export type MessageId = z.infer<typeof MessageId>;

/** One unit of work assigned to one agent. Survives its own retries (ADR-0020 §7). */
export const TaskId = idSchema(ID_PREFIXES.TaskId).brand<'TaskId'>();
export type TaskId = z.infer<typeof TaskId>;

/** Generates a new id of the given kind. */
function mint(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${ulid()}`;
}

export const newProjectId = (): ProjectId => ProjectId.parse(mint('ProjectId'));
export const newEventId = (): EventId => EventId.parse(mint('EventId'));
export const newMemoryId = (): MemoryId => MemoryId.parse(mint('MemoryId'));
export const newNodeId = (): NodeId => NodeId.parse(mint('NodeId'));
export const newEdgeId = (): EdgeId => EdgeId.parse(mint('EdgeId'));
export const newCycleId = (): CycleId => CycleId.parse(mint('CycleId'));
export const newGoalId = (): GoalId => GoalId.parse(mint('GoalId'));
export const newProposalId = (): ProposalId => ProposalId.parse(mint('ProposalId'));
export const newAgentId = (): AgentId => AgentId.parse(mint('AgentId'));
export const newBeliefId = (): BeliefId => BeliefId.parse(mint('BeliefId'));
export const newUncertaintyId = (): UncertaintyId => UncertaintyId.parse(mint('UncertaintyId'));
export const newContradictionId = (): ContradictionId =>
  ContradictionId.parse(mint('ContradictionId'));
export const newCriterionId = (): CriterionId => CriterionId.parse(mint('CriterionId'));
export const newQuestionId = (): QuestionId => QuestionId.parse(mint('QuestionId'));
export const newReasoningCallId = (): ReasoningCallId => ReasoningCallId.parse(mint('ReasoningCallId'));
export const newExperimentId = (): ExperimentId => ExperimentId.parse(mint('ExperimentId'));
export const newObservationId = (): ObservationId => ObservationId.parse(mint('ObservationId'));
export const newMessageId = (): MessageId => MessageId.parse(mint('MessageId'));
export const newTaskId = (): TaskId => TaskId.parse(mint('TaskId'));

/** A lowercase hex SHA-256 digest. */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, {
  message: 'expected a lowercase hex sha-256 digest',
});
export type Sha256Hex = z.infer<typeof Sha256Hex>;
