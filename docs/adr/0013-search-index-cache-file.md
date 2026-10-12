# ADR 0013 — The search index is a cache file of its own, queried in a worker thread

Status: accepted (owner M4-Q4, 2026-10-12) · Spec: C §3.2 (tables: `session_search` (FTS5) in `state.db`; "Heavy FTS queries run in a worker thread")

## Context

M4 indexes every Pi session created after the install (spec D) for ⌘K. The index is derived from Pi's JSONL files, which
pap reads in place and never owns (C §3.1). It can grow to hundreds of megabytes, or more, at 10 000 sessions.

## Decision

The FTS5 index and the scanner's byte-offset cursors live in `$PAP_HOME/search.db`, not in `state.db`:

- It is a cache. A schema change bumps `SEARCH_SCHEMA_VERSION`; a version mismatch or a damaged file deletes the file
  and the scanner rebuilds it from the Pi files (bounded by the install cutoff). No migration, no pre-migration snapshot.
- Damage is handled at runtime too, not only at open: SQLite's `SQLITE_CORRUPT` (code 11, extended codes included) or
  `SQLITE_NOTADB` (26), raised by a scanner commit or a worker query, stops the scanner and the query thread, deletes the
  file, reopens it and rescans, logged `search_index_rebuilt {reason: "damaged"}`; at most 3 rebuilds an hour, after which
  search stays off until the next start (`search_index_unusable`). There is no `quick_check` at open: it would read the
  whole file at every boot.
- It runs with `synchronous = NORMAL`: WAL keeps it consistent, and a commit lost in a crash is read again by the
  scanner, whereas `FULL` would cost an fsync per scanner step.
- There is no global size cap (owner M4-Q14). The size of `search.db` and its WAL is logged at boot
  (`search_index_size`); each file contributes at most `MAX_INDEXED_CHARS` characters of text.
- `state.db` stays small, so its pre-migration snapshots and `pap backup` (M6) stay cheap; the backup can leave
  `search.db` out.
- The daemon is still the single writer (the scanner, on the main thread, in short transactions). Queries run in one
  worker thread with its own read-only connection (WAL), as spec C asks. A query past 2 s is answered `timeout` and its
  thread is abandoned, not terminated: `terminate()` cannot interrupt a running SQLite statement, so the thread keeps
  its core until the statement ends. The deadline (`pap_deadline()`) is checked per matched row only; FTS5 loads a
  prefix's doclists before any row is filtered, and `node:sqlite` has no progress handler to stop that. What bounds the
  cost is the 3-character prefix minimum, decided on the tokens FTS5 itself produces (a mark FTS5 splits at cannot
  make a one-letter prefix), at most 4 queries in flight and at most 3 thread starts a minute.

## Consequences

- One more 0600 file in `$PAP_HOME`; it holds transcript text (user and agent messages), like the Pi files it comes from.
- Deleting `search.db` is always safe: the next start rebuilds it.
- The `sessions` table (state.db) stays the list of sessions; `search.db` only says where a word was seen.
