# ADR-0005 — Authority hierarchy governs conflicts, not confidence scores

- **Status:** Accepted
- **Date:** 2026-09-18
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION`

## Context

When two claims about a project conflict, something has to decide which governs.

The common approach is a confidence score: each claim carries a number, the
higher number wins. This fails in a specific and dangerous way for GENESIS: a
language model can produce a confident-sounding assertion with a high score and
no grounding at all, and it will outrank a human's quietly stated requirement.
Confidence measures *how sure the producer sounds*, not *how entitled the claim
is to be believed*.

## Decision

Conflicts are resolved by **authority**, a fixed ordinal defined in
[SPEC-00](../architecture/00-MASTER-SPEC.md) §4.2:

```
HUMAN_DECISION > VERIFIED_SYSTEM_STATE > ACTIVE_REQUIREMENT
                > EVIDENCE > HISTORICAL > AI_ASSUMPTION
```

Rules:

1. Authority is a property of the claim's **source and grounding**, not of its
   producer's certainty.
2. Model-produced claims are **clamped** to `AI_ASSUMPTION` at the writer. An
   agent cannot assert its own authority
   ([SPEC-04](../architecture/04-AGENT-ARCHITECTURE.md) §4.2).
3. Promotion is always an event carrying the higher-authority source. Nothing
   promotes itself.
4. A `confidence` number may be stored as metadata. **No control flow branches
   on it alone.** It is diagnostic, and useful later for calibration analysis.
5. When authority is equal or indeterminate, the conflict is **not** resolved by
   tiebreak. Both claims stay active, an uncertainty is opened, and a question
   is raised. The system says "I cannot determine this" rather than picking.
6. Belief state transitions have their own evidence requirements
   ([SPEC-01](../architecture/01-COGNITIVE-ARCHITECTURE.md) §6.1) that a
   confidence score cannot satisfy.

## Consequences

**Positive**

- A human's requirement cannot be silently overridden by a fluent assumption.
  This is the single most important safety property in the knowledge layer.
- Resolution is explainable in one sentence: *"this governs because a human
  decided it; that was an AI assumption."*
- Ties produce questions, which is the behaviour the project is named for.

**Negative**

- Coarse. Six levels cannot express "strong evidence from three independent
  runs" versus "one flaky observation."
- Equal-authority ties are common in practice (two evidence records
  disagreeing), so the system will generate real work for humans.
- Recency is not in the ordering: a stale `HUMAN_DECISION` outranks fresh
  `EVIDENCE`, which is sometimes wrong.

**Mitigations**

- Evidence strength (count, independence, recency of observation) is a
  *retrieval ranking* signal in context assembly
  ([SPEC-01](../architecture/01-COGNITIVE-ARCHITECTURE.md) §11.2), where
  gradation is appropriate — it just never overrides authority in conflict
  resolution.
- Time-bounded facts use `validUntil`
  ([SPEC-02](../architecture/02-MEMORY-ARCHITECTURE.md) §3) so stale decisions
  can expire deliberately rather than by heuristic.
- When fresh `VERIFIED_SYSTEM_STATE` contradicts an old `HUMAN_DECISION`, that
  contradiction is surfaced to the human as a question — the right outcome, since
  it usually means the decision needs revisiting.
- The equal-authority case is expected to be the main source of human questions.
  The question engine's scoring exists precisely to keep that volume useful.
