## Scope

`@torkbot/sledge` is a focused library for durable event and work orchestration on SQLite-backed runtimes.

Prioritize correctness, legibility, and operational predictability over convenience.

## Design principles

- Keep public APIs small, semantic, and transport-agnostic.
- An API that allows correctness-by-construction is always better than alternatives.
- A delightful API is one that will actually get used.
- Avoid leaking storage internals into API contracts.
- Prefer one clear way to do a thing; avoid overlapping capabilities. MECE is the goal.
- Favor clean refactors and breaking changes over preserving flawed abstractions.

## Correctness expectations

- Treat runtime behavior as concurrent/distributed: races, contention, retries, and interruption are normal.
- Preserve transactional integrity between event append, projection, and work materialization.
- Design cancellation and restart behavior explicitly; no silent hangs.
- Keep read/write semantics deterministic and well-scoped.
- A timeout / retry is a sign that we're failing. We _will_ need timers here and there but they should be the exception, not the solution.

## Validation and typing

- Treat all I/O as untrusted data.
- Validate boundary data with TypeBox `Value.Decode(...)`.
- Use strict TypeScript.
- Avoid `any`; use `unknown` for untrusted values and thrown errors.
- Minimize type casts; use them only when unavoidable and local.
- Tests should be MECE. Identify classes of edge cases and cover these with deterministic, high-quality tests.

## Node/TypeScript conventions

- Prefer `node --run` over `npm run`.
- Avoid top-level await in executable entry points.
- Prefer `#privateField` and `readonly` where appropriate.
- Propagate cancellation with `AbortSignal`.

## Code style

- Write production-legible code; avoid clever or compressed patterns.
- Add intent comments for non-obvious invariants/trade-offs.
- Avoid comments tied to PR/discussion history.
- Avoid conditional object spread for optionals; use explicit assignment/branches.
- Avoid speculative optionality. Avoid speculative complexity. Focus on the _immediate_ need without losing sight of the long-term vision.

## Quality gates

After changes, run:

- `node --run lint`
- `node --run typecheck`
- `node --run test`

When package surface/build behavior changes, also run:

- `node --run build`
- `npm pack --dry-run`

## Release hygiene

- Keep `README.md` aligned with current API behavior.
- Keep `CHANGELOG.md` updated for user-visible changes.
