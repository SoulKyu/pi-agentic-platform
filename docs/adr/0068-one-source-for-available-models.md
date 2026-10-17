# ADR 0068: one source for the models a context may use

Status: accepted (models batch, chain A)
Date: 2026-10-17
Spec: M7 (Settings › Models), spec C section on sessions. ADR 0023 (Pi's configuration is read in a helper), ADR 0026 (`models.json` writes). Rulings: MPR1 to MPR6, MPR21, MPR25, MPR-C2, MPR-C6 in `docs/research/models-batch-rulings.md`.

## Decision

One function decides which models a context may use: `listAvailable(runtime, patterns, sessionScope?)` in `packages/pi-host/src/available-models.ts`. The session's scope wins; otherwise the models `enabledModels` resolves to (Pi's `resolveModelScopeWithDiagnostics`) when that is non-empty; otherwise everything the runtime says is available (a provider with a key). Patterns that match only unsigned providers fall back to the signed-in list, so a picker is never empty because of a stale pattern.

It has two callers:

- The worker (`sessions.models`, `sessions.setModel`) calls `freshAvailable`: when the session is idle it re-reads `settings.json` and `models.json` (`settings.reload()`, `runtime.refresh({ allowNetwork: false })`, both offline) before it lists, so a warm worker sees what the owner changed a minute ago and not what it read at start (MPR25). A running session lists from the snapshot its run started with; a model switch is refused during a run anyway.
- The helper op `models.available` (`pi:read`, `cwd` optional with the project check) serves every picker that has no session: the agent form and the new-lane dialog. It opens Pi's `ModelRuntime` over pap's own credential store (`createAuthFileStore`, as `auth.login` does), with `refreshOnCreate: false` and no model network, then makes the same offline `refresh` as the worker (MPR-C2) and calls `listAvailable`. No `!command` is run, no request is made (MC25, MPR2). The answer is `ModelSummary` rows, provider names and the origin (`scope` or `signed-in`), cut at 2000 models, 300 providers and 600 000 bytes (`truncated`); nothing secret.

The daemon puts a cache in front of the op (`modules/models/available.ts`): 10 s TTL per `cwd`, 32 keys, single flight, and a generation counter so a read that started before a write never stores its result. The writes of the models service clear it (`setEnabled`, the defaults, `config.save`, `refreshCatalog`, `setApiKey`, `logout`, a login's `onSignedIn`); MCP and trust writes do not, and show when the TTL ends. The `cwd` check runs before the cache is asked (user A filling a folder never answers user B).

Pickers read `models.available` or `sessions.models` and nothing else; a source scan fails when a file outside `features/models/` calls `models.overview` to build choices. `models.overview` stays for Settings (the switches, the defaults, the first-run step).

## Alternatives rejected

- **The daemon asks a live worker.** A cold project would fork a worker only to open a form: a start costs seconds and a capacity slot, and the form would fail with `capacity` when workers are full. The helper pool is cheap and short-lived.
- **Filter the overview on the client.** The overview's `enabled` flag means "not switched off, among all models", not "usable now": it says nothing about sign-in, and it is another list that can drift from the worker's.
- **A helper over Pi's default credential store.** Pi's own store resolves a stored `!command` when it reads a credential. A picker that opens would then run the owner's secret manager. pap's store returns what is stored without resolving it.

## Consequences

- **Same list, two stated conditions.** "Exactly the models Pi would let that context use" holds when the worker re-reads before it lists (above) and no provider's key is a `!command`. The worker's default store resolves such a key, so the provider is offered by both lists and may fail when used; the helper reports it configured without running it. The picker footnote says so.
- **Extension models appear only in a session's menu.** The helper loads no extension (MPR17); a no-session picker cannot list them. The footnote says so, and Settings shows them in a read-only list on a click.
- **The cache.** A change made outside pap's writes (a hand edit, the `pi` CLI, a trust change in the `trust` module) shows when the 10 s TTL ends. A helper killed mid-write by a deadline or a cancel may land its file after the cache was cleared: the answer lags by at most one TTL. Worst case memory: 32 keys of at most 600 000 bytes, about 19 MB.
- **The expired OAuth probe (task 2).** A stored OAuth credential whose access token expired neither refreshes nor blocks the answer: the network guard stayed empty, the provider is listed, and no token appears in the result (`available.oauth-expired.no-network`, run without `PI_OFFLINE` since the fix round). The "treat OAuth providers by pap's file facts" branch was therefore not needed.
- **Pi's one write.** The offline refresh creates `models-store.json` when that file is missing, before Pi takes its lock (the worker's refresh does the same), and otherwise only reads it. The op writes no other file.
- **A stored saved choice that is no longer offered** stays visible in the picker as "saved, no longer offered", first model row after Pi's default (MPR5, MPR-C6). No run-start check exists in this batch: the run fails with Pi's own error, as before.
- **Backups.** M6b leaves `models.json`, `auth.json` and `settings.json` out of the backup; after a restore the providers, the selection and the keys are set again (`docs/agents/models.md`).
