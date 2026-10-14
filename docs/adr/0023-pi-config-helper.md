# ADR 0023 — Pi configuration work runs in a short-lived helper process

Status: accepted · Date: 2026-10-13 · Spec: C §1 (daemon), §8 (supply chain), §9.4 (zero telemetry) · Rulings: M7R36–M7R40, M7R151, M7R152

## Context

Pi's configuration is code in disguise. A `!cmd` value in `auth.json` runs a shell command to produce a key, an OAuth or catalog flow reaches the network, an MCP Test starts a configured server, and an npm or npx install runs package scripts. The daemon holds the database, the session cookies and every `PAP_*` setting. None of that work may run in its process or with its environment.

## Decision

- Every Pi call that reads or writes Pi's configuration, signs in, refreshes a catalog, resolves a `!cmd` key, tests an MCP server or installs a package runs in a helper: one short-lived child process per operation (`packages/pi-host/src/helper/main.ts`, exported as `@pap/pi-host/helper`). The daemon never imports the configuration side of the Pi SDK.
- The daemon starts it with the worker's rules: `workerEnv` (no `PAP_*`, no `NODE_OPTIONS`, `PI_TELEMETRY=0`, `PI_SKIP_VERSION_CHECK=1`), `PI_CODING_AGENT_DIR` set to the agent directory, the worker's `execArgv` (so the network guard applies in tests), its own process group, and `os.tmpdir()` as its working directory. There is no systemd scope: the helper is short-lived, its group is tracked with the workers' (`killAllWorkerGroups()` reaches it), and the group is killed when the helper exits.
- The protocol is a first `helper_run` record (`op`, `agentDir`, `papHome`, optional `cwd`, `params`), then `helper_event`, `helper_prompt` and one `helper_done` from the helper, and `helper_answer` and `helper_cancel` from the daemon. Every record is parsed with a strict schema on both sides. An operation is a table entry with its own params schema (`OPS`); the daemon module that asked parses the result with its own schema. The test operations exist only with `PAP_TEST_PROVIDER=1`, which only a daemon started with a scripted provider sets.
- The pool is capped at `PAP_HELPERS_MAX` (default 4, 1-16). A run beyond the cap is refused at once with `capacity`; it is never queued. Per run: at most 256 events, 16 prompts and 1 MiB per record, otherwise the helper is killed and the run fails `helper_failed`. Every run has a deadline; at the deadline the run rejects `timeout` and the helper climbs the kill ladder (`helper_cancel`, SIGTERM after 2 s, SIGKILL after 3 s more, on the whole group). A helper that exits without answering fails the run with `helper_failed`.
- stdout and stderr are kept as an 8 KiB tail; a failed run (answer, timeout, exit or malformed record) logs it clipped to 2 KB only for `skills.install`, whose output the helper masks line by line. Any other op logs its code and clipped detail, since Pi runs npm and git with inherited stdio and their output is not masked (MC57, MC59). The detail of a failed operation is logged clipped and never sent to a client; the client sees a stable code and a fixed message.
- A helper whose IPC channel closes (the daemon died) kills its own group and exits at once, so none waits for an answer nobody will give.
- The daemon's wiring lives in `apps/daemon/src/compose-pi.ts`. `daemon.ts` calls it, spreads its `rpc`, and stops it together with the sessions: `await Promise.all([pi.stopAll(), sessions.shutdownAll()])`, then the worker groups are killed.
- A token never holds `pi:admin`, and no token can run an operation that changes what pap runs later.

## Consequences

- Each Settings action costs a process start (about 0.15 s for a bare helper; more when the operation loads the Pi SDK, so operations import it when they run, not at start-up).
- A busy Settings page can see one `capacity` refusal and retries.
- Residuals: Node reads a helper's record whole before the daemon can look at it, so the 1 MiB bound is enforced on what was read, not before it. A helper is user-configured code running as the same user: it is contained from the daemon's environment and process, not from the user's files.
