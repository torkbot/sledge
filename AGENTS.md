## Scope

`@torkbot/sledge` is a focused library for durable event + work orchestration on SQLite-backed runtimes.

Optimize for correctness, clarity, and predictable behavior under retries/restarts/contention. Prefer breaking changes over carrying bad abstractions.

## API design principles

- Keep public APIs semantic and minimal.
- Do not leak storage mechanics into user-facing contracts unless absolutely necessary.
- Cursor contracts must be opaque by API contract. Consumers persist and replay cursors; they must not parse or construct them.
- Prefer separate APIs for distinct intent over overloaded option bags with conflicting semantics.

## Correctness and consistency

- Treat this as a distributed/concurrent system even when single-process is common.
- Avoid races around stream handoff, cancellation, and wakeups.
- Consumer reads must not observe uncommitted writes from in-flight transactions.
- Avoid steady-state polling when event-driven wakeups can provide correctness without idle load.

## Data validation

- Treat all I/O as untrusted (DB rows, external payloads, adapter boundaries).
- Validate with TypeBox `Value.Decode(...)` at boundaries.
- Use `Value.Encode(...)` on writes where canonical encoding matters.
- Avoid ad hoc field-parsing helpers when schema decoding can express the contract.

## TypeScript and Node conventions

- Strict TypeScript only.
- Avoid `any` and avoid casts unless unavoidable.
- Use `unknown` for untrusted data and thrown errors.
- Avoid top-level await in executable entry points.
- Prefer `node --run` over `npm run`.
- Prefer `#privateField` and `readonly` where applicable.
- Prefer `AbortSignal` propagation and explicit cancellation handling.

## Code style

- Production-legible, non-clever code.
- Add durable intent comments for non-obvious invariants and trade-offs.
- No tombstone/deprecation comments tied to review history.
- Avoid conditional object spread for optionals; use explicit assignment/branches.

## Testing and quality gates

After changes, run:

- `node --run lint`
- `node --run typecheck`
- `node --run test`

If packaging/publish surface changes, also run:

- `node --run build`
- `npm pack --dry-run`

## Release hygiene

- Keep `README.md` aligned with real API behavior.
- Keep `CHANGELOG.md` updated for user-visible changes.
- Preserve backward compatibility only when it is clearly worth the cost; otherwise choose cleaner contracts.

## Working in this repo

- Do not use bash heredoc syntax. Write content to a temporary file and reference it.
- When posting to GitHub via `gh`, use `--body-file` from a temporary file.
