# ADR-0016 — The orchestrator owns graph mirroring; the graph is never a source of truth

- **Status:** Accepted
- **Date:** 2026-09-19
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION` (open decision E12)
- **Builds on:** [ADR-0004](0004-event-sourced-ledger.md), [ADR-0006](0006-proposal-based-mutation.md), [ADR-0013](0013-projections-as-pure-folds.md), [ADR-0014](0014-cognitive-primitives-as-deciders.md)

## Context

SPEC-01 makes uncertainties, questions and contradicting claims visible in the
knowledge graph: an uncertainty is a node, a contradiction is a `CONTRADICTS`
edge, a question is a `QUESTION` node. ADR-0014 kept the graph out of the
cognition package — a decider that reads a second store has a second input —
and deferred the question of *who writes those nodes and edges*.

There are three candidates: the agents that produce cognitive records, the
cognition package itself, or the core orchestrator. The choice decides whether
the graph can drift from the canonical state.

## Options considered

**A. Agents write cognitive nodes and edges directly.** Rejected. It violates
ADR-0006 (agents propose; the core mutates), and a graph written by several
independent writers is a second source of truth that nothing reconciles.

**B. The cognition package writes the graph as a side effect of deciding.**
Rejected. Deciders are pure (ADR-0014 rule 2); a write inside one would make
the graph change on a decision that the ledger then refuses (a lost race), and
the two would disagree.

**C. The orchestrator mirrors committed state into the graph.** Chosen.

## Decision

1. **Commit first, mirror second.** A cognitive record exists when its event is
   in the ledger. Only then does the core orchestrator (or a projector it runs)
   write the corresponding graph nodes and edges. A refused command leaves no
   trace in either.
2. **Agents never write cognitive records into the graph.** The package
   boundary already denies agents the graph store (ADR-0001, ADR-0006); this ADR
   extends the rule to every writer that is not the orchestrator's mirror.
3. **Only approved state is mirrored.** What is mirrored is what the ledger
   holds: a `DRAFT` question, an escalated contradiction, a refuted belief — each
   with the status the ledger gives it. The mirror never promotes anything.
4. **The graph is rebuildable.** Dropping the mirrored part of the graph and
   replaying the ledger must reproduce it exactly. The mirror is therefore a
   projection in the ADR-0013 sense: deterministic, idempotent, and ordered by
   ledger sequence.
5. **The graph is never an independent source of truth.** No decision reads a
   fact that exists only in the graph. Traversal results used in a decision
   (for example an impact set in context assembly) are recorded with the
   decision, so the decision is explainable even if the graph later changes.

## Where the code is today — stated plainly

This ADR sets the rule; it does not claim the code already meets it.

- **The mirror does not exist yet.** P3 adds no graph writes. Cognitive records
  are not yet visible in the graph; they carry `affectedRefs` so the mirror can
  link them when it is built.
- **The graph and memory stores are not yet ledger-backed.** `GraphStore` and
  `MemoryStore` (P1 slices 2–3) are written directly through their ports, not
  derived from ledger events. Rule 4 therefore holds today only for the
  cognition and self-model projections, not for the graph as a whole.
- **Context assembly reads the graph.** Per rule 5, every context manifest
  records the node ids, depths and memory record versions it used, so a context
  is explainable without trusting the graph to be unchanged.

**Migration plan.** When the core orchestrator is built (P4), it gets a graph
mirror projector for cognitive records, fed from the cognition events, with a
drop-and-replay test proving rule 4. Moving the P1 graph and memory writes
behind ledger events — so the whole graph, not just its cognitive part, is
rebuildable — is a separate change that needs its own ADR, because it alters
two ports and both adapters.

## Consequences

**Positive**

- One writer per fact: the ledger for cognitive state, the mirror for its graph
  shadow. The graph cannot disagree with the ledger except by a bug the
  drop-and-replay test catches.
- Refused commands never leave half-written graph structure behind.

**Negative**

- Graph visibility of cognitive records lags the ledger by one mirror step, and
  until P4 there is none at all.
- Until the migration ADR lands, "the graph is rebuildable from the ledger" is
  true only of the part the mirror will write, and this ADR says so rather than
  implying otherwise.

**Mitigations**

- Nothing in P3 reads cognitive facts from the graph; the cognition projection
  is the source for them.
- Context manifests record what was read from the graph and memory, so the lag
  and the non-ledger stores cannot silently change an explanation after the
  fact.
