/**
 * The core orchestrator: one task, from context to recorded outcome
 * (ADR-0018 §3).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). This is where model output meets canonical
 * state, so it is where the architecture's promises are kept or broken:
 *
 *   - The provider is reached only through the port, under a budget and an
 *     outer timeout, and every way it can fail is recorded as a typed failure.
 *   - Nothing the model says is acted on unless it is recorded first
 *     (REASONING_RESPONDED carries the exact text), so every run can be
 *     explained and replayed from the ledger.
 *   - Output becomes state only as AGENT proposals of four permitted kinds,
 *     each checked for shape, for goal contribution, and then by the cognitive
 *     deciders themselves. The orchestrator never writes a cognitive event.
 *   - Context that cannot fit stops the run before any model call, recorded.
 *   - The graph is reconciled from the committed cognitive state afterwards,
 *     never the other way round (ADR-0016).
 *
 * Runs for one project are serialised in-process; ids and the clock are
 * injected. For a given ledger, task and provider output, the events a run
 * appends are fully determined.
 */

import { checkContribution, type CognitiveEngine } from '@genesis/cognition';
import {
  type AssemblyOptions,
  assembleContext,
  contextAssembledEvent,
  type ContextManifest,
  type ContextRequest,
  gatherCandidates,
} from '@genesis/context';
import {
  AUTHORITY_LEVELS,
  CognitiveRuleViolationError,
  type EventActor,
  type JsonValue,
  newCycleId,
  newReasoningCallId,
  type ProjectScope,
  ValidationError,
} from '@genesis/core-types';
import type { GraphStore } from '@genesis/graph';
import type { EventLedger } from '@genesis/ledger';
import type { MemoryStore } from '@genesis/memory';
import {
  emptyProjection,
  type ProjectionState,
  resumeProjection,
  type SelfModelState,
  selfModelProjector,
} from '@genesis/projections';
import {
  asReasoningError,
  ReasoningError,
  type ReasoningProvider,
  type ReasoningRequest,
  ReasoningResult,
} from '@genesis/reasoning';
import { z } from 'zod';
import { ORCHESTRATION_EVENTS, type OrchestrationEventType, type ProposalEvaluated } from './events.js';
import { GraphMirror, type MirrorReport } from './mirror.js';
import { checkEnvelope, checkProposal, toCommand } from './proposals.js';
import { buildReasoningRequest, requestHash, responseHash } from './request.js';
import { type RunsState, runsProjector } from './runs.js';

export interface OrchestratorIds {
  cycle(): string;
  call(): string;
}

export const defaultOrchestratorIds: OrchestratorIds = {
  cycle: () => newCycleId(),
  call: () => newReasoningCallId(),
};

export interface OrchestratorOptions {
  readonly ledger: EventLedger;
  /** The cognitive engine every proposal goes through. Shared with other writers. */
  readonly engine: CognitiveEngine;
  readonly provider: ReasoningProvider;
  /** Read for context; the orchestrator never writes memory. */
  readonly memory: Pick<MemoryStore, 'query'>;
  /** Read for context, and written only by the mirror. */
  readonly graph: GraphStore;
  /** Who records the run. Must be a SYSTEM actor. */
  readonly actor?: EventActor;
  readonly ids?: OrchestratorIds;
  /** ISO timestamp source, for events and for the assembly's `asOf`. */
  readonly now?: () => string;
  readonly reasoning?: {
    readonly maxOutputTokens?: number;
    readonly timeoutMs?: number;
    /** Added to the provider's own timeout before the orchestrator stops waiting. */
    readonly guardMs?: number;
  };
  readonly assembly?: AssemblyOptions;
  /** Output longer than this is not recorded, and so not acted on. */
  readonly maxRecordedOutputChars?: number;
}

export const TaskInput = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    text: z.string().min(1),
    nodeIds: z.array(z.string().min(1)).default([]),
    activeGoalId: z.string().min(1).nullable().default(null),
    budgetTokens: z.number().int().positive(),
    policies: z
      .array(z.object({ id: z.string().min(1), text: z.string().min(1), authority: z.enum(AUTHORITY_LEVELS) }).strict())
      .default([]),
  })
  .strict();
export type TaskInput = z.input<typeof TaskInput>;

export type RunStatus = 'COMPLETED' | 'SPLIT_REQUIRED' | 'FAILED';

export interface RunResult {
  readonly cycleId: string;
  readonly taskId: string;
  readonly status: RunStatus;
  readonly manifest: ContextManifest;
  readonly callId: string | null;
  readonly failure: { readonly kind: string; readonly message: string } | null;
  readonly proposals: readonly ProposalEvaluated[];
  readonly mirror: MirrorReport | null;
}

const DEFAULTS = { maxOutputTokens: 2048, timeoutMs: 60_000, guardMs: 1_000, maxRecordedOutputChars: 100_000 };

type CallOutcome = { readonly ok: true; readonly result: ReasoningResult } | { readonly ok: false; readonly error: ReasoningError };

export class Orchestrator {
  readonly #o: OrchestratorOptions;
  readonly #actor: EventActor;
  readonly #reasoner: EventActor;
  readonly #ids: OrchestratorIds;
  readonly #now: () => string;
  readonly #mirror: GraphMirror;
  readonly #selfModels = new Map<string, ProjectionState<SelfModelState>>();
  readonly #runs = new Map<string, ProjectionState<RunsState>>();
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: OrchestratorOptions) {
    const actor = options.actor ?? { kind: 'SYSTEM', id: 'orchestrator' };
    if (actor.kind !== 'SYSTEM') {
      throw new ValidationError(`the orchestrator records runs as the system, not as ${actor.kind}`, { actor: actor.id });
    }
    this.#o = options;
    this.#actor = actor;
    // Model output enters state as an agent's, under every agent rule (ADR-0018 §3).
    this.#reasoner = { kind: 'AGENT', id: `reasoner:${options.provider.id}`, agentRole: 'REASONER' };
    this.#ids = options.ids ?? defaultOrchestratorIds;
    this.#now = options.now ?? ((): string => new Date().toISOString());
    this.#mirror = new GraphMirror(options.graph, { now: () => new Date(this.#now()) });
  }

  /** Runs one task. Resolves with its outcome; rejects only when the stores themselves fail. */
  run(scope: ProjectScope, task: TaskInput): Promise<RunResult> {
    const parsed = TaskInput.safeParse(task);
    if (!parsed.success) {
      return Promise.reject(
        new ValidationError('invalid task', {
          issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
        }),
      );
    }
    return this.#serialise(scope.projectId, () => this.#run(scope, parsed.data));
  }

  /** Reconciles the graph with the committed cognitive state, outside a run (ADR-0016). */
  syncGraph(scope: ProjectScope): Promise<MirrorReport> {
    return this.#serialise(scope.projectId, async () => this.#mirror.reconcile(scope, (await this.#o.engine.state(scope)).state));
  }

  /** Every run in the project, rebuilt from the ledger. */
  runs(scope: ProjectScope): Promise<RunsState> {
    return this.#serialise(scope.projectId, async () => {
      const cached = this.#runs.get(scope.projectId) ?? emptyProjection(runsProjector, scope);
      const { projection } = await resumeProjection(runsProjector, cached, this.#o.ledger);
      this.#runs.set(scope.projectId, projection);
      return projection.state;
    });
  }

  async #run(scope: ProjectScope, task: z.output<typeof TaskInput>): Promise<RunResult> {
    const cycleId = this.#ids.cycle();
    const record = (type: OrchestrationEventType, payload: JsonValue) =>
      this.#o.ledger.append(scope, {
        type,
        actor: this.#actor,
        authority: 'VERIFIED_SYSTEM_STATE',
        payload,
        cycleId,
        timestamp: this.#now(),
      });
    const finish = async (result: Omit<RunResult, 'cycleId' | 'taskId'>): Promise<RunResult> => {
      await record(ORCHESTRATION_EVENTS.TASK_FINISHED, { taskId: task.id });
      return { cycleId, taskId: task.id, ...result };
    };

    await record(ORCHESTRATION_EVENTS.TASK_STARTED, { taskId: task.id });

    // 1. Context, against the cognitive state at a known ledger position.
    const cognition = await this.#o.engine.state(scope);
    const request: ContextRequest = {
      task: { id: task.id, kind: task.kind, text: task.text, nodeIds: task.nodeIds },
      activeGoalId: task.activeGoalId,
      asOf: this.#now(),
      budgetTokens: task.budgetTokens,
    };
    const gathered = await gatherCandidates({ memory: this.#o.memory, graph: this.#o.graph }, scope, request, {
      cognition: cognition.state,
      selfModel: await this.#selfModel(scope),
      policies: task.policies,
    });
    const assembly = assembleContext(request, gathered.candidates, this.#o.assembly);
    const { manifest } = assembly;
    await this.#o.ledger.append(scope, {
      ...contextAssembledEvent(manifest, { asOfSeq: cognition.lastSeq, impact: gathered.impact }, this.#actor, this.#now()),
      cycleId,
    });

    // 2. Mandatory context does not fit: record it, and stop before any model call.
    if (manifest.status === 'SPLIT_REQUIRED') {
      await record(ORCHESTRATION_EVENTS.TASK_SPLIT_REQUIRED, {
        taskId: task.id,
        budgetTokens: manifest.budgetTokens,
        mandatoryTokens: manifest.mandatoryTokens,
        mandatory: manifest.entries.filter((e) => e.mandatory !== null).map((e) => e.id),
      });
      return finish({ status: 'SPLIT_REQUIRED', manifest, callId: null, failure: null, proposals: [], mirror: null });
    }

    // 3. The call, recorded before it is made.
    const callId = this.#ids.call();
    const reasoningRequest = buildReasoningRequest(callId, task.text, assembly.items, {
      maxOutputTokens: this.#o.reasoning?.maxOutputTokens ?? DEFAULTS.maxOutputTokens,
      timeoutMs: this.#o.reasoning?.timeoutMs ?? DEFAULTS.timeoutMs,
    });
    await record(ORCHESTRATION_EVENTS.REASONING_REQUESTED, {
      taskId: task.id,
      callId,
      providerId: this.#o.provider.id,
      purpose: reasoningRequest.purpose,
      requestHash: requestHash(reasoningRequest),
      contextIds: assembly.items.map((c) => c.id),
    });

    const failed = async (kind: string, message: string, signature: string): Promise<RunResult> => {
      await record(ORCHESTRATION_EVENTS.EXECUTION_FAILED, { signature });
      return finish({ status: 'FAILED', manifest, callId, failure: { kind, message }, proposals: [], mirror: null });
    };

    const outcome = await this.#call(reasoningRequest);
    if (!outcome.ok) {
      const { error } = outcome;
      await record(ORCHESTRATION_EVENTS.REASONING_FAILED, {
        callId,
        kind: error.kind,
        retryable: error.retryable,
        message: error.message,
      });
      return failed(error.kind, error.message, `${task.kind}:reasoning:${error.kind}`);
    }

    // 4. The response, recorded before anything reads it.
    const { result } = outcome;
    const limit = this.#o.maxRecordedOutputChars ?? DEFAULTS.maxRecordedOutputChars;
    const recordable = result.outputText.length <= limit;
    await record(ORCHESTRATION_EVENTS.REASONING_RESPONDED, {
      callId,
      modelId: result.modelId,
      stopReason: result.stopReason,
      usage: result.usage,
      responseHash: responseHash(result.outputText),
      outputText: recordable ? result.outputText : null,
      outputLength: result.outputText.length,
    });

    const envelope = recordable
      ? checkEnvelope(result.output)
      : ({ ok: false, issues: [`output of ${result.outputText.length} characters exceeds the recorded limit of ${limit}`] } as const);
    if (!envelope.ok) {
      const reason = recordable ? 'NOT_AN_ENVELOPE' : 'TOO_LARGE';
      await record(ORCHESTRATION_EVENTS.REASONING_OUTPUT_REJECTED, { callId, reason, issues: [...envelope.issues] });
      return failed(`OUTPUT_${reason}`, envelope.issues.join('; '), `${task.kind}:reasoning:INVALID_OUTPUT`);
    }

    // 5. Each proposal on its own merits (SPEC-04 §4.3).
    const proposals: ProposalEvaluated[] = [];
    for (const [index, item] of envelope.items.entries()) {
      const evaluated = await this.#evaluate(scope, cycleId, callId, index, item);
      await record(ORCHESTRATION_EVENTS.PROPOSAL_EVALUATED, evaluated);
      proposals.push(evaluated);
    }

    // 6. The graph follows the committed state.
    const mirror = await this.#mirror.reconcile(scope, (await this.#o.engine.state(scope)).state);
    return finish({ status: 'COMPLETED', manifest, callId, failure: null, proposals, mirror });
  }

  async #evaluate(
    scope: ProjectScope,
    cycleId: string,
    callId: string,
    index: number,
    item: unknown,
  ): Promise<ProposalEvaluated> {
    const base = { callId, index, rule: null, eventSeqs: [] as number[] };
    const check = checkProposal(item);
    if (!check.ok) {
      return { ...base, kind: check.kind, outcome: 'REJECTED', reason: check.reason, detail: check.issues.join('; ') };
    }
    const { proposal } = check;
    const { state } = await this.#o.engine.state(scope);
    const drift = checkContribution(state, proposal.contributesTo);
    if (drift.drift) {
      const unknown = drift.unknownGoals.length === 0 ? '' : ` (unknown: ${drift.unknownGoals.join(', ')})`;
      return { ...base, kind: proposal.kind, outcome: 'REJECTED', reason: 'GOAL_DRIFT', detail: `${drift.reason}${unknown}` };
    }
    try {
      const { events } = await this.#o.engine.execute(scope, this.#reasoner, toCommand(proposal, callId), { cycleId });
      return { ...base, kind: proposal.kind, outcome: 'ACCEPTED', reason: null, detail: null, eventSeqs: events.map((e) => e.seq) };
    } catch (error) {
      if (!(error instanceof CognitiveRuleViolationError)) throw error;
      return {
        ...base,
        kind: proposal.kind,
        outcome: 'REJECTED',
        reason: 'RULE_VIOLATION',
        rule: error.rule,
        detail: error.message,
      };
    }
  }

  /**
   * One provider call, never trusted to end on its own or to return what it
   * promised: an outer timer bounds it, and the result is checked against the
   * port's schema before anything reads it.
   */
  async #call(request: ReasoningRequest): Promise<CallOutcome> {
    const waitMs = request.budget.timeoutMs + (this.#o.reasoning?.guardMs ?? DEFAULTS.guardMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new ReasoningError('TIMEOUT', `provider ${this.#o.provider.id} did not settle within ${waitMs}ms`)),
        waitMs,
      );
    });
    // `then` rather than a direct call, so a provider that throws instead of
    // rejecting is handled the same way.
    const outcome = await Promise.race([Promise.resolve().then(() => this.#o.provider.complete(request)), guard]).then(
      (raw: unknown): CallOutcome => {
        const parsed = ReasoningResult.safeParse(raw);
        return parsed.success
          ? { ok: true, result: parsed.data }
          : {
              ok: false,
              error: new ReasoningError('INVALID_RESPONSE', `provider ${this.#o.provider.id} returned a malformed result`),
            };
      },
      (error: unknown): CallOutcome => ({ ok: false, error: asReasoningError(error) }),
    );
    clearTimeout(timer);
    return outcome;
  }

  async #selfModel(scope: ProjectScope): Promise<SelfModelState> {
    const cached = this.#selfModels.get(scope.projectId) ?? emptyProjection(selfModelProjector, scope);
    const { projection } = await resumeProjection(selfModelProjector, cached, this.#o.ledger);
    this.#selfModels.set(scope.projectId, projection);
    return projection.state;
  }

  async #serialise<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    // As in the cognitive engine: the queue swallows every outcome, so it
    // never rejects, and one failed run does not poison the next.
    const previous = this.#queues.get(projectId) ?? Promise.resolve();
    const run = previous.then(task);
    this.#queues.set(
      projectId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}

