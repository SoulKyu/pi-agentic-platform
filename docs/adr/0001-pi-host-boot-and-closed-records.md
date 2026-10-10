# ADR 0001 — the `init` and `extension_ui_closed` records of the daemon ⇄ pi-host protocol

Status: accepted · Date: 2026-10-10 · Spec: C §2.3 (as amended by decision 34)

Spec C §2.3, as amended by decision 34, lists `init{…}` as the first daemon → worker record and `extension_ui_closed{id}` as a worker → daemon record, and defers both to this ADR. The earlier draft of the table had neither. This ADR fixes their fields and the worker's behaviour around them.

## `init` (daemon → worker, always the first record)

`init{cwd, agentDir, papHome, sessionFile?, policy, testProviderScript?}`

- The worker needs its session file, directories and policy before it can send `ready`. The environment would leak them into every `bash` child, and argv would show them in `ps`, so they travel in a record. `policy` is the "rules sent at worker boot" of §5.1; `policy_update{rules}` stays the hot-reload path.
- `cwd`, `agentDir` and `papHome` are absolute paths, checked by the contract. `agentDir` (the Pi agent directory) and `papHome` (the pap data directory, `$PAP_HOME`) are the two roots `pap-policy` protects: an edit under either asks, and a session directory that contains either gets no automatic edits. A relative path would be resolved against the worker's own working directory and protect the wrong place, so `papHome` is required, not optional.
- Fail fast, never wait: a malformed `init` or a `policy` that `PolicyRules` rejects makes the worker print the reason on stderr and exit with code 70 before it opens a session. The daemon sees a worker that failed to start, not one that is silent. A later `policy_update` with invalid rules keeps the previous rules and is reported as an `extension_error` for `<inline:pap-policy>`.
- Records that arrive between `init` and `ready` are queued and handled, in order, right after `ready`. A `shutdown` is never queued. A malformed command that carries an `id` gets a failed `response`; a malformed `extension_ui_response` cancels its dialog.
- `testProviderScript` exists only for tests: the daemon sends it when `PAP_TEST_PROVIDER_SCRIPT` is set and logs a warning at boot.

## Worker environment

Pi derives its session directory from `PI_CODING_AGENT_DIR`, not from the `agentDir` it is handed. The worker environment built in Task 22 sets `PI_CODING_AGENT_DIR` to the same directory as `init.agentDir`, and the worker refuses to start when the two differ: a mismatch would write sessions where the init record does not say. `HOME` must be the user's home, because Pi reads user-level skills from it and the policy judges "the home directory" by it.

## Project trust

pap uses the shared Pi agent directory (decision 24), so `trust.json` is the one the `pi` CLI uses (S7). The SDK's own default is fail open (`projectTrusted: true`, and `reload()` never asks again), so the worker decides:

- `SettingsManager.create(cwd, agentDir, { projectTrusted: false })`, and the trust resolver is always installed, not only when the project has trust-requiring files at open. An extension that appears later (`git pull`, the model's `write`) is not loaded by a reload.
- The project is trusted only when `ProjectTrustStore.get(cwd)` returns `true`. A missing decision, an explicit `false`, a corrupt or wrongly shaped file, a held lock and an unwritable agent directory all mean untrusted. A store failure does not reject the session open; it is reported once as an `extension_error` for `<pap:project-trust>`.
- pap does not read `defaultProjectTrust` or the `project_trust` extension event, which the CLI honours. Trusting a project from pap's UI comes with roadmap M7.

## `extension_ui_closed` (worker → daemon)

`extension_ui_closed{id}`: when Pi resolves a dialog on its own (extension timeout or abort signal), the daemon must remove the card. pi-web already used this record.

## Consequences

- The Task 22 worker environment must set `PI_CODING_AGENT_DIR`, and every `init` it sends must carry `papHome`.
- A worker cannot run without `pap-policy`: `movePolicyLast` makes session creation fail when the policy extension did not load, and the policy stays last after `reload()`, after trust is granted and after Pi's built-in extensions load.
