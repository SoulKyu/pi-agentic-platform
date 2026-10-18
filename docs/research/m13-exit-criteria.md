# M13 exit criteria: the evidence

The four exit criteria of spec A (`docs/specs/2026-10-10-A-product-scope.md`), each with the command or test that proves it and the result recorded in the M13 ledger. Results were measured by the controller on the unified join branch unless a cell says otherwise. Nothing here claims that GitHub CI is green: the first GitHub run of the new jobs (`e2e`, the sandbox provisioning, the typecheck build fix) is part of the release runbook (`docs/agents/release.md`, step 3).

## 1. Crash isolation

A crashing, hung or killed worker does not take the daemon or another session down.

| Evidence | What it proves | Result |
| --- | --- | --- |
| `apps/daemon/src/modules/sessions/sessions.crash.int.test.ts` | extensions that throw, a killed worker with open cards and queued steers (everything clears, the daemon and the other sessions carry on), a relaunch on the next prompt, a worker whose `session_shutdown` never finishes | green in `pnpm test:int` |
| `apps/daemon/src/modules/sessions/sessions.crash.oom.int.test.ts` | the scope's limit killing a command keeps the session; the limit killing the worker is reported as out of memory | green in `pnpm test:int` |
| `apps/daemon/src/modules/sessions/sessions.crash.flood.int.test.ts` | a flood of dialogs and decorations is capped while the daemon answers other sessions | green in `pnpm test:int` |
| `apps/daemon/src/kernel/supervisor/scope.int.test.ts` | the worker scope: `MemoryMax`, reaping of the worker's process groups, the out-of-memory classification, a forced exit; skipped locally without a user manager, required in CI | green in `pnpm test:int` |
| `apps/daemon/src/daemon.int.test.ts` | the daemon end to end; `daemon.boot.int.test.ts` pins the stop order with a real worker | green in `pnpm test:int` |
| `apps/daemon/src/modules/sessions/sessions.crash.hard.int.test.ts` (task B3, M13R51) | `process.exit(7)`, `process.abort()` and `kill -9` of a worker, each while a second session streams: the second stream is gapless across the death | green; SIGKILL hits an active run; 3 runs in a row green; the mutation that breaks the assertion is red |
| `pnpm test:int` on the join (`6ba3ff83`) | all of the above together | 241 files green |

Limit (B3 re-review): frames in flight at the exact instant of the exit are not exercised, because the parked second session streams nothing at that moment.

## 2. Boundaries and the 400-line rule

| Evidence | What it proves | Result |
| --- | --- | --- |
| `eslint/pap-plugin.test.js`, "rejects a file over 400 lines" and "accepts a file of exactly 400 lines" | the line rule is exact | green in `pnpm test:unit` |
| `eslint/pap-plugin.test.js`, "module boundaries" | a module imports only `@pap/contracts`, `kernel/` and other modules' `index.ts` | green in `pnpm test:unit` |
| `scripts/source-guards.test.ts` | no real source file is over 400 lines and no file carries an ESLint inline config; the guard catches a 401-line file and a comment that switches the rule off | green in `pnpm test:unit` |
| CJ2, controller demonstration in a scratch worktree from `main` (removed afterwards) | a deliberate violation fails the real lint | a 401-line file: `max-lines: File has too many lines (401). Maximum allowed is 400`; an import of `../sessions/service.ts` from `modules/files`: `boundaries/entry-point: No rule allows the entry point service.ts in dependencies of type module with domain sessions`; `eslint` exit code 1 |

## 3. One-step install by a stranger

| Evidence | What it proves | Result |
| --- | --- | --- |
| M6b Appendix A, `docs/research/m6b-final-review.md` (steps 1 to 11, 2026-10-17) | install, taken port, update, rollback, cut update, backup and restore, doctor, container and npm on a real host | recorded there with the defects it found and their fixes (D1 to D3 for npm) |
| `pnpm smoke:install` | the unit's own command line boots | green on the join |
| CJ3, controller, join `95af1a19` | the archive installer on a clean user: `pnpm build:archive` rc 0; `./pap-install-<id>.sh --port 7791 --home ~/.pap-m13-try --bin-dir ~/.pap-m13-try/bin` rc 0 in 7 s; healthz 200; listening on `127.0.0.1:7791` only; `pap service url` prints the setup URL; `pap doctor` rc 0 with no fail and no warn; `pap service uninstall` ok; the try home, `~/.local/share/pap` and the unit removed; the preview untouched | PASS |
| CB6, controller, online, 2026-10-18 (ADR 0073) | the npm tarball with the shrinkwrap: the `(path, version, resolved, integrity)` tuples are identical (175 = 175, 0 diff) after `npm install --package-lock-only`; `npm ci --dry-run` rc 0; `npm install -g` of the packed tarball rc 0 with 0 empty folders and node-pty compiled; all `@earendil-works` packages at 1.1.0; `@pap/*` `inBundle` with `dist`; `npm ls --omit=dev` shows only unmet optional dependencies (esbuild platforms, ws `bufferutil` and `utf-8-validate`); the installed pap: `doctor` ok, `serve` healthz 200, `models.config.get` ok, `sessions.create` ok | ACCEPTED |
| Container, M6b Appendix A step 9 | `scripts/pap-container.sh build` rc 0 in 165 s, image 619 MB; healthz 200 on the published port; a file written from the container lands as the host user; `doctor --only bwrap` ok in the container, and a warn naming the fix without `systempaths=unconfined`; no credential in the image | recorded in `m6b-final-review.md`, section "9 OCI image" |
| `pnpm release:check` and `pnpm build:npm` on the join | the release gate (licence, shrinkwrap, pre-flip shapes) and the package build | ok; `build:npm` ships `LICENSE` and the licence `AGPL-3.0-or-later` |

Not proved by these: a real GitHub release, `curl | sh` and `npm publish` have not run; they wait for the v1 flip (`docs/agents/release.md`, ADR 0076).

## 4. Feature parity with pi-web

| Evidence | What it proves | Result |
| --- | --- | --- |
| `docs/agents/parity.md` (task P3) | one row per pi-web behaviour, each with a proof file and a verdict | 197 rows (160 in `parity.md`, 37 in `models.md`): 186 green, 8 after v1 (each with the owner's decision), 3 dropped by the owner. The one finding of P3's first pass (the codemode card) was built in M13 by task C9 and is green (P01-17) |
| `scripts/parity-doc.test.ts` | a row with a missing proof file, an unknown verdict or a `gap` fails the unit run | green in `pnpm test:unit` |
| `pnpm test:e2e` on the join (`6ba3ff83`, container mode, Chromium and WebKit) | fifteen journeys J01 to J15 drive the built app | 36 passed, 2 skipped by design (J13 on WebKit), 4.4 minutes (budget 15) |

## The whole gate on the join

On `6ba3ff83` (all three chains, F1 and the sweeps P1a, P1b, P2a): unit 20659 tests, integration 241 files, `pnpm budgets`, `pnpm test:budget`, `pnpm smoke`, `pnpm smoke:install`, `pnpm release:check`, `pnpm build:npm` and the e2e run above, all green. The lint, format, typecheck and knip steps are rerun on the join head by task J1b.
