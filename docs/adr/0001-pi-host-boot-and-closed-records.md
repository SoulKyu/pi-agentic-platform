# ADR 0001 — the `init` and `extension_ui_closed` records of the daemon ⇄ pi-host protocol

Status: accepted · Date: 2026-10-10 · Spec: C §2.3 (as amended by decision 34)

Spec C §2.3, as amended by decision 34, lists `init{…}` as the first daemon → worker record and `extension_ui_closed{id}` as a worker → daemon record, and defers both to this ADR. The earlier draft of the table had neither. This ADR fixes their fields and the worker's behaviour around them.

## `init` (daemon → worker, always the first record)

`init{cwd, agentDir, papHome, sessionFile?, policy, testProviderScript?}`

- The worker needs its session file, directories and policy before it can send `ready`. The environment would leak them into every `bash` child, and argv would show them in `ps`, so they travel in a record. `policy` is the "rules sent at worker boot" of §5.1; `policy_update{rules}` stays the hot-reload path.
- `cwd`, `agentDir`, `papHome`, `sessionFile` and `testProviderScript` are absolute paths, checked by the contract. `agentDir` (the Pi agent directory) and `papHome` (the pap data directory, `$PAP_HOME`) are the two roots `pap-policy` protects: an edit under either asks, and a session directory that contains either gets no automatic edits. A relative path would be resolved against the worker's own working directory and protect the wrong place, so `papHome` is required, not optional. The daemon passes only session files it knows as `sessionFile`.
- Fail fast, never wait: a malformed `init` or a `policy` that `PolicyRules` rejects makes the worker print the reason on stderr and exit with code 70 before it opens a session. The daemon sees a worker that failed to start, not one that is silent. A later `policy_update` with invalid rules keeps the previous rules and is reported as an `extension_error` for `<inline:pap-policy>`.
- Records that arrive between `init` and `ready` are queued (at most 128; the 129th makes the worker exit 70) and handled, in order, right after `ready`. A `shutdown` is never queued. A malformed command that carries an `id` gets a failed `response`; a malformed `extension_ui_response` cancels its dialog; any record of type `shutdown`, well formed or not, shuts the worker down.
- `shutdown{graceMs}`: the worker cancels its dialogs, asks the running agent to abort, waits for that for at most `graceMs` (2 s when the record does not parse), then disposes the session, which stops a running command, and exits 0.
- A `prompt` is answered once, as soon as Pi has classified it. If Pi rejects it afterwards, the daemon already has its answer, so the failure goes to stderr as one bounded line (2000 characters at most) and nowhere else.
- Every string the worker puts in an `extension_error` or a failed `response` is clipped to 2000 characters before it leaves the worker.
- `testProviderScript` exists only for tests. The worker honours it only when its own environment also has `PAP_TEST_PROVIDER=1`, and exits 70 otherwise, so a stray field can never swap the model of a real session. The daemon sets the variable and sends the field only when `PAP_TEST_PROVIDER_SCRIPT` is set, and logs a warning at boot.

## Worker environment

Pi derives its session directory from `PI_CODING_AGENT_DIR`, not from the `agentDir` it is handed. The worker environment built in Task 22 sets `PI_CODING_AGENT_DIR` to the same directory as `init.agentDir`, and the worker refuses to start when the two differ: a mismatch would write sessions where the init record does not say. `HOME` must be the user's home, because Pi reads user-level skills from it and the policy judges "the home directory" by it. When the channel to the daemon closes, however the worker learns of it (the `disconnect` event, a `send` that finds the channel closed, or the `ERR_IPC_CHANNEL_CLOSED` error Node emits later), it disposes the session and exits 0, without a crash trace.

## Processes a worker leaves behind

Pi's `bash` tool starts every command with `detached: true`, so each command leads a session and a process group of its own. A signal to the worker's group (what the daemon's kill ladder sends) never reaches it, and `process.exit` leaves it running; a grandchild that called `setsid` is beyond even Pi's own list of detached children. The SDK kills that list on its own signals (`killTrackedDetachedChildren`) but does not export it, so `pi-host` walks `/proc` itself:

- On `shutdown`, on a closed channel, when orphaned, and on SIGTERM and SIGHUP, the worker SIGKILLs every descendant (found by parent pid) and the group of each descendant that leads one, then exits. The walk comes first: once Pi has killed a command's shell, the shell's children have a new parent and are no longer found. SIGTERM and SIGHUP are handled once and re-raised, so the daemon still reads the exit as a signal.
- It does this only when the worker leads a group of its own (the daemon forks it `detached`), never signals its own group, and does nothing off Linux.
- Residual: when the worker itself is killed (SIGKILL, the OOM killer) nothing runs in it and these processes survive. The cgroup of the systemd scope (roadmap M2) is the only cover for that case; its priority goes up in M2.
- On its side the daemon signals the worker's group when the worker exits and exports `killAllWorkerGroups()` for the signal handlers of the daemon (Task 23): `process.on("exit")` does not run for a signal whose default action kills the process.

## Record size

Node reads a whole IPC record before any code sees it and has no receive-side limit, so the daemon cannot cap what a worker sends: a valid 100 MiB record costs about 430 MB of resident memory in the daemon (measured in the Task 21 review), one line without a newline can end it with a `RangeError`, and a line that is not JSON throws a `SyntaxError` inside the channel's reader that the daemon cannot catch. The cap is at the source: `ipc.send` serializes each record, and a record of more than 4 MiB (UTF-8 bytes of its JSON) is dropped. One bounded line goes to stderr and an `extension_error` for `pi-host:ipc` goes to the daemon; a dropped `response` is replaced by a failed response with the same id, so no request waits for it. Reports are sampled (1st, 2nd, 4th, 8th drop…); every dropped response is still answered.

Accepted residual: code running inside the worker (an extension) can write to the channel's file descriptor directly and crash the daemon, as it could already signal it. The durable fix belongs to the sandbox stage: a plain pipe on that descriptor with a daemon-side line framer that has a byte cap and parses inside `try`/`catch` (the transport adapter of spec §2.2).

## Project trust

pap uses the shared Pi agent directory (decision 24), so `trust.json` is the one the `pi` CLI uses (S7). The SDK's own default is fail open (`projectTrusted: true`, and `reload()` never asks again), so the worker decides:

- `SettingsManager.create(cwd, agentDir, { projectTrusted: false })`, and the trust resolver is always installed, not only when the project has trust-requiring files at open. An extension that appears later (`git pull`, the model's `write`) is not loaded by a reload.
- The project is trusted only when `ProjectTrustStore.get(cwd)` returns `true`. A missing decision, an explicit `false`, a corrupt or wrongly shaped file, a held lock and an unwritable agent directory all mean untrusted. A store failure does not reject the session open; it is reported once as an `extension_error` for `<pap:project-trust>`.
- pap does not read `defaultProjectTrust` or the `project_trust` extension event, which the CLI honours. Trusting a project from pap's UI comes with roadmap M7.

## `extension_ui_closed` (worker → daemon)

`extension_ui_closed{id}`: when Pi resolves a dialog on its own (extension timeout or abort signal), the daemon must remove the card. pi-web already used this record.

## Consequences

- The Task 22 worker environment must set `PI_CODING_AGENT_DIR`, and every `init` it sends must carry `papHome`. It sets `PAP_TEST_PROVIDER=1` only under test (when `PAP_TEST_PROVIDER_SCRIPT` is set).
- A worker cannot run without `pap-policy`: `movePolicyLast` makes session creation fail when the policy extension did not load, and the policy stays last after `reload()`, after trust is granted and after Pi's built-in extensions load.
- The daemon's request timeouts are per command. A `prompt` has none by default: an extension command is answered only when it ends, possibly after a dialog that takes minutes, so Task 22 must not treat a long wait as a failure and relays `custom_input` independently (R38). Every other command defaults to 30 s and rejects with the `timeout` error code, which is distinct from `worker_failed` (the worker is gone).
- `outputTail()` is 8 KiB; Task 22 clips it to 2 KB before it logs it (R66).
