# ADR-0009 — Per-project hash chain over sequenced ledger events

- **Status:** Accepted
- **Date:** 2026-09-18
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION`

## Context

[ADR-0004](0004-event-sourced-ledger.md) makes the event ledger the write-ahead
system of record: append-only, never updated, never deleted. Everything the
system can explain about itself — why a belief is held, who changed a
requirement, what an agent proposed — is reconstructed from it.

But "append-only" as written was a *policy*. The store refuses `UPDATE` and
`DELETE` because the code says so. Anyone with database access, and any bug in
the adapter, can violate it, and nothing downstream would notice. That is a weak
foundation for a system whose central claim is that its history is trustworthy.

There is a second, more mundane problem: SPEC-00 §7 gave events a ULID `id` and
a timestamp but no gapless ordering. ULIDs are monotonic per generator, not
across processes, and timestamps collide. Replay needs a total order per
project, and "was anything missing?" needs to be answerable.

## Options considered

1. **Trust the append-only policy.** Zero cost. Detects nothing.
2. **Hash chain — each event commits to its predecessor.** Cheap, detects any
   retroactive edit or deletion, and gives replay a verifiable integrity check.
3. **Signed events (asymmetric keys).** Detects tampering *and* attributes it,
   and would survive an attacker who can rewrite the whole chain. Requires key
   management, rotation, and a story for what signs what.

## Decision

Adopt option 2 now; leave option 3 as the already-recorded open question in
SPEC-06 §10.

Each event carries, in addition to the fields in SPEC-00 §7:

| Field | Meaning |
|---|---|
| `projectId` | The chain this event belongs to. Chains are per-project ([ADR-0008](0008-project-scoping.md)) |
| `seq` | Per-project, gapless, starting at 1, assigned by the ledger on append |
| `payloadHash` | `sha256` over this event's canonical serialisation |
| `prevHash` | The `payloadHash` of event `seq - 1` in the same project; `null` for `seq = 1` |

Rules:

1. **The ledger assigns `seq` and `prevHash`.** A caller cannot supply them. An
   append that tries is a typed error.
2. **Canonical serialisation is fixed and versioned** — sorted keys, no
   insignificant whitespace, explicit `null`s — because a hash over an unstable
   encoding verifies nothing.
3. **`verify(scope)` walks a project's chain** and reports the first `seq` where
   the recomputed hash or the `prevHash` link fails. Verification is part of the
   conformance suite every adapter must pass, and part of the P1 exit criteria.
4. **Gaps are detectable.** `seq` is gapless, so a missing event is found by
   arithmetic even before hashing.
5. **Replay verifies by default.** Rebuilding a projection checks the chain as
   it reads, so corruption surfaces at the moment history is used, not months
   later.
6. **Compensating events, not edits.** The chain does not prevent mistakes; it
   makes them visible. A wrong event is corrected by appending one that
   `SUPERSEDES` it, exactly as ADR-0004 already requires.

## Consequences

**Positive**

- Append-only becomes a *verifiable* property instead of a promise. Tampering,
  truncation and gaps are all detectable, and the chain names the first bad
  event.
- Replay correctness is checked every time replay happens.
- `seq` gives per-project total ordering, which ULIDs alone did not, so snapshot
  offsets ([ADR-0004](0004-event-sourced-ledger.md)) have something exact to
  refer to.
- It is a natural place to hang evidence-artifact signing later (SPEC-06 §10).

**Negative**

- Appends within a project **serialise**. The chain is inherently sequential:
  you cannot compute `prevHash` for two concurrent appends independently. This
  is a real throughput limit, per project.
- The canonical serialisation format is now permanent. Changing it invalidates
  every historical hash.
- Verification cost is linear in history length, which grows forever.
- It detects tampering; it does not prevent it, and it does not defend against
  an attacker who can rewrite the entire chain including every subsequent hash.

**Mitigations**

- Serialisation is versioned alongside `schemaVersion`: verification uses the
  serialiser that was current for that event's version, so the format can evolve
  without invalidating history.
- Verification runs incrementally from the last verified `seq`, recorded
  alongside snapshots; full verification from `seq = 1` remains available and is
  run periodically rather than on every read.
- Per-project serialisation is acceptable because the write rate per project is
  driven by cognitive cycles, which are not high-frequency. If it ever binds,
  the fix is batching multiple state changes into one event, which the proposal
  model already encourages.
- The "rewrite the whole chain" attack is exactly what signing addresses, which
  is why it stays on the roadmap rather than being dismissed.
