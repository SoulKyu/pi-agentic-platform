# ADR 0029 — Some Pi settings are written by Pi's SettingsManager, behind pap's queue and guard

Status: accepted · Date: 2026-10-14 · Spec: C §1.4 (one writer), deviation from ADR 0023's "every write goes through `writePiFile`" · Rulings: M7R40b, M7R48, MC28, MC29

## Context

pap writes Pi's configuration only in a helper, from Settings, with the file boundary of `pi-file.ts` (`writePiFile`: a temp file beside the real one, mode 0600, a rename, links confined to the agent directory and the home, a file with another hard link refused). For `settings.json` that is not always the right tool. The keys pap edits for models (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `enabledModels`) are shared with the `pi` CLI, which holds a lock folder around its own read-modify-write and merges field by field. A whole-file rename from pap would drop a key the CLI wrote between pap's read and its rename, and would ignore the lock.

## Decision

- The model defaults and `enabledModels` are written with Pi's own `SettingsManager` setters (`models-defaults.ts`, `enabled-models.ts`, and the resync after a `models.json` save in `models-json.ts`): Pi's lock, a field-level merge, and the file written in place (not atomic). After a write the helper flushes and reads `drainErrors()`; a write that failed is read back, never assumed.
- Immediately before each such write the helper runs `guardSettingsWrite` (`helper/ops/models-open.ts:29`): the read-time guard again (real path inside the agent directory or the home, a regular file, at most 1 MiB, no FIFO) and the write-time rule of `writePiFile`, a file with another hard link is refused (`config_path_refused`, reason `hard-link`).
- The daemon serialises every Pi settings write: one chain for the daemon's one agent directory (`kernel/pi-write-queue.ts`, created in `compose-pi.ts:60`), at most 8 writes in flight or waiting, then `capacity` (MC28, MC29). The models service and the MCP service share it. Reads are not queued. The trust service has its own queue because `trust.json` is a different file with Pi's own store and lock.
- The code mode keys (`defaultTools`, `codemode.mode`, `codemode.inlineBudget`, `mcp.setCodemode`) have no `SettingsManager` setter. They are edited in `ops/codemode-settings.ts` and written with `writePiFile` through the same queue.

## Consequences

- Residual: a same-user process can swap the file for a link, or add a hard link, between `guardSettingsWrite` and Pi's write. A same-user process can write the file directly anyway; this matters once the M11 sandbox exists.
- A `settings.json` write is not atomic: a crash in Pi's write can leave a partial file, which the next read reports as `config_invalid` and pap never writes over.
- A project that decides the same key (`.pi/settings.json`) makes pap refuse with `project_scope` instead of writing a value that would not apply.
- Another milestone's writer to Pi's `settings.json` takes the same queue (MC29) and must say here if it uses neither `SettingsManager` nor `writePiFile`.
