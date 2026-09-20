# ADR-0022 — Purposes, not prompts: how a role varies what it asks for

- **Status:** Accepted
- **Date:** 2026-09-20
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION`
- **Implements:** P7 — SPEC-00 §8; SPEC-04 §3.3
- **Builds on:** [ADR-0007](0007-reasoning-provider-port.md), [ADR-0018](0018-reasoning-and-orchestration.md), [ADR-0020](0020-agent-protocol-and-runtime.md)
- **Amends:** ADR-0018 §3 (one output schema) · **Settles:** SPEC-04 §7 question 4

## Context

P6 closed the system-prompt question by construction: a `TaskFraming` carries no
prompt, no model and no sampling parameter, so a role cannot smuggle
model-specific behaviour in as text. That was the right default and it held for
four roles that all wanted the same thing from a model — cognitive proposals.

P7 breaks that assumption. A Builder asking for source code and a Planner asking
for beliefs cannot share one output schema, and a schema is exactly the part of
a request that the model must satisfy ([ADR-0007](0007-reasoning-provider-port.md)
rule 2). So a role now genuinely needs to vary something about its call.

The tempting answer is to let a role supply its own prompt, or a fragment of
one, or "just a few extra instructions". Every version of that has the same
consequence: the wording that reaches a provider starts living in the domain
packages, and within a release there is a role whose behaviour depends on a
sentence tuned for one model. The reasoning port exists precisely so that
nothing downstream of it knows which model is on the other side.

The second tempting answer is a per-role prompt template owned by the core.
That is better, but it makes the number of prompts equal to the number of roles,
and two roles that want the same thing end up with two prompts that drift.

## Decision

### 1. A role names a purpose. The core owns everything else.

`TaskFraming` gains one field: `purpose`, from a closed set.

```canonical:ReasoningPurpose
PROPOSE_COGNITIVE_UPDATES
PRODUCE_ARTIFACT
DIAGNOSE_FAILURE
```

The core holds one table, `PURPOSE_CONTRACTS`, mapping each purpose to:

- the **system prompt**, written once and owned by `packages/core`;
- the **output schema** the model must satisfy;
- the **handler** that turns a valid output into recorded events.

A role picks a purpose. It cannot write a prompt, cannot pick a model, cannot
pick a schema, and cannot add an instruction. Adding a purpose is a change to
the core, reviewed as one — which is the point, because a purpose is a new
shape of thing a model is trusted to be asked for.

Purposes are canonical (SPEC-00 §4), so the list exists in one place and the
enum-drift test holds the code and the specification to each other.

### 2. Roles configure themselves in typed, model-agnostic terms

Where a role needs to vary behaviour, it does so through a `RoleConfig`: bounded
numbers and enumerated choices, never text that reaches a model.

```
ROLE_CONFIG
  purpose            ReasoningPurpose      // which contract this role uses
  maxArtifacts       number                // bounded output
  maxRepairAttempts  number                // bounded retry
  severityFloor      Severity              // what a reviewer reports
  blockOn            [Severity]            // what stops verification
```

Every field is a number or a member of a closed set. There is no string a model
ever sees. A role that wanted "be more careful about nulls" has to express that
as a check, a threshold or a purpose — which is the difference between a
behaviour the system can test and a sentence someone hopes works.

### 3. Three purposes, and what each is for

| Purpose | Asked for | Handled by recording |
|---|---|---|
| `PROPOSE_COGNITIVE_UPDATES` | Beliefs, uncertainties, drafted questions, contradictions | The four proposal kinds, through `evaluateProposal` — unchanged from P4 |
| `PRODUCE_ARTIFACT` | Source artifacts: path and contents | `ARTIFACT_PROPOSED`, at `GENERATED` and no further |
| `DIAGNOSE_FAILURE` | A root-cause reading of a recorded failure | `FAILURE_DIAGNOSED`, as an `AI_ASSUMPTION` |

None of the three can produce truth. The first goes through the cognitive
deciders, which cap an agent at `AI_ASSUMPTION`. The second records an artifact
at `GENERATED`, which is the state that means *this exists and nothing is
claimed about it*. The third records a reading, not a finding of fact.

This amends ADR-0018 §3, which assumed one output schema for all runs. The
amendment is narrow: the orchestrator now selects the contract by purpose, and
everything else about a run — the recorded request, the recorded response, the
budget, the outer timeout, the typed failures — is unchanged.

### 4. What stays out of the domain, restated

`packages/agents` still may not depend on `reasoning`. It names a purpose by its
canonical value, which lives in `core-types` with the rest of the shared
vocabulary. The mapping from purpose to prompt lives in `packages/core`, on the
core side of the port, where it always has.

A conformance test asserts the negative directly: no source file under
`packages/agents` or `packages/protocol` contains a system prompt, a model id,
or a sampling parameter.

## Consequences

**Positive**

- A role can ask for a genuinely different thing without any wording leaving the
  core, so the port still means what it meant.
- The number of prompts is the number of *kinds of request*, not the number of
  roles, so two roles wanting the same thing share one contract by construction.
- A new purpose is visible as a core change with an output schema and a handler,
  rather than as a string appearing in a role.

**Negative**

- Roles cannot be tuned without a core change. A role that would benefit from
  slightly different phrasing has no way to get it, and the honest options are
  to add a purpose or to accept the shared one.
- `PURPOSE_CONTRACTS` is a table every purpose must be added to in three places
  at once — prompt, schema, handler — and a purpose added to two of them is a
  runtime gap rather than a compile error. A completeness test closes that.
- The canonical enum means adding a purpose touches the specification, the
  types and the core together. That friction is intended and is still friction.

**Mitigations**

- The purpose table is registered safety-critical and held to 100% branch
  coverage, with a test asserting every canonical purpose has all three parts.
- The "no prompts in the domain" rule is a test over the source of the two
  packages, not a convention, so it fails rather than erodes.
