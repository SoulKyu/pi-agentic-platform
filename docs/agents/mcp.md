# MCP (Settings › MCP, the session's MCP tools)

Code: `apps/daemon/src/modules/mcp/` (`service.ts`, `undo.ts`, `test-results.ts`), helper ops `packages/pi-host/src/helper/ops/mcp-{read,write,test}.ts` and `codemode-settings.ts`, file reader `helper/mcp-file.ts`, masking `helper/mask.ts`, worker side `packages/pi-host/src/builtins.ts`, web `apps/web/src/features/mcp/` (see `web.md`). Contracts: `packages/contracts/src/mcp-methods.ts`. ADRs 0023, 0025, 0027. Rulings: `docs/research/m7-rulings.md`. Policy for MCP tools in a session: `policy.md`.

## In a session

- The worker registers Pi's `mcp`, `codemode` and `tool-search` extensions as `builtin:mcp`, `builtin:codemode` and `builtin:tool-search`, replaceable (`builtins.ts`); `chat` sessions get none of them (ADR 0028). Codemode runs with `models: false` (owner m11): scripts cannot call classifier or image models. Servers come from `<agentDir>/mcp.json` and, only when the project's trust decision is `true`, from `<project>/.pi/mcp.json` (`host.builtins.int.test.ts`: an untrusted project's server never starts).
- Judgement, fencing and taint of MCP calls are M5's pipeline, exercised through a real daemon worker by `security/mcp-taint.int.test.ts` and `codemode-nested.int.test.ts` (`policy.md`).
- OAuth sign-in is Pi's `/mcp` in a session (owner m6, M7R139). Settings shows the file state and the last Test (`needs-sign-in`); the sign-in itself needs a session open.

## Methods (all `pi:admin`: browser sessions only, never a token, MC38)

- `mcp.overview { cwd? }` reads the global file and, for a trusted project, the project file, in a helper (`ops/mcp-read.ts`). Files only: nothing is started, no `${VAR}` or `!command` is resolved (ADR 0025). The answer holds masked views, `codemode` and `settings` (the code mode keys of the global `settings.json`), `codemodeBuiltinOff` (Pi's settings list `-builtin:codemode`, `contracts/src/mcp-methods.ts:99`) and each server's `lastTest`. Limits: 200 servers per file, a view of at most 400 000 bytes.
- Writes: `mcp.setEnabled` (a list, one result row per server), `mcp.setExposure`, `mcp.setInProject` (a project's `{ enabled }` override of a global server), `mcp.remove`, `mcp.undo`, `mcp.add { scope, name, entry }`, `mcp.setCodemode`. The browser parses what the owner pastes (M7R101, `features/mcp/import.ts`); the daemon gets a validated entry, never a command line to parse.
- Step-up (password, 5 minutes): global `mcp.add`, global `mcp.undo` and every `mcp.test` (`service.ts:170`, `:198`, `:209`). Switches, exposure, removals and project overrides never ask (M7R133).
- A project target needs the "Save anyway?" confirmation: `confirmProtected: true`, else `protected_path`; no `cwd` is `bad_request` (`service.ts:91`). The `cwd` must be a folder the caller has a project in (`invalid_cwd`). The helper repeats the confirmation and the trust check, so a helper run never depends on the daemon's.
- All writes go through the shared Pi write queue (`kernel/pi-write-queue.ts`, MC29) and then the helper: a file is read, one entry edited, and written with `writePiFile` (temp file, rename; the global file keeps 0600, a new project file 0644).
- `mcp.add` lists `sensitiveParams: ["scope", "name", "cwd"]` (`mcp-methods.ts:266`): the receipt hashes the target, not the entry, which may carry literal env and header values.

## Undo

- `mcp.remove` answers a token and `expiresInMs` (60 s, `undo.ts:5`). The removed entry text stays in daemon memory only (never sent, never logged) and is forgotten at expiry by a `Clock` timer or at restart. At most 100 pending per owner: a full list refuses the removal with `limit_reached` before the file is touched. `mcp.undo` writes the entry back at its old position; a failed write keeps the record. Another owner's token is `not_found`.

## Test (`mcp.test`)

- Runs the server the file names in a throwaway in-memory Pi session inside a helper, waits `TEST_DEADLINE_MS` (20 s) plus a 15 s margin for the helper (`service.ts:25`). Answer: a state (`connected`, `needs-sign-in`, `failed`, `timeout`), up to 200 tool names (each clipped to 128), `toolsTruncated` and a masked message of at most 512 characters. Never the server's stderr. An untrusted project's server answers `forbidden`.
- The server's environment is the worker's: the daemon's environment without `PAP_*`, `NODE_OPTIONS` and service-manager variables, so `${VAR}` resolves as in a session (`mcp-test.int.test.ts`).
- The daemon keeps `{ at, state, count, truncated }` per server for the overview, in memory, at most 400 per owner (`test-results.ts:4`), keyed by scope, name and (for a project) its folder. A removal during a Test makes that Test's result stale and it is not kept. The `mcp.test` receipt holds the masked message and the tool names: masked like every MCP view, behind `pi:admin`, purged with the receipts (MC45, accepted).
- The helper reuses the worker's `installSignalCleanup()` and `killDetachedDescendants()`: a stdio server that ignores SIGTERM is gone when the helper stops, and `stopAll()` during a Test leaves none (`helper/main.ts:14`, `:25`; `mcp-test.cleanup.int.test.ts`).

## Code mode block

- `mcp.setCodemode { choice?, mode?, inlineBudget? }` writes the global `settings.json` through the shared queue (`ops/codemode-settings.ts`). "Automatic" removes every `defaultTools` entry naming codemode, and when that empties the list the key itself is removed (an empty list would mean no tools, MC44 M7). "Always on" makes `+codemode` the entry unless the list already enables it. `codemode.mode` and `codemode.inlineBudget` are the other keys.
- The `-builtin:codemode` block reads the global `settings.json` only (MC46). The pane disables "Always on" with a visible reason while `codemodeBuiltinOff` is true. The sandbox half of the block is deferred to M11, which brings the sandbox.
- `mcp.setCodemode` holds Pi's `settings.json.lock` folder (the `auth-store.ts` `acquire`, stale after 30 s) around the read, the edit and the rename, so the `pi` CLI and workers do not lose each other's write (MC59).

## Dotfiles latitude (owner m13, M7R146)

- The global `mcp.json` may be a symlink anywhere inside `$HOME` (`ops/mcp-read.ts:105`, `mcp-write.ts:63`: roots `[agentDir, home]`). Only a process of the same user can plant the link, and it can already write the target. A link out of both roots, a dangling link, a FIFO, a non-file or a file over 1 MiB is a `problem` (read) or `config_path_refused` (write). A project's `.pi/mcp.json` must stay inside the session folder's real path.

## Residuals (MC44)

- Names that are canonical integers (`"1"`) sort first in a JS object, so such a server moves to the top of the file on a rewrite.
- Duplicate keys in the file collapse to the last on rewrite (`JSON.parse` semantics).
- A compact or CRLF file is rewritten with its first indent (two spaces when there is none, at most 10 characters) and LF line ends (`helper/mcp-file.ts:106`).
- A `timeout` on `mcp.remove` can leave no undo record: the outcome is unknown and the file may be written.
- The `pi` CLI can write `mcp.json` between pap's read and rename; the rename wins. Writes within pap are serialised.
- A group switch writes file by file: a failed file marks only its rows `ok: false` with code `write_failed`, rows already written stay `ok: true`.
- No audit line is written for `mcp.add` or `mcp.undo` (not a spec requirement; an option for the owner).
