# ADR 0009 — forks and clones are written by the daemon, as new files only

Status: accepted · Date: 2026-10-11 · Spec: C §3.1 ("Pi owns its files; pap reads them in place and never copies
them"), §2.3 (`fork` / `clone` listed as worker records)

## Context

A fork (a new session from before a user message) and a clone (a copy of the active branch) must work while the
source session runs, and for a cold session without starting its worker. Pi's `SessionManager` opens a file and
writes a branched copy (`createBranchedSession`) without an agent runtime; pi-web does the same.

`SessionManager.open()` is not read-only. Read in the SDK (1.1.0): it appends a newline to a file whose last line has
no newline (a line a worker is writing, or a torn one); it rewrites in place a file that is empty or older than
`CURRENT_SESSION_VERSION`. Both race a worker that appends to the file.

## Decision

- The daemon loads the SDK lazily (R108), and per request copies the source's **complete lines** (up to the last
  newline) into a private file `<uuid>.jsonl` under `$PAP_HOME/fork-tmp` (mode 0700, file 0600; the source is opened `O_NONBLOCK` and must be a regular file), opens the copy with a fresh
  `SessionManager`, calls `createBranchedSession(...)` and deletes the copy on every path. The source is only ever
  read, never opened by Pi, so neither rewrite above can touch it. At boot the folder's own copies (by name, regular files only) are deleted.
- The copy is opened with the source's folder as the session directory, so the new file lands next to the source
  (Pi's folder for that cwd). The header's `parentSession` would name the copy; the daemon points it at the real source
  before branching and checks the new file's header afterwards (a mismatch deletes the file and fails `internal`). The new file must pass `isPiSessionFile`, else it is deleted and `internal` is thrown.
- A source whose first line is not a current-format Pi header, or that is empty, is refused (`unreadable` -> `internal`):
  the daemon does not migrate files. A source over 32 MiB is refused (`too_large` -> `capacity`, logged as such),
  because parsing it is synchronous work on the daemon's thread. The fork's `text` is clipped to 800 000 JSON bytes.
- Error codes: a branch with no user or assistant message is `session_empty`; a fork point that is not a user message
  is `bad_request`; a header naming a parent other than the real source (`lineage_mismatch`, logged
  `fork_lineage_mismatch`) is `internal`, like the other refusals above.
- A clone copies the branch as written on disk, ending at the worker's leaf (or the file's last entry when the leaf is
  not written yet). A fork at the first message makes a draft row with no file; Pi writes one with the first message.
- The new row is inserted cold, owned by the caller, in the source's cwd; no worker starts.

## Consequences

- Fork and clone work mid-run; a clone does not contain the turn in flight.
- Pi's `session_before_fork` hooks do not run (no extension runtime in the daemon), as in pi-web.
- A session in an older file format is forked or cloned only after its own worker opened (and migrated) it once.
- This is the one place pap writes a Pi file, and it only ever creates one. Cost: a source is read whole and copied
  once per request (at most 32 MiB of memory and disk, briefly).
