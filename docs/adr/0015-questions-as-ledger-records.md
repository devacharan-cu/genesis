# ADR-0015 — Questions are ledger records; humans answer through a web interface

- **Status:** Accepted
- **Date:** 2026-09-19
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION` (open decision E8)
- **Implements:** SPEC-01 §9 (question engine)
- **Builds on:** [ADR-0005](0005-authority-over-confidence.md), [ADR-0006](0006-proposal-based-mutation.md), [ADR-0008](0008-project-scoping.md), [ADR-0014](0014-cognitive-primitives-as-deciders.md)

## Context

SPEC-01 §9 defines a question engine: questions are generated from open
uncertainties, scored, batched to a human, and their answers change what the
system does next. It leaves open *how a human is asked* and *what an answer
does to the rest of the state*. The two obvious answers are both wrong:

- An interactive terminal prompt. It blocks a process on a person, it is not
  recorded anywhere but a scrollback, it has no identity beyond "whoever was at
  the keyboard", and it cannot be batched, reviewed, or answered from another
  device. An answer that is not a record cannot be replayed, audited or
  contradicted.
- A free-text answer attached to the question and nothing else. Then the
  uncertainty it answers stays open, the assumption it refutes stays `ASSUMED`,
  and the "answer" changes nothing — which is the one thing a question exists
  to do.

## Options considered

**A. Terminal prompts during a cycle.** Rejected for the reasons above. Allowed
only as a development convenience that goes through the same commands; never
the production interface.

**B. Questions in a side store, answered by a UI that writes the store.**
Rejected: a second system of record beside the ledger (the argument of
ADR-0014 option A), and the answer's effects on uncertainties and beliefs would
be applied by UI code rather than by the rules.

**C. Questions are cognitive records; a human response is a command.** Chosen.
The question is a record in the cognition projection, created and changed only
by events. A human's response is a command decided by the same decider as
everything else, and the events it produces update the uncertainty, beliefs or
contradiction it concerns in the same atomic append.

## Decision

### 1. A question is a structured project record

Each question records: the question text; the **reason** it is worth asking;
the uncertainty it would settle; its **audience** (`HUMAN`, `SELF`,
`EXTERNAL`); the **resolution method** (the uncertainty's strategy); the
**affected goals and nodes**; the **relevant evidence**; its **score** with the
full factor breakdown and the scorer's name and version; its **status**
(`DRAFT`, `ASKED`, `ANSWERED`, `WITHDRAWN`, `UNANSWERABLE`); the response; and
the outcome. It is project-scoped like every ledger record (ADR-0008).

### 2. Three response kinds, each with a defined effect

| Response | Who | Effect, in the same append |
|---|---|---|
| `ANSWER` | a human for a `HUMAN` question; a human or the system, with cited evidence, for `SELF`/`EXTERNAL` | The uncertainty is `RESOLVED` with the question as resolution evidence. The answer may be attached as `HUMAN_STATEMENT` evidence for or against the uncertainty's related beliefs. For a contradiction's uncertainty the answer must name the governing side, and the contradiction is resolved by the human decision. |
| `REJECT_ASSUMPTION` | a human | The named related beliefs are downgraded to `UNKNOWN`, the rejection is attached to each as contradicting evidence, and the uncertainty is `RESOLVED`. |
| `ACCEPT_RISK` | a human | The uncertainty is `ACCEPTED`: a person chose to live with the gap. It does not pretend the gap closed. |

A response is recorded as an immutable `QUESTION_RESPONDED` event carrying the
responder, the kind, the text and the authority (`HUMAN_DECISION` for a human).
It is never edited; a changed mind is a new question.

### 3. The web interface is the production interface

The human surface is a first-class GENESIS web interface over the question
records: a queue of asked questions ordered by score, each shown with its
reason, affected goals and nodes, evidence and allowed responses. The core
exposes that contract as pure selectors (`pendingHumanQuestions`,
`questionView`) and commands (`RESPOND_TO_QUESTION`), so the interface holds no
rules of its own.

The actor on a human response must come from an **authenticated session**. A
response whose actor is typed into a form is a forgery waiting to happen, so the
HTTP interface is built together with authentication (SPEC-06) and not before.
Until then the commands are exercised by tests and by trusted in-process
callers only.

### 4. Agents draft; they do not ask or answer for a human

An agent may draft a question. Only the system or a human moves questions to
`ASKED`, and only a human responds to a `HUMAN` question, rejects an assumption
or accepts a risk. An agent never resolves a question addressed to a person.

## Consequences

**Positive**

- Every answer is replayable, attributable and auditable; the state it changed
  is rebuildable from the ledger.
- An answer cannot "not take": its effects on the uncertainty, beliefs and
  contradiction are decided by the same rules as every other change and land
  atomically with it.
- The interface is thin. Any number of front ends — web, a notification, a CLI
  for development — are safe as long as they go through the command.

**Negative**

- No human-facing interface ships with P3. Until the authenticated web
  interface exists, a human answer can only be recorded by an in-process caller.
- Three response kinds are a deliberate restriction. A reply such as "partly
  true" must be expressed as an `ANSWER` with text plus separate belief
  commands, not as a fourth kind.
- A rejected assumption goes to `UNKNOWN`, not to a new negated belief. The
  negation, if it matters, is a new belief recorded on its own.

**Mitigations**

- The commands and selectors that the web interface will call are fully tested
  now, so the interface adds transport and authentication, not behaviour.
- `questionView` reports which response kinds are allowed for a question in its
  current state, so a front end never has to re-derive a rule.
