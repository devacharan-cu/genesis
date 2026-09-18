# GENESIS

An experimental **self-questioning software intelligence**: an engineering
system that maintains persistent, structured knowledge about a software project
and uses it to build, test, repair, verify, deploy and maintain software.

> **Current status: Phase 1, slice 1 — the core state substrate.** What exists
> and is tested: the canonical type layer and the event ledger, with two
> interchangeable adapters. None of the cognitive machinery described below is
> built yet. The roadmap marks what is done and what is not, and nothing in this
> README describes a capability that has not been executed.

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
| **P1** | Core state substrate: types, storage ports, SQLite adapters, event ledger | 🟡 Slice 1 done (types + ledger); slices 2–4 (memory, graph, projections) remain |
| **P2** | Cognitive primitives: world/self model, goals, beliefs, contradictions | ⬜ |
| **P3** | Inquiry: question engine, scoring, context assembly | ⬜ |
| **P4** | `ReasoningProvider` port, mock and Bedrock adapters | ⬜ |
| **P5** | Experiments, sandbox, verification engine | ⬜ |
| **P6** | Agents (proposal-based) | ⬜ |
| **P7** | Software factory and self-repair loop | ⬜ |
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
| `packages/adapters-sqlite` | SQLite adapter. The only package permitted to import `node:sqlite` |
| `packages/testkit` | Conformance suites written against the ports |

### On the checkers

Each checker ships with a negative test that deliberately breaks things and
asserts the checker notices. This is not ceremony — both checkers have already
been caught passing vacuously, once from a pattern that matched nothing and once
from a baseline that was already failing. A checker that cannot fail reports
green forever and everyone believes it.

The same principle runs through the test suite: the two ledger adapters run the
*same* conformance suite, so "these are interchangeable" is demonstrated rather
than asserted; and the suite corrupts stored events to prove tampering is
actually detected, rather than trusting that the append-only code path is the
only way in.

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
