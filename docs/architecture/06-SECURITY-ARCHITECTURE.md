# GENESIS — Security Architecture

**Document ID:** `SPEC-06` · **Subordinate to:** [`00-MASTER-SPEC.md`](00-MASTER-SPEC.md)

Defines the trust model, least-privilege permissions, sandboxing of generated
code, secret handling, and the authorization gates for high-risk operations.

---

## 1. Threat model

GENESIS writes and executes code, and part of that code is produced by a
language model. The design assumptions are therefore deliberately pessimistic:

| # | Assumption |
|---|---|
| T1 | Generated code may be wrong, may loop, may exhaust resources, and may attempt network or filesystem access it was not asked to make. |
| T2 | Content read from the project, from tool output, or from external sources may contain **prompt-injection** attempts aimed at the reasoning provider. |
| T3 | An agent may be induced to propose a destructive or exfiltrating change. |
| T4 | A dependency pulled during a build may be malicious. |
| T5 | Any credential reachable by an agent may end up in a log, a proposal, or a model context. |

The controls below map to these assumptions. Nothing here assumes the model is
adversarial in intent; it assumes the *inputs* can be, which is sufficient.

---

## 2. Principles

1. **Least privilege, declared statically.** Every agent and tool declares its
   permissions in its manifest; the runtime denies anything not declared.
2. **Deny by default.** Filesystem, network and cloud access are allowlists.
3. **No ambient credentials.** Nothing inherits the developer's or the
   operator's credentials.
4. **Secrets never enter model context.** Structurally prevented, not just
   discouraged.
5. **High-risk actions require a human.** Explicit, recorded authorization.
6. **Untrusted content is data, never instruction.** Anything read from the
   project, the web, or tool output is wrapped and labelled as untrusted before
   it reaches a reasoning call.

---

## 3. Permission model

```
PERMISSION
  scope    FS_READ | FS_WRITE | NET_EGRESS | PROCESS_EXEC | SECRET_READ
         | CLOUD_READ | CLOUD_WRITE | DB_READ | DB_WRITE | DEPLOY
  target   a concrete resource pattern (path glob, host, ARN pattern, table)
  level    NONE | LIMITED | FULL
  grantedBy  policyId | humanDecisionEventId
  expiresAt  ISO-8601 | null
```

Rules:

- No agent is granted `SECRET_READ` on raw secret material. Agents receive
  **references**; the tool runner resolves them outside the model path (§5).
- No agent is granted `CLOUD_WRITE` at administrator scope, ever. Deployment
  permissions are scoped to named stacks.
- `DB_WRITE` to a production database is never granted to an autonomous agent.
  Schema changes go through a proposal, a human authorization, and a migration
  tool — not an agent's connection.
- `PROCESS_EXEC` implies the sandbox (§4); there is no unsandboxed exec path.
- Permissions are time-bounded where the grant is task-specific.

### 3.1 Permission derivation

An agent's effective permissions = (manifest request) ∩ (role policy) ∩
(task-scoped grant). The intersection is computed at task assignment and pinned
for the task's lifetime. Widening mid-task is impossible; a broader need is a
new task with a new grant.

---

## 4. Sandboxing

All generated code, all tests of generated code, and all experiments execute in
an isolated sandbox. Never in the core process, never on the operator's host
filesystem.

| Control | Local (P1–P7) | AWS (P8) |
|---|---|---|
| Isolation | Container with a read-only base image, non-root user, dropped capabilities, no host mounts except the workspace | Isolated compute (e.g. Firecracker-backed / dedicated task) per execution |
| Filesystem | Only `/workspace`, `tmpfs` elsewhere, size-capped | Ephemeral volume, size-capped |
| Network | Deny by default; per-task allowlist (package registry during install phase only, then closed) | VPC with no default egress; endpoint allowlist |
| Resources | CPU, memory, PID and wall-clock limits; hard kill on breach | Task-level limits + timeout |
| Credentials | None injected | Task role with only the permissions §3 allows |
| Output | stdout/stderr/artifacts captured to the evidence store | Same, to S3 |
| Reuse | Fresh container per execution; no state carried between runs | Fresh task per execution |

The sandbox is also what makes evidence trustworthy: a recorded exit code from a
controlled environment with a pinned commit and image digest is reproducible.

### 4.1 Dependency handling (T4)

Installs run in a separate network phase with the registry allowlisted, a
lockfile required, and the resulting tree hashed. The execution phase runs with
networking closed. Unlocked or unpinned dependency installs are refused.

---

## 5. Secret handling

**Rule: secret *values* never appear in source control, in logs, in memory
records, in proposals, in events, or in any model context.**

Mechanism:

- Secrets live in a secret manager (AWS Secrets Manager / SSM Parameter Store;
  a local encrypted file for development). Never in `.env` committed to git —
  `.gitignore` enforces the file-level half of this.
- The system passes a `SecretRef` (`{ provider, name, version }`) everywhere a
  secret is referenced. `SecretRef` is the only type that crosses component
  boundaries.
- Resolution happens **inside the tool runner**, at the last moment, outside the
  reasoning path. The resolved value is held in a wrapper type that has no
  `toString`/`toJSON` serialisation and is not loggable.
- Evidence capture runs output through a redaction pass keyed on resolved secret
  values before storage.
- A pre-commit hook and a CI job run secret scanning. A detected secret fails the
  build.

If a secret is ever observed in an artifact, the response is: revoke and rotate
first, then remove from history. Removal alone is not remediation.

---

## 6. Prompt injection and untrusted content (T2)

Content from files, tool output, web search, and issue trackers is **untrusted**.

- It is wrapped with explicit provenance and an untrusted marker before entering
  a reasoning call, and the system prompt for every reasoning call states that
  such content is data and must not be followed as instruction.
- Reasoning output is never executed directly. It becomes a **proposal**, which
  runs the full lifecycle including `POLICY_CHECK`
  ([`05-VERIFICATION-ARCHITECTURE.md`](05-VERIFICATION-ARCHITECTURE.md) §3.3).
  This is the real mitigation: injection can influence a suggestion, but it
  cannot reach state or the host, because there is no path from model output to
  execution that skips policy.
- Any proposal whose ops exceed the agent's declared `proposalKinds`, or whose
  impact set reaches outside the task's scope, is rejected and recorded as a
  `FINDING` — injection attempts leave evidence.

---

## 7. Authorization gates

Operations requiring explicit, recorded human authorization
(`HUMAN_DECISION` event) before `APPLY`:

| Operation | Why |
|---|---|
| Any write to a production environment | Irreversible blast radius |
| Schema migrations (any environment beyond sandbox) | Data loss risk |
| Deletion of data, resources, or infrastructure | Irreversible |
| IAM / permission changes | Privilege escalation path |
| Secret creation, rotation or access-policy change | Credential exposure |
| Network egress allowlist changes | Exfiltration path |
| Cost-incurring resource creation above a configured threshold | Financial blast radius |
| Experiments targeting anything other than `SANDBOX` | Real-system impact |
| Overriding a contradiction block | Bypasses a safety invariant |

Gate behaviour: the change halts at `POLICY_CHECK`, a question is raised to the
human with the impact set and the rationale, and the change resumes only on an
explicit authorization event. Timeout means **denied**, never "proceed".

---

## 8. Audit

Every security-relevant action is an immutable ledger event: permission grants
and denials, secret resolutions (by reference and consumer, never by value),
sandbox executions with image digest and exit code, authorization requests and
decisions, policy violations, and rejected proposals with reasons.

The ledger is append-only. In AWS, the events table is write-once with deletion
protection and a separate role for reads.

---

## 9. What is explicitly not permitted

- Autonomous agents with host filesystem access outside the workspace.
- Autonomous agents holding production credentials.
- Cloud administrator privileges for any automated component.
- Destructive database permissions for any automated component.
- Disabling TLS verification, anywhere, for any reason.
- Committing credentials, even temporarily, even in a branch.
- Executing model output without the proposal lifecycle.

---

## 10. Open design questions

1. Sandbox runtime choice for local development (Docker vs Podman vs a
   lighter-weight isolate) — decide in P5 with a measured startup-cost budget.
2. Whether redaction should be hash-based rather than value-based to catch
   partial leaks (P5).
3. Signing of evidence artifacts so tampering is detectable independent of the
   store (P8).
