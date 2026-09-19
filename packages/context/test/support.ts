/**
 * Fixtures for the context tests: a cognition state built by the real deciders
 * and fold (no ledger — this package may not depend on one), and a request.
 */

import {
  type CognitionState,
  cognitionProjector,
  decide,
  emptyCognitionState,
  type IdSource,
} from '@genesis/cognition';
import { ContextRequest, type ParsedContextRequest } from '@genesis/context';
import type { EventActor, GenesisEvent } from '@genesis/core-types';

export const HUMAN: EventActor = { kind: 'HUMAN', id: 'dev' };
export const SYSTEM: EventActor = { kind: 'SYSTEM', id: 'core' };
export const AGENT: EventActor = { kind: 'AGENT', id: 'agt-1', agentRole: 'IMPLEMENTER' };

export const AS_OF = '2026-03-01T00:00:00.000Z';

function countingIds(): IdSource {
  const counters = new Map<string, number>();
  const next = (prefix: string) => (): string => {
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    return `${prefix}-${n}`;
  };
  return {
    goal: next('goal'),
    criterion: next('crit'),
    belief: next('bel'),
    uncertainty: next('unc'),
    contradiction: next('ctr'),
    question: next('qst'),
  };
}

/** Runs commands through the deciders and the fold, one second apart from 1 Feb 2026. */
export class Cognition {
  state: CognitionState = emptyCognitionState();
  #seq = 0;
  #t = Date.UTC(2026, 1, 1);
  readonly #ids = countingIds();

  run(actor: EventActor, command: unknown): this {
    const now = new Date(this.#t).toISOString();
    this.#t += 1000;
    for (const input of decide(this.state, command, { actor, now, ids: this.#ids })) {
      this.#seq += 1;
      const event = {
        id: `evt_${String(this.#seq).padStart(26, '0')}`,
        projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        seq: this.#seq,
        schemaVersion: 1,
        type: input.type,
        actor: input.actor,
        subject: null,
        before: null,
        after: null,
        cause: null,
        cycleId: null,
        authority: input.authority,
        payload: input.payload,
        timestamp: input.timestamp,
        payloadHash: 'a'.repeat(64),
        prevHash: null,
      } as GenesisEvent;
      this.state = cognitionProjector.apply(this.state, event);
    }
    return this;
  }
}

type RequestOverrides = Partial<Omit<ContextRequest, 'task'>> & { readonly task?: Partial<ContextRequest['task']> };

export const request = (over: RequestOverrides = {}): ContextRequest => ({
  asOf: AS_OF,
  budgetTokens: 1000,
  activeGoalId: null,
  ...over,
  task: { id: 'task-1', kind: 'implement', text: 'implement booking cancellation', nodeIds: [], ...over.task },
});

/** A request as the builders see it: parsed, defaults filled. */
export const parsed = (over: RequestOverrides = {}): ParsedContextRequest => ContextRequest.parse(request(over));
