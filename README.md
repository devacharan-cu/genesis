# GENESIS

An experimental **self-questioning software intelligence**: an engineering
system that maintains persistent, structured knowledge about a software project
and uses it to build, test, repair, verify, deploy and maintain software.

> **Current status: Phases 1–4 complete — the state substrate, the cognitive
> primitives, inquiry, and the reasoning provider with the core orchestrator.** What exists and is tested: the canonical type layer,
> the hash-chained event ledger, the memory store with its write-time authority
> policy, the knowledge graph with invariants G1–G13, projections that rebuild
> the world and self models from the ledger, the **goal system, belief system,
> uncertainty engine and contradiction engine** as deciders over the ledger, the
> **question engine** — questions as ledger records, scored by a deterministic,
> replaceable scorer, answered by a person through `ANSWER`, `REJECT_ASSUMPTION`
> or `ACCEPT_RISK` with the effects applied in the same append — and **context
> assembly**: budgeted, explainable, deterministic selection of what a task is
> shown, with mandatory items that cannot be crowded out. P4 adds the
> **`ReasoningProvider` port** with a deterministic mock and a **Bedrock
> adapter** (Converse API), and the **core orchestrator**: one task runs from
> recorded context to a recorded model call to proposals that enter state only
> as an agent's — four permitted kinds, clamped to `AI_ASSUMPTION` and checked by
> the cognitive deciders — with `SPLIT_REQUIRED` stopping a run before any call,
> every provider failure typed and recorded, and the graph **mirrored from the
> committed cognitive state** and proven rebuildable from the ledger. Every port
> has an in-memory and a SQLite adapter running one shared conformance suite. P7 turns the runtime into a **software factory**: intent in,
verified artifact out, through plan, architecture, build, test, security review
and verification, with a bounded repair loop that re-enters at test rather than
at verify. A role varies its model call by naming a purpose from a closed set;
the core owns every prompt and schema, so no wording lives in a domain package.
The factory runs the sandbox and QA reports what it observed, because an agent
cannot reach one. "Verified" means the P5 engine said so from evidence, and the
record that says it is a projection anyone can rebuild from the ledger.
>
> What is **not** built: the full cognitive loop (planning, acting, verifying),
> task splitting, the web question interface and its authentication,
> experiments, verification and agents. The Bedrock adapter is unit-tested
> against a fake client; its live integration suite exists but has **not** been
> run against AWS. No person can yet answer a question except through an
> in-process caller. The roadmap marks what is done and what is not,
> and nothing in this README describes a capability that has not been executed.

---

## What makes it different

The common pattern for AI engineering tools is `LLM + large prompt + vector
database`. GENESIS deliberately is not that, because that pattern has no way to
represent authority, no way to say *"I don't know"*, no way to hold a
contradiction open, and no auditable history.

Instead, a **Cognitive Core** owns the canonical project state, and the language
model is a replaceable reasoning component the core calls when it needs one.

The core maintains:

- **Persistent memory** across seven logical classes, every record carrying its
  source and its authority
- **A knowledge graph** of requirements, components, files, tests, evidence,
  beliefs and the relationships between them
- **An immutable event ledger** — every state change is an event, so history,
  audit and explanation are properties of the storage model
- **A world model and a self model** — including what the system currently
  *cannot* do
- **Explicit uncertainty**: unknowns are records, not the absence of records
- **A question engine** that asks when an answer would actually change what
  happens next
- **An experiment engine** that resolves empirical questions by running real
  experiments
- **A verification engine** where generation is not verification and no state
  advances without evidence from a real execution

## What it does not claim

GENESIS is **not** conscious, sentient, self-aware, an AGI, or superintelligent.
Terms like "self-model", "belief", "question" and "experiment" are technical
names for the data structures and processes defined in
[the master specification](docs/architecture/00-MASTER-SPEC.md). They make no
claim about inner experience.

Three rules are enforced, not merely stated:

1. **No fake functionality.** A module that cannot do what its name implies does
   not exist, or throws, or is marked a stub in both code and docs.
2. **No fabricated evidence.** Test results and experiment observations come
   from real execution. An evidence record cannot be written without stored raw
   output whose hash matches.
3. **Generation is not verification.** An artifact a model produced is at
   `GENERATED` and nothing more until real tests say otherwise.

---

## Documentation

Start with the master spec; everything else is subordinate to it.

| Document | Scope |
|---|---|
| [`00-MASTER-SPEC.md`](docs/architecture/00-MASTER-SPEC.md) | Terminology, canonical enumerations, scope, phasing |
| [`01-COGNITIVE-ARCHITECTURE.md`](docs/architecture/01-COGNITIVE-ARCHITECTURE.md) | The loop, world/self model, goals, beliefs, uncertainty, questions, experiments, contradiction, context assembly |
| [`02-MEMORY-ARCHITECTURE.md`](docs/architecture/02-MEMORY-ARCHITECTURE.md) | Memory classes, record schema, authority hierarchy, lifecycle |
| [`03-GRAPH-ARCHITECTURE.md`](docs/architecture/03-GRAPH-ARCHITECTURE.md) | Node and edge semantics, invariants, query surface |
| [`04-AGENT-ARCHITECTURE.md`](docs/architecture/04-AGENT-ARCHITECTURE.md) | Agent roster, typed messages, proposal protocol |
| [`05-VERIFICATION-ARCHITECTURE.md`](docs/architecture/05-VERIFICATION-ARCHITECTURE.md) | Verification states, change lifecycle, evidence rules |
| [`06-SECURITY-ARCHITECTURE.md`](docs/architecture/06-SECURITY-ARCHITECTURE.md) | Threat model, least privilege, sandboxing, secrets |
| [`07-AWS-ARCHITECTURE.md`](docs/architecture/07-AWS-ARCHITECTURE.md) | AWS service responsibilities and port mapping |
| [`docs/adr/`](docs/adr/README.md) | Architecture decision records |
| [`PRE-BUILD-ARCHITECTURE-AUDIT.md`](docs/audit/PRE-BUILD-ARCHITECTURE-AUDIT.md) | Phase-0 audit: contradictions, risks, open decisions |

---

## The cognitive loop

```
OBSERVE → UPDATE WORLD MODEL → UPDATE SELF MODEL → RETRIEVE MEMORY
   → CHECK GOALS → DETECT UNCERTAINTY → GENERATE QUESTIONS
   → ASK / SEARCH / EXPERIMENT → UPDATE BELIEFS → PLAN → ACT
   → VERIFY → STORE EXPERIENCE → OBSERVE AGAIN
```

A cycle may legitimately end **blocked**, having recorded what it could not
determine and why that matters. That is the system working correctly, not
failing.

---

## Roadmap

| Phase | Contents | Status |
|---|---|---|
| **P0** | Architecture, ADRs, audit | ✅ Complete |
| **P1** | Core state substrate: types, storage ports, SQLite adapters, event ledger | 🟢 Slices 1-4 done: types + hash-chained ledger, MemoryStore + authority policy, GraphStore + invariants G1-G13, projections with replay/live equivalence |
| **P2** | Cognitive primitives: world/self model, goals, beliefs, contradictions | 🟢 Done: goal system, belief ladder, uncertainty engine, contradiction engine as deciders over the ledger; conditional append; self model v2 |
| **P3** | Inquiry: question engine, scoring, context assembly | 🟢 Done: questions as ledger records with ANSWER / REJECT_ASSUMPTION / ACCEPT_RISK responses; deterministic, replaceable question scorer; context assembly with mandatory inclusions, split-on-overflow and recorded manifests. The web interface is specified (ADR-0015), not built |
| **P4** | `ReasoningProvider` port, mock and Bedrock adapters | 🟢 Done: the port with typed failures, the deterministic mock, the Bedrock Converse adapter (unit-tested; live suite not yet run), and the core orchestrator — recorded context, recorded calls, proposals through the deciders, `SPLIT_REQUIRED` handling, and the graph mirror (ADR-0018) |
| **P5** | Experiments, sandbox, verification engine | 🟢 Done: Experiment engine, secure sandbox port, local sandbox adapter with timeout and abort handling, deterministic verification engine state machine, event recording for evidence (ADR-0019) |
| **P6** | Agents (proposal-based) | 🟢 Done: the typed agent protocol (nine message kinds, strict bodies, an agent manifest that can only narrow), the task state machine, the agent registry, four roles (Planner, Architect, Researcher, and a deterministic Verifier), and the agent runtime — assignment, bounded dispatch, typed failure with self-model signatures, bounded retry, verification handoff and a replayable task projection. Agents hold no store and no provider, which `check-boundaries.mjs` enforces (ADR-0020). Parallel agents are deliberately not taken |
| **P7** | Software factory and self-repair loop | 🟢 Done: reasoning purposes so a role varies what it asks for without any wording leaving the core, the artifact door recording produced files at `GENERATED`, the Builder, QA, Security and Repair roles, impact leases with staleness detection, the eight-stage factory pipeline with a bounded repair loop, and the verified-artifact projection whose state comes from the P5 engine and nowhere else (ADR-0021, ADR-0022, ADR-0023). Security review is a pattern-based reviewer over artifact text and says so |
| **P8** | AWS deployment | ⬜ |

Full phase definitions and exit criteria:
[master spec §8](docs/architecture/00-MASTER-SPEC.md#8-phasing).

---

## Development

TypeScript (`strict`, no `any`), pnpm workspace monorepo, Node 22.5+.

```bash
corepack pnpm install
bash tools/verify-all.sh     # every check; nothing is committed unless green
```

Individual steps:

```bash
pnpm test                    # vitest
pnpm coverage                # + the coverage policy from SPEC-00 §8.1
pnpm typecheck               # tsc --noEmit, strict
pnpm lint                    # eslint
pnpm check:docs              # documentation consistency
pnpm check:boundaries        # package dependency rules (ADR-0001)
```

### Packages

| Package | Contents |
|---|---|
| `packages/core-types` | Canonical enums, branded ids, monotonic ULID, project scoping, authority ordering, event schemas. Depends on no other workspace package. |
| `packages/ledger` | `EventLedger` port, append path, hash chain, verifier, schema upcasting, in-memory adapter |
| `packages/memory` | `MemoryStore` port, write-time authority policy and grounding ladder, contradiction preservation, in-memory adapter |
| `packages/graph` | `GraphStore` port, node/edge schemas, invariants G1–G13, depth-capped traversal and impact analysis, in-memory adapter |
| `packages/projections` | Projections as pure folds over the ledger, replay/live equivalence by digest, `ProjectionSnapshotStore` port, world and self model projectors |
| `packages/cognition` | Goal system, belief system, uncertainty engine, contradiction engine and question engine: pure deciders, one fold, a replaceable question scorer, and an engine that appends conditionally on the head it decided against |
| `packages/reasoning` | The `ReasoningProvider` port, typed provider failures, provider-neutral prompt rendering with fenced untrusted content, and the deterministic `MockReasoningProvider`. Imports no model SDK |
| `packages/core` | The orchestrator (context → recorded call → proposals through the cognitive deciders → graph mirror), the four permitted proposal kinds, the graph mirror derived from canonical state, and the run projection. Depends on the reasoning port, never on a provider |
| `packages/adapters-aws` | `BedrockReasoningProvider` on the Bedrock Runtime Converse API. The only package permitted to import the AWS SDK |
| `packages/context` | Context assembly: candidate builders, six weighted signals with replaceable relevance and token estimators, budgeted selection with mandatory inclusions, and the `CONTEXT_ASSEMBLED` manifest. Reads stores only through read-only views |
| `packages/adapters-sqlite` | SQLite adapters for all four ports. The only package permitted to import `node:sqlite` |
| `packages/testkit` | Conformance suites written against the ports |

### On the checkers

Each checker ships with a negative test that deliberately breaks things and
asserts the checker notices. This is not ceremony — both checkers have already
been caught passing vacuously, once from a pattern that matched nothing and once
from a baseline that was already failing. A checker that cannot fail reports
green forever and everyone believes it.

The same principle runs through the test suite: every port's two adapters run
the *same* conformance suite, so "these are interchangeable" is demonstrated
rather than asserted; the suite corrupts stored events to prove tampering is
actually detected, rather than trusting that the append-only code path is the
only way in; and the projection suite splits each history at every point and
requires snapshot-plus-tail to equal a full replay, so "rebuildable from the
ledger" is a test that runs rather than a sentence in a specification. The
cognitive primitives add seeded random command streams, from every mix of
actors, with every invariant checked after every accepted command — no goal
satisfied that is not done, no belief verified by an agent, no contradiction
decided without trustworthy authority — ending in a replay-equals-live check.

The coverage thresholds get the same treatment. A per-file threshold whose path
matches nothing passes silently and guarantees nothing, so each one is checked
by deleting a test and confirming the gate goes red for that file.

These check **consistency and behaviour, not correctness of the design**. None
of them can tell you the architecture is a good one.

## Development rules

1. Do not generate the full project in one step.
2. Do not create fake functionality or fake AI output.
3. Do not claim a feature is complete unless it is tested.
4. Keep the architecture modular; TypeScript strict; tests alongside code.
5. Run build and tests frequently; fix errors before moving on.
6. Record major architecture decisions in `docs/adr/`.
7. Do not change the architecture silently — document the reason first.

## License

Not yet chosen. See the audit's open-decisions section.
