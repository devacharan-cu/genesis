# GENESIS — Memory Architecture

**Document ID:** `SPEC-02` · **Subordinate to:** [`00-MASTER-SPEC.md`](00-MASTER-SPEC.md)

Defines the memory classes, the common record schema, the authority hierarchy,
how contradiction is preserved, and the lifecycle of a memory record.

---

## 1. Principles

1. **Memory classes are logical, not physical.** All classes share one record
   schema and one store interface. The class is a field. This keeps
   cross-class queries (e.g. "everything about `component:booking`") cheap and
   keeps the storage adapter simple.
2. **Append-only by default.** Records are versioned; updates create a new
   version and link `SUPERSEDES`. Nothing is destructively overwritten.
3. **Authority is explicit on every record.** There is no default-trusted
   source.
4. **AI output is never automatically truth.** A record written by the reasoning
   provider enters at `AI_ASSUMPTION` (see §4) and stays there until an event
   supplies higher-authority support.
5. **Contradictions are data.** They are stored, linked and surfaced — never
   resolved by deletion.

---

## 2. Memory classes

```canonical:MemoryClass
WORKING
SEMANTIC
EPISODIC
DECISION
PROCEDURAL
EVIDENCE
ARCHIVED
```

| Class | Holds | Written by | Retention |
|---|---|---|---|
| `WORKING` | The active cycle's scratch context: current task, assembled context refs, intermediate reasoning outputs | Cycle executor | Cleared at cycle end; summary promoted to `EPISODIC` |
| `SEMANTIC` | Durable facts about the project and world: "the booking API rejects overlapping slots" | World model, evidence promotion, humans | Indefinite, versioned |
| `EPISODIC` | What happened: cycles, actions taken, what the outcome was | Cycle executor at `STORE_EXPERIENCE` | Indefinite, archivable |
| `DECISION` | Decisions and their rationale, alternatives, and who decided | Humans, Architect agent proposals accepted by humans | Indefinite, never archived |
| `PROCEDURAL` | How to do things that worked: repair recipes, build sequences, diagnostic playbooks | Learned from successful episodes, or authored | Indefinite, versioned, usage-scored |
| `EVIDENCE` | Immutable observations: test output, command results, experiment observations, human statements | Verification engine, experiment engine, tool runners | Immutable, indefinite |
| `ARCHIVED` | Records aged out of active retrieval but retained for history and audit | Lifecycle job | Indefinite, cold storage |

### 2.1 Why `EVIDENCE` is separate from `SEMANTIC`

A fact and the reason to believe the fact are different things with different
mutability. `SEMANTIC` records are interpretations and can be superseded.
`EVIDENCE` records are observations and are **immutable** — they are what the
system saw. Belief state transitions (`01-COGNITIVE-ARCHITECTURE.md` §6) require
`EVIDENCE` records specifically, which is what prevents the system from
bootstrapping its own assumptions into verified truth.

### 2.2 Why `ARCHIVED` is modelled explicitly

Archiving changes retrieval behaviour (excluded from default context assembly)
and storage tier (cold). Naming it makes both explicit and makes "why wasn't
this in context?" answerable.

### 2.3 `ARCHIVED`: one field, not two

`ARCHIVED` appears both in `MemoryClass` and in the record `status` enum (§3).
That is a real ambiguity, and it is resolved as follows:

- **`status` is the field that changes.** Archiving sets `status = ARCHIVED`.
  The record's `class` never changes, so an archived decision is still a
  `DECISION` record and its provenance survives.
- **The `ARCHIVED` memory class is a logical view**: the set of records whose
  `status` is `ARCHIVED`, regardless of their original class.

So `MemoryClass.ARCHIVED` is queryable and meaningful, but nothing is ever
*written* with `class: ARCHIVED`. `MemoryStore.query` accepts it as a class
filter and translates it to a status filter. The alternative — mutating `class`
on archive — would destroy the record's origin, which violates §1.2.

---

## 3. Record schema

Every memory record, regardless of class:

```
MEMORY_RECORD
  id              mem_01J...                ULID, unique per VERSION
  logicalId       mem_01J...                stable across versions; equals `id` at version 1
  projectId       prj_01J...                mandatory, immutable (ADR-0008)
  class           <MemoryClass>
  type            string                    // class-specific subtype, e.g. "api-behaviour"
  content         { statement: string, body?: unknown }
  authority       <Authority>                effective, after the write-time policy (§4.2)
  authorityRequested <Authority>             what the writer asked for, before clamping
  authorityClamps [<ClampReason>]            why it was reduced; empty when it was not
  status          ACTIVE | SUPERSEDED | SUPERSEDED_BY_AUTHORITY | CONTRADICTED | ARCHIVED | RETRACTED
  createdAt       ISO-8601
  updatedAt       ISO-8601
  validFrom       ISO-8601
  validUntil      ISO-8601 | null           // for time-bounded facts
  version         integer                   // monotonic per logical record
  previousVersion mem_... | null
  sourceRefs      [{ kind: HUMAN|TOOL|EXPERIMENT|FILE|EXTERNAL|MODEL, id, uri?, hash? }]
  relatedEntities [{ nodeType: <NodeType>, nodeId }]
  producedByCycle cyc_... | null
  producedByAgent agentId | null
  evidenceRefs    [mem_...]                 // EVIDENCE-class records supporting this
  contradicts     [mem_...]
  contradictedBy  [mem_...]
  confidence      number | null             // metadata only; never gates a transition
  tags            [string]
```

Notes:

- `sourceRefs` is mandatory and non-empty. A record with no source cannot be
  written. `MODEL` sources carry the model identifier and a hash of the prompt
  and response so any claim can be traced to the exact reasoning call.
- `validUntil` lets the system represent facts that expire (a deploy target, a
  credential rotation window) without deleting them.
- `confidence` is deliberately last and deliberately optional. Nothing in the
  system branches on it alone.

### 3.1 Evidence record specialisation

`EVIDENCE`-class records additionally carry:

```
  observation   { kind: TEST_RUN|COMMAND|EXPERIMENT|HUMAN_STATEMENT|RUNTIME_PROBE,
                  raw: artifactRef,          // pointer to the stored raw output
                  exitCode?, durationMs?, environment, startedAt, finishedAt }
  reproducible  { command?, seed?, commit?, imageDigest? }
```

`raw` points at stored bytes (S3 or local blob store). The record is not the
summary of the output; it is a pointer to the actual output plus a summary.
**An evidence record may not be created without real captured output.** This is
enforced in the evidence writer: the `raw` artifact must exist and its hash must
match before the record commits.

---

## 4. Authority hierarchy

```canonical:Authority
HUMAN_DECISION
VERIFIED_SYSTEM_STATE
ACTIVE_REQUIREMENT
EVIDENCE
HISTORICAL
AI_ASSUMPTION
```

Rank 1 is highest. Meaning:

| Level | Meaning | Example |
|---|---|---|
| `HUMAN_DECISION` | A human explicitly decided this | "Sessions close after 12 hours, not 24" |
| `VERIFIED_SYSTEM_STATE` | Observed state of the real running system | The deployed Lambda's configured timeout |
| `ACTIVE_REQUIREMENT` | A currently-in-force requirement record | "Bookings must never double-allocate a slot" |
| `EVIDENCE` | An observation that has not yet been generalised into requirement or verified state | A test run's output |
| `HISTORICAL` | Previously true, now superseded or aged | Last release's schema |
| `AI_ASSUMPTION` | Produced by the reasoning provider without external support | "This service probably uses optimistic locking" |

### 4.1 Promotion rules

- Promotion is always an **event**, never a side effect.
- `AI_ASSUMPTION → EVIDENCE` requires a linked immutable evidence record.
- `EVIDENCE → VERIFIED_SYSTEM_STATE` requires the observation environment to be
  the real target environment, not the sandbox.
- `* → HUMAN_DECISION` requires an actor of kind `HUMAN`.
- `* → ACTIVE_REQUIREMENT` requires the record to be linked to a `REQUIREMENT`
  node that is currently in force.
- Nothing promotes itself. A reasoning call cannot assert its own authority
  level; the writer clamps model-sourced records to `AI_ASSUMPTION`.

### 4.2 Write-time authority policy

§4.1 describes how a record's authority may be *promoted* over its life. This
section states what a record may claim **at the moment it is written**, which is
where the guarantee is actually enforced. See
[ADR-0011](../adr/0011-write-time-authority-policy.md).

Three ceilings are applied in order. Each can only lower the authority, never
raise it. The lowest result wins.

| # | Ceiling | Rule | Clamp reason |
|---|---|---|---|
| 1 | **Actor** | `HUMAN` → `HUMAN_DECISION`, `SYSTEM` → `VERIFIED_SYSTEM_STATE`, `AGENT` → `EVIDENCE` | `ACTOR_CEILING` |
| 2 | **Model provenance** | Any `sourceRef` of kind `MODEL` → `AI_ASSUMPTION`, regardless of actor | `MODEL_SOURCED` |
| 3 | **Grounding** | `EVIDENCE` and `VERIFIED_SYSTEM_STATE` require ≥1 `evidenceRef`; `ACTIVE_REQUIREMENT` requires ≥1 related `REQUIREMENT` entity. Otherwise → `AI_ASSUMPTION` | `NO_EVIDENCE`, `NO_REQUIREMENT_LINK` |

Ceiling 2 is what makes the guarantee absolute: **an agent's own claim is
model-sourced, so it lands at `AI_ASSUMPTION` and cannot promote itself, no
matter what it asks for.** Promotion from there requires a *later* event
supplying higher-authority support (§4.1) — never the same write.

**Clamping is recorded, not silent.** The record keeps `authorityRequested`
alongside the effective `authority`, plus the `authorityClamps` that explain the
reduction. A silent clamp would hide a miscalibrated agent; a recorded one is
the calibration signal ADR-0006 §4.1 calls for. Querying for records where the
two differ answers "which components over-claim, and how often?".

Clamping rather than rejecting is deliberate here, and differs from the event
ledger, which *rejects* an over-reaching authority. The difference is what the
two are for: an event is an immutable statement about what happened, so writing
one at a different authority than the caller stated would make the ledger
disagree with its own caller. A memory record is an interpretation, and the
honest response to an over-claimed interpretation is to keep it at the level it
can actually support rather than to discard the content.

**Known wart:** `AI_ASSUMPTION` is also the floor for an *ungrounded* claim by a
human or the system, where the name does not fit what happened. The authority
levels are fixed by the project brief, so this is recorded as open decision
**E11** rather than worked around by inventing a level.

### 4.3 Demotion

When a requirement is retired, its records move to `HISTORICAL` via an event.
When the real system changes, previous `VERIFIED_SYSTEM_STATE` records become
`HISTORICAL` and the new observation takes their place. Demotion preserves the
record.

---

## 5. Contradiction handling

When two records make incompatible claims about the same subject:

1. Both records are retained. Neither is deleted at any point.
2. A symmetric `CONTRADICTS` link is written on both records and a
   `CONTRADICTS` edge in the graph.
3. Authority is compared:
   - **Strictly higher on one side** → the lower side moves to
     `SUPERSEDED_BY_AUTHORITY`. It remains readable and is still returned by
     explicit history queries; it is excluded from default context assembly.
     The governing side keeps its status unchanged.
   - **Equal or indeterminate** → **both** move to `CONTRADICTED`; an
     uncertainty is opened (`01-COGNITIVE-ARCHITECTURE.md` §8) and an issue is
     created.

   An earlier draft said the equal case leaves both `ACTIVE` *and* marks them
   `CONTRADICTED`. `status` is one field, so that was not implementable as
   written. The resolution: `CONTRADICTED` is the status, and — unlike the
   `SUPERSEDED*` statuses — **`CONTRADICTED` records remain visible to default
   queries**, because the conflict is unresolved and both sides still stand.
   Hiding them would be the silent overwrite this whole section exists to
   prevent. See §7 for exactly which statuses are visible by default.
4. A `CONTRADICTION_DETECTED` event is appended with both record ids.
5. Any proposal touching the affected nodes is blocked at `POLICY_CHECK` until
   resolved or explicitly overridden by a human.

**There is no code path that deletes the losing record.**

---

## 6. Lifecycle

```
                 write
  (validated) ─────────▶ ACTIVE
                            │
     ┌──────────────────────┼───────────────────────┐
     │                      │                       │
  new version         contradiction              age-out
     │                      │                       │
     ▼                      ▼                       ▼
 SUPERSEDED     CONTRADICTED / SUPERSEDED_      ARCHIVED
                      BY_AUTHORITY
     │                      │                       │
     └──────────────────────┴───────────────────────┘
                            ▼
              retained forever, queryable by history
```

`RETRACTED` is reserved for records a human explicitly withdraws (e.g. a
requirement stated in error). Retraction is an event; the record and its history
survive.

### 6.1 Working memory clearing

At cycle end, `WORKING` records are summarised into one `EPISODIC` record
containing: the goal, the plan, the actions, the outcomes, evidence refs, and
any beliefs that transitioned. Raw working records are then archived, not
deleted, for a configurable window (default 30 days) to support debugging.

### 6.2 Procedural learning

A `PROCEDURAL` record is written only when an episode **succeeded and was
verified** — the artifact reached at least `UNIT_TESTED` and the goal criterion
was met. Each procedural record tracks `timesApplied` and `timesSucceeded`; a
recipe whose success rate falls below threshold is demoted, not silently reused.

---

## 7. Store interface (port)

The core depends on this, not on any database:

```ts
interface MemoryStore {
  put(scope: ProjectScope, record: NewMemoryRecord, ctx: WriteContext): Promise<MemoryRecord>;
  putVersion(scope: ProjectScope, logicalId: MemoryId, record: NewMemoryRecord, ctx: WriteContext): Promise<MemoryRecord>;
  get(scope: ProjectScope, id: MemoryId): Promise<MemoryRecord | null>;
  current(scope: ProjectScope, logicalId: MemoryId): Promise<MemoryRecord | null>;
  history(scope: ProjectScope, logicalId: MemoryId): Promise<MemoryRecord[]>;
  query(scope: ProjectScope, q: MemoryQuery): Promise<Page<MemoryRecord>>;
  link(scope: ProjectScope, a: MemoryId, b: MemoryId, kind: 'CONTRADICTS' | 'SUPERSEDES'): Promise<LinkOutcome>;
  links(scope: ProjectScope, id: MemoryId): Promise<MemoryLink[]>;
  transition(scope: ProjectScope, id: MemoryId, status: MemoryStatus, cause: EventId | null): Promise<MemoryRecord>;
  close(): Promise<void>;
}
```

**`put` takes the scope**, and stamps `projectId` from it rather than trusting a
caller-supplied value — the same rule the ledger follows. A caller cannot write
a record into a project it is not scoped to.

Every read takes a `ProjectScope` as its first argument, so an unscoped query is
not expressible ([ADR-0008](../adr/0008-project-scoping.md)). `link` requires
both records to be in the scoped project; a cross-project link is a typed error.

**`link` returns a `LinkOutcome`** describing what the link did to each record's
status — which side governs, which was superseded by authority, or that the
conflict is unresolved. Returning `void` would mean the caller had to re-read
both records to discover whether a contradiction had been resolved or left open,
and the difference matters: an unresolved one is supposed to raise a question.

`MemoryQuery` supports filtering by class, type, authority range, status,
related entity, tag, validity window, and free text — plus an explicit
`includeNonActive` flag that defaults to `false`.

**Default visibility.** With `includeNonActive: false`, a query returns records
whose status is `ACTIVE` **or `CONTRADICTED`**, and only the latest version of
each logical record. `SUPERSEDED`, `SUPERSEDED_BY_AUTHORITY`, `ARCHIVED` and
`RETRACTED` are excluded. `CONTRADICTED` is included deliberately: the conflict
is unresolved and both sides still stand, so hiding them would be the silent
overwrite §5 exists to prevent. Retrieval for context assembly never silently
includes superseded records, but it must never silently hide live disagreement
either.

Adapters: SQLite (P1, local), DynamoDB (P8, cloud). Both must pass the same
conformance test suite. See [ADR-0003](../adr/0003-ports-and-adapters-persistence.md).

---

## 8. Storage mapping

| Concern | SQLite (P1) | AWS (P8) |
|---|---|---|
| Records | `memory_records` table, PK `(project_id, id)`, JSON1 for `content` | DynamoDB single-table, PK `prj#<projectId>#mem#<id>` |
| Versions | `previous_version` FK + partial index on `(project_id, status='ACTIVE')` | Sort key `v#<n>`, GSI on logical id within the project partition |
| Links | `memory_links(project_id, a, b, kind)` | Adjacency items under the project partition |
| Text search | FTS5 virtual table, `project_id` in every query | OpenSearch or DynamoDB + embedding store (P3 decision) |
| Raw evidence blobs | Local blob dir, content-addressed | S3, content-addressed, versioning on |
| Archive tier | Same table, `status='ARCHIVED'` | S3 / DynamoDB TTL to archive table |

---

## 9. What memory does **not** do

- It does not rank by "confidence" alone.
- It does not merge two conflicting facts into a blended statement.
- It does not forget on write conflict.
- It does not let an agent write directly; agents emit proposals
  ([`04-AGENT-ARCHITECTURE.md`](04-AGENT-ARCHITECTURE.md)) and the core writes.
