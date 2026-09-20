# GENESIS console

The operator console: a React app through which a person states an intent and
watches the real GENESIS factory carry it out.

## Running it

```bash
corepack pnpm --filter api start   # the runtime, on :3001
corepack pnpm --filter web dev     # this app, on :5173
```

## The one rule

**The browser holds raw ledger events and derives everything else with
`foldConsole`** — the same function the API uses (ADR-0027). There is no second
model of what happened in here: no counters, no timers, no stage list maintained
by hand. If you need to show something new, derive it in `@genesis/console` and
it will be correct in both places at once.

Two consequences worth knowing before changing anything:

- **Replay is free.** Showing the run as it stood at event *N* is
  `foldConsole(events.slice(0, N))`. That is all the scrubber does.
- **A new event type cannot be silently ignored.** The fold reports anything it
  has no reading for in `anomalies`, and the console displays that count.

## What is real

Everything after the model's answer: real agents, a real sandbox running real
`node`, real evidence, the real verification engine, a real hash-chained ledger.
The model's answer itself comes from the repository's deterministic provider,
and the header says `reasoning deterministic-local` so nobody has to guess.

Nothing here animates a stage that is not running, and replay is labelled as
replay throughout.

## Layout

| File | Contents |
|---|---|
| `src/App.tsx` | Composition, the event/cursor state, and the replay loop |
| `src/lib/api.ts` | The typed client and the SSE subscription |
| `src/lib/theme.ts` | One colour and one mandate per lane, keyed off the console's own vocabulary |
| `src/components/PipelineRibbon.tsx` | The six canonical stages, plus the repair loop when one happened |
| `src/components/EventStream.tsx` | The timeline, with lane and stage filters and a per-event inspector |
| `src/components/NetworkScene.tsx` | The system map. Lazy-loaded, and degrades to a written explanation without WebGL |
| `src/components/ArtifactPanel.tsx` | What came out, its hash, and the evidence behind its state |
| `src/components/ReplayBar.tsx` | Scrubbing recorded history |

## Accessibility and degradation

Every control is a real button with a label, filters are keyboard reachable, and
the timeline rows are focusable. The 3D map is loaded on its own chunk and sits
behind a capability check and an error boundary: without WebGL, or after a lost
context, the panel explains itself and the rest of the console is unaffected.
