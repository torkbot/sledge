## Scope

`@torkbot/sledge` is a focused library for durable event and work orchestration on SQLite-backed runtimes.

Prioritize correctness, legibility, and operational predictability over convenience.

## Design principles

- Keep public APIs small, semantic, and transport-agnostic.
- Avoid leaking storage internals into API contracts.
- Prefer one clear way to do a thing; avoid overlapping capabilities.
- Favor clean refactors and breaking changes over preserving flawed abstractions.

## Correctness expectations

- Treat runtime behavior as concurrent/distributed: races, contention, retries, and interruption are normal.
- Preserve transactional integrity between event append, projection, and work materialization.
- Design cancellation and restart behavior explicitly; no silent hangs.
- Keep read/write semantics deterministic and well-scoped.

## Validation and typing

- Treat all I/O as untrusted data.
- Validate boundary data with TypeBox `Value.Decode(...)`.
- Use strict TypeScript.
- Avoid `any`; use `unknown` for untrusted values and thrown errors.
- Minimize type casts; use them only when unavoidable and local.

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
