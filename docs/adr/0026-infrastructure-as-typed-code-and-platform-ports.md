# ADR-0026 — Infrastructure as typed code, and the three platform ports

- **Status:** Accepted
- **Date:** 2026-09-20
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION`
- **Implements:** P8 — SPEC-00 §8; SPEC-06 §5; SPEC-07 §3.4, §3.12, §3.14, §4
- **Builds on:** [ADR-0003](0003-ports-and-adapters-persistence.md), [ADR-0005](0005-authority-over-confidence.md), [ADR-0024](0024-dynamodb-single-table-and-cloud-persistence.md), [ADR-0025](0025-cloud-runtime-and-what-is-not-adopted.md)

## Context

SPEC-07 §4 lists nine ports and their cloud adapters. Five existed before P8.
Three did not exist at all — `BlobStore`, `IdentityProvider`, `SecretResolver` —
and they are not optional extras:

- Evidence is currently recorded inline in ledger events. SPEC-05 §4 requires
  that an evidence record's `raw` exist in a blob store and that its hash match
  the stored bytes, and *an evidence record whose raw artifact is absent is
  rejected*. Without a blob store there is nowhere for it to be absent from.
- Authority is meaningless without knowing which human decided
  ([ADR-0005](0005-authority-over-confidence.md), SPEC-07 §3.12). A
  `HUMAN_DECISION` event that cannot name a verified subject is a claim nobody
  can check.
- SPEC-06 §5 defines `SecretRef` as a pointer to be resolved, never a value to
  be stored. Nothing resolved it.

And the infrastructure itself has to exist as something real. The posture the
specs demand — encryption everywhere, a write-once ledger, no public buckets,
per-component roles with no wildcards — is either enforced by the deployed
resources or it is a paragraph.

## Decision

### 1. Three small ports, each with a local adapter

| Port | Owns | Local adapter | Cloud adapter |
|---|---|---|---|
| `BlobStore` | Content-addressed immutable bytes: evidence, artifacts, logs | In-memory, and a content-addressed directory | S3 |
| `IdentityProvider` | Turning a bearer token into a verified subject | A development provider that only accepts tokens it was explicitly given | Cognito |
| `SecretResolver` | Resolving a `SecretRef` to a value, never storing one | An in-memory map | Secrets Manager / SSM |

Each is a port in its own package with an in-memory implementation and a shared
conformance suite, on the pattern every other port in this repository follows.

Two rules are in the types rather than in guidance:

- **`BlobStore` has no `overwrite`.** A put whose key exists and whose bytes
  differ is refused. Content addressing makes the key the hash, so a differing
  put is a hash collision or a caller bug, and both should be loud. This is what
  makes SPEC-05 §4's "evidence is immutable" a property rather than a policy.
- **`IdentityProvider` returns a subject or refuses.** There is no
  "unauthenticated" subject and no anonymous fallback, because a fallback is how
  an unattributed `HUMAN_DECISION` gets written.

The development identity provider deliberately has no default credential: it is
constructed with the tokens it will accept, so a deployment that forgot to
configure a real provider authenticates nobody rather than everybody.

### 2. Infrastructure is typed code that emits CloudFormation

The stack is built by typed functions in `packages/infrastructure` that emit a
CloudFormation template, rather than by a hand-maintained YAML file or by a
CDK app.

Three reasons, in order of weight:

1. **It is testable.** The posture the specs require is asserted over the
   emitted template: point-in-time recovery on, SSE-KMS everywhere, the ledger
   writer role holding no `DeleteItem` or `UpdateItem`, every bucket blocking
   public access, no `Action: "*"` and no `Resource: "*"` in any policy, the
   sandbox task role reaching exactly one S3 prefix. Those are tests, and they
   fail when someone loosens a policy.
2. **It shares the vocabulary.** The Step Functions definitions are generated
   from the same canonical enumerations the code uses, so SPEC-07 §3.7's claim
   that the state machine mirrors `ChangeLifecycle` is checked rather than
   maintained.
3. **It adds no deployment dependency.** The output is a template file. It
   deploys with `aws cloudformation deploy` and needs nothing else installed.
   A CDK app would add a large dependency and a synthesis step to test through.

The cost is that CloudFormation's own semantics are not validated here: a
template can be well-shaped and still be rejected by the service. Validating it
requires an account, which §4 addresses.

### 3. Least privilege is expressed per component, and tested

Every component gets its own role. The roles that matter:

- **Ledger writer** — `PutItem` and `TransactWriteItems` on the table, and
  nothing else. No `DeleteItem`, no `UpdateItem`. The append-only guarantee is
  in the type system (the port has no update), in the hash chain, and now in
  IAM, which is the layer that survives someone reaching past the port.
- **Projection updater** — reads the stream, writes only snapshot items.
- **Sandbox task** — `PutObject` under one S3 prefix. No table access, no
  secrets, no network egress by default.
- **Agent worker** — invokes Bedrock and reads the table. It cannot write the
  ledger, which is the IAM expression of ADR-0020's central claim.

A test asserts each of those negatives directly, because a policy that grants
more than intended reads exactly like one that does not.

### 4. Nothing here has been deployed

No AWS account, credentials or container daemon is available in this
environment. The template is emitted and asserted against; it has not been
submitted to CloudFormation, the stack has not been created, and no adapter has
spoken to a real endpoint.

That is recorded here, in SPEC-07 and in the README, and deploying is the
outstanding obligation for calling P8 production-ready — alongside the Bedrock
live suite, which SPEC-07 §3.10 has been carrying since P4.

## Consequences

**Positive**

- Evidence has somewhere to live, human decisions have someone to attribute to,
  and secrets have somewhere to resolve from — each behind a port with a local
  adapter, so none of it requires a cloud to develop against.
- The security posture is a test suite over a template rather than a paragraph.
- The deployment artifact is a file; the toolchain needed to apply it is the AWS
  CLI and nothing else.

**Negative**

- A typed emitter is a small amount of infrastructure tooling this project now
  owns, where CDK would have been someone else's.
- The template's validity against CloudFormation itself is unproven.
- Three more packages, each small, on a repository that already has nineteen.

**Mitigations**

- The emitter is deliberately narrow: it emits the resources this stack needs
  and has no ambition to be a general framework.
- Template validation is one `aws cloudformation validate-template` call away
  once an account exists, and is listed as an obligation rather than assumed.
