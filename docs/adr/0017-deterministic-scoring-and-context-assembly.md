# ADR-0017 — Deterministic, replaceable scoring; context assembly as a pure package

- **Status:** Accepted
- **Date:** 2026-09-19
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION`
- **Implements:** SPEC-01 §9.2 (question scoring), §11 (context assembly)
- **Builds on:** [ADR-0001](0001-monorepo-layout.md), [ADR-0007](0007-reasoning-provider-port.md), [ADR-0014](0014-cognitive-primitives-as-deciders.md), [ADR-0015](0015-questions-as-ledger-records.md), [ADR-0016](0016-orchestrator-owns-graph-mirroring.md)

## Context

P3 needs two scoring functions. SPEC-01 §9.2 scores questions by
`informationGain × decisionImpact × riskReduction × dependencyCoverage`, and
says outright that the formula is a heuristic that will be wrong. §11 scores
context candidates on six weighted signals under a token budget, with four
kinds of mandatory inclusion. Both will be replaced — by better heuristics, by
learned weights, by embeddings (open decision E5). What must not change when
they are replaced: that the core is deterministic, that it has no model in it,
and that every score it acted on is recorded and explainable.

## Decision

### 1. Scorers are interfaces with a named, versioned default

- `QuestionScorer { name, version, score(state, uncertainty) }` returns the four
  factors. The engine multiplies them, so a scorer cannot report a value that
  disagrees with its own breakdown. Factors outside `[0, 1]` or not finite are
  refused (`INVALID_SCORE`), and nothing is written.
- `RelevanceScorer { name, version, score(task, candidate) }` and
  `TokenEstimator { name, version, estimate(text) }` do the same for context.
- Each default is a pure function of its inputs: no clock, no randomness, no
  model call. Tests pin exact values.
- The scorer in use is injected (`DecisionContext.scorer`, the assembly
  options), and its name and version are recorded next to every score, so a
  replaced scorer leaves an audit trail of which scores came from which.

### 2. Question scores are recorded when they are acted on

A question is scored when drafted, and scored **again** when it is asked,
against the state at that moment; the `QUESTION_ASKED` event records that
score. Batching (`nextQuestionBatch`) ranks drafts by a live score. Recording
the score at asking time is what lets §9.2's outcome record be compared with the
score that actually selected the question.

### 3. Context assembly is its own package, and pure

`packages/context` may depend on `core-types`, `memory`, `graph`, `projections`
and `cognition` — for their **types and pure selectors**. Its assembly is a pure
function: candidates, request and options in; a manifest out. It never writes a
store. The optional gatherer that reads memory and the graph takes narrow
read-only interfaces (`query`, `getNode`, `impactSet`), not the store ports, so
it cannot write even by mistake. `agents` may not depend on it: assembling
context is the core's job, and an agent receives the result.

### 4. Model-specific reasoning stays out

Relevance is **lexical** by default: term coverage of the task by the
candidate, over a fixed tokeniser. Embedding similarity is deferred to E5 and
will arrive as another `RelevanceScorer`, behind the reasoning provider port
(ADR-0007), never as a model call inside the core. The token estimate is a
documented approximation (`ceil(chars / 4)`), not a model's tokenizer; a
provider-specific estimator is another `TokenEstimator`.

### 5. Mandatory inclusions cannot be crowded out; overflow splits the task

Policies applicable to the task, open blocking uncertainties for the active
goal, escalated contradictions touching the task's impact set, and known
failures matching the task kind are included before any scored candidate. If
they alone exceed the budget, assembly returns `SPLIT_REQUIRED` with what did
not fit, and **no** context: silently dropping a mandatory item is the failure
§11.3 exists to prevent. Splitting the task is the planner's job (P4).

### 6. Every assembly is explainable

The result is a manifest: the weights, the scorers, every candidate's signals
and score, what was included and why, what was excluded and why, the graph
depths and memory record versions used (ADR-0016 rule 5). It is recorded as a
`CONTEXT_ASSEMBLED` event input for the orchestrator to append.

## Consequences

**Positive**

- A scorer can be replaced without touching a decider, a fold or a test of the
  rules, and old scores stay attributable to the scorer that made them.
- The same inputs always give the same context, byte for byte, so a cycle can
  be re-run and explained.

**Negative**

- Lexical relevance misses paraphrase: a candidate phrased differently from the
  task scores low. Authority, goal and dependency signals (70% of the default
  weight) partly compensate; E5 is the fix.
- `ceil(chars / 4)` over- or under-counts real tokens by model and language.
  Budgets must leave headroom until a provider estimator exists.
- The default question score is a product, so an uncertainty that blocks no
  goal scores 0. Such questions are still ordered, by risk and age, but always
  after any blocking one. That is the formula's intent (§9.1) and may prove too
  strict.
- Known-failure matching uses a provisional rule — the failure signature's
  first `:`-separated segment equals the task kind — pending SPEC-01 §12 item 2.

**Mitigations**

- Every limitation above is in a named, versioned, injectable component, so
  fixing one is a local change with a recorded version bump.
- Outcome records (§9.2) collect the data needed to evaluate the question
  scorer against reality.
