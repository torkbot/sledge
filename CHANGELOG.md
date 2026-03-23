# Changelog

## Unreleased

## 0.2.0

* Add event tailing and resume APIs for external consumers

    You can now consume ledger events as a stream using `tailEvents({ last, signal })` and continue later with `resumeEvents({ cursor, signal })`. This makes it practical to build and maintain read models in separate processes (including browser and worker clients) without replaying from the beginning each time.

* Make event stream cursors opaque and portable

    Stream items now include a cursor token intended for persistence and later resume. The cursor format is intentionally opaque, so applications should store and pass it back as-is.

* Prevent tail/resume consumers from seeing uncommitted events

    Event stream reads are now coordinated with in-flight mutations so consumers don't observe rows that are later rolled back. In practice, this makes client-side materialization safer under failures and concurrent writes.

* Improve stream shutdown behavior

    Closing a stream iterator (including via `return()`) now shuts down cleanly without requiring external abort plumbing.

## 0.1.0

* Initial public release of `@torkbot/sledge`

    This release introduces a SQLite-backed event and work engine with typed events and queues, projector/materializer registration, deterministic retries, dead-letter outcomes, and lease-based work handling.

* Add better-sqlite3 and Turso adapters

    You can run the same ledger model against local SQLite (`better-sqlite3`) or Turso using the provided adapters.

* Add runtime scheduling primitives for production and tests

    Includes Node runtime helpers for real execution and a virtual runtime harness for deterministic tests.
