# ADR 0007 — a hot session's transcript is read from Pi's file with the worker's leaf

Status: accepted · Date: 2026-10-11 · Spec: C §3.3 ("Hot session: the daemon uses `get_entries{since}`")

## Context
`get_entries` answers with every entry of the session in one record. A long session crosses the 4 MiB record cap
(ADR 0001) and is dropped. Pi writes each entry right after its subscribers saw it (S1, R38), so the file is complete
except for what the current run produced, which the daemon already holds from the run's events. What the file does not
know is where the leaf is after a navigation: `navigate_tree` moves it in memory and writes nothing (S1).

## Decision
The daemon reads hot and cold sessions from Pi's file through the SDK's own helpers. Parsed entries are cached per
file, up to 64 MiB of source across files (least recently read out first). A file Pi appended to is parsed from its
last complete line only, provided its inode, its header line and its last 4 KiB read are unchanged and its format is
current; a file over 32 MiB is read from its tail, and that tail window slides: the oldest entries are dropped once the
window has grown by half, without parsing the file again. Every walk over parent links is bounded by the number of
entries and keeps a visited set, so a damaged file (a cycle) gives a finite answer.

Landed with the reader (Task 10a): the cache, the bounded walks, rows read from the file along the last entry of the
file, and `upToBytes` for a run in progress. Landed with the leaf (Task 10b): Pi 1.1.0 announces no `entry_appended`
for messages or manual compactions (only for the cache warmer, virtual-model state, boundary drafts, context edits and
extension appends), so pi-host looks at `SessionManager.getLeafId()` one macrotask after `message_end`, `compaction_end`,
`turn_end`, `agent_end`, `agent_settled`, an announced entry and a `navigate_tree` answer. When the leaf moved it sends the
entries back to the leaf it last reported as slim `entry_appended` records (at most 128 per flush; Pi's own announced
entries are not sent twice), or one `leaf` record when the leaf moved without a chain back (a navigation) or too many
entries are new (`resync`: the rows of the run keep no id until the file is read; the daemon only logs it). The file is
never read because of a `message_end` (R38). The daemon takes the leaf from `ready.leafId`, each entry and each `leaf`
record (an id over 128 characters is unknown: the page follows the file's last entry, M2R4/M2R52); Pi's system prompt
entry moves the leaf but is not published (R107). Still to come: history pages and tool output on
demand over the reader's `page`, `forks` and `toolCall` in Task 11. During a run the daemon reads the file only up to
its size when the run began, and appends the run's own rows (R38).

## Consequences
- No transcript ever travels over IPC; once Tasks 10b and 11 land, history pages and tool output on demand read the
  file too.
- A navigation nobody continued is lost when the worker goes away (release, crash): Pi's leaf lives in memory. pi-web
  behaves the same (owner M2-Q11). The composer keeps the text "Edit from here" put in it (Task 24).
- The daemon parses synchronously: a full parse costs one pass over at most 32 MiB; an append parses only the new
  lines, but still rebuilds the entry index (O(entries) for the file, without parsing again).
- The cache weight counts source bytes only. Parsed objects take several times that in memory, and nothing is evicted
  while idle, so 64 MiB of source can hold a few hundred MB: this is above R108's idle target (about 42 MB) whenever
  large sessions were read, and a lower `MAX_CACHE_BYTES` or an idle eviction is the lever if RSS matters.
- The oldest history of a session file over 32 MiB is not shown (logged as `tail_only`).
- A file in an older format is parsed whole (tail) on every change: Pi rewrites such a file when it opens it, so only
  cold sessions are concerned.
