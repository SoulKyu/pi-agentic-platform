# ADR 0007 — a hot session's transcript is read from Pi's file with the worker's leaf

Status: accepted · Date: 2026-10-11 · Spec: C §3.3 ("Hot session: the daemon uses `get_entries{since}`")

## Context
`get_entries` answers with every entry of the session in one record. A long session crosses the 4 MiB record cap
(ADR 0001) and is dropped. Pi writes each entry right after its subscribers saw it (S1, R38), so the file is complete
except for what the current run produced, which the daemon already holds from the run's events. What the file does not
know is where the leaf is after a navigation: `navigate_tree` moves it in memory and writes nothing (S1).

## Decision
The daemon reads hot and cold sessions from Pi's file through the SDK's own helpers. Parsed entries are cached per
file, up to 64 MiB of source across files (least recently read out first); a file Pi appended to is parsed from its
last complete line only, and a file over 32 MiB is read from its tail. Every walk over parent links is bounded by the
number of entries and keeps a visited set, so a damaged file (a cycle) gives a finite answer. For a hot session the
daemon walks the branch from the worker's leaf, which it tracks from `ready.leafId`, every `entry_appended` and every
`navigate_tree` answer; during a run it reads the file only up to its size when the run began, from the leaf at that
moment, and appends the run's own rows (R38).

## Consequences
- No transcript ever travels over IPC; history pages and tool output on demand read the file too.
- A navigation nobody continued is lost when the worker goes away (release, crash): Pi's leaf lives in memory. pi-web
  behaves the same (owner M2-Q11). The composer keeps the text "Edit from here" put in it (Task 24).
- The daemon parses synchronously: a full parse costs one pass over at most 32 MiB, an append only the new lines.
- The oldest history of a session file over 32 MiB is not shown (logged as `tail_only`).
