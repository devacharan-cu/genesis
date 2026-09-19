/**
 * The Bedrock adapter against real Bedrock (ADR-0007 mitigations, ADR-0018).
 *
 * SKIPPED unless explicitly enabled, and never part of the default gate: it
 * needs AWS credentials (the SDK's default chain), model access in the region,
 * network, and it costs money. Enable with:
 *
 *   GENESIS_BEDROCK_IT=1 GENESIS_BEDROCK_REGION=eu-west-1 \
 *   GENESIS_BEDROCK_MODEL_ID=<model or inference profile id> \
 *   corepack pnpm exec vitest run packages/adapters-aws/test/bedrock.integration.test.ts
 *
 * It checks the adapter's contract with the real service — a well-formed call
 * returns a ReasoningResult, a bad model id is a typed INVALID_REQUEST — and
 * nothing about the quality of what the model says. Required before P8
 * acceptance; not evidence of anything until it has actually been run.
 */

import { bedrockProvider } from '@genesis/adapters-aws';
import { ReasoningError, type ReasoningRequest } from '@genesis/reasoning';
import { describe, expect, it } from 'vitest';

const enabled = process.env['GENESIS_BEDROCK_IT'] === '1';
const region = process.env['GENESIS_BEDROCK_REGION'] ?? 'us-east-1';
const modelId = process.env['GENESIS_BEDROCK_MODEL_ID'] ?? '';

const request: ReasoningRequest = {
  callId: 'rsn_integration',
  purpose: 'PROPOSE_COGNITIVE_UPDATES',
  system: 'You are a test. Answer with the JSON the schema describes.',
  task: 'Return an empty list of proposals.',
  context: [],
  untrustedContent: [],
  outputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['proposals'],
    properties: { proposals: { type: 'array', maxItems: 0 } },
  },
  budget: { maxOutputTokens: 64, timeoutMs: 30_000 },
};

describe.skipIf(!enabled)('Bedrock, for real', () => {
  it('returns a reasoning result for a well-formed call', async () => {
    const result = await bedrockProvider({ region, modelId }).complete(request);
    expect(result.modelId).toBe(modelId);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.output).toBeTypeOf('object');
  });

  it('reports an unknown model as a typed failure', async () => {
    const failure = bedrockProvider({ region, modelId: 'genesis.no-such-model' }).complete(request);
    await expect(failure).rejects.toBeInstanceOf(ReasoningError);
    await expect(failure).rejects.toMatchObject({ kind: 'INVALID_REQUEST' });
  });
});
