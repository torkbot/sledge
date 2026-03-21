# @torkbot/sledge

A SQLite-backed event and work engine that stays consistent across retries, restarts, and failures.

## What's included

- `src/ledger/ledger.ts`: type-safe model and runtime contracts.
- `src/ledger/database-ledger-engine.ts`: core SQLite-backed ledger runtime.
- `src/ledger/better-sqlite3-ledger.ts`: better-sqlite3 adapter.
- `src/ledger/turso-ledger.ts`: Turso adapter.
- `src/runtime/contracts.ts`: runtime clock/scheduler interfaces.
- `src/runtime/virtual-runtime.ts`: deterministic test runtime.

## Scripts

- `node --run test`
- `node --run typecheck`
- `node --run lint`
