# GENESIS — Verification Architecture

**Document ID:** `SPEC-05` · **Subordinate to:** [`00-MASTER-SPEC.md`](00-MASTER-SPEC.md)

Defines what counts as verification, the artifact verification state machine,
the change lifecycle in detail, and the evidence rules that make the whole thing
non-fakeable.

---

## 1. The central claim

> **Generation is not verification.**

An artifact that an LLM produced is, at that moment, worth exactly nothing as
evidence about its own correctness. The verification subsystem exists to make
that principle mechanically enforced rather than merely stated.

Two rules do most of the work:

1. **Every state advance requires an evidence record** produced by real
   execution, with stored raw output whose hash matches
   ([`02-MEMORY-ARCHITECTURE.md`](02-MEMORY-ARCHITECTURE.md) §3.1).
2. **No component can advance its own verification state.** The Verifier is
   deterministic and separate from whatever produced the artifact.

---

## 2. Verification states

```canonical:VerificationState
GENERATED
STATIC_CHECKED
UNIT_TESTED
INTEGRATION_TESTED
E2E_TESTED
DEPLOYED
PRODUCTION_VERIFIED
```

Per **artifact version**. A new version of an artifact restarts at `GENERATED` —
there is no inheritance of a previous version's verification.

| State | Entry requirement (all must hold) |
|---|---|
| `GENERATED` | Artifact bytes exist and are content-hashed. Nothing else is claimed. |
| `STATIC_CHECKED` | Type check, lint and build all executed and passed; evidence holds the real tool output and exit codes. |
| `UNIT_TESTED` | Unit suite executed; **≥1 test actually exercises this artifact** (coverage-attributed, not merely "the suite passed"); zero failures. |
| `INTEGRATION_TESTED` | Integration suite executed against real collaborators (real DB adapter, real HTTP layer), not mocks of the thing under test. |
| `E2E_TESTED` | End-to-end scenario executed against a deployed sandbox/staging instance. |
| `DEPLOYED` | Deployment to a named environment succeeded and a post-deploy health probe returned a real response. |
| `PRODUCTION_VERIFIED` | In production, the artifact's requirement-level acceptance criteria were observed to hold (synthetic check or real traffic evidence) over a defined window. |

### 2.1 Anti-gaming rules

These close the loopholes that would otherwise let the system report progress it
has not earned:

- **Coverage attribution.** `UNIT_TESTED` requires evidence that this artifact's
  code was executed by a test, from a real coverage report. A passing suite that
  never touches the file does not count.
- **Assertion presence.** A test with no assertions, or whose assertions are
  trivially true, is flagged by a static check and does not count toward
  `UNIT_TESTED`.
- **Mock boundary.** For `INTEGRATION_TESTED`, the artifact under test may not
  itself be mocked, and its direct collaborator of record (database, queue,
  adapter) must be real. Mocking *outward* is allowed; mocking *the subject* is
  not.
- **Same-author independence.** For a `CHANGE` proposed by the Builder, the
  tests that advance it must not be authored in the same proposal **without**
  QA-agent review recorded as a separate finding. Self-written passing tests are
  evidence of nothing on their own.
- **Environment truthfulness.** `PRODUCTION_VERIFIED` requires evidence whose
  `environment` field is the real production environment. The sandbox cannot
  satisfy it.

### 2.2 Regression

If evidence later contradicts a state (a test that passed now fails), the
artifact **downgrades** to the highest state still supported by non-contradicted
evidence, an issue is opened, and a `VERIFICATION_STATE_CHANGED` event records
the downgrade with its cause. States are monotonic *within* a version only in
the absence of contradicting evidence; reality wins over bookkeeping.

---

## 3. Change lifecycle

```canonical:ChangeLifecycle
PROPOSE
IMPACT_ANALYSIS
POLICY_CHECK
APPLY
TEST
VERIFY
COMMIT_STATE
```

Every `CHANGE` node carries its current lifecycle state. The stages:

### 3.1 `PROPOSE`
A proposal arrives ([`04-AGENT-ARCHITECTURE.md`](04-AGENT-ARCHITECTURE.md) §4).
Schema-validated, goal-linked, rationale present.

### 3.2 `IMPACT_ANALYSIS`
The core computes the impact set **itself** from the graph
(`GraphStore.impactSet`), ignoring the agent's claim. Outputs:

- affected nodes, ranked;
- the test set that must run (tests with `VERIFIES` edges into the impact set,
  plus tests whose `IMPLEMENTS`/`CONTAINS` ancestry intersects it);
- the requirements at risk;
- whether the impact set intersects any contradicted or blocked region.

If the impact set cannot be computed (missing graph data), that is an
**uncertainty**, not an approval. The change waits.

### 3.3 `POLICY_CHECK`
Security policy, permission scopes, and authorization gates
([`06-SECURITY-ARCHITECTURE.md`](06-SECURITY-ARCHITECTURE.md)). Also the
contradiction block from [`01-COGNITIVE-ARCHITECTURE.md`](01-COGNITIVE-ARCHITECTURE.md)
§8.6. High-risk operations stop here pending explicit human authorization.

### 3.4 `APPLY`
Transactional write of artifact changes and state ops, with events appended.
Atomic: either the whole accepted op set lands or none of it does. A snapshot
reference is recorded so `TEST` failure can roll back.

### 3.5 `TEST`
The test set from §3.2 is **executed**. Real runner, real exit codes, raw output
captured to the evidence store. On failure the change moves to repair:

```
BUILD → TEST → FAILURE → DIAGNOSE → REPAIR → REGRESSION TEST → VERIFY → DEPLOY
```

The repair loop is bounded: `maxRepairAttempts` (default 3) per change. On
exhaustion the change is rolled back, an issue is opened, and — because the
system could not resolve it — a question is raised to the human. It does not
keep trying forever and it does not declare success.

### 3.6 `VERIFY`
The **verification engine** — a deterministic component of the core, delivered
in P5 — reads the evidence and advances `VerificationState` per §2. It has no
authority to advance anything the evidence does not support.

This is distinct from the **Verifier agent** (P7,
[`04-AGENT-ARCHITECTURE.md`](04-AGENT-ARCHITECTURE.md) §2), which exists to
*review* whether the evidence is adequate and to raise findings — for example,
that a test asserting nothing was counted, or that the Builder wrote its own
tests. The engine applies the state machine; the agent judges evidence quality.
The engine ships first and the lifecycle is fully functional without the agent,
which is why proposals can traverse `VERIFY` from P6 onward.

Neither is ever the component that produced the artifact.

### 3.7 `COMMIT_STATE`
Projections updated, `CHANGE` marked committed, `FIXES`/`ACHIEVES` edges
written, goal success criteria re-evaluated.

---

## 4. Evidence rules

```
EVIDENCE (see SPEC-02 §3.1)
  observation.raw        must exist in the blob store
  observation.hash       must match the stored bytes
  observation.environment  SANDBOX | STAGING | PRODUCTION | LOCAL
  reproducible.command   the exact command, where applicable
  reproducible.commit    the exact revision under test
```

Enforced at the writer:

1. An evidence record whose `raw` artifact is absent is **rejected**.
2. An evidence record whose hash does not match stored bytes is **rejected**.
3. Evidence may not be authored by a reasoning provider. The provider may
   *interpret* evidence; it may not *create* it. This is a type-level
   distinction in the code: `EvidenceWriter` is only reachable from tool
   runners and the experiment engine, never from an agent's LLM path.
4. Evidence is immutable. A retracted observation is superseded by a new record
   explaining the retraction.

---

## 5. Test taxonomy

| Kind | Runs against | Advances |
|---|---|---|
| `PROPERTY` | Pure logic, generated inputs | `UNIT_TESTED` |
| `UNIT` | A module with its collaborators mocked outward | `UNIT_TESTED` |
| `CONFORMANCE` | A port's adapters — every adapter runs the identical suite | `UNIT_TESTED` / `INTEGRATION_TESTED` |
| `INTEGRATION` | Real adapter + real dependency (SQLite file, container) | `INTEGRATION_TESTED` |
| `E2E` | Deployed sandbox/staging instance | `E2E_TESTED` |
| `REGRESSION` | Previously failing case, pinned | Prevents downgrade |

Conformance suites matter structurally here: they are how the SQLite adapter and
the DynamoDB/Neptune adapter are proven interchangeable
([ADR-0003](../adr/0003-ports-and-adapters-persistence.md)).

---

## 6. What the system reports

The status surface reports, per artifact and per requirement:

- current `VerificationState` and the evidence that justifies it;
- the highest state **not** reached and what is missing to reach it;
- open contradictions and uncertainties in the impact region.

It never reports "done" for something at `GENERATED`. The phrase used for an
artifact that exists but is unverified is exactly that: *generated, not
verified*.

---

## 7. Open design questions

1. Coverage attribution mechanism per language (V8 coverage for TS is the P1
   answer; other languages deferred to P7).
2. Definition of the `PRODUCTION_VERIFIED` observation window per requirement
   class (P8).
3. Whether `maxRepairAttempts` should adapt based on failure signature novelty
   (P7).
