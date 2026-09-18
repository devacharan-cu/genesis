# GENESIS

An experimental **self-questioning software intelligence**: an engineering
system that maintains persistent, structured knowledge about a software project
and uses it to build, test, repair, verify, deploy and maintain software.

> **Current status: Phase 0 — pre-build architecture. No application code exists
> yet.** This repository currently contains the specification, the architecture
> decision records, and the Phase-0 audit. Nothing here is running software, and
> nothing in this README describes a capability that has been built.

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
| **P1** | Core state substrate: types, storage ports, SQLite adapters, event ledger | ⬜ Next |
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

Planned stack: TypeScript (`strict`), pnpm workspace monorepo, Node 22+.
No package manifests exist yet — they arrive with P1.

Checks that run today:

```bash
node tools/docs-check.mjs                     # the check
bash tools/docs-check.negative-test.sh        # proves the check can fail
```

`docs-check.mjs` validates that every required document exists, that required
sections are present, that the canonical enumerations are identical everywhere
they appear, that internal links and heading anchors resolve, that every ADR is
indexed, and that the required honesty statements are present.

`docs-check.negative-test.sh` deliberately breaks the documentation seven
different ways in a throwaway copy and asserts the checker catches each one —
because a checker that cannot fail reports green forever and everyone believes
it.

Both check **consistency, not correctness**. Neither can tell you the
architecture is a good one.

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
