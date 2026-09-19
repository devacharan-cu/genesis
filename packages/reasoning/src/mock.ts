/**
 * The deterministic mock provider (ADR-0007: "the core's full test suite
 * passes with this alone").
 *
 * It answers from a script, in order, and records every request it was given.
 * It behaves like a provider in the ways the core depends on: text output goes
 * through the same JSON parser a real adapter uses, a step can fail with any
 * failure kind, and a step can hang, in which case the request's own
 * `timeoutMs` ends it with TIMEOUT — so timeout handling is tested against the
 * budget, not against a mock that cheats.
 *
 * It verifies the orchestrator's logic, never a model's behaviour: a test that
 * passes against scripted output says nothing about whether a real model would
 * produce it.
 */

import type { JsonValue } from '@genesis/core-types';
import { parseJsonOutput, ReasoningError } from './errors.js';
import { ReasoningRequest, type ReasoningProvider, type ReasoningResult, type StopReason, type TokenUsage } from './port.js';

export type MockStep =
  /** Output given as a value: returned as its JSON text, parsed back. */
  | { readonly output: JsonValue; readonly stopReason?: StopReason; readonly usage?: TokenUsage }
  /** Output given as raw text: parsed exactly as a real adapter would. */
  | { readonly text: string; readonly stopReason?: StopReason; readonly usage?: TokenUsage }
  | { readonly error: ReasoningError }
  /** Never answers; the request's timeout ends it. */
  | { readonly hang: true };

export type MockScript = readonly MockStep[] | ((request: ReasoningRequest, call: number) => MockStep);

export interface MockOptions {
  readonly id?: string;
  readonly modelId?: string;
}

export class MockReasoningProvider implements ReasoningProvider {
  readonly id: string;
  readonly #modelId: string;
  readonly #script: MockScript;
  readonly #requests: ReasoningRequest[] = [];

  constructor(script: MockScript, options: MockOptions = {}) {
    this.id = options.id ?? 'mock';
    this.#modelId = options.modelId ?? 'mock-model';
    this.#script = script;
  }

  /** Every request received, in order, as received. */
  get requests(): readonly ReasoningRequest[] {
    return [...this.#requests];
  }

  complete(request: ReasoningRequest): Promise<ReasoningResult> {
    // A real provider refuses a malformed request before it spends anything.
    const parsed = ReasoningRequest.safeParse(request);
    if (!parsed.success) {
      return Promise.reject(new ReasoningError('INVALID_REQUEST', 'the request does not satisfy the port schema'));
    }
    const call = this.#requests.length;
    this.#requests.push(parsed.data);
    const step = typeof this.#script === 'function' ? this.#script(parsed.data, call) : this.#script[call];
    if (step === undefined) {
      return Promise.reject(new ReasoningError('UNKNOWN', `mock script has no step for call ${call}`));
    }
    return this.#run(step, parsed.data.budget.timeoutMs);
  }

  #run(step: MockStep, timeoutMs: number): Promise<ReasoningResult> {
    if ('hang' in step) {
      return new Promise((_resolve, reject) => {
        setTimeout(() => reject(new ReasoningError('TIMEOUT', `no answer within ${timeoutMs}ms`)), timeoutMs);
      });
    }
    if ('error' in step) return Promise.reject(step.error);
    const outputText = 'text' in step ? step.text : JSON.stringify(step.output);
    try {
      return Promise.resolve({
        output: parseJsonOutput(outputText),
        outputText,
        modelId: this.#modelId,
        stopReason: step.stopReason ?? 'END_TURN',
        usage: step.usage ?? { inputTokens: 0, outputTokens: 0 },
      });
    } catch (error) {
      return Promise.reject(error as ReasoningError);
    }
  }
}
