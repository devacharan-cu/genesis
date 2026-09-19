/**
 * The cognitive engine: decide, append, fold (ADR-0014).
 *
 * The only moving part in this package. It keeps a live cognition projection per
 * project, and runs each command as:
 *
 *   1. catch the projection up to the ledger head
 *   2. decide the command against that state          (pure)
 *   3. append the events, CONDITIONAL on the head it decided against
 *   4. fold the appended events into the projection   (pure)
 *
 * Step 3 is what makes this safe with more than one writer. If anything else
 * appended to the project between 1 and 3, the append is refused and nothing is
 * written; the engine catches up and decides again. Deciding again is safe
 * because deciding is pure — and a command that WAS legal may no longer be, in
 * which case it is refused rather than written on top of a state it never saw.
 *
 * Commands for one project are also serialised in-process, so writers in the
 * same process do not burn retries on each other.
 */

import {
  type EventActor,
  type GenesisEvent,
  type ProjectScope,
  SequenceConflictError,
} from '@genesis/core-types';
import type { EventLedger } from '@genesis/ledger';
import { applyEvents, emptyProjection, type ProjectionState, resumeProjection } from '@genesis/projections';
import { type DecisionContext, defaultIdSource, type IdSource } from './context.js';
import { decide } from './decide.js';
import { defaultQuestionScorer, type QuestionScorer } from './scoring.js';
import { cognitionProjector } from './projector.js';
import type { CognitionState } from './records.js';

export interface CognitiveEngineOptions {
  readonly ids?: IdSource;
  /** ISO timestamp source. Injected so tests are deterministic. */
  readonly now?: () => string;
  /** How many times to decide again after losing a race. Defaults to 3. */
  readonly maxAttempts?: number;
  /** How questions are scored. Defaults to the deterministic default scorer (ADR-0017). */
  readonly scorer?: QuestionScorer;
}

export interface ExecutionResult {
  /** Exactly the events this command appended, as stored. */
  readonly events: readonly GenesisEvent[];
  /** The projection after them. */
  readonly projection: ProjectionState<CognitionState>;
}

export class CognitiveEngine {
  readonly #ledger: EventLedger;
  readonly #ids: IdSource;
  readonly #now: () => string;
  readonly #maxAttempts: number;
  readonly #scorer: QuestionScorer;
  readonly #live = new Map<string, ProjectionState<CognitionState>>();
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(ledger: EventLedger, options: CognitiveEngineOptions = {}) {
    this.#ledger = ledger;
    this.#ids = options.ids ?? defaultIdSource;
    this.#now = options.now ?? ((): string => new Date().toISOString());
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#scorer = options.scorer ?? defaultQuestionScorer;
  }

  /** The cognition projection, caught up to the ledger head. */
  state(scope: ProjectScope): Promise<ProjectionState<CognitionState>> {
    return this.#serialise(scope.projectId, () => this.#catchUp(scope));
  }

  /** Decides and records one command. Throws, having appended nothing, if it is refused. */
  execute(scope: ProjectScope, actor: EventActor, command: unknown): Promise<ExecutionResult> {
    return this.#serialise(scope.projectId, () => this.#attempt(scope, actor, command, 1));
  }

  /**
   * One attempt: catch up, decide, append conditionally, fold.
   *
   * A lost race tries again by recursion, bounded by `maxAttempts`, rather than
   * by an unbounded loop — a `for (;;)` has an exit nothing can reach, and an
   * unreachable path in a module held to full branch coverage is a sign the code
   * models a case the problem does not have.
   */
  async #attempt(
    scope: ProjectScope,
    actor: EventActor,
    command: unknown,
    attempt: number,
  ): Promise<ExecutionResult> {
    const current = await this.#catchUp(scope);
    const ctx: DecisionContext = {
      actor,
      now: this.#now(),
      ids: this.#ids,
      scorer: this.#scorer,
    };
    const inputs = decide(current.state, command, ctx);

    let appended: GenesisEvent[];
    try {
      appended = await this.#ledger.appendMany(scope, inputs, { expectedLastSeq: current.lastSeq });
    } catch (error) {
      // Only a lost race is retried, and only a bounded number of times.
      if (error instanceof SequenceConflictError && attempt < this.#maxAttempts) {
        return this.#attempt(scope, actor, command, attempt + 1);
      }
      throw error;
    }

    // Outside the try: once the append has landed, nothing here may cause it
    // to be attempted again.
    const projection = applyEvents(cognitionProjector, current, appended);
    this.#live.set(scope.projectId, projection);
    return { events: appended, projection };
  }

  async #catchUp(scope: ProjectScope): Promise<ProjectionState<CognitionState>> {
    const cached = this.#live.get(scope.projectId) ?? emptyProjection(cognitionProjector, scope);
    const { projection } = await resumeProjection(cognitionProjector, cached, this.#ledger);
    this.#live.set(scope.projectId, projection);
    return projection;
  }

  async #serialise<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    // `previous` never rejects — the queue below swallows every outcome — so a
    // plain `then(task)` runs the task after it in every case. A rejection
    // handler here would be a branch no input can reach.
    const previous = this.#queues.get(projectId) ?? Promise.resolve();
    const run = previous.then(task);
    // The queue swallows the outcome, so one failed command does not poison
    // every later command for that project.
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
