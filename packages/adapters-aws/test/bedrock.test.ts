/**
 * The Bedrock adapter against a fake Converse client: every mapping, no
 * network, no credentials. The real `ConverseCommand` is constructed — that is
 * pure — and the fake inspects exactly the input Bedrock would receive.
 */

import { bedrockProvider, BedrockReasoningProvider, type ConverseClient } from '@genesis/adapters-aws';
import type { ConverseCommand, ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { ReasoningError, type ReasoningRequest, renderPrompt } from '@genesis/reasoning';
import { describe, expect, it } from 'vitest';

const request: ReasoningRequest = {
  callId: 'rsn_1',
  purpose: 'PROPOSE_COGNITIVE_UPDATES',
  system: 'You propose.',
  task: 'do it',
  context: [{ id: 'goal:goal-1', kind: 'GOAL', authority: 'HUMAN_DECISION', text: 'ship it' }],
  untrustedContent: [],
  outputSchema: { type: 'object', required: ['proposals'] },
  budget: { maxOutputTokens: 256, timeoutMs: 1000 },
};

const answer = (text: string | null, over: Partial<ConverseCommandOutput> = {}): ConverseCommandOutput =>
  ({
    output: { message: { role: 'assistant', content: text === null ? [] : [{ text }] } },
    stopReason: 'end_turn',
    usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 },
    metrics: { latencyMs: 10 },
    $metadata: {},
    ...over,
  }) as ConverseCommandOutput;

/** A client that records what it was sent and answers as told. */
function fake(reply: (command: ConverseCommand, signal: AbortSignal) => Promise<ConverseCommandOutput>) {
  const sent: ConverseCommand[] = [];
  const client: ConverseClient = {
    send: (command, options) => {
      sent.push(command);
      return reply(command, options.abortSignal);
    },
  };
  return { client, sent };
}

const sdkError = (name: string, message = 'from bedrock'): Error => Object.assign(new Error(message), { name });

describe('BedrockReasoningProvider', () => {
  it('sends the rendered prompt through Converse and returns the parsed output', async () => {
    const { client, sent } = fake(() => Promise.resolve(answer('{"proposals":[]}')));
    const provider = new BedrockReasoningProvider({ client, modelId: 'anthropic.claude-test' });
    expect(provider.id).toBe('bedrock:anthropic.claude-test');

    const result = await provider.complete(request);
    expect(result).toEqual({
      output: { proposals: [] },
      outputText: '{"proposals":[]}',
      modelId: 'anthropic.claude-test',
      stopReason: 'END_TURN',
      usage: { inputTokens: 120, outputTokens: 40 },
    });

    const { system, user } = renderPrompt(request);
    expect(sent[0]?.input).toEqual({
      modelId: 'anthropic.claude-test',
      system: [{ text: system }],
      messages: [{ role: 'user', content: [{ text: user }] }],
      inferenceConfig: { maxTokens: 256, temperature: 0 },
    });
  });

  it('asks for native structured output only when told the model supports it', () => {
    const provider = new BedrockReasoningProvider({
      client: fake(() => Promise.reject(new Error('unused'))).client,
      modelId: 'm',
      id: 'bedrock-eu',
      nativeStructuredOutput: true,
      temperature: 0.2,
    });
    expect(provider.id).toBe('bedrock-eu');
    expect(provider.input(request)).toMatchObject({
      inferenceConfig: { maxTokens: 256, temperature: 0.2 },
      outputConfig: {
        textFormat: {
          type: 'json_schema',
          structure: { jsonSchema: { name: 'genesis_output', schema: JSON.stringify(request.outputSchema) } },
        },
      },
    });
  });

  it('joins text blocks, skips non-text blocks, and normalises stop reasons and missing usage', async () => {
    const reply = answer(null, {
      output: { message: { role: 'assistant', content: [{ text: '{"a":' }, { reasoningContent: {} } as never, { text: '1}' }] } },
      stopReason: 'stop_sequence',
      usage: undefined,
    });
    const provider = new BedrockReasoningProvider({ client: fake(() => Promise.resolve(reply)).client, modelId: 'm' });
    expect(await provider.complete(request)).toMatchObject({
      output: { a: 1 },
      outputText: '{"a":1}',
      stopReason: 'STOP_SEQUENCE',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  it.each([
    ['max_tokens', 'OUTPUT_TRUNCATED'],
    ['model_context_window_exceeded', 'OUTPUT_TRUNCATED'],
    ['content_filtered', 'CONTENT_FILTERED'],
    ['guardrail_intervened', 'CONTENT_FILTERED'],
    ['malformed_model_output', 'INVALID_RESPONSE'],
    ['malformed_tool_use', 'INVALID_RESPONSE'],
    ['tool_use', 'INVALID_RESPONSE'],
    ['something_new', 'INVALID_RESPONSE'],
    [undefined, 'INVALID_RESPONSE'],
  ] as const)('treats stop reason %s as %s, never parsing the output', async (stopReason: string | undefined, kind: string) => {
    const reply = answer('{"proposals":[]}', { stopReason: stopReason as never });
    const provider = new BedrockReasoningProvider({ client: fake(() => Promise.resolve(reply)).client, modelId: 'm' });
    await expect(provider.complete(request)).rejects.toMatchObject({ kind });
  });

  it('refuses a response with no text, and text that is not JSON', async () => {
    const empty = new BedrockReasoningProvider({ client: fake(() => Promise.resolve(answer(null))).client, modelId: 'm' });
    await expect(empty.complete(request)).rejects.toMatchObject({ kind: 'INVALID_RESPONSE', message: 'Bedrock returned no text' });
    const missing = new BedrockReasoningProvider({
      client: fake(() => Promise.resolve(answer(null, { output: undefined }))).client,
      modelId: 'm',
    });
    await expect(missing.complete(request)).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    const prose = new BedrockReasoningProvider({ client: fake(() => Promise.resolve(answer('Sure, here you go'))).client, modelId: 'm' });
    await expect(prose.complete(request)).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
  });

  it.each([
    ['ThrottlingException', 'THROTTLED'],
    ['ServiceQuotaExceededException', 'THROTTLED'],
    ['ServiceUnavailableException', 'UNAVAILABLE'],
    ['InternalServerException', 'UNAVAILABLE'],
    ['ModelNotReadyException', 'UNAVAILABLE'],
    ['ModelErrorException', 'UNAVAILABLE'],
    ['ModelTimeoutException', 'TIMEOUT'],
    ['AccessDeniedException', 'ACCESS_DENIED'],
    ['ValidationException', 'INVALID_REQUEST'],
    ['ResourceNotFoundException', 'INVALID_REQUEST'],
    ['ConflictException', 'INVALID_REQUEST'],
    ['SomethingElse', 'UNKNOWN'],
  ] as const)('maps %s to %s', async (name: string, kind: string) => {
    const provider = new BedrockReasoningProvider({ client: fake(() => Promise.reject(sdkError(name))).client, modelId: 'm' });
    const failure = provider.complete(request);
    await expect(failure).rejects.toBeInstanceOf(ReasoningError);
    await expect(failure).rejects.toMatchObject({ kind, message: `Bedrock ${name}: from bedrock`, details: { sdkError: name, modelId: 'm' } });
  });

  it('classifies a thrown non-error as UNKNOWN', async () => {
    const provider = new BedrockReasoningProvider({ client: fake(() => Promise.reject('just a string')).client, modelId: 'm' });
    await expect(provider.complete(request)).rejects.toMatchObject({ kind: 'UNKNOWN', message: 'Bedrock NonError: just a string' });
  });

  it('aborts the call at the request’s timeout and reports TIMEOUT', async () => {
    const { client } = fake(
      (_command, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(sdkError('AbortError', 'Request aborted')));
        }),
    );
    const provider = new BedrockReasoningProvider({ client, modelId: 'm' });
    await expect(provider.complete({ ...request, budget: { maxOutputTokens: 1, timeoutMs: 15 } })).rejects.toMatchObject({
      kind: 'TIMEOUT',
      message: 'Bedrock did not answer within 15ms',
    });
  });

  it('refuses a malformed request before sending anything', async () => {
    const { client, sent } = fake(() => Promise.resolve(answer('{}')));
    const provider = new BedrockReasoningProvider({ client, modelId: 'm' });
    await expect(provider.complete({ ...request, system: '' })).rejects.toMatchObject({ kind: 'INVALID_REQUEST' });
    expect(sent).toHaveLength(0);
  });
});

describe('bedrockProvider', () => {
  it('builds a provider on a real client without touching the network', () => {
    const provider = bedrockProvider({ region: 'eu-west-1', modelId: 'anthropic.claude-test' });
    expect(provider).toBeInstanceOf(BedrockReasoningProvider);
    expect(provider.id).toBe('bedrock:anthropic.claude-test');
  });
});
