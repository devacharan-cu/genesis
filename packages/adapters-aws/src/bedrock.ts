/**
 * The Bedrock ReasoningProvider (ADR-0007, ADR-0018 §1–2).
 *
 * Built on the Bedrock Runtime Converse API of
 * `@aws-sdk/client-bedrock-runtime` (3.1136.0): one `ConverseCommand` per call,
 * system prompt and a single user turn in, one assistant message out.
 * Everything Bedrock-shaped stays in this file — the request's text comes from
 * the provider-neutral `renderPrompt`, and every outcome leaves as a
 * `ReasoningResult` or a `ReasoningError`.
 *
 * What it deliberately does not do:
 *   - Retry. The client it builds makes one attempt (`maxAttempts: 1`); a
 *     failed call is the orchestrator's to record, not this adapter's to hide.
 *   - Guess at output. Text that is not one JSON value is INVALID_RESPONSE;
 *     output cut off at the token limit is OUTPUT_TRUNCATED, never parsed.
 *   - Assume native structured output. Converse's `json_schema` output format
 *     is sent only when `nativeStructuredOutput` is set, because not every
 *     model accepts it; the schema is always in the prompt either way.
 *   - Hold credentials. The client resolves them through the SDK's default
 *     provider chain (an IAM role in AWS); nothing here reads a secret.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import {
  parseJsonOutput,
  ReasoningError,
  type ReasoningFailureKind,
  type ReasoningProvider,
  ReasoningRequest,
  type ReasoningResult,
  renderPrompt,
  type StopReason,
} from '@genesis/reasoning';

/** The one method of the SDK client this adapter uses. A fake in tests; the real client in production. */
export interface ConverseClient {
  send(command: ConverseCommand, options: { abortSignal: AbortSignal }): Promise<ConverseCommandOutput>;
}

export interface BedrockProviderOptions {
  readonly client: ConverseClient;
  /** A Bedrock model id or inference profile id. */
  readonly modelId: string;
  /** Recorded on every call event. Defaults to `bedrock:<modelId>`. */
  readonly id?: string;
  /** Send Converse's `json_schema` output format. Only for models that support it. */
  readonly nativeStructuredOutput?: boolean;
  /** Defaults to 0: the least variable output the model offers. Not a determinism guarantee. */
  readonly temperature?: number;
}

/**
 * SDK error names, by the failure kind they mean. Matched by `name` rather
 * than `instanceof` so the mapping does not depend on which copy of the SDK
 * module constructed the error.
 */
const ERROR_KINDS: Readonly<Record<string, ReasoningFailureKind>> = {
  ThrottlingException: 'THROTTLED',
  ServiceQuotaExceededException: 'THROTTLED',
  ServiceUnavailableException: 'UNAVAILABLE',
  InternalServerException: 'UNAVAILABLE',
  ModelNotReadyException: 'UNAVAILABLE',
  ModelErrorException: 'UNAVAILABLE',
  ModelTimeoutException: 'TIMEOUT',
  AccessDeniedException: 'ACCESS_DENIED',
  ValidationException: 'INVALID_REQUEST',
  ResourceNotFoundException: 'INVALID_REQUEST',
  ConflictException: 'INVALID_REQUEST',
};

/**
 * Converse stop reasons. A stop that means the output is incomplete or was not
 * the model's own is a failure; the rest are normalised.
 */
const STOPS: Readonly<Record<string, StopReason | ReasoningFailureKind>> = {
  end_turn: 'END_TURN',
  stop_sequence: 'STOP_SEQUENCE',
  max_tokens: 'OUTPUT_TRUNCATED',
  model_context_window_exceeded: 'OUTPUT_TRUNCATED',
  content_filtered: 'CONTENT_FILTERED',
  guardrail_intervened: 'CONTENT_FILTERED',
  malformed_model_output: 'INVALID_RESPONSE',
  // No tools are offered, so a tool call is not an answer.
  malformed_tool_use: 'INVALID_RESPONSE',
  tool_use: 'INVALID_RESPONSE',
};

const isStop = (value: StopReason | ReasoningFailureKind): value is StopReason =>
  value === 'END_TURN' || value === 'STOP_SEQUENCE';

export class BedrockReasoningProvider implements ReasoningProvider {
  readonly id: string;
  readonly #client: ConverseClient;
  readonly #modelId: string;
  readonly #native: boolean;
  readonly #temperature: number;

  constructor(options: BedrockProviderOptions) {
    this.id = options.id ?? `bedrock:${options.modelId}`;
    this.#client = options.client;
    this.#modelId = options.modelId;
    this.#native = options.nativeStructuredOutput ?? false;
    this.#temperature = options.temperature ?? 0;
  }

  /** The Converse input for a request. Exposed so the mapping is testable without a client. */
  input(request: ReasoningRequest): ConverseCommandInput {
    const prompt = renderPrompt(request);
    return {
      modelId: this.#modelId,
      system: [{ text: prompt.system }],
      messages: [{ role: 'user', content: [{ text: prompt.user }] }],
      inferenceConfig: { maxTokens: request.budget.maxOutputTokens, temperature: this.#temperature },
      ...(this.#native
        ? {
            outputConfig: {
              textFormat: {
                type: 'json_schema',
                structure: { jsonSchema: { name: 'genesis_output', schema: JSON.stringify(request.outputSchema) } },
              },
            },
          }
        : {}),
    };
  }

  async complete(request: ReasoningRequest): Promise<ReasoningResult> {
    const parsed = ReasoningRequest.safeParse(request);
    if (!parsed.success) throw new ReasoningError('INVALID_REQUEST', 'the request does not satisfy the port schema');

    const { timeoutMs } = parsed.data.budget;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: ConverseCommandOutput;
    try {
      response = await this.#client.send(new ConverseCommand(this.input(parsed.data)), { abortSignal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ReasoningError('TIMEOUT', `Bedrock did not answer within ${timeoutMs}ms`, { modelId: this.#modelId });
      }
      throw classify(error, this.#modelId);
    } finally {
      clearTimeout(timer);
    }
    return this.#result(response);
  }

  #result(response: ConverseCommandOutput): ReasoningResult {
    const stop = STOPS[response.stopReason ?? ''] ?? 'INVALID_RESPONSE';
    if (!isStop(stop)) {
      throw new ReasoningError(stop, `Bedrock stopped with ${response.stopReason ?? 'no stop reason'}`, {
        modelId: this.#modelId,
      });
    }
    const content = response.output?.message?.content ?? [];
    const texts = content.flatMap((block) => (typeof block.text === 'string' ? [block.text] : []));
    if (texts.length === 0) {
      throw new ReasoningError('INVALID_RESPONSE', 'Bedrock returned no text', { modelId: this.#modelId });
    }
    const outputText = texts.join('');
    return {
      output: parseJsonOutput(outputText),
      outputText,
      modelId: this.#modelId,
      stopReason: stop,
      usage: { inputTokens: response.usage?.inputTokens ?? 0, outputTokens: response.usage?.outputTokens ?? 0 },
    };
  }
}

/** An SDK failure, as the port's failure. Unknown errors keep their name and message. */
function classify(error: unknown, modelId: string): ReasoningError {
  const name = error instanceof Error ? error.name : 'NonError';
  const message = error instanceof Error ? error.message : String(error);
  return new ReasoningError(ERROR_KINDS[name] ?? 'UNKNOWN', `Bedrock ${name}: ${message}`, { modelId, sdkError: name });
}

export interface BedrockRegionOptions extends Omit<BedrockProviderOptions, 'client'> {
  readonly region: string;
}

/**
 * The production composition: a real client for one region, one attempt per
 * call, credentials from the SDK's default chain. Constructing it makes no
 * network call; the first `complete` does.
 */
export function bedrockProvider(options: BedrockRegionOptions): BedrockReasoningProvider {
  const { region, ...rest } = options;
  return new BedrockReasoningProvider({ ...rest, client: new BedrockRuntimeClient({ region, maxAttempts: 1 }) });
}
