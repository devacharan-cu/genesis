# ADR-0011 — Write-time authority policy: clamp, and record the clamp

- **Status:** Accepted
- **Date:** 2026-09-18
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION`
- **Refines:** [ADR-0005](0005-authority-over-confidence.md), [ADR-0006](0006-proposal-based-mutation.md)

## Context

[ADR-0005](0005-authority-over-confidence.md) establishes that authority, not
confidence, resolves conflicts, and that model-produced claims are clamped to
`AI_ASSUMPTION` and "cannot promote themselves". SPEC-02 §4.1 describes how a
record's authority may be *promoted* over its life.

Neither says what happens at the moment a record is **written**, which is where
the guarantee actually has to hold. Without a stated write-time rule, an agent
could simply call `put` with `authority: 'HUMAN_DECISION'` and the store would
take it. Every downstream safety property — context assembly ranking,
contradiction resolution, proposal policy checks — would then be reasoning over
a value the agent chose for itself.

The event ledger (P1 slice 1) already faced the narrow version of this question
and answered it by **rejecting** an over-reaching authority. Memory records need
their own answer, and it is not obviously the same one.

## Options considered

1. **Reject over-reaching writes**, as the ledger does. Loud and unambiguous.
   But it discards the record's *content* over a metadata error, and an agent
   that over-claims would lose work it may have done correctly.
2. **Clamp silently.** Simple, and the record ends up at an honest level. But a
   miscalibrated agent becomes invisible: nothing distinguishes "asked for
   `AI_ASSUMPTION`" from "asked for `HUMAN_DECISION` and was cut down to it".
3. **Clamp, and persist what was clamped and why.**

## Decision

Option 3. Three ceilings, applied in order, each able only to lower the
authority (SPEC-02 §4.2):

| # | Ceiling | Effect | Recorded reason |
|---|---|---|---|
| 1 | Actor | `HUMAN` → `HUMAN_DECISION`, `SYSTEM` → `VERIFIED_SYSTEM_STATE`, `AGENT` → `EVIDENCE` | `ACTOR_CEILING` |
| 2 | Model provenance | any `sourceRef` of kind `MODEL` → `AI_ASSUMPTION` | `MODEL_SOURCED` |
| 3 | Grounding | `EVIDENCE` / `VERIFIED_SYSTEM_STATE` need ≥1 evidence ref; `ACTIVE_REQUIREMENT` needs ≥1 related `REQUIREMENT` | `NO_EVIDENCE`, `NO_REQUIREMENT_LINK` |

The record persists `authorityRequested` and `authorityClamps` next to the
effective `authority`.

Ceiling 2 is the one that makes the guarantee absolute rather than approximate.
An agent's own claim carries a `MODEL` source, so it lands at `AI_ASSUMPTION`
regardless of the actor ceiling, regardless of what it asked for, and regardless
of how much evidence it attaches to its own reasoning. Promotion requires a
*later* event supplying independent higher-authority support — never the same
write.

**Why clamp here when the ledger rejects.** An event is an immutable statement
of what happened; writing one at a different authority than the caller stated
would make the ledger disagree with its own caller, so refusal is the honest
option. A memory record is an *interpretation*, and the honest response to an
over-claimed interpretation is to record it at the level it can support rather
than throw the content away. The two stores differ because what they hold
differs, not because the rule is applied inconsistently.

## Consequences

**Positive**

- "An agent cannot promote its own claims" becomes a property of one small,
  exhaustively tested function rather than a convention spread across callers.
- Clamps are queryable. `authority != authorityRequested` answers "which
  components over-claim, and how often?" — the calibration signal ADR-0006 §4.1
  asks for, available without extra instrumentation.
- The policy is a pure function of `(requested, actorKind, sourceKinds,
  evidenceRefs, relatedEntities)`, so its whole input domain can be enumerated
  in tests rather than sampled.

**Negative**

- Clamping is quieter than rejection. A caller that ignores the returned record
  will not notice its claim was reduced.
- Two extra fields on every record, forever.
- `AI_ASSUMPTION` is now also the floor for an *ungrounded* claim by a human or
  the system, where the name plainly does not fit what happened. The authority
  levels come from the project brief, so this ADR does not invent a level to fix
  it.
- **The policy is not monotone**, and the missing level is why. A `SYSTEM` actor
  with no evidence asking for `HUMAN_DECISION` is capped to
  `VERIFIED_SYSTEM_STATE`, fails that level's grounding check, and lands on the
  `AI_ASSUMPTION` floor — whereas the same actor asking for the *lower*
  `HISTORICAL`, which needs no grounding, keeps it. Over-claiming therefore
  lands below asking modestly. Found by the exhaustive property test, which
  asserted monotonicity on the assumption it was obviously true.

  Two cheaper fixes were considered and rejected. Stepping down to the highest
  grounded level instead of the floor would land such records on `HISTORICAL`,
  which asserts "previously true, now superseded" — a specific claim that would
  be false. Checking grounding against the *requested* level rather than the
  effective one is worse still: a system probe asking for `HUMAN_DECISION` would
  then land on `VERIFIED_SYSTEM_STATE` with no evidence at all, which is exactly
  what the grounding rule exists to prevent.

  The safety guarantee is unaffected — every clamp moves authority down, never
  up — so the behaviour stands as documented and is pinned by a test rather than
  left to be rediscovered.
- The grounding checks are structural, not semantic: they verify that an
  evidence reference *exists*, not that it supports the statement. A record can
  reach `EVIDENCE` by citing an irrelevant observation.

**Mitigations**

- Open decision **E11** covers both problems at once, because they have one
  cause: there is no level meaning "ungrounded". Adding an `UNGROUNDED` level
  below `HISTORICAL` would give ungrounded claims an honest name *and* restore
  monotonicity, since the grounding step would then have somewhere truthful to
  fall to. It changes an enum the brief specified, so it needs a human decision
  rather than being taken here.
- Whether the cited evidence actually supports the claim is the Verifier agent's
  job (SPEC-04 §2, P7), and it is explicitly out of scope for a storage policy.
  This ADR claims only that the reference exists.
- The store returns the written record, so a caller that checks gets the truth
  immediately; and because the clamp is persisted, one that does not check can
  still discover it later.
