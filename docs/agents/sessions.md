# Sessions module

Code: `apps/daemon/src/modules/sessions/`. Identity of a session and its Pi file: ADR 0005. Worker protocol: ADR 0001.

## Pieces

- `service.ts`: the one place that knows which workers are up (`live`), which are coming up (`starting`, `reopening`) and when a session's Pi file is remembered. RPC handlers (`rpc.ts`) only decode, call it and let `PapError` through.
- `live-session.ts`: one worker's session. Sends `init`, tracks status, dialogs, run boundaries and the run's messages; everything it knows leaves through `publish` (stream) and `record` (table `session_events`).
- `run-tracker.ts` (run start/end), `dialogs.ts` (cards), `run-view.ts` + `snapshot.ts` + `transcript.ts` (what a subscriber starts from), `pi-files.ts`, `cwd.ts`, `store.ts`.
- `testing/` helpers are for tests only (the build and the lint keep them out of production code): `service-bed.ts` (real database and hub, fake workers), `live-bed.ts`, `helpers.ts`. A helper in `testing/` may import a module only through its `index.ts`, so the test files import `service.ts`, `store.ts` and `live-session.ts` themselves and pass the factories in.

## Capacity

A worker counts against `maxWorkers` from the moment it is forked: `starting` is a set, checked and filled in the same tick, so concurrent creates cannot both pass (R9). It leaves `starting` only after the session is in `live`. `minFreeMemMb` is checked at the same place. Both refuse with `capacity`; nothing waits in a queue. After `shutdownAll` every new start is refused with `capacity` too.

A worker that does not say `ready` within 30 s (`READY_TIMEOUT_MS`) is stopped and the start fails with `worker_failed`. A worker that exits before `ready` (exit 70 for a bad init, policy or `PI_CODING_AGENT_DIR`) gives the same fixed `worker_failed`; the log has its exit and the last 2000 characters of its output, never the client.

A failed start of a new session leaves nothing: the row is inserted only when the worker is ready, and nothing is published or recorded for a row that is not stored (the hub keeps a channel for every key it is asked to publish for, so a ghost key would stay).

## Runs

- A run starts at `agent_start` and ends when `agent_settled` is confirmed by up to three `get_state` probes 100 ms apart; new input cancels the probes. Spec C §2.4 says what happens when no probe sees Pi idle: the run stays open until the next `agent_settled`.
- Abort: `get_state` first; compaction, or no answer within 2 s, terminates the worker. Otherwise `abort` is sent and the worker is terminated if the run has not settled 5 s later. One deadline, not two.
- `prompt` has no timeout (R99): an extension command answers only when it ends, possibly after a dialog the user takes minutes to answer. The pending request ends with the worker (`worker_failed`). Dialog answers do not wait for it. No sessions method can answer `timeout`: `get_state` and `abort` are internal and their timeouts are handled where they happen. If one ever did, it would mean "outcome unknown" (R105): the dispatcher stores no receipt for an error, nothing retries, and the client has to look at the session's state before it sends the command again.
- A crash closes every open dialog, records `run_end {interrupted: cause}` and `worker_exit`, publishes `status cold` with a readable cause and removes the worker from `live`. Nothing restarts it; the next prompt does, on the same Pi file (or a new Pi session for a draft).

## Dialogs

At most 64 open dialogs and 8 MiB per session; extra ones are answered `cancelled` at once. Methods other than `select`, `confirm`, `input` and `editor` are decorations (passed on as `pi` events) or, if unknown, cancelled. The worker's text is untrusted: a dialog is rebuilt from the fields we know, text is cut to the limits of `Dialog` and then to 1 000 000 bytes as serialised (a character can take up to six bytes once escaped), so one dialog is never more than one frame. A `select` whose options do not fit (more than 100, or one longer than 4096 characters) is cancelled instead of cut, because the extension is waiting for one of those exact strings. A cancel caused by size or by the limit also publishes a `notice`. Extension errors reach the client as a fixed sentence with, at most, the event name when it looks like one; the worker's text only goes to the log, clipped to 2000 characters (R66).

## What a subscriber starts from

- `snapshot` is the current status, the open dialogs and about the last 75 messages, held under 1 MB: dialogs first (oldest first), then messages newest first, contiguous. An unknown session id is `not_found` (R79), so a client cannot make the hub create channels.
- Messages come from the Pi file through the SDK helpers (never written, never migrated on disk). Pi writes an entry after its subscribers saw it, so during a run the file is read only up to its size when the run began, and the run's own messages (from `message_end`) follow it (R38). Once the run has settled the file is complete.
- Pi puts its system prompt in the file as the first message (`role: "system"`, about 9 KB in the default prompt). It is part of the snapshot and of the `message_*` events of the first run; the web client decides what to show of it.
- The snapshot has no partial assistant message: a client that subscribes in the middle of a reply gets the messages finished so far and the deltas that follow. Spec C §4.3 wants the partial message too; that is left for the web client work.
- `agent_end` and `turn_end` reach the daemon without `messages` and `toolResults` (R103, `toWireEvent` in pi-host): they grow with the run. Each message is in its `message_end`, each tool result in its `tool_execution_end`.
- Events are sent whole or not at all: a Pi event over 1 MB becomes a `notice` (deltas are never measured).
- Importing the SDK for these helpers costs the daemon about 90 MB of resident memory and half a second at start (measured: 42 to 136 MB).

## Traps

- `ready.sessionFile` of a draft does not exist; do not treat a missing file as an error anywhere (reads give an empty transcript).
- Never read the Pi file because of a `message_end`.
- A worker's `sessionId` is Pi's, not the session's. The session's id is the pap id everywhere a client or the hub sees it.
- Tests use fake workers with the fake clock; the one test that forks the real `pi-host` is `sessions.int.test.ts` (scripted model, network guard, temporary agent directory, home and pap home).
