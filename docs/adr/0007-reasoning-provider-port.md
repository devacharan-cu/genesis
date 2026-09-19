# ADR-0007 — `ReasoningProvider` port, with Bedrock as the first adapter

- **Status:** Accepted
- **Date:** 2026-09-18
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION`

## Context

The architectural principle of GENESIS is that the LLM is a *reasoning
component*, not the system. The Cognitive Core owns state and truth
([SPEC-00](../architecture/00-MASTER-SPEC.md) §2).

That principle is only real if the core does not depend on a specific model
vendor, and if the core's behaviour can be tested without calling a model at
all. A core whose test suite requires inference is a core that has the model on
its critical path.

The deployment target is AWS, which argues for Bedrock; local development
argues for something faster and cheaper; tests argue for something
deterministic.

## Decision

Define a single port:

```ts
interface ReasoningProvider {
  readonly id: string;               // recorded on every event for provenance
  complete(req: ReasoningRequest): Promise<ReasoningResult>;
}

type ReasoningRequest = {
  purpose: ReasoningPurpose;         // e.g. GENERATE_QUESTIONS, DIAGNOSE_FAILURE
  system: string;
  context: AssembledContext;         // built by context assembly, token-budgeted
  untrustedContent: UntrustedBlock[];// explicitly labelled, never instructions
  outputSchema: JSONSchema;          // structured output is required
  budget: { maxTokens: number; timeoutMs: number };
};

type ReasoningResult = {
  output: unknown;                   // validated against outputSchema before use
  usage: TokenUsage;
  modelId: string;
  requestHash: string;
  responseHash: string;
};
```

Adapters:

| Adapter | Phase | Use |
|---|---|---|
| `MockReasoningProvider` | P4 | Deterministic, fixture-driven. **The core's full test suite passes with this alone.** |
| `BedrockReasoningProvider` | P4 | Primary runtime adapter; AWS IAM boundary, request logging |
| `AnthropicApiReasoningProvider` | P4 (optional) | Faster local iteration |

Binding rules:

1. **No package other than `packages/reasoning` imports a model SDK.** The core
   and every agent see only the port.
   *Amended by [ADR-0018](0018-reasoning-and-orchestration.md): model SDKs live
   in adapter packages (`adapters-aws` for Bedrock), outside the core's
   dependency closure; `packages/reasoning` holds the port and the mock only.*
2. **Structured output only.** Every call declares an `outputSchema` and the
   result is validated before anything reads it. Free-form text is never parsed
   heuristically.
3. **Output is never executed, never written to state directly.** It becomes a
   proposal ([ADR-0006](0006-proposal-based-mutation.md)).
4. **Every call is an event** carrying `modelId`, `purpose`, `requestHash`,
   `responseHash` and usage — so a cycle is explainable even though it is not
   bit-reproducible.
5. **Records produced from a reasoning call are clamped to `AI_ASSUMPTION`**
   ([ADR-0005](0005-authority-over-confidence.md)).
6. **Secrets never enter `ReasoningRequest`.** The type carries `SecretRef`
   values only; resolution happens in tool runners
   ([SPEC-06](../architecture/06-SECURITY-ARCHITECTURE.md) §5).

## Consequences

**Positive**

- The core is testable with zero inference cost and deterministic results.
- Vendor choice is a composition-root decision, changeable without touching
  logic.
- Provenance of every model-derived claim is recorded by construction.
- Structured output removes a large class of parsing failures and injection
  surface.

**Negative**

- The port must be narrow enough to be portable yet expressive enough to be
  useful; provider-specific features (extended thinking, caching, tool use,
  long context) do not map uniformly.
- Mock-driven tests can drift from real model behaviour — passing tests do not
  prove the prompt works.
- Structured output support and quality differ across providers.

**Mitigations**

- Provider-specific capabilities are declared in a `capabilities` descriptor on
  the adapter; the core degrades gracefully when one is absent rather than
  assuming it.
- A separate, explicitly-tagged integration suite exercises the real Bedrock
  adapter against recorded scenarios. It is not part of the default test run and
  it never gates the core suite — but it is required before P8 acceptance.
- Prompt-level regressions are caught by evaluating real outputs against
  recorded expectations, tracked separately from unit tests. Mock tests verify
  *our* logic; they are never claimed to verify the model's.
