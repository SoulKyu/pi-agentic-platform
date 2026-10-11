# ADR 0005 — a session has its own id; Pi's file is attached once it exists

Status: accepted · Date: 2026-10-10 · Spec: C §3.3 (as amended by decision 34) · Spike: S1 · Rulings: R10, R37

Spec C §3.3 identifies a session by "its absolute Pi file path plus the header uuid". S1 measured that Pi creates that file only when the first user message is recorded: a session that was created and never prompted has a reported `sessionFile` that does not exist, even after the worker is disposed. S1 also measured that reopening such a path with `SessionManager.open` succeeds but gives the session a new Pi id, and that recreating it with the old id changes the file name. So a session cannot be identified by its Pi file before there is one, and a restart of a session nobody has spoken to cannot find "its" file.

## Decision

- A session has its own id: a UUID the daemon makes when the session is created. It is the `sessions.id` key, what clients and the `session` stream use, and the owner of the session's events. Pi's id for the same session is a separate attribute.
- `pi_path` and `pi_session_id` are NULL for a draft (a session whose file does not exist). They are set together, once, when the file exists (`CHECK ((pi_path IS NULL) = (pi_session_id IS NULL))`, and `bindPiFile` updates only a row whose `pi_path` is NULL). A partial unique index keeps two sessions from owning one file; drafts do not collide.
- The daemon notices the file by looking at the path the worker reported in `ready`: after every Pi event until it finds the file (one `stat` per event, only while the session is a draft), when a run ends and when the worker exits. It never reads the file right after `message_end`: Pi writes an entry after its subscribers have seen it (R38).
- The path comes from the worker, so it is untrusted (R66). It is remembered only if it ends in `.jsonl` and lies below `<agentDir>/sessions`. A session whose worker reports anything else stays a draft.
- Reopening a session whose worker is gone:
  - bound: `init.sessionFile` is the stored path (the daemon never passes a file it does not know, R96). The worker's `ready.sessionId` must equal `pi_session_id`; otherwise the file was replaced under the session, the worker is stopped and the prompt gets `worker_failed`;
  - draft: no `sessionFile` is sent. Pi starts a new session in the same directory, the live worker is bound to the same pap id, and the draft binds to the new file when it appears. This is never a `worker_failed` (R10).
- The liveness check compares the pap id with its worker (the `live` map), not Pi's id, while the session is a draft.

## Consequences

- The id the client holds never changes, whatever happens to the worker or to Pi's file.
- If a draft's worker dies before Pi has recorded the first user message, that message is lost with it (it never reached a file). The prompt that carried it already failed with `worker_failed`, so the client knows.
- A bound session whose file was deleted by hand fails to reopen with `worker_failed` instead of silently starting an empty session under the old id.
- A scanner for CLI sessions (spec §3.3, a later milestone) will meet rows with a NULL `pi_path`: those are pap's own drafts and have nothing to scan.
