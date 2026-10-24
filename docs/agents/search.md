# Search module

Code: `apps/daemon/src/modules/search/`. The index is a cache of Pi's files (ADR 0013). The module owns the scanner, `search.db`, the worker thread and `search.query`; it reaches the sessions table only through `SessionsScanPort` (`claim`, `touched`, `named`, `previewed`, `summary`).

## Scanner

- Watches `<agentDir>/sessions` (root) and each folder under it (`fs.watch`, at most 512 folders). While `sessions/` does not exist it watches the agent folder and starts the root when the folder appears. Events are debounced 250 ms with a 1 s maximum wait (`DEBOUNCE_MS`, `DEBOUNCE_MAX_MS`); the queue holds 20 000 paths.
- Reconcile every 60 s (`RECONCILE_MS`), and 1 s after an event it cannot place: it lists the folders, queues what changed, and `lstat`s at most 20 000 files per pass, going on where the last pass stopped. A listing yields every 500 entries. It is the net for lost events (network mounts, inotify limits).
- Links are never followed and a FIFO never blocks: a file is opened `O_NOFOLLOW | O_NONBLOCK` and refused unless `fstat` says regular (`openRegular`).
- The cutoff is the install time (`ensureInstallTimestamp`): a file whose header is dated before it is marked `excluded` and never shows, even when resumed today (owner Q7). Every later Pi session is adopted whoever wrote it: pap, the `pi` CLI or pi-web, as a session of the instance owner.
- One step reads at most 4 MiB (`STEP_BYTES`); the engine yields between steps. A line over 8 MiB (`MAX_LINE_BYTES`) is skipped across steps (`skip_line`). Only complete lines are read; a file that shrinks, changes inode or header is a different file and starts again.
- Per-file cap: `MAX_INDEXED_CHARS` = 4 000 000 characters of indexed text, and `MAX_ROW_CHARS` = 16 384 per row. The count is kept per file in `files.indexed_chars`. **Lowering the cap keeps what is already indexed:** the next step finds `indexed_chars` above the new cap, adds no row and says nothing more. **Raising it resumes after a gap:** rows dropped while the file was capped are not recovered (the offset moved on); new rows are indexed from the current offset until `indexed_chars` reaches the new cap. Only deleting `search.db` (or a version bump) reindexes a capped file whole.
- Log lines (warn, one per event name per 60 s, with `suppressed`): `session_file_capped`, `session_file_lines_skipped`, `session_file_bad_header`, `session_file_unreadable {code}`, `session_list_failed {code}`, `session_reconcile_failed`, `session_scanner_stop_slow`, `session_file_port_failed`. Only error codes are logged, never a message or file text. Info lines: `search_index_size` and, from the sessions scan port, `session_adopted`.
- Read-only mode (a database a newer pap wrote): `search.db` is not opened, the scanner does not start, `search.query` answers no hits (`search_disabled_read_only`).
- Start and stop: `createDaemon` calls `search.start()` after the HTTP server listens, so a first scan never delays the boot; `stop()` runs before the database closes. The scanner checks `stopped` after each await.

## `search.db`

- `$PAP_HOME/search.db`: tables `meta`, `files` (one cursor per Pi file: inode, size, mtime, offset, head, state `indexed | excluded | bad | waiting`), `rows` (user messages and assistant text only, Q5) and `rows_fts` (FTS5, `unicode61 remove_diacritics 2`, content table). `synchronous=NORMAL`: a lost commit is rescanned. 0600 through the process umask. It holds message text and is safe to delete: the next boot rebuilds it from Pi's files.
- Rebuilt (files removed, new index, scanner restarted) when `SEARCH_SCHEMA_VERSION` changes or SQLite reports damage, at open or at runtime (`search_index_rebuilt {reason}`). At runtime at most 3 times an hour; after that `search_index_unusable` and search is off until restart.
- A `search.db` that cannot be opened (EACCES, ENOSPC, CANTOPEN) never stops the daemon: boot logs `search_index_open_failed {code}`, no scanner or thread starts, and `search.query` answers `internal` until the next restart.
- Size: `search_index_size {bytes, rows}` is logged at boot. There is no global cap (owner Q14). The rule for lowering the per-file cap to 1 M characters is decided from the preview's boot line (above 1 GiB, M4R128), not from a test.

## Queries

- `search.query {q, limit?}` runs in a worker thread (`search-thread.ts`; `.js` next to the module in the build, `pnpm smoke` proves it). Deadline 2 s, counted from when the client asked (the thread gets an absolute `deadlineAt`, so a query queued behind a slow one gets no fresh budget) (`timeout`: the client stops waiting and abandons the thread, which keeps its core until its statement ends — `terminate()` cannot interrupt SQLite, and `pap_deadline()` is only checked per matched row, not while FTS5 loads a prefix's doclists), at most 4 in flight (`capacity`), thread started on demand, stopped after 5 idle minutes, at most 3 starts a minute.
- `matchExpression`: every word of the input (letters, digits, marks, NFKC) quoted, all required (at most 8); the last word is a prefix while it is being typed and its last FTS5 token has 3 characters or more. Marks that FTS5's tokenizer splits at (asked of the real tokenizer, e.g. the Devanagari vowel signs) count as separators, so `bिि` or `किताब` never makes a one-letter prefix (I1). That minimum is what bounds a query's cost. Nothing else of the input reaches FTS5.
- Rows are filtered by the caller's `owner_id`. The best row of each session is chosen in SQL (`bm25`, one place per session); the answer carries up to 20 hits with a snippet of at most 400 units. Snippet highlights are the control markers `\u0002` and `\u0003`, turned into `<mark>` by the web, never HTML.

## Measured budgets

Both live in `budgets.json` and are measured headless by `pnpm test:budget` (`PAP_BUDGET_RUN=1`). The default `pnpm test:int` runs the same files without the wall-clock assertions (`search.budget.int.test.ts` on 300 sessions, `scanner.exit.int.test.ts` with a 30 s wait). `pnpm budgets` only names them.

- **Search p95 (`searchP95Ms` = 200).** `search.budget.int.test.ts` builds a deterministic corpus (`testing/corpus.ts`, seed 42, temp dir removed in `afterAll`, about 60 to 80 s and 400 MB of disk): 10 000 sessions, 1 188 251 rows, 147 979 324 indexed characters, 2 249 rows over 2 000 characters; rows per session `20 + floor(e^(ln 60 + z))` (cap 2 000), words per row `floor(e^(ln 12 + 1.2 z))` (cap 2 400), 50 000 words with Zipf weights `1/rank^1.07`. After a warm-up it runs 50 queries through the real thread three times. `test:budget` prints and asserts two figures against the same 200 ms: the p95 of each query's best time over the three passes, and the worst single-pass p95 (the plan's exit criterion: 50 queries asked once). Queries: 20 two-word mid-frequency, 10 rare, 10 three-letter prefixes, 10 common plus rare.
- Measured (6-core dev host, tmpfs): p50 7 to 9 ms; p95 99.3, 101 and 132 ms over three single-pass runs, 97.1 ms best-of-3. Index 404 324 352 bytes, 2.73 bytes per indexed character, about 40 KB per session.
- Caveat: the mix has no very common single word or prefix. The slowest queries are the three-letter prefixes (240 to 440 ms single-pass); the p95 is the third slowest of 50. A user typing `the` or `con` on a real corpus is not covered by this number.
- **CLI session latency (`scannerLatencyMs` = 2500).** `scanner.exit.int.test.ts` writes a session with Pi's own `SessionManager` under the test daemon's agent folder and times it to the `session` event on the `shell` stream over a real `fs.watch` (about 1008 ms). The reconcile finds a lost event within 60 s. `pnpm smoke` repeats it on the build: a Pi file written by hand reaches the stream within 10 s and the smoke session's own reply is found by search.

## Mirror roots (lot B1)

- Three scanners share one index: `<agentDir>/sessions`, `$PAP_HOME/agents/.mirrors` and `$PAP_HOME/boxes/.mirrors`. `start()` creates the two mirror parents (0700) so the first box session after boot is indexed at once. A pass judges only the store paths under its own root.
- **No adoption.** `SessionsScanPort.claim` answers `wait` for a file at `<mirror root>/<id>/<file>` that no session row names yet: the scanner marks it `waiting` and the reconcile re-queues it, so a row that binds the path later gets it indexed (from after the header). An unknown mirror file is never adopted as a session.
- **A mirror append is not an outside write.** `touched` records no outside write and no outside-write taint when the row's `pi_path` is a mirror file. The mirror's `replaced/` subfolder is never indexed (the reconcile lists only files directly in `<id>/`).
- A VM agent's and a box project's conversations are found by search like any session's.

## Outside-write notice (Task 29, owner Q13)

The scanner's `touched` feeds the sessions module, which remembers the latest write it saw that pap did not make, and for a live worker the quiet time since its last activity. The session screen shows a notice when that write is under 2 minutes old. See `docs/agents/sessions.md`, "Outside writes" and "Coexistence with pi-web and a live worker's file".

## Deferred

Custom Pi session folders (only `<agentDir>/sessions` is read); tool output and thinking are not indexed; a hit opens the session, not the older entry (jumping to it waits); `pap backup` leaves the index out (`backup.md`).
