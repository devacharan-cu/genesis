# GENESIS — Knowledge Graph Architecture

**Document ID:** `SPEC-03` · **Subordinate to:** [`00-MASTER-SPEC.md`](00-MASTER-SPEC.md)

Defines node and edge semantics, structural invariants, the query surface the
core depends on, and the storage mapping.

---

## 1. Role of the graph

The graph answers questions that are expensive or impossible for a record store:

- *What breaks if I change this?* — impact analysis over `DEPENDS_ON`,
  `AFFECTS`, `CALLS`, `READS`, `WRITES`.
- *Is this requirement actually implemented and tested?* — presence of
  `IMPLEMENTS` and `VERIFIES` edges.
- *Why is this belief held?* — `SUPPORTS` / `CONTRADICTS` from evidence.
- *Which goal does this work serve?* — `ACHIEVES` paths.
- *What caused this issue?* — `CAUSES` chains.

The graph stores **structure and relationships**. It does not duplicate record
content; nodes carry identity plus a small denormalised label and a pointer to
the authoritative record.

---

## 2. Node types

```canonical:NodeType
PROJECT
GOAL
REQUIREMENT
DECISION
FEATURE
COMPONENT
FILE
FUNCTION
API
DATABASE
TEST
ISSUE
CHANGE
EVIDENCE
BELIEF
QUESTION
EXPERIMENT
DEPLOYMENT
EVENT
```

Common node shape:

```
NODE
  id          <type>_01J...
  type        <NodeType>
  label       string                 // short human-readable
  recordRef   mem_... | evt_... | null
  status      ACTIVE | SUPERSEDED | ARCHIVED | DELETED_LOGICALLY
  attrs       type-specific, small and queryable
  createdAt, updatedAt, version
```

Type-specific `attrs` worth fixing now:

| Type | Key attributes |
|---|---|
| `REQUIREMENT` | `statement`, `priority`, `inForce: bool`, `acceptanceCriteria[]` |
| `COMPONENT` | `layer: FRONTEND\|BACKEND\|DATABASE\|INFRA`, `path` |
| `FILE` | `path`, `contentHash`, `language` |
| `FUNCTION` | `name`, `signature`, `fileId`, `lineRange` |
| `API` | `method`, `path`, `authRequired: bool` |
| `TEST` | `kind: UNIT\|INTEGRATION\|E2E\|PROPERTY`, `runner`, `lastResult` |
| `CHANGE` | `lifecycleState: <ChangeLifecycle>`, `proposalId`, `diffRef` |
| `EVIDENCE` | `observationKind`, `rawRef`, `hash` |
| `BELIEF` | `state: <BeliefState>` |
| `DEPLOYMENT` | `environment: SANDBOX\|STAGING\|PRODUCTION`, `verificationState` |
| `EVENT` | `eventType`, `actorKind` |

`EVENT` nodes are projections of ledger entries; they exist in the graph so that
causal chains (`CAUSES`, `MODIFIED_BY`) are traversable. The ledger remains the
authoritative store.

---

## 3. Edge types

```canonical:EdgeType
CONTAINS
DEPENDS_ON
IMPLEMENTS
VERIFIES
SUPPORTS
CONTRADICTS
AFFECTS
CAUSES
FIXES
CALLS
READS
WRITES
CREATED_BY
MODIFIED_BY
SUPERSEDES
DERIVED_FROM
REQUIRES
BLOCKS
ACHIEVES
```

Common edge shape:

```
EDGE
  id, type <EdgeType>, from nodeId, to nodeId,
  authority <Authority>,          // how well-established this relationship is
  evidenceRefs [mem_...],
  weight number | null,
  status ACTIVE | SUPERSEDED | RETRACTED,
  createdAt, createdByCycle, version
```

Edges carry authority because a relationship asserted by the reasoning provider
("this probably calls that") is not the same claim as one extracted by a parser
or observed at runtime. Context assembly and impact analysis weight edges by
authority.

### 3.1 Semantics and legal endpoints

| Edge | Direction reads as | Legal `from` → `to` (non-exhaustive but enforced) |
|---|---|---|
| `CONTAINS` | parent contains child | `PROJECT`→any; `COMPONENT`→`FILE`; `FILE`→`FUNCTION` |
| `DEPENDS_ON` | A needs B to work | `COMPONENT`→`COMPONENT`, `FILE`→`FILE`, `FEATURE`→`API` |
| `IMPLEMENTS` | A realises requirement B | `FILE`/`FUNCTION`/`COMPONENT`/`API`→`REQUIREMENT`/`FEATURE` |
| `VERIFIES` | A demonstrates B holds | `TEST`/`EVIDENCE`/`EXPERIMENT`→`REQUIREMENT`/`BELIEF`/`CHANGE` |
| `SUPPORTS` | A is reason to believe B | `EVIDENCE`→`BELIEF`; `BELIEF`→`BELIEF` |
| `CONTRADICTS` | A and B cannot both hold | any ↔ any, **symmetric** |
| `AFFECTS` | changing A may change B | any→any, used for impact sets |
| `CAUSES` | A brought about B | `EVENT`/`CHANGE`/`ISSUE`→`ISSUE`/`EVENT` |
| `FIXES` | A resolves B | `CHANGE`→`ISSUE` |
| `CALLS` | code A invokes code B | `FUNCTION`→`FUNCTION`/`API` |
| `READS` | A reads data B | `FUNCTION`/`COMPONENT`→`DATABASE`/`FILE` |
| `WRITES` | A writes data B | `FUNCTION`/`COMPONENT`→`DATABASE`/`FILE` |
| `CREATED_BY` | A was created by actor B | any→`EVENT` |
| `MODIFIED_BY` | A was modified by B | any→`CHANGE`/`EVENT` |
| `SUPERSEDES` | A replaces B | same-type→same-type |
| `DERIVED_FROM` | A was derived from B | any→any |
| `REQUIRES` | A cannot proceed without B | `GOAL`/`CHANGE`/`FEATURE`→any |
| `BLOCKS` | A prevents B proceeding | `ISSUE`/`QUESTION`→`GOAL`/`CHANGE` |
| `ACHIEVES` | A advances goal B | `CHANGE`/`FEATURE`/`EXPERIMENT`→`GOAL` |

Endpoint legality is validated on write against a table in code. An illegal edge
is a rejected write with a typed error, never a silent insert.

---

## 4. Invariants

Checked by `GraphStore` on write, and by a periodic consistency job:

| # | Invariant | On violation |
|---|---|---|
| G1 | `CONTAINS` forms a forest: every node has ≤1 `CONTAINS` parent | Reject write |
| G2 | `CONTAINS` is acyclic | Reject write |
| G3 | `DEPENDS_ON` is acyclic across `COMPONENT` nodes | Reject write, open issue (cycles are sometimes real in code — see note) |
| G4 | `CONTRADICTS` is symmetric: writing A→B writes B→A | Auto-repair on write |
| G5 | `SUPERSEDES` is acyclic and same-type | Reject write |
| G6 | An edge's endpoints exist and are not `DELETED_LOGICALLY` | Reject write |
| G7 | Endpoint types are legal for the edge type (§3.1) | Reject write |
| G8 | Every `REQUIREMENT` with `inForce: true` and no inbound `IMPLEMENTS` opens an uncertainty | Open uncertainty, do not block |
| G9 | Every `REQUIREMENT` with inbound `IMPLEMENTS` but no inbound `VERIFIES` opens an uncertainty | Open uncertainty, do not block |
| G10 | Nodes are never hard-deleted; deletion is `DELETED_LOGICALLY` | Reject hard delete |

Note on G3: real codebases contain dependency cycles. The invariant applies to
the **architectural** `COMPONENT` layer, where a cycle is a design defect worth
blocking. `FILE`-level cycles are recorded as issues, not rejected.

G8 and G9 are the mechanism by which the graph itself generates uncertainties —
the structure notices its own gaps.

---

## 5. Query surface (port)

```ts
interface GraphStore {
  addNode(n: NewNode, ctx: WriteContext): Promise<Node>;
  addEdge(e: NewEdge, ctx: WriteContext): Promise<Edge>;
  getNode(id: NodeId): Promise<Node | null>;
  neighbourhood(id: NodeId, opts: {
    depth: number;                 // hard-capped, default 3
    edgeTypes?: EdgeType[];
    direction?: 'out' | 'in' | 'both';
    minAuthority?: Authority;
    limit: number;                 // mandatory
  }): Promise<Subgraph>;
  impactSet(id: NodeId, opts?: { maxDepth?: number }): Promise<NodeId[]>;
  paths(from: NodeId, to: NodeId, opts: { maxDepth: number; edgeTypes?: EdgeType[] }): Promise<Path[]>;
  findOrphans(criteria: OrphanCriteria): Promise<Node[]>;   // powers G8/G9
  transitionNode(id: NodeId, status: NodeStatus, cause: EventId): Promise<Node>;
}
```

`limit` is mandatory and `depth` is capped so that no query can accidentally
pull the whole graph into a model context — the anti-pattern this architecture
exists to avoid.

### 5.1 Impact analysis

`impactSet(nodeId)` = nodes reachable via outbound `AFFECTS`, and inbound
`DEPENDS_ON`, `CALLS`, `READS`, `WRITES`, `IMPLEMENTS`, transitively to
`maxDepth` (default 4), ranked by edge authority and path length. It is the
input to `IMPACT_ANALYSIS` in the change lifecycle
([`05-VERIFICATION-ARCHITECTURE.md`](05-VERIFICATION-ARCHITECTURE.md)) and to
contradiction blocking.

---

## 6. Storage mapping

| Concern | SQLite (P1) | AWS (P8) |
|---|---|---|
| Nodes | `graph_nodes(id, type, label, status, attrs JSON, ...)` | DynamoDB item `node#<id>` |
| Edges | `graph_edges(id, type, from_id, to_id, authority, status, ...)` with indexes on `(from_id,type)` and `(to_id,type)` | Adjacency items + GSI on `to` |
| Traversal | Recursive CTE, depth-capped | Neptune / Neptune Analytics (Gremlin) |
| Invariants | SQL constraints + application checks | Application checks + DynamoDB conditional writes |

Both adapters must pass one shared conformance suite covering every invariant in
§4 and every query in §5. A traversal correctness suite compares SQLite CTE
results against Neptune results on the same fixture graph before the cloud
adapter is accepted. See [ADR-0003](../adr/0003-ports-and-adapters-persistence.md).

---

## 7. Graph and project tree

The project tree in [`00-MASTER-SPEC.md`](00-MASTER-SPEC.md) §6 is a view over
`CONTAINS` edges rooted at the `PROJECT` node. It is not a separate structure.
Invariants G1 and G2 are what make it a well-formed tree.

---

## 8. Open design questions

1. Whether `EVENT` nodes should be materialised for every ledger entry or only
   for events referenced by causal edges (volume concern, decide in P1).
2. Embedding-based node similarity for retrieval — where embeddings live (P3).
3. Neptune Analytics vs plain Neptune for impact-set computation at scale (P8).
