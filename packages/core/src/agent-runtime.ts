/**
 * The agent runtime: assignment, dispatch, outcome, all recorded
 * (SPEC-04 §1, ADR-0020).
 *
 * SAFETY-CRITICAL (SPEC-00 §8.1). This is the whole of what an agent can cause
 * to happen, so the guarantees it keeps are the ones P6 rests on:
 *
 *   - **An agent never writes.** It returns messages. The runtime checks each
 *     one, records it, and only then acts on the kinds that act.
 *   - **There is one orchestration path.** The reason-and-propose leg is the
 *     existing `Orchestrator`, which assembles context, calls the provider
 *     under budget, records the call, and puts each proposal through the
 *     cognitive deciders. The runtime does none of those things itself.
 *   - **There is one door to canonical state.** An agent's own proposals go
 *     through `evaluateProposal`, the function the orchestrator uses.
 *   - **A silent agent is a failed agent.** Every dispatch is bounded by the
 *     assignment's deadline; the runtime settles the task rather than waiting.
 *   - **Verification is not the agent's.** Submitted evidence goes to the
 *     verification engine, and the state it returns is the engine's.
 *   - **One project runs one agent task at a time** (ADR-0020 §9). Tasks are
 *     serialised exactly as cognitive commands and orchestrator runs are.
 *
 * Ids and the clock are injected. For a given ledger, assignment and provider
 * output, a task appends the same events in the same order.
 */

import type { Agent, AgentRegistry, AgentServices } from '@genesis/agents';
import { AgentError, checkOutcome, failureKindOf, failureSignature } from '@genesis/agents';
import type { CognitiveEngine } from '@genesis/cognition';
import {
  type AgentRole,
  type AgentTaskState,
  type EventActor,
  isTerminalAgentTaskState,
  type JsonValue,
  type MessageId,
  newMessageId,
  newTaskId,
  type ProjectScope,
  type TaskId,
  ValidationError,
  type VerificationState,
} from '@genesis/core-types';
import type { EventLedger } from '@genesis/ledger';
import {
  type AgentFailureKind,
  type AgentManifest,
  checkEnvelope,
  type Envelope,
  INITIAL_AGENT_TASK_STATE,
  type RunSummary,
  type TaskAssignmentBody,
  TaskFraming,
} from '@genesis/protocol';
import { AGENT_EVENTS, type AgentEventType } from './agent-events.js';
import { evaluateProposal } from './evaluate.js';
import type { ProposalEvaluated } from './events.js';
import type { Orchestrator, RunResult } from './orchestrator.js';

/** How the runtime mints ids. Injected so a replay produces the same ones. */
export interface AgentRuntimeIds {
  task(): TaskId;
  message(): MessageId;
}

export const defaultAgentRuntimeIds: AgentRuntimeIds = {
  task: () => newTaskId(),
  message: () => newMessageId(),
};

/**
 * Decides what a piece of submitted evidence justifies. The P5 engine's shape,
 * named as a port so the runtime depends on the decision rather than on the
 * class (ADR-0003).
 */
export interface EvidenceVerifier {
  evaluate(artifactId: string, evidence: readonly EvidenceInput[]): VerificationState;
}

/** What the verifier is given. Matches the P5 `EvidenceRecord` field for field. */
export interface EvidenceInput {
  readonly observationId: string;
  readonly raw: string;
  readonly hash: string;
  readonly environment: 'SANDBOX' | 'STAGING' | 'PRODUCTION' | 'LOCAL';
  readonly exitCode: number;
  readonly testKind?: string | undefined;
  readonly claimedArtifacts: string[];
}

export interface AgentRuntimeOptions {
  readonly ledger: EventLedger;
  readonly engine: CognitiveEngine;
  readonly registry: AgentRegistry;
  /** The reason-and-propose leg. Not reimplemented here (ADR-0020 §2). */
  readonly orchestrator: Orchestrator;
  /** Applied to submitted evidence. Omitted, evidence is recorded and not ruled on. */
  readonly verifier?: EvidenceVerifier;
  /** Who records the task. Must be a SYSTEM actor. */
  readonly actor?: EventActor;
  readonly ids?: AgentRuntimeIds;
  readonly now?: () => string;
  /** A bound on how much one agent may say at once. */
  readonly maxMessagesPerTask?: number;
  /** Added to the assignment's own budget before the runtime stops waiting. */
  readonly guardMs?: number;
}

/** What the caller asks for. The runtime mints the task id and the deadline. */
export interface TaskRequest {
  readonly role: AgentRole;
  readonly instruction: string;
  readonly contributesTo: readonly string[];
  /** Context the core assembled for this agent. Text, never a handle. */
  readonly context?: readonly { id: string; kind: string; authority: JsonValue; text: string }[];
  /** The role-specific input, validated by the role that reads it. */
  readonly input?: JsonValue;
  readonly budget?: { readonly maxOutputTokens?: number; readonly timeoutMs?: number };
}

export interface TaskOutcome {
  readonly taskId: TaskId;
  readonly state: AgentTaskState;
  readonly attempts: number;
  readonly failure: { readonly kind: AgentFailureKind; readonly message: string; readonly signature: string } | null;
  readonly proposals: readonly ProposalEvaluated[];
  readonly verified: readonly { readonly artifactId: string; readonly state: VerificationState }[];
  /** Messages the runtime accepted, in order. */
  readonly messages: readonly Envelope[];
  /** Messages it refused, with why. An agent's mistakes are visible, not dropped. */
  readonly rejected: readonly { readonly kind: string | null; readonly issues: readonly string[] }[];
  /**
   * What the task's run produced under a non-cognitive purpose, already checked
   * and recorded by the core: the artifacts a build landed, or the diagnosis a
   * repair read. Null when the task framed no run, or framed a cognitive one.
   */
  readonly produced: JsonValue | null;
}

const DEFAULTS = { maxMessagesPerTask: 50, guardMs: 1_000, maxOutputTokens: 2048, timeoutMs: 60_000 };

export class AgentRuntime {
  readonly #o: AgentRuntimeOptions;
  readonly #actor: EventActor;
  readonly #ids: AgentRuntimeIds;
  readonly #now: () => string;
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: AgentRuntimeOptions) {
    const actor = options.actor ?? { kind: 'SYSTEM', id: 'agent-runtime' };
    if (actor.kind !== 'SYSTEM') {
      throw new ValidationError(`the runtime records tasks as the system, not as ${actor.kind}`, { actor: actor.id });
    }
    this.#o = options;
    this.#actor = actor;
    this.#ids = options.ids ?? defaultAgentRuntimeIds;
    this.#now = options.now ?? ((): string => new Date().toISOString());
  }

  /**
   * Assigns one task and sees it through. Resolves with its outcome; rejects
   * only when the stores themselves fail or nothing fills the role — a failed
   * agent is an outcome, not an exception.
   */
  assign(scope: ProjectScope, request: TaskRequest, signal?: AbortSignal): Promise<TaskOutcome> {
    const registered = this.#o.registry.forRole(request.role);
    if (registered === null) {
      return Promise.reject(new ValidationError(`no agent fills the role ${request.role}`, { role: request.role }));
    }
    if (request.contributesTo.length === 0) {
      return Promise.reject(
        new ValidationError('a task must name at least one goal it serves; work that serves no goal is drift', {
          role: request.role,
        }),
      );
    }
    return this.#serialise(scope.projectId, () => this.#assign(scope, request, registered, signal));
  }

  async #assign(
    scope: ProjectScope,
    request: TaskRequest,
    registered: { agent: Agent; manifest: AgentManifest; proposalKinds: readonly string[] },
    signal?: AbortSignal,
  ): Promise<TaskOutcome> {
    const { manifest, agent, proposalKinds } = registered;
    const taskId = this.#ids.task();
    const budgetMs = request.budget?.timeoutMs ?? manifest.timeoutMs;

    let state: AgentTaskState = INITIAL_AGENT_TASK_STATE;
    const accepted: Envelope[] = [];
    const rejected: { kind: string | null; issues: readonly string[] }[] = [];
    const proposals: ProposalEvaluated[] = [];
    const verified: { artifactId: string; state: VerificationState }[] = [];
    let failure: TaskOutcome['failure'] = null;
    let produced: JsonValue | null = null;
    let attempt = 0;

    const record = (type: AgentEventType, payload: JsonValue): Promise<unknown> =>
      this.#o.ledger.append(scope, {
        type,
        actor: this.#actor,
        authority: 'VERIFIED_SYSTEM_STATE',
        payload,
        timestamp: this.#now(),
      });

    // Every move the runtime makes is one the machine permits; the task
    // projection re-checks each recorded transition and flags any that is not
    // (ADR-0020 §6). A second guard here would be unreachable code pretending
    // to be a safeguard, so the property is proven by test instead.
    const moveTo = async (next: AgentTaskState, reason: string): Promise<void> => {
      await record(AGENT_EVENTS.AGENT_TASK_STATE_CHANGED, { taskId, from: state, to: next, reason });
      state = next;
    };

    while (attempt < manifest.maxAttempts && !isTerminalAgentTaskState(state)) {
      attempt += 1;
      const assignment: TaskAssignmentBody = {
        taskId,
        attempt,
        role: manifest.role,
        kind: `${manifest.role}_TASK`,
        instruction: request.instruction,
        contributesTo: [...request.contributesTo],
        context: (request.context ?? []) as TaskAssignmentBody['context'],
        budget: {
          maxOutputTokens: request.budget?.maxOutputTokens ?? DEFAULTS.maxOutputTokens,
          timeoutMs: budgetMs,
        },
        deadline: new Date(new Date(this.#now()).getTime() + budgetMs).toISOString(),
        input: request.input ?? null,
      };

      await record(AGENT_EVENTS.AGENT_TASK_ASSIGNED, {
        taskId,
        attempt,
        agentId: manifest.id,
        role: manifest.role,
        kind: assignment.kind,
        contributesTo: assignment.contributesTo,
        deadline: assignment.deadline,
        proposalKinds: [...proposalKinds],
      });
      if (state === 'ASSIGNED') await moveTo('RUNNING', `attempt ${attempt} started`);

      const attemptResult = await this.#attempt(scope, assignment, agent, registered, signal, budgetMs);

      for (const bad of attemptResult.rejected) rejected.push(bad);
      accepted.push(...attemptResult.accepted);
      proposals.push(...attemptResult.proposals);

      if (attemptResult.failure === null) {
        failure = null;
        produced = attemptResult.produced;
        for (const item of attemptResult.verified) verified.push(item);
        await moveTo(attemptResult.reached, 'the agent reported its outcome');
        // The engine has ruled on the submitted evidence, so the wait is over.
        // With no verifier configured nothing has ruled, and the task stays
        // AWAITING_VERIFICATION rather than completing on an unanswered
        // question (ADR-0020 §8).
        if (state === 'AWAITING_VERIFICATION' && verified.length > 0) {
          await moveTo('COMPLETED', 'the verification engine ruled on the submitted evidence');
        }
        break;
      }

      failure = attemptResult.failure;
      const willRetry = attempt < manifest.maxAttempts && attemptResult.failure.kind !== 'CANCELLED';
      await record(AGENT_EVENTS.AGENT_TASK_FAILED, {
        taskId,
        attempt,
        kind: failure.kind,
        message: failure.message,
        signature: failure.signature,
        willRetry,
      });
      // The signature is the self model's vocabulary, so a role that keeps
      // failing the same way becomes something the system knows (SPEC-01 §4).
      await this.#o.ledger.append(scope, {
        type: 'EXECUTION_FAILED',
        actor: this.#actor,
        authority: 'VERIFIED_SYSTEM_STATE',
        payload: { signature: failure.signature },
        timestamp: this.#now(),
      });
      if (!willRetry) {
        await moveTo(failure.kind === 'CANCELLED' ? 'CANCELLED' : 'FAILED', failure.message);
        break;
      }
      // A retry is a real pair of moves, recorded: the task is blocked by the
      // failure and then resumed. The ledger shows the retry rather than
      // implying one from a second assignment appearing out of nowhere.
      await moveTo('BLOCKED', `attempt ${attempt} failed: ${failure.kind}`);
      await moveTo('RUNNING', `attempt ${attempt + 1} starting`);
    }

    await record(AGENT_EVENTS.AGENT_TASK_FINISHED, {
      taskId,
      finalState: state,
      attempts: attempt,
      messages: accepted.length,
      proposalsAccepted: proposals.filter((p) => p.outcome === 'ACCEPTED').length,
    });

    return { taskId, state, attempts: attempt, failure, proposals, verified, messages: accepted, rejected, produced };
  }

  /** One attempt: frame, run, dispatch, read what came back. */
  async #attempt(
    scope: ProjectScope,
    assignment: TaskAssignmentBody,
    agent: Agent,
    registered: { manifest: AgentManifest; proposalKinds: readonly string[] },
    signal: AbortSignal | undefined,
    budgetMs: number,
  ): Promise<{
    readonly accepted: readonly Envelope[];
    readonly rejected: readonly { readonly kind: string | null; readonly issues: readonly string[] }[];
    readonly proposals: readonly ProposalEvaluated[];
    readonly verified: readonly { readonly artifactId: string; readonly state: VerificationState }[];
    readonly reached: AgentTaskState;
    readonly failure: TaskOutcome['failure'] | null;
    readonly produced: JsonValue | null;
  }> {
    const { manifest, proposalKinds } = registered;
    const fail = (kind: AgentFailureKind, message: string): TaskOutcome['failure'] => ({
      kind,
      message,
      signature: failureSignature(manifest.role, assignment.kind, kind),
    });
    const nothing = { accepted: [], rejected: [], proposals: [], verified: [], produced: null } as const;

    // 1. Framing: pure, role-specific, and checked. A role that frames nonsense
    //    fails here rather than sending nonsense to a provider.
    let run: RunSummary | null = null;
    let framing: unknown;
    try {
      framing = agent.frame(assignment);
    } catch (thrown) {
      return { ...nothing, reached: 'FAILED', failure: fail(failureKindOf(thrown), messageOf(thrown)) };
    }
    if (framing !== null) {
      const parsed = TaskFraming.safeParse(framing);
      if (!parsed.success) {
        return {
          ...nothing,
          reached: 'FAILED',
          failure: fail('MALFORMED_OUTPUT', `${manifest.role} framed an invalid task: ${issuesOf(parsed.error)}`),
        };
      }
      // 2. The run. The orchestrator does the whole leg and records it.
      const result = await this.#o.orchestrator.run(
        scope,
        { id: assignment.taskId, ...parsed.data },
        { actor: { kind: 'AGENT', id: manifest.id, agentRole: manifest.role }, proposalKinds },
      );
      run = summarise(result);
    }

    // 3. Dispatch, bounded. A silent agent is a failed agent.
    const controller = new AbortController();
    const onOuterAbort = (): void => {
      controller.abort();
    };
    signal?.addEventListener('abort', onOuterAbort);
    const services: AgentServices = {
      run,
      now: this.#now,
      newMessageId: () => this.#ids.message(),
      signal: controller.signal,
    };

    let raw: unknown;
    try {
      raw = await this.#bounded(agent.handle(assignment, services), budgetMs + (this.#o.guardMs ?? DEFAULTS.guardMs), controller);
    } catch (thrown) {
      return { ...nothing, reached: 'FAILED', failure: fail(failureKindOf(thrown), messageOf(thrown)) };
    } finally {
      signal?.removeEventListener('abort', onOuterAbort);
    }

    // 4. Nothing the agent said is acted on before it is checked and recorded.
    const checked = checkOutcome(assignment, raw, this.#o.maxMessagesPerTask ?? DEFAULTS.maxMessagesPerTask);
    if (!checked.ok) {
      return { ...nothing, reached: 'FAILED', failure: fail(checked.kind, checked.reason) };
    }

    const accepted: Envelope[] = [];
    const rejected: { kind: string | null; issues: readonly string[] }[] = [];
    const proposals: ProposalEvaluated[] = [];
    const verified: { artifactId: string; state: VerificationState }[] = [];

    for (const [index, message] of checked.outcome.messages.entries()) {
      const envelope = checkEnvelope(message);
      if (!envelope.ok) {
        rejected.push({ kind: envelope.kind, issues: envelope.issues });
        await this.#o.ledger.append(scope, {
          type: AGENT_EVENTS.AGENT_MESSAGE_REJECTED,
          actor: this.#actor,
          authority: 'VERIFIED_SYSTEM_STATE',
          payload: { taskId: assignment.taskId, messageId: null, messageKind: envelope.kind, issues: [...envelope.issues] },
          timestamp: this.#now(),
        });
        continue;
      }
      await this.#o.ledger.append(scope, {
        type: AGENT_EVENTS.AGENT_MESSAGE_RECEIVED,
        actor: this.#actor,
        authority: 'VERIFIED_SYSTEM_STATE',
        payload: {
          taskId: assignment.taskId,
          messageId: envelope.envelope.id,
          messageKind: envelope.envelope.kind,
          envelope: JSON.parse(JSON.stringify(envelope.envelope)) as JsonValue,
        },
        timestamp: this.#now(),
      });
      accepted.push(envelope.envelope);

      if (envelope.envelope.kind === 'PROPOSAL') {
        proposals.push(
          await evaluateProposal({
            engine: this.#o.engine,
            scope,
            proposer: { actor: { kind: 'AGENT', id: manifest.id, agentRole: manifest.role }, proposalKinds },
            cycleId: run?.cycleId ?? null,
            callId: run?.callId ?? null,
            index,
            item: envelope.envelope.body.changes,
          }),
        );
      }
      if (envelope.envelope.kind === 'EVIDENCE_SUBMISSION') {
        verified.push(...this.#verify(envelope.envelope.body));
      }
    }

    return { accepted, rejected, proposals, verified, reached: checked.outcome.reached, failure: null, produced: run?.produced ?? null };
  }

  /**
   * What the evidence justifies, decided by the engine and never by the agent
   * that submitted it (ADR-0020 §8). With no verifier configured the evidence
   * is recorded and nothing is claimed about it, which is the honest default.
   */
  #verify(body: Extract<Envelope, { kind: 'EVIDENCE_SUBMISSION' }>['body']): {
    artifactId: string;
    state: VerificationState;
  }[] {
    const verifier = this.#o.verifier;
    if (verifier === undefined) return [];
    const record: EvidenceInput = {
      observationId: body.experimentId ?? 'obs_unrecorded',
      raw: body.raw,
      hash: '',
      environment: body.environment,
      exitCode: body.exitCode,
      testKind: body.testKind,
      claimedArtifacts: [...body.claimedArtifacts],
    };
    return body.claimedArtifacts.map((artifactId) => ({ artifactId, state: verifier.evaluate(artifactId, [record]) }));
  }

  /**
   * An agent that does not settle in time has failed, whatever it is doing, and
   * a cancelled one stops now rather than when it gets round to noticing.
   *
   * Both outcomes settle the wait itself. An agent that ignores its signal
   * would otherwise hold the task open until the deadline, which turns a cancel
   * into a delay.
   */
  async #bounded<T>(work: Promise<T>, waitMs: number, controller: AbortController): Promise<T> {
    let abandon!: (reason: unknown) => void;
    const stop = new Promise<never>((_resolve, reject) => {
      abandon = reject;
    });
    const onAbort = (): void => {
      abandon(new AgentError('CANCELLED', 'the task was cancelled while the agent was working'));
    };
    controller.signal.addEventListener('abort', onAbort);
    // Rejected before the abort, so a deadline is reported as a deadline: the
    // abort below fires `onAbort`, and a settled promise ignores it.
    const timer = setTimeout(() => {
      abandon(new AgentError('TIMEOUT', `the agent did not settle within ${waitMs}ms`));
      controller.abort();
    }, waitMs);
    try {
      return await Promise.race([work, stop]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }

  async #serialise<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    // As in the cognitive engine and the orchestrator: the queue swallows every
    // outcome, so one failed task does not poison the next.
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

const messageOf = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));

const issuesOf = (error: { issues: readonly { path: (string | number)[]; message: string }[] }): string =>
  error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');

/**
 * The run, as an agent is allowed to see it (ADR-0020 §2). No raw model output:
 * an agent reads what its proposals came to, not what the model said.
 */
export function summarise(result: RunResult): RunSummary {
  return {
    outcome: result.status,
    cycleId: result.cycleId,
    callId: result.callId,
    failure: result.failure,
    produced: result.produced,
    proposals: result.proposals.map((p) => ({
      kind: p.kind,
      accepted: p.outcome === 'ACCEPTED',
      reason: p.reason,
      detail: p.detail,
    })),
    context: {
      status: result.manifest.status,
      usedTokens: result.manifest.usedTokens,
      budgetTokens: result.manifest.budgetTokens,
      shown: result.manifest.entries
        .filter((entry) => entry.included)
        .map((entry) => ({ id: entry.id, kind: entry.kind, mandatory: entry.mandatory })),
    },
  };
}
