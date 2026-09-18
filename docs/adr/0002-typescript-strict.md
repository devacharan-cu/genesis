# ADR-0002 — TypeScript with strict typing, and what "strict" means here

- **Status:** Accepted
- **Date:** 2026-09-18
- **Deciders:** Dev (human), lead engineering agent
- **Authority:** `HUMAN_DECISION`

## Context

GENESIS's safety properties are largely *type* properties: an agent cannot reach
a store handle; a model-sourced record cannot carry an authority above
`AI_ASSUMPTION`; a secret value cannot be serialised into a log. These only hold
if the type system is actually enforcing them.

## Decision

TypeScript with the following compiler settings, repo-wide, no per-file
opt-outs:

```jsonc
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "noImplicitOverride": true,
  "noFallthroughCasesInSwitch": true,
  "noPropertyAccessFromIndexSignature": true,
  "isolatedModules": true,
  "verbatimModuleSyntax": true,
  "target": "ES2023",
  "module": "NodeNext"
}
```

Additional rules:

1. **No `any`.** `unknown` plus narrowing instead. The lint rule is an error,
   not a warning. `@ts-expect-error` requires an adjacent comment with a reason;
   `@ts-ignore` is banned outright.
2. **Branded ids.** `MemoryId`, `NodeId`, `EventId`, `GoalId` etc. are branded
   string types so they cannot be interchanged by accident.
3. **Runtime validation at every boundary.** Types vanish at runtime, so every
   external input — messages, tool output, adapter reads, model responses — is
   parsed with a schema validator that produces the branded type. Trusting a
   cast at a boundary is a defect.
4. **Exhaustive unions.** Every switch over a canonical enum ends in a
   `never`-typed default, so adding an enum member breaks the build everywhere
   it must be handled.
5. **Non-serialisable secret wrapper.** `Secret<T>` has no `toString`/`toJSON`
   and is not assignable to `string`.

## Consequences

**Positive**

- Adding a `NodeType` or `BeliefState` produces compile errors at every site
  that must change, rather than silent fallthrough.
- Branded ids eliminate a whole class of "passed the wrong id" bugs that would
  otherwise corrupt graph edges.
- Boundary validation is where the anti-fabrication rules are actually enforced.

**Negative**

- More ceremony: constructors for branded types, schemas alongside types.
- `noUncheckedIndexedAccess` makes array access noisier.
- Runtime validators duplicate type declarations unless generated from one
  source.

**Mitigation:** derive types from the validation schemas (schema is the single
source), so there is one declaration per boundary type rather than two.
