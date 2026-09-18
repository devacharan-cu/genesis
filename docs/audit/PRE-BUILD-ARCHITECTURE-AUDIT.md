# GENESIS — Pre-Build Architecture Audit

**Phase:** P0 · **Date:** 2026-09-18 · **Auditor:** lead engineering agent
**Status:** Complete — awaiting human review before P1 begins

This audit closes Phase 0. It reports what was created, what was decided, what
contradicted what, what is risky, and what still needs a human decision.

**Scope statement:** this is an audit of *documents*, not of software. No
application code exists. Nothing in this repository has been executed except the
documentation consistency checker. The audit cannot and does not assert that the
architecture is correct — only that it is internally consistent and that its
gaps are named.

---

## A. Files created

22 files.

### Architecture (8)

| File | Lines | Purpose |
|---|---|---|
| `docs/architecture/00-MASTER-SPEC.md` | ~433 | Authoritative terminology, canonical enums, canonical state, event ledger, phasing, glossary |
| `docs/architecture/01-COGNITIVE-ARCHITECTURE.md` | ~431 | Cycle, world/self model, goals, beliefs, uncertainty, contradiction, questions, experiments, context assembly |
| `docs/architecture/02-MEMORY-ARCHITECTURE.md` | ~290 | Seven memory classes, record schema, authority hierarchy, contradiction preservation, lifecycle, store port |
| `docs/architecture/03-GRAPH-ARCHITECTURE.md` | ~249 | Node/edge semantics, legal endpoints, invariants G1–G10, query port, storage mapping |
| `docs/architecture/04-AGENT-ARCHITECTURE.md` | ~236 | Agent roster and phasing, typed message protocol, proposal protocol, authority clamping |
| `docs/architecture/05-VERIFICATION-ARCHITECTURE.md` | ~226 | Verification states with anti-gaming rules, change lifecycle, evidence rules, test taxonomy |
| `docs/architecture/06-SECURITY-ARCHITECTURE.md` | ~204 | Threat model, permissions, sandboxing, secrets, prompt injection, authorization gates |
| `docs/architecture/07-AWS-ARCHITECTURE.md` | ~267 | Per-service responsibility, port→adapter map, services rejected with reasons |

### Decision records (8)

`docs/adr/README.md` (index) plus:

| ADR | Decision |
|---|---|
| 0001 | pnpm workspace monorepo — package boundaries enforce "agents cannot write state" |
| 0002 | TypeScript strict, no `any`, branded ids, runtime validation at every boundary |
| 0003 | Ports and adapters; SQLite first, DynamoDB/Neptune later; shared conformance suites |
| 0004 | Event-sourced ledger; projections rebuildable by replay |
| 0005 | Authority hierarchy governs conflicts; confidence is metadata only |
| 0006 | Agents propose, only the core mutates state |
| 0007 | `ReasoningProvider` port; mock adapter satisfies the full core test suite; Bedrock first real adapter |

### Supporting (6)

| File | Purpose |
|---|---|
| `README.md` | Honest project overview; states plainly that no application code exists |
| `.gitignore` | Node/TS artifacts, SQLite state, secrets, IaC output, sandbox scratch |
| `tools/docs-check.mjs` | Documentation consistency checker (executed — see §C.1) |
| `tools/docs-check.negative-test.sh` | Negative test proving the checker actually fails on breakage (executed — see §C.1) |
| `tools/verify-all.sh` | Single entry point for every check that exists; nothing is committed unless it is green |
| `docs/audit/PRE-BUILD-ARCHITECTURE-AUDIT.md` | This document |

---

## B. Architecture decisions

### B.1 Decided in this phase

1. **The Cognitive Core owns state; the LLM is a called component.** The core's
   full test suite must pass against a mock reasoning provider. If it cannot,
   the LLM is on the critical path and the principle is not real. (ADR-0007)

2. **Authority, not confidence, resolves conflicts.** Model-produced claims are
   clamped to `AI_ASSUMPTION` at the writer and cannot promote themselves. This
   is the single most important safety property in the knowledge layer.
   (ADR-0005)

3. **Agents cannot write state — structurally.** Enforced three ways: package
   dependency rules make the import impossible, the type system offers no store
   handle, and a per-agent conformance test asserts the write is refused.
   (ADR-0001, ADR-0006)

4. **The event ledger is the write-ahead system of record.** Everything else is
   an immutable record set or a rebuildable projection. This also supplies the
   answer to cross-store consistency in AWS, where DynamoDB and Neptune cannot
   share a transaction. (ADR-0004)

5. **Ports and adapters, SQLite first.** The DynamoDB key schema will be
   designed against the real query list produced by P1–P5 rather than guessed
   now. Every adapter passes one shared conformance suite. (ADR-0003)

6. **Generation is not verification, enforced mechanically.** Evidence records
   cannot be written without stored raw output whose hash matches; the evidence
   writer is unreachable from any model code path; coverage attribution,
   assertion presence and mock-boundary rules close the obvious loopholes.
   (SPEC-05 §2.1, §4)

7. **Unknowns are first-class records.** "I cannot determine this from current
   information" is a representable state — an open uncertainty with
   `ASK_HUMAN` resolution, linked to a belief at `UNKNOWN`, blocking the goal —
   and a cycle may legitimately end `BLOCKED_ON_HUMAN`. (SPEC-01 §4.2, §7)

8. **Question value is an explicitly replaceable heuristic.** The formula is
   isolated behind a `QuestionScorer` interface, every score is recorded with
   its breakdown, and every asked question records whether the answer actually
   changed anything — so the heuristic can be evaluated against reality rather
   than defended. (SPEC-01 §9.2)

9. **Every AWS service must justify itself.** Six services were considered and
   rejected with reasons recorded (SPEC-07 §6), and Bedrock AgentCore is marked
   *conditional, not committed* pending evaluation against the proposal-only
   mutation constraint.

### B.2 Deliberate deviations from the original brief

These deviate from the literal text you supplied and need your explicit
agreement:

| # | Brief said | Architecture says | Why |
|---|---|---|---|
| D1 | Loop phase "ASK / SEARCH / EXPERIMENT" | Phase named `GATHER_INFORMATION`, with the three strategies as `UncertaintyResolution` values | One phase with three strategies models better than a phase named after a disjunction; the three strategies are preserved exactly |
| D2 | Bedrock AgentCore listed among AWS services | Marked **conditional**, adoption deferred to a P8 evaluation | Your own rule: no service for appearance. AgentCore must be shown compatible with proposal-only mutation before it is committed |
| D3 | "Eventually support specialized agents" (9 listed) | Roster split across P6/P7/P8, none before the core is green | Prevents the agent layer being built on unfinished state semantics |
| D4 | Verification states as a flat list | Added anti-gaming entry requirements per state (coverage attribution, assertion presence, mock boundary, same-author independence) | Without these, "UNIT_TESTED" can be reached by a passing suite that never touches the artifact |

---

## C. Contradictions found

The brief asked for a contradiction check across all documents. Two kinds were
run: a mechanical consistency check, and a manual cross-reading.

### C.1 Mechanical check

`tools/docs-check.mjs` was written and **executed**. It verifies: required
documents exist; required sections are present; every `canonical:` enumeration
block is byte-identical everywhere it appears and is declared in the master
spec; internal links resolve including heading anchors; every ADR is indexed;
required honesty statements are present.

Result: **PASS** — 18 documents scanned, 89 internal links resolved, 9 canonical
enumerations consistent across 15 occurrences, 7 ADRs indexed.

A checker that cannot fail is worse than no checker, so
`tools/docs-check.negative-test.sh` was also written and executed. It breaks the
documentation seven ways in a throwaway copy — enum drift, broken link, broken
anchor, missing document, missing section, unindexed ADR, removed honesty
statement — and asserts the checker catches each. Result: **7 detected, 0
missed**.

That negative test earned its place immediately. On its first run one case
reported green, which looked like a checker bug; it was in fact a `sed` pattern
that matched nothing, so no breakage was ever introduced. The test now verifies
that each mutation actually changed a file before trusting the result — a green
run on an unmodified file is reported as `INVALID`, not as a pass. This is the
same class of error the project's rule 2 forbids, caught in its own tooling.

Both tools' limits are stated in their headers: they check consistency, not
correctness. Neither can tell you the architecture is good.

### C.2 Contradictions found by manual cross-reading — and resolved

Four genuine contradictions were found in the first drafts. All four were fixed
before this audit was written; they are recorded here rather than quietly
corrected, per development rule 11.

| # | Contradiction | Resolution |
|---|---|---|
| **X1** | SPEC-00 §4.4 stated verification states are "monotonic per artifact version"; SPEC-05 §2.2 required **downgrade** when later evidence contradicts a state. Flatly incompatible. | SPEC-00 amended: monotonic *while the supporting evidence stands*; downgrade on contradicting evidence, recorded as an event. Reality outranks bookkeeping. |
| **X2** | `ARCHIVED` appeared both as a `MemoryClass` value and as a record `status` value, with no statement of which one changes on archive. A record could be `class: DECISION, status: ARCHIVED` or `class: ARCHIVED` — both were readable from the text. | SPEC-02 §2.3 added: `status` is the field that changes; `class` never changes so provenance survives; `MemoryClass.ARCHIVED` is a queryable logical view that the store translates to a status filter. Nothing is ever written with `class: ARCHIVED`. |
| **X3** | SPEC-04 placed the **Verifier** at P7, but SPEC-05 made the Verifier responsible for the `VERIFY` stage of the change lifecycle, which P6 proposals must traverse. The lifecycle would have been unrunnable in P6. | Split into two components: the core's deterministic **verification engine** (P5) applies the state machine; the **Verifier agent** (P7) reviews evidence *adequacy* and raises findings. Both SPEC-04 and SPEC-05 amended. |
| **X4** | SPEC-03 listed `UNCERTAINTY-bearing node` as a legal `BLOCKS` endpoint, but `NodeType` — fixed by your brief — has no `UNCERTAINTY` member. An unrepresentable edge. | Endpoint corrected to `ISSUE`/`QUESTION`. The underlying modelling gap is *not* silently closed; it is raised as open decision **E2** below, because fixing it properly means changing an enum you specified. |

### C.3 Tensions identified but deliberately left standing

These are not defects; they are places where two correct goals pull apart, and
the resolution needs to be seen rather than hidden.

| # | Tension | Position taken |
|---|---|---|
| T1 | The system is named "self-questioning", yet SPEC-01 §7.2 prefers `SEARCH` and `EXPERIMENT` over `ASK_HUMAN`. | Deliberate. Human attention is the scarcest resource. `ASK_HUMAN` is chosen when the other two *cannot* settle the question, not when they are merely inconvenient. |
| T2 | The word "evidence" names a memory class, a graph node type, and an authority level. | Kept — all three come from your brief and each is correct in its own context. Mitigated by always qualifying in prose (`EVIDENCE`-class record, `EVIDENCE` node, `EVIDENCE` authority) and by distinct branded types in code. |
| T3 | Equal-authority conflicts produce questions rather than a tiebreak, so the system will generate real human workload. | Accepted as correct behaviour. The question engine's scoring exists to keep that volume useful rather than to suppress it. |
| T4 | Proposal-based mutation adds latency and ceremony to every state change. | Accepted. Batched ops reduce round-trips; agents' internal work needs no proposal, only state changes do. |

---

## D. Risks

Ordered by how much damage each would do if ignored.

| # | Risk | Severity | Mitigation / where it is tracked |
|---|---|---|---|
| **R1** | **Scope.** The architecture describes a very large system. The realistic failure mode is not a wrong design; it is P1–P5 never finishing because P7 looks more interesting. | **High** | Phase exit criteria are executable, not judgemental (SPEC-00 §8). Hard rule: nothing in P7 before P1–P5 are green. This risk is the one most likely to actually bite. |
| **R2** | **Async experiments vs a synchronous loop.** The cycle has `GATHER_INFORMATION` → `UPDATE_BELIEFS` in sequence, but a real experiment may take minutes or hours. The current model schedules the experiment and moves on, so belief update happens in a *later* cycle. This is stated nowhere explicitly and the loop diagram implies otherwise. | **High** | Raised as open decision **E1**. Must be settled before P5. |
| **R3** | **The question-value heuristic is unvalidated.** Four multiplied factors with no empirical basis. If it is bad, the system asks useless questions and humans stop answering — which disables the system's core differentiator. | **High** | Isolated behind `QuestionScorer`; every question records a score breakdown and an outcome. Evaluate against real outcome data in P3 before trusting it. |
| **R4** | **Evidence integrity depends on one enforcement point.** The whole anti-fabrication property rests on the evidence writer being unreachable from model code paths. One convenience import defeats it. | **High** | Package boundary rule + `tools/check-boundaries.mjs` in CI (ADR-0001) + a dedicated conformance test. Must be among the first tests written in P1. |
| **R5** | **Ledger growth and replay cost.** Append-only storage grows without bound; naive full replay eventually becomes impractical. | Medium | Snapshots with ledger offsets (ADR-0004), explicitly a cache and never a source of truth; full replay from zero stays possible and is tested periodically. |
| **R6** | **SQLite/Neptune traversal divergence.** Recursive CTEs and Gremlin can differ on cycles, ordering and depth limits, so a cloud adapter could pass unit tests and behave differently in production. | Medium | Traversal-parity test over a shared fixture graph is an acceptance gate for the cloud adapter (ADR-0003). |
| **R7** | **Mock-driven tests prove our logic, not the model's.** A green suite against `MockReasoningProvider` says nothing about whether prompts work. | Medium | Explicitly stated in ADR-0007. A separate, tagged Bedrock integration suite is required before P8 acceptance and never gates the core suite. |
| **R8** | **Sandbox cost and complexity.** Fresh isolated container per execution may make the test loop slow enough that the team is tempted to bypass it. | Medium | Runtime choice deferred to P5 *with a measured startup-cost budget* rather than pre-decided (SPEC-06 §10). There is no unsandboxed exec path. |
| **R9** | **Cross-store consistency window.** Ledger-first writes with eventually-consistent projections means reads can be stale; a decision made on a stale projection could be wrong. | Medium | Each read API declares its consistency; strongly-consistent reads go to the ledger or immutable record sets (ADR-0004). |
| **R10** | **`impactSet` precision.** Impact analysis gates both contradiction blocking and test selection. Too broad and everything is blocked; too narrow and unsafe changes pass. | Medium | Depth caps and authority-weighted ranking (SPEC-03 §5.1); needs measurement on a real graph in P2, not tuning by intuition. |
| **R11** | **Prompt injection via project content.** Untrusted content reaching a reasoning call could steer an agent. | Medium | The real mitigation is structural: model output cannot reach state or the host without traversing `POLICY_CHECK`. Injection can influence a suggestion; it cannot execute one (SPEC-06 §6). |
| **R12** | **Cost.** Neptune plus per-execution isolated compute plus Bedrock inference is a non-trivial monthly floor for an experimental system. | Low–Medium | Neptune is a rebuildable projection, so a small deployment may run without it as a supported configuration (SPEC-07 §7). Cost-incurring resource creation above threshold is an authorization gate. |

---

## E. Missing decisions

These need a human decision. Several block specific phases; none block P1 except
where noted.

| # | Decision needed | Blocks | Recommendation |
|---|---|---|---|
| **E1** | **How do long-running experiments rejoin the loop?** Options: (a) cycles suspend and resume on experiment completion; (b) experiments always resolve in a later cycle and the loop never blocks on them; (c) both, chosen per experiment duration. | P5 (design must be settled before the experiment engine) | (b) as the default, with (a) available for short probes. It keeps the loop non-blocking and matches Step Functions' wait pattern in P8. |
| **E2** | **Should `NodeType` gain `UNCERTAINTY`?** Uncertainties are in the canonical state but have no graph node, so they cannot be `BLOCKS` endpoints or traversal targets (contradiction X4). Adding it changes an enum you specified. | P2 | Add it. The alternative is uncertainties being invisible to impact analysis, which weakens the engine that exists to find gaps. **Your call — I have not changed your enum.** |
| **E3** | **Licence.** Not chosen. Affects whether this can be published or accept contributions. | Any public release | — |
| **E4** | **Reference project for P7.** The self-healing loop needs a concrete target project to build. The booking/concurrency example in SPEC-01 §10 implies something like a scheduling service. | P7 | Pick something with real concurrency and real data constraints; the attendance/booking domain your brief's examples suggest would work. |
| **E5** | **Embedding model and vector store** for the lexical half of retrieval. | P3 | Defer until context assembly has real corpora to measure against. |
| **E6** | **Sandbox runtime** (container technology locally; ECS/Fargate vs CodeBuild vs Firecracker-backed in AWS). | P5 / P8 | Decide with measured cold-start numbers, not preference. |
| **E7** | **Bedrock AgentCore adoption.** | P8 | Evaluate against proposal-only mutation. Do not adopt on availability alone. |
| **E8** | **Human interface for questions and authorization gates.** The console is mentioned (Amplify) but never specified. If answering questions is awkward, the loop stalls at its most important point. | P3 (questions exist), P6 (gates matter) | Specify a minimal CLI surface in P1–P3; the web console can wait. |
| **E9** | **Coverage threshold.** SPEC-00 §8 states "≥90% line coverage on core" for P1. That number is currently arbitrary. | P1 | Either justify it or replace it with branch coverage on the specific modules where the safety properties live (authority clamping, evidence writer, invariants). |
| **E10** | **Multi-project support.** Everything is written for one project's state. Whether GENESIS manages several concurrently changes key schemas and the permission model. | P1 (key schema) | Decide before P1 storage work. Recommendation: design keys with a project partition from the start, even if only one project is supported initially — retrofitting it later is expensive. |

---

## F. Recommended next implementation milestone

**P1 — Core state substrate.** Not the whole of P1 at once; the first shippable
slice, in this order:

### F.1 Slice 1 — types and the ledger (recommended immediate next step)

1. **`packages/core-types`** — canonical enums generated from, or checked
   against, the `canonical:` blocks in SPEC-00; branded id types; record and
   event schemas with runtime validators (ADR-0002).
2. **`packages/ledger`** — `EventLedger` port, append-only semantics, event
   schema versioning and upcasting hooks.
3. **`packages/adapters-sqlite`** — ledger adapter.
4. **`packages/testkit`** — the first conformance suite, run against the SQLite
   ledger adapter.
5. **`tools/check-boundaries.mjs`** — the import-boundary enforcer, in CI from
   the first commit that adds packages (R4 depends on this existing early).

**Exit criteria, all executable:**

- Appending events and replaying them from empty reconstructs identical state.
- The ledger rejects updates and deletes — proven by a test, not by inspection.
- Event schema v1 → v2 upcasting round-trips on a fixture ledger.
- `check-boundaries` fails the build on a deliberately-added illegal import
  (a test that asserts the enforcement actually enforces).
- `docs-check` still passes.

### F.2 Then, in order

Slice 2: `MemoryStore` port + SQLite adapter + authority clamping + contradiction
preservation, with property tests on the authority ordering.
Slice 3: `GraphStore` port + SQLite adapter + invariants G1–G10 + `impactSet`.
Slice 4: projections and replay-to-projection equivalence.

### F.3 Before starting

Three answers are worth having first, because they are cheap now and expensive
later:

- **E10** (multi-project key design) — affects every table.
- **E9** (what coverage actually means here) — affects the definition of "green".
- **E2** (`UNCERTAINTY` node type) — affects `core-types`, which is slice 1.

E1, E4–E8 can wait.

---

## Audit conclusion

The document set is internally consistent (mechanically verified), the four
contradictions found have been fixed and recorded rather than quietly patched,
and the significant gaps are named rather than papered over.

**What this audit does not establish:** that the architecture is correct, that
it is buildable in a reasonable time, or that the question-value heuristic is
worth anything. Those are empirical claims and there is no evidence for them
yet — which is, appropriately, exactly the state the system itself would record
as `ASSUMED`.

**Recommendation:** answer E2, E9 and E10, then begin P1 slice 1.

---

## G. Human decisions received (2026-09-18)

The three blocking decisions were answered. Recorded here with authority
`HUMAN_DECISION`; the documents were amended accordingly and the amendments are
listed so the change is not silent (development rule 11).

| # | Decision | Documents amended |
|---|---|---|
| **E2** | **Yes** — `UNCERTAINTY` becomes a first-class `NodeType`. | SPEC-00 §4.7 (canonical block), SPEC-03 §2 (canonical block + attrs), §3.1 (`BLOCKS` endpoints), §4 (new invariant G13), SPEC-01 §7 |
| **E9** | **Replaced** — the arbitrary ≥90% line-coverage requirement is gone. | SPEC-00 §8 (P1 exit criteria) and new §8.1 *Coverage policy*: 100% **branch** coverage on an explicit list of safety-critical modules, 80% line coverage repo-wide as a floor |
| **E10** | **Yes** — multi-project from the start; all project-scoped state carries `projectId`. | SPEC-00 §5, §7 (event shape); SPEC-01 §7; SPEC-02 §3, §7, §8; SPEC-03 §2, §3, §4 (G11–G12), §5, §6; new [ADR-0008](../adr/0008-project-scoping.md) |

Two further decisions were required to implement E10 and are recorded as ADRs
rather than made silently:

- **[ADR-0009](../adr/0009-ledger-hash-chain.md)** — per-project hash chain over
  sequenced events. E10 makes ledgers per-project, which needed a per-project
  ordering (`seq`) that ULIDs alone did not provide. Having introduced sequence
  numbers, making append-only a *verifiable* property rather than a policy was a
  small additional step and closes a real weakness in ADR-0004: nothing
  previously detected a retroactive edit.
- **[ADR-0010](../adr/0010-node-sqlite-driver.md)** — use the built-in
  `node:sqlite` driver rather than a native addon, so `pnpm install` cannot fail
  on a compile step. Confined to one package and reversible by passing the same
  conformance suite.

### Status of the remaining open decisions

E1, E3–E8 are unchanged and not blocking. **E1** (how long-running experiments
rejoin the loop) remains the highest-value one to settle before P5.
