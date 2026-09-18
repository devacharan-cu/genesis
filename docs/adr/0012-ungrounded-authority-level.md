# ADR-0012 — Add `UNGROUNDED`, and make the grounding step a ladder

- **Status:** Accepted
- **Date:** 2026-09-18
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION`
- **Answers:** open decision **E11**
- **Refines:** [ADR-0005](0005-authority-over-confidence.md), [ADR-0011](0011-write-time-authority-policy.md)

## Context

[ADR-0011](0011-write-time-authority-policy.md) recorded two defects with one
cause: the authority ladder had no level meaning *"nothing supports this"*.

1. `AI_ASSUMPTION` was doing double duty as the floor for an ungrounded claim by
   a human or the system, where the name states something false about where the
   claim came from.
2. The policy was **not monotone**. A `SYSTEM` actor with no evidence asking for
   `HUMAN_DECISION` was capped to `VERIFIED_SYSTEM_STATE`, failed that level's
   grounding check, and dropped to the `AI_ASSUMPTION` floor — while the same
   actor asking for the *lower* `HISTORICAL` kept it. Asking for more produced
   strictly less.

## Decision

Two changes, both required. Adding the level alone does not fix (2).

### 1. `UNGROUNDED` joins the authority enum, at the bottom

```
HUMAN_DECISION > VERIFIED_SYSTEM_STATE > ACTIVE_REQUIREMENT
               > EVIDENCE > HISTORICAL > AI_ASSUMPTION > UNGROUNDED
```

It sits **below** `AI_ASSUMPTION`, not merely below `HISTORICAL`, because an AI
assumption *is* grounded — in a model's reasoning, which is a real if weak
provenance. `UNGROUNDED` means nothing at all supports the claim.

### 2. The grounding check becomes a ladder, not a floor

Previously a failed grounding check dropped straight to a fixed floor. Now each
level states what grounds it, and a claim that fails its level **steps down to
the highest level at or below it whose grounding is satisfied**:

| Level | Grounded by |
|---|---|
| `HUMAN_DECISION` | the actor being `HUMAN` (owned by the actor ceiling, not re-checked here) |
| `VERIFIED_SYSTEM_STATE` | ≥1 evidence reference |
| `ACTIVE_REQUIREMENT` | ≥1 related `REQUIREMENT` entity |
| `EVIDENCE` | ≥1 evidence reference |
| `HISTORICAL` | a `validUntil` — the claim states when it stopped being current |
| `AI_ASSUMPTION` | a `MODEL` source — the model's reasoning is the grounding |
| `UNGROUNDED` | nothing; it is the floor and always satisfied |

**Why this restores monotonicity.** The step-down is
`L ↦ max{ L' ≤ L : grounded(L') }`, which is monotone non-decreasing in `L` by
construction, and the two ceilings above it are `min` operations, which are also
monotone. Composing monotone functions gives a monotone policy. `UNGROUNDED`
being unconditionally satisfied is what makes the set non-empty, which is why
change 1 is a prerequisite for change 2 rather than an independent improvement.

**Why `HISTORICAL` had to be gated.** It was previously claimable with no
grounding at all, which is what let it sit *above* the fall-through target of
higher levels and break the ordering. It also means something specific —
"previously true, now superseded or aged" — so `validUntil` is both the
monotonicity fix and the honest reading of the level.

**The safety guarantee is unchanged.** A model-sourced claim is still capped at
`AI_ASSUMPTION` by the provenance ceiling, and `AI_ASSUMPTION` is grounded by
exactly that `MODEL` source, so it settles there and never steps lower. An agent
still cannot promote its own claims above `AI_ASSUMPTION`, whatever it asks for,
whichever actor kind it presents as, and however much evidence it attaches to
its own reasoning.

## Consequences

**Positive**

- Ungrounded claims are named honestly. A human's unsupported assertion is
  `UNGROUNDED`, not mislabelled as an AI assumption.
- The policy is monotone: over-claiming can no longer land a record lower than
  asking modestly would have.
- Every level now states what grounds it in one table, so "why is this record at
  this level?" is answerable without reading the algorithm.
- Retrieval gains a genuinely useful floor: context assembly can exclude
  `UNGROUNDED` without excluding model-derived reasoning.

**Negative**

- A canonical enum changed. Every switch over `Authority` must handle the new
  member — the `never`-typed defaults required by ADR-0002 turn that into
  compile errors rather than silent fallthrough, which is the point, but it is
  still churn.
- `HISTORICAL` is stricter than it was. A caller who means "this is old" must
  now say when it stopped being current.
- Records written before this change carry the old semantics. There are none in
  production — the store has never been deployed — so no migration is written.
  Had there been any, this would need an upcaster.
- Seven levels is more to hold in mind than six.

**Mitigations**

- The canonical-enum drift test compares the specification's `canonical:` blocks
  against the TypeScript arrays, so the enum cannot change in one place only.
- The policy's whole input domain is enumerated in tests — now 1008
  combinations — and monotonicity is asserted across it rather than sampled.
