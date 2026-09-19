# ADR-0018 — The reasoning port, the Bedrock adapter, and the core orchestrator

- **Status:** Accepted
- **Date:** 2026-09-19
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION`
- **Implements:** P4 — SPEC-00 §8; SPEC-01 §2, §11; SPEC-04 §4; SPEC-06 §6
- **Amends:** [ADR-0007](0007-reasoning-provider-port.md) binding rule 1
- **Builds on:** [ADR-0005](0005-authority-over-confidence.md), [ADR-0006](0006-proposal-based-mutation.md), [ADR-0014](0014-cognitive-primitives-as-deciders.md), [ADR-0015](0015-questions-as-ledger-records.md), [ADR-0016](0016-orchestrator-owns-graph-mirroring.md), [ADR-0017](0017-deterministic-scoring-and-context-assembly.md)

## Context

P4 puts a model in the loop for the first time. Everything before it was
deterministic and model-free; everything after it has to stay that way in the
parts that decide what is true. Four questions have to be settled before the
code is written:

1. Where does the model SDK live, and what can reach it?
2. What does a provider failure look like to the core?
3. What is the orchestrator allowed to do with a model's output?
4. How is the graph mirror (ADR-0016) made derived rather than a second writer?

## Decision

### 1. Three packages, one direction of dependency

| Package | Holds | May depend on |
|---|---|---|
| `reasoning` | The `ReasoningProvider` port, request and result schemas, the typed failure, the deterministic `MockReasoningProvider`, and the model-agnostic rendering of a request to text | `core-types` |
| `adapters-aws` | `BedrockReasoningProvider`, on the Bedrock Runtime **Converse** API of `@aws-sdk/client-bedrock-runtime` | `core-types`, `reasoning` (and the P8 store adapters later) |
| `core` | The orchestrator, the graph mirror, the run projection | `core-types`, `ledger`, `memory`, `graph`, `projections`, `cognition`, `context`, `reasoning` |

**Amendment to ADR-0007 rule 1.** ADR-0007 put model SDKs in
`packages/reasoning`. That would make the SDK part of the core's dependency
closure, because the core depends on the port. Instead the SDK lives in
`adapters-aws`, the same shape as `node:sqlite` in `adapters-sqlite`: the
boundary checker allows AWS SDK modules (`@aws-sdk/*`) there and nowhere
else, and `core` may not depend on any adapter package. The composition root
(an application, later) is the only place the two meet.

### 2. The port

`complete(request) → Promise<ReasoningResult>`. The request carries a call id,
a purpose, a system prompt, labelled context blocks (each with its authority),
explicitly untrusted blocks, the task, the JSON Schema the output must satisfy,
and a budget (`maxOutputTokens`, `timeoutMs`). The result carries the parsed
JSON output, the raw text it was parsed from, the model id, a normalised stop
reason and token usage.

Every failure is a `ReasoningError` with one of a fixed set of kinds —
`TIMEOUT`, `THROTTLED`, `UNAVAILABLE`, `ACCESS_DENIED`, `INVALID_REQUEST`,
`INVALID_RESPONSE`, `OUTPUT_TRUNCATED`, `CONTENT_FILTERED`, `UNKNOWN` — and a
`retryable` flag derived from the kind. An adapter maps its SDK's errors onto
these kinds; nothing SDK-shaped crosses the port. Output that is not a single
JSON value is `INVALID_RESPONSE`; output cut off at the token limit is
`OUTPUT_TRUNCATED`, never parsed as if it were whole.

Request and response hashes (ADR-0007 rule 4) are computed by the core with the
ledger's canonical serialiser, not by adapters, so there is one definition of
"the same request".

### 3. The orchestrator's loop, and what model output may do

One run of one task:

1. `TASK_STARTED` (the self model's existing vocabulary).
2. Gather and assemble context (ADR-0017) against the cognition state at a
   known ledger position; append `CONTEXT_ASSEMBLED` with the manifest, the
   impact set and that position.
3. If the assembly is `SPLIT_REQUIRED`: append `TASK_SPLIT_REQUIRED` naming the
   mandatory items and the overflow, then `TASK_FINISHED`. **No model call is
   made.** Splitting the task is the planner's job (P6).
4. Append `REASONING_REQUESTED` (call id, provider, purpose, request hash), then
   call the provider under an outer timeout.
5. On failure: `REASONING_FAILED` with the kind, the self model's
   `EXECUTION_FAILED` with signature `<task kind>:reasoning:<KIND>`, then
   `TASK_FINISHED`. The signature leads with the task kind, so the failure
   becomes a known failure that the next context for a task of the same kind
   must include (SPEC-01 §11.3).
6. On success: `REASONING_RESPONDED` with the model id, usage, stop reason,
   response hash and the raw output text (bounded). If the output is not the
   proposal envelope, `REASONING_OUTPUT_REJECTED` and `EXECUTION_FAILED`.
7. Each proposal is evaluated separately (SPEC-04 §4.3, partial acceptance):
   - it must be one of the permitted kinds — `RECORD_BELIEF`,
     `RECORD_UNCERTAINTY`, `DRAFT_QUESTION`, `RECORD_CONTRADICTION` — and
     well-formed; anything else is `NOT_PERMITTED` or `MALFORMED`;
   - it must name the goals it contributes to, one of them `ACTIVE`
     (goal-drift conditions 1 and 2, SPEC-01 §5.2);
   - it is executed by the cognitive engine **as an `AGENT` actor**, so every
     agent rule applies unchanged: beliefs capped at `AI_ASSUMPTION`, no
     `TESTED`/`VERIFIED`, agent-asserted authority indeterminate in a
     contradiction, drafts but never asks. A belief's `reasoningCallId` is set
     by the orchestrator to the call that produced it, whatever the output
     says, so the belief cannot later count its own call as independent
     support.
   Each outcome is recorded as `PROPOSAL_EVALUATED`.
8. The graph mirror catches up (§4), then `TASK_FINISHED`.

Every event of a run carries the run's `cycleId`. Ids and the clock are
injected, runs for one project are serialised in-process, and cognitive writes
keep the engine's conditional append, so the sequence of events for a given
ledger, task and provider output is deterministic.

The provider's output is never evidence. `REASONING_RESPONDED` records, with
`VERIFIED_SYSTEM_STATE` authority, only that the provider *said* this; what it
said reaches cognitive state only as `AGENT` proposals, clamped and checked by
the same deciders as any agent's.

### 4. The graph mirror reconciles from canonical state

The mirror computes the graph a cognition state implies — goal nodes with
`REQUIRES` edges to child goals, belief nodes, uncertainty nodes with `BLOCKS`
edges to the goals they block, `CONTRADICTS` between two belief sides, question
nodes `DERIVED_FROM` their uncertainty — and reconciles the graph to it:
missing nodes and edges are added, statuses that differ are transitioned.
Node and edge ids are derived deterministically from the project and record
ids, labels and attributes are immutable facts of the record, and lifecycle
maps to graph status (`ARCHIVED` for a closed goal, uncertainty or question,
`SUPERSEDED` for a belief that lost on authority, `RETRACTED` for a `BLOCKS`
edge whose uncertainty closed).

So the mirror is a pure function of canonical state plus idempotent writes:
running it twice changes nothing, running it on a fresh graph from a replayed
state gives the same nodes and edges, and a mirrored node whose type or label
disagrees with its record is a `MirrorDivergenceError`, not something to
overwrite. The mirror never deletes and never reads a fact from the graph to
decide anything.

## What P4 does not do

- **No automatic retry.** A failed call is recorded and the run ends; a caller
  may run the task again. Retrying inside a run would make one run's events
  depend on timing.
- **No task splitting.** `SPLIT_REQUIRED` is recorded and returned.
- **No other proposal kinds.** Graph writes, memory writes, artifact changes and
  transitions are P6 proposals with impact analysis and policy checks.
- **No streaming, tool use or extended features** of any provider.
- **No Anthropic API adapter** (ADR-0007 listed it as optional).
- **The Bedrock integration suite** runs only when explicitly enabled with
  credentials; it never gates the default gate (ADR-0007 mitigations).

## Consequences

**Positive**

- The core is model-free and SDK-free by package graph, not by convention.
- Every run is explainable from the ledger: what was shown, what was asked,
  what came back, what was accepted and why the rest was not.
- A model can at most propose assumptions, unknowns, drafts and escalations —
  exactly what an agent may do — and every one is attributable to its call.

**Negative**

- Native structured output is model-specific on Bedrock. The adapter always
  states the schema in the prompt and sends Converse's `json_schema` output
  format only when configured to; with it off, malformed output is caught
  after the fact rather than prevented.
- The mirror reconciles the whole cognition state each time: O(records) per
  run. Adequate at P4's scale; an event-driven mirror is the optimisation if it
  is not.
- Graph node timestamps and versions are the mirror's write times, not the
  records' — the graph is a view, and only its structure is compared on rebuild.

**Mitigations**

- The mock provider and fake SDK clients cover every failure kind and every
  malformed-output shape deterministically.
- A rebuild test proves an incrementally mirrored graph and a graph mirrored
  once from a replayed state are structurally identical.
