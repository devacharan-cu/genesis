# ADR-0027 — The console as a pure fold, shared by the server and the browser

- **Status:** Accepted
- **Date:** 2026-09-20
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION`
- **Implements:** the operator console — SPEC-00 §1.1 (honesty), SPEC-05 §4
- **Builds on:** [ADR-0004](0004-event-sourced-ledger.md), [ADR-0013](0013-projections-as-pure-folds.md), [ADR-0023](0023-software-factory-and-the-verified-artifact.md)

## Context

A system whose entire claim is that it knows *why* it believes things is judged,
in practice, by a screen. If that screen is wrong, nothing else matters: an
operator cannot audit what they are being misled about.

The console that existed before this decision was wrong in the ways screens
usually are. It rendered `{node, msg}` strings assembled from guessed event
names. It attributed events to agents by lowercasing the first word of a stage.
It showed two decorative badges — `SYSTEM SECURE`, `SAIF ENFORCED` — that were
connected to nothing. Its panels were empty for agents that had done work,
because the mapping it filtered on did not match the events the system emits.
None of that is a cosmetic problem. A dashboard that reports a state the ledger
does not contain is the same category of failure as a projection that does.

Three specific forces:

1. **Attribution is not in the event.** `AGENT_TASK_STATE_CHANGED` carries a
   task id and no role. `REASONING_RESPONDED` carries a call id and no task.
   Answering "who did this?" requires remembering what earlier events said.
2. **A run finishes in well under a second.** There is nothing to watch in real
   time. The obvious fix — slowing the system down, or animating stages on a
   timer — would make the console a fiction.
3. **Two readers, one history.** The API answers `GET /state`; the browser
   follows a stream. If each derives its own view, they will eventually
   disagree, and the disagreement will be invisible.

## Decision

### 1. The console view is a projection, and lives in a package

`@genesis/console` is a pure fold from `GenesisEvent[]` to what a person sees:
lanes, stages, artifacts, findings, and a timeline row per event. It holds no
state, calls nothing, and writes nothing. Given the same events it produces the
same view.

Production code in it imports **only** `@genesis/core-types`, and a test
enforces that by reading its own source. It therefore cannot become a second
source of truth however the view grows, and it runs unchanged in a browser.

### 2. The same fold runs on both sides

The API folds the ledger for `GET /api/projects/:id`. The browser holds raw
events and folds them itself. The stream carries **raw `GenesisEvent`s**, not a
pre-digested reading of them.

This is the decision that makes divergence impossible rather than unlikely, and
it is asserted directly: a test folds what the stream sent and compares it to
the server's fold of the ledger.

It also makes replay free. Showing the run as it stood at event *N* is folding
the first *N* events — so the scrubber is not a separate feature with separate
state, it is the same function with a smaller argument.

### 3. Attribution is derived by remembering, never by guessing

The fold keeps two maps while folding: `taskId → role`, from
`AGENT_TASK_ASSIGNED`, and `callId → taskId`, from `REASONING_REQUESTED`. Every
later event on a task or a call is attributed through them.

Where the assignment was never seen — a client that joined mid-run — the
fallback is the owning lane of the stage that is running, and then the core's
lane. Both are honest answers. Inventing an agent would not be.

The stage-to-lane table is taken from what the factory actually assigns, not
from the stage's name: `DIAGNOSE` runs the Repair agent and `REPAIR` runs the
Builder, because diagnosing is reasoning about a failure and repairing is
producing an artifact. The tidier mapping would have been wrong.

### 4. Nothing is invented, and nothing is silently dropped

A row shows the sentence the producing package wrote. Where the factory recorded
`the test run exited 1`, that is what a reader sees — not "stage failed".

An event type the fold has no reading for still appears, under its real type, in
the core's lane, and is counted in `anomalies`. A console that hid what it could
not parse would be most misleading exactly when something unusual had happened.
The suite asserts `anomalies` is empty for a real run, so a new event type
surfaces as a failing test rather than as a gap on a screen.

### 5. Replay is labelled as replay

The console never animates a stage that is not running. When the cursor is off
the head, the UI says *replaying*; when a run is live, it says *live*. The
difference between "this is happening" and "this happened" is exactly the kind
of thing a console must not blur.

### 6. The server signals; it does not become a second ledger

`WatchedLedger` delegates every method to the real ledger and, after an append
lands, tells listeners that history moved. Listeners then **read the ledger**.
That is the same discipline as the DynamoDB stream in
[ADR-0024](0024-dynamodb-single-table-and-cloud-persistence.md): a notification
is a signal, the ledger is the record.

A run's *status* settles after its last event, so it is announced separately —
otherwise a client would see the whole run and never learn that it ended.

## Consequences

**What this buys.** The screen cannot drift from the ledger, because there is no
second model of what happened to drift. Replay, reconnection and late joining
all work without special cases. An operator can check the console against
`GET /api/projects/:id/events`, which serves the raw chain and its verification
report.

**What it costs.** The browser re-folds the whole history on every event. At a
hundred events that is free; at a hundred thousand it would not be, and the
honest answer then is snapshots — the same answer
[ADR-0013](0013-projections-as-pure-folds.md) already gives for projections.

**What it does not claim.** The fold is presentation. It decides nothing, and a
mistake in it misleads a person without changing what the system believes. It is
held to full branch coverage anyway, because for a system whose whole claim is
auditability, misleading the auditor is the harm.

## Alternatives considered

**Send a pre-rendered view over the stream.** Simpler client, and the shape the
first version had. Rejected: the client then cannot replay without asking the
server for every intermediate state, and the two readings can differ with
nothing to catch it.

**Put the fold in `projections` with the others.** It is the same kind of thing.
Rejected because `projections` is part of the system's own state derivation and
is depended on by the core; the console is depended on by nobody but the apps,
and keeping it out of that graph is what lets it import almost nothing.

**Slow the factory down so the demo is watchable.** Rejected outright. The
system is fast because the work is small; making it pretend otherwise would be
the exact failure this ADR exists to prevent. Replay solves the same problem
without lying.
