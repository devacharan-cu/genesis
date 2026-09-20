# GENESIS console API

The thin HTTP surface between a person and the real GENESIS runtime. It creates
projects, starts factory runs, and streams what the ledger records.

```bash
corepack pnpm --filter api start        # :3001, or GENESIS_API_PORT
```

## What it is not

It decides nothing and stores nothing of its own. Goals are created **through
the cognitive engine**, so the API asks the core to record state rather than
writing it (ADR-0006). Every value it returns is `foldConsole` over the ledger,
so there is no counter here that could disagree with history.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | What is answering: reasoning provider, ledger, sandbox |
| `GET` | `/api/scenarios` | What the builder can be asked to produce |
| `POST` | `/api/projects` | Create a project and record the intent as a real goal |
| `GET` | `/api/projects/:id` | The project, and the console fold of its ledger |
| `GET` | `/api/projects/:id/events` | The raw chain, with its verification report |
| `POST` | `/api/projects/:id/runs` | Start a factory run. 202, or 409 if one is in flight |
| `GET` | `/api/projects/:id/stream` | Server-sent events: `snapshot`, `append`, `status`, `error` |

## The stream

A signal-and-read, not a second event system. `WatchedLedger` delegates every
method to the real ledger and announces that history moved; the stream then
**reads** the ledger and sends the raw events. A client that connects late or
reconnects gets a snapshot rebuilt from the ledger, so nothing is lost, and the
pump is serialised against itself so no event is ever sent twice.

A run's status settles *after* its last event, so it is announced separately —
otherwise a client would see the whole run and never learn that it ended.

## Isolation

One runtime per project: its own ledger, cognitive engine, agent registry,
graph and factory. Nothing is shared and nothing is global, so project isolation
(ADR-0008) holds in the server as well as in the stores. A test asserts that a
second project sees none of the first project's run.

## Scenarios

`src/scenarios.ts` supplies only what a model would supply — the text of an
answer, keyed on the request's reasoning purpose. Everything after that is the
real factory. The failure scenario ships a genuine bug, the sandbox genuinely
fails the test, and the repair genuinely fixes it.
