# M2 final review (archived 2026-10-12)

Opus whole-branch review of M2, copied verbatim from the git-ignored SDD workspace. Items marked Carry feed M3 P1–P7 (done) and M4. Ledger: [m2-sdd-ledger.md](m2-sdd-ledger.md).

# M2 final whole-branch review — feat/m2-sessions `f765f2a..14a8878`

Reviewer: Opus (final, per X2). Read-only on the worktree; every build, mutation and merge ran in scratch copies under `/tmp/claude-1000/` (deleted afterwards).

## Verdict

**Approve for merge after one small fix (I1). Strongly recommended in the same batch: M1, M2, M10.** No Critical findings.

- All six exit criteria are met. Every test the plan names exists and passes, and the gate is green locally (details below). CI cannot be run from this host. The user-manager step is in `ci.yml` and `pi-compat.yml`.
- The security seams hold across tasks:
  - The approval channel fails closed on every path.
  - Grant stamping and coalesced pushes survive the add/revoke races.
  - No worker or Pi error text reaches a client, except the assistant's own `errorMessage` (ruled).
  - Untrusted text is clipped and rendered as React text. There are no HTML sinks and no `style` props.
  - The export is `sandbox` + attachment and never runs on the pap origin.
  - Fork and clone only read a private copy.
  - Every method checks the owner.
  - No path is built from client input. One exception: `policy.listRules{cwd}` only `stat`s the path.
- The known OOM flake has a root cause and a verified fix (I1). It is not a timeout problem and not host memory pressure: the kernel picks its victim on a margin of about 1.6 MB.
- I2 and I3 belong on the M3 rebase checklist. They do not block M2's own merge. The trial merge shows the conflict tables miss four items that turn the merged gate red, plus one behaviour regression.
- Strengths:
  - The live-session split (run, ui, commands, idle) keeps one owner per piece of state.
  - All in-flight counters settle on both paths.
  - Every timer is on the kernel `Clock` and is cleared at exit.
  - Byte budgets are measured in JSON bytes everywhere.
  - The merged bundle grows by only about 0.6 KB of initial weight.

Counts: **Critical 0 · Important 3 · Minor 10**.

## Gate results

Commands ran from a `cp -a` copy (`.git` removed) with pnpm from the worktree shim. `test:int` ran in `env -i HOME PATH LANG=C.UTF-8 CI=1 XDG_RUNTIME_DIR`.

| Run | Step | Result |
|---|---|---|
| A | lint / format:check / typecheck / knip | pass (7 s / 5 s / 8 s / 2 s) |
| A | test:unit | 2614/2616: 2 `scripts/source-guards.test.ts` cases call `git ls-files` and the copy had no `.git` (environment artefact) |
| A | test:int #1 | 266/272: 6 `host.probes.int.test.ts` cases, "fd is not installed". My clean PATH lacked `~/.local/bin`, and under `CI=1` a probe may not skip (by design; environment artefact) |
| A | build / budgets / smoke | pass. Budgets **160.3 / 180 KB**. Smoke ok (1 worker gone at SIGTERM) |
| A | test:int #2 (after build + smoke) | same 6 `fd` cases |
| B | test:unit (copy given its own `git init` snapshot of the same 692 tracked files) | **2616/2616** (217 files) |
| B | test:int #3, full PATH | **271/272**: `main.int.test.ts` "prints the setup address…" got exit code `null`. That is a SIGTERM before the handlers exist, a pre-existing M1 race (Minor M1) |
| B | build / budgets / smoke | pass (160.3 / 180) |
| B | test:int #4 (right after build + smoke) | **272/272** (46 files). The OOM file ran its 2 cases in 2.9 s |
| C | OOM probe: the command-OOM case 8× as is, then 6× with the I1 fix | 14/14 green. The kernel log shows the victim each time (see I1) |

## Critical

None.

## Important

### I1 — OOM test flake: the cgroup OOM killer sometimes picks the worker, not the hog

- **Where:** `apps/daemon/src/modules/sessions/sessions.crash.oom.int.test.ts:22-36`, `apps/daemon/src/modules/sessions/testing/extensions.ts:106-107`.
- **Cause, with evidence:**
  - pi-host sets `oom_score_adj = 800` on itself (`packages/pi-host/src/watchdog.ts:12`). The bash tool's children inherit it, so inside the 256 MiB scope the kernel compares raw RSS plus page tables.
  - Measured worker: RSS ≈ 172 MB (anon 113 + file 59), cgroup charge ≈ 120 MB.
  - The hog can only reach about 140 MB anon + 35 MB file before the limit. The two scores sit within about 1 %.
  - `journalctl -k` (the adm group can read it): 28 command-OOM events since 2026-10-11. In one, at 2026-10-12 05:27:54, the victim was the **worker**: `pid 2142673 total-vm:9992448kB anon-rss:116020kB pgtables:3324kB` scored 44 710 pages against the hog's 44 302. The hog was killed later.
  - With the worker dead, the session goes `cold`, `waitFor(idle, 30_000)` never matches, and the test fails with "not yet" at 31 s. That is exactly the Task 30 failure.
- **Ruled out:** not the timeout bound (a normal pass takes about 1.7 s) and not hog pacing. Host state only moves the ±5 MB of cgroup charge that flips a 1.6 MB margin.
- **Fix (test-only, verified 6/6, kernel log shows `oom_score_adj:1000` on every victim):**
  1. The hog raises its own score:
     `node -e "require('fs').writeFileSync('/proc/self/oom_score_adj','1000');const k=[];…"`.
     That adds 0.2 × 65 536 pages ≈ 51 MB to the hog's side, about 30× the observed spread.
  2. Make the failure explicit and fast: wait for `status` `idle` **or** `cold`, then `expect(settled).toEqual({kind:"status",status:"idle"})` and `expect(bed.exits).toEqual([])`.
  3. Optional extra margin: `LIMITS.memoryMaxMb` 512 with `CEILING_MB` 1024.

  CI must run this test (owner M2-Q8), so a ~1-in-30 red is a gate defect.

### I2 — The trial merge turns the gate red on four items missing from both conflict tables

Details are under "Merge readiness" below. M3's rebase has to handle all four in the same commit as the conflict resolution:

- (a) M2 made `SessionSummary.name` required (`packages/contracts/src/streams.ts:224-232`). M3's shell fixtures no longer compile: `apps/web/src/routes/shell/{TabBar.test.tsx:42, item-title.test.ts:7, palette-items.test.ts:11, session-groups.test.ts:9,17,22}`, 9 TS errors in total.
  - M3's labels ignore names: `item-title.ts:11`, `palette-items.ts:68`, `session-groups.ts:29` use `basename(cwd)`. A renamed or auto-named session keeps showing its folder in tabs and the palette.
  - Fix: add `name: null` to the fixtures. Labels become `session.name ?? basename(cwd)`, rendered as text (already clipped by `nameOf`).
- (b) M2 tests assert M1 Button classes, which M3's restyled `Button` no longer emits:
  - `apps/web/src/features/sessions/Composer.test.tsx:102-111` (`bg-human-fill`, `bg-panel`)
  - `apps/web/src/features/sessions/dialogs/ApprovalDialog.test.tsx:77-81` (`bg-human-fill`)

  The merged run is 3410/3412. P1 is too late: fix at the rebase with M3's names (`bg-you-fill` and the secondary class), like rule 5 does for `SessionScreen.test.tsx`.
- (c) `apps/web/src/i18n/i18n.test.ts` is a modify/delete conflict: M3 moved it to `i18n.test.tsx`. M2's `plural()` test (`sessions.queue.more`, en and fr) must move into M3's file. `plural` and `tp` survive the auto-merge of `i18n/index.ts` (merged line 124).
- (d) P4 ("server texts by code") lists, at planning time, only `live-run`, `live-ui`, `notices` and `exit.ts`. Since then M2 also emits fixed English notices from:
  - `grants.ts:21-23,120`
  - `panels.ts:7`
  - `service-commands.ts:93-99`
  - `live-session.ts:104`
  - `live-ui.ts:27-32,202`
  - `notices.ts:37-40`

  Give P4 the full list.

### I3 — After the merge, Escape in an extension input/editor dialog (or an approval card) stops the run

- **Where:** M3 `features/commands/defaults.ts` (merged lines 60-64) maps `escape` to `session.stop` when `sessionFocus && !panelFocus && !overlayOpen && !dialogOpen && !paletteOpen`.
  - `dialogOpen` only sees `[data-pap-modal][data-state=open]`.
  - M2's cards are inline: `dialogs/ExtensionCard.tsx:33-37` (`role=group`), `dialogs/TextDialog.tsx:28-41` (no Escape handling), `dialogs/ApprovalDialog.tsx:47` (`role=alertdialog`).
  - The dispatcher listens on `window` in the capture phase, so a component's `stopPropagation` cannot help.
- **Effect:** a person pressing Escape to dismiss an extension's `input` stops the agent. The pi TUI cancels the dialog instead. The existing post-merge carry covers only the rename field (`[data-inline-edit]`).
- **Fix:**
  - M2, cheap, pre-merge: put `data-inline-edit` on the ExtensionCard and ApprovalDialog roots.
  - M3 P3/P7: the `inlineEditFocus` key (`active.closest("[data-inline-edit]")`) goes into the escape rule. A focused dialog card answers Escape as `{cancelled:true}`, never `session.stop`.
  - Add a shell test: Escape in an input dialog cancels the dialog, and the run continues.

## Minor

- **M1 — The daemon can die of SIGTERM in its startup window (pre-existing M1 race, seen 1 in 4 int runs).**
  - Where: `apps/daemon/src/main.ts:59-76`, `apps/daemon/src/daemon.ts:201-206`. `createDaemon` announces `setup_url` before `main.ts` installs `watchSignals`.
  - `main.int.test.ts:104-105` kills on that line and sometimes gets `code: null`.
  - Fix: `createDaemon` returns `setupUrl` (it already does) and `main.ts` announces it right after `watchSignals`. Alternatively, install the signal handlers before `createDaemon`, with a shutdown that waits for the handle.
- **M2 — Docs: stale or wrong claims (spot-checked 14, these 8 are off).**
  - `docs/agents/sessions.md:32`, "No sessions method can answer `timeout`": false. `clearQueue`, `rename`, `autoName` and `exportHtml` can (`methods.ts:95,133,142,154`; `worker-io.ts:20-28`).
  - `sessions.md:45`, "dialogs first (oldest first)": since Task 13a approvals come first, then decorations, panels, partial and rows (`snapshot.ts:126-188`).
  - `sessions.md:60`, "the other three mutations": there are 13 now.
  - ADR 0008 (`docs/adr/0008-pap-records-added-in-m2.md:16`) does not list the `leaf{leafId, resync?}` worker record added in Task 10b (`packages/contracts/src/pi-host.ts`, `PapRecord`).
  - `docs/agents/daemon.md:9`: the forced exit is now `forceKill` (worker groups **and** `killAllNow` of the home slice), not `killAllWorkerGroups()` alone.
  - `daemon.md:64`, "migrated before sessions": only `session_name` sorts after `policy`; `202610100200_sessions.sql` sorts before it.
  - `AGENTS.md:16`, "the scope tests … fail without it": they fail only under `CI=1`. Locally they skip with a warning (`scope.int.test.ts:35-38`, `real-scopes.ts:29-32`).
  - Plan merge note 1 and file map (`docs/plans/2026-10-11-m2-sessions-core.md:153, 9893`) still name `202610110000_session_name.sql`. The real stamp is `…0200`.
  - Checked and correct: ADR 0009's `>32 MiB → capacity` (`forks.ts:53-56`, `methods.ts:166`); ADR 0006 headers, TTL and pending cap; ADR 0007 constants (4096/128 walk, 64/32 MiB); `UI_LIMITS`; the throttle (50 ms, 64 keys); notices (10 per 10 s, ring of 20); panels (4, 64 closed ids); exports (16, 10 min); `PAGE_BYTES` 900 000; R113 5 s; idle 30 min / 8 h; worker env defaults (`config.ts:150-166`, `scope.ts:62`).
- **M3 — Two pap notices bypass the snapshot ring and the coalescer flush.**
  - Where: `grants.ts:120` (`tellSessionOnly`) and `service-commands.ts:93-99` (`reloadNotice`) publish straight to the hub. A client that subscribes later never sees them, which contradicts M2R85 ("every notice … whoever says it"). They can also overtake pending deltas.
  - The reload notice carries `source:"pap"` while every other pap notice carries none (sessions.md:85).
  - Fix: add `LiveSession.notice(n)` (the live session's `emit`) and call that, dropping `source:"pap"`; or document these as ephemeral.
- **M4 — Large dialogs can empty the snapshot's rows, and "Load older" then skips them (deferred #33).**
  - Where: `snapshot.ts:126-138` gives dialogs the first claim on the 1 MB budget (`Dialog.prefill` alone can be about 1 MB, and so can several 100 KB dialogs). `withTrimmedHistory` (`snapshot.ts:212-216`) then falls back to `page.oldestEntryId`, so `sessions.history{before}` returns rows above the whole page and the dropped recent rows never show until a reload.
  - Fix: reserve a row floor (for example 64 KiB, at least the newest row's placeholder) and cap non-approval dialogs at about 256 KiB, with the rest counted in `hiddenDialogs`. When no bound row survives, keep `oldestEntryId` on the oldest *kept* bound row, never on the page's oldest.
  - Carry: M4.
- **M5 — `hiddenDialogs` goes stale on the web.**
  - Where: `apps/web/src/stores/session-reducer.ts:131-132`. `dialog_closed` for an id the view lacks never decrements it, and the hidden dialogs never reach this client until the next snapshot, so a hidden approval cannot be answered here.
  - Fix: decrement on an unknown-id `dialog_closed`. When `hiddenDialogs > 0` and a visible dialog closes, re-subscribe for a fresh snapshot.
  - Carry: M4.
- **M6 — Helpers duplicated across tasks.**
  - `sizeOf` exists 3 times: `dialogs.ts:55` and `wire-clip.ts:13` re-define `kernel/json-bytes.ts:2`.
  - `isCount` exists twice with different meanings: `Number.isFinite` in `service-commands.ts:57`, `isSafeInteger` in `live-commands.ts:35`.
  - `MAX_ID_CHARS = 128` exists 3 times: `entries-cache.ts:8`, `snapshot.ts:245`, `live-session.ts:36`.
  - `LONE_SURROGATE` exists twice: `export-http.ts:21`, `names.ts:3`.
  - A surrogate-safe cut is hand-written 6 times, and `dialogs.ts:59` `cut` lacks it (deferred #24).
  - Fix: one `kernel/text.ts` (`cutUnits`, `LONE_SURROGATE`, `MAX_ID_CHARS`), import `sizeOf`, one `isCount`. Carry: M4 (no behaviour change).
- **M7 — A prompt sent during Stop's probe can be aborted at start (deferred #15).**
  - Where: `live-run.ts:218-234`. `promptsInFlight` is read **after** `await getState()`, so a prompt sent during Stop's ≤ 2 s probe is aborted at its start.
  - Fix: `const waiting = promptsInFlight > 0` before the await; set `abortAtStart` only if `waiting && promptsInFlight > 0`. Add a fake-clock test.
  - Carry: M4.
- **M8 — A small `PAP_WORKER_MEMORY_MAX_MB` can make the kernel kill the worker for a command's memory.**
  - Where: `config.ts:162` accepts `PAP_WORKER_MEMORY_MAX_MB` down to 256. Because tool children inherit the worker's `oom_score_adj` (I1), a command near the worker's 170–230 MB RSS can get the **worker** killed. The 2 GiB default is safe.
  - Fix: raise the floor to 1024, or document it in `daemon.md`.
- **M9 — fr users see daemon text in English.**
  - Daemon notices and `status.cause` (`exit.ts:15-30`) are English and shown verbatim (ruled English-only, Task 14b).
  - Carry: M3 P4 with the full emitter list (I2d).
- **M10 — `exports.ts:12-13` stacks two doc comments.** The `TOKEN_PATTERN` comment sits above `OWN_FILE`'s (deferred #37). Fix: move line 12 above line 15.

## Deferred-minors triage (49 ledger lines)

Decisions: **Fix before merge 1 · Resolved already 5 · Carry 14 · Accept 29.**

| # | Task | Item | Decision | Where / note |
|---|---|---|---|---|
| 1 | 1a | approval answers/category not enforced | Resolved | `streams.ts:60-65` superRefine, `dialogs.ts:147` |
| 2 | 1a | UI_LIMITS cap-crossing tests | Resolved | `snapshot.limits.test.ts:14-17`, `streams.test.ts:53,102`, `panels.test.ts:106` |
| 3 | 1a | streams.ts mid-file import, export order | Accept | cosmetic (`streams.ts:9`) |
| 4 | 1b | fitSnapshot count clamps | Resolved | `snapshot.ts:141-172` |
| 5 | 1b | test naming, +39 comment, RED | Accept | |
| 6 | 2 | queueEntries slice, compact asserts, dispatch default, editorText surrogate | Accept | a lone surrogate renders as U+FFFD; covered by M6 if done |
| 7 | 3 | auto-name docs | Resolved | `sessions.md:79` |
| 8 | 4 | ipc send-failed test, sweep over-count, comments | Accept | |
| 9 | 5 | vague skip reason | Resolved | `scope.int.test.ts:38` |
| 10 | 5 | slice distinctness, M7 test, doc form, bare awaits, execFileText signal | Accept | |
| 11 | 6 | parseCount accepts `1e3` and `0x100`, no upper bound | Carry → M4 | config hardening (operator input) |
| 12 | 6 | forceKill wiring, sweep fail-closed path, log-level dependency | Accept | |
| 13 | 7 | import order | Accept | |
| 14 | 8 | runs folded when `agent_start` lands during the probe | Carry → M4 | journal accuracy only; the UI is unaffected |
| 15 | 8 | promptsInFlight read after await (+ realOf, log level, caps) | Carry → M4 | Minor M7 (2-line fix); the rest accepted |
| 16 | 9a | pending bytes, timer flush, redundant flush | Accept | |
| 17 | 9b | partial cap and depth-8 tests, lone surrogate, duplicate import | Accept | |
| 18 | 10a | memoise indexEntries / lastEntryId | Carry → M4 / M13 | with virtualisation (M2-Q9) |
| 19 | 10a | malformed re-read, same-size rewrite | Accept | documented in ADR 0007 |
| 20 | 10b | same-millisecond, same-role entries bind swapped ids | Carry → M4 | bind the oldest unbound (`session-reducer.ts:81` uses `findLastIndex`); fork/edit could target the twin message; the rest accepted |
| 21 | 11 | cursor skip, args flag, view cap, `.strict()` | Accept | view cap goes with M4/M13 virtualisation |
| 22 | 12 | post-reset slot test, late queue_update | Accept | |
| 23 | 13a | take-before-send loses the approval | Accept | the worker is gone |
| 24 | 13a | `dialogs.ts:59` cut splits a pair | Carry → M4 | with M6's shared `cutUnits` |
| 25 | 13b | pending cap of 65 is silent | Accept | |
| 26 | 13b | scalar `spend` tests | Accept | |
| 27 | 14a | `.git` above /tmp, uid-0 skip | Accept | |
| 28 | 14a | rollback test; dev DB recreate | Accept | an M3 dev home that applied `settings` also refuses M2's stamps → recreate dev homes after the merge |
| 29 | 14b | tool name > 256 never matches | Accept | fails closed |
| 30 | 14b | several frames per read: a prompt can beat a revoke | Carry → M5 | per-connection ordered dispatch, with the policy work |
| 31 | 15 | a stale widget handle's async rejection clears its replacement | Carry → M4 | pi-host `widget-components.ts`: `if (live.get(key) !== handle) return`; the rest accepted |
| 32 | 16 | panelInput `not_found` under backpressure; > 64 keys unthrottled | Accept | plan-mandated |
| 33 | 16 | large dialogs crowd the snapshot; re-cancel | Carry → M4 | = Minor M4 |
| 34 | 17a | Stop during a navigate; extension `before_agent_start` window | Accept | documented, `sessions.md:74-75` |
| 35 | 17b | ZWJ lookalikes, duplicate name event, raw U+200B in a test | Accept | the U+200B may trip P7's literal gate: fix it there |
| 36 | 18 | patch blocks about 270 ms at 64 MiB | Accept | documented |
| 37 | 18 | stacked doc comment in `exports.ts`; POST test | **Fix before merge** | Minor M10 (1 line); the POST test accepted |
| 38 | 19 | no count cap on fork/clone | Carry → M4 | quotas (disk) |
| 39 | 19 | isFile pin, symlink-to-FIFO test | Accept | |
| 40 | 20 | `session_busy` vs wait on a closing worker; tool daemons kept up to 8 h | Accept | by design |
| 41 | 20 | a throwing exit handler skips cleanup | Accept | `onExit` sits in `finally` |
| 42 | 21 | snapshotWhen resubscribes per poll | Accept | |
| 43 | 22 | widget clip pinned by a unit test only | Accept | |
| 44 | 24 | stale "may have been sent" after a remount; live region; silent truncation at the draft cap | Carry → M3 P3 | P3 owns polite live regions and the composer in the shell |
| 45 | 23 | harness flag, the 285 figure, measure-script checks, hard-coded path, headroom | Carry → M4 + **owner info** | 285 MB is a 300-turn figure: RSS grows about 0.18 MB per turn and crosses 285 near turn 600 |
| 46 | 25 | Transcript load `catch` never releases the scroll anchor | Carry → M3 P3 | `Transcript.tsx:58`: call `release()` in the catch |
| 47 | 26 | 100-option and double "Send again" tests | Accept | |
| 48 | 27 | Safari `compositionend` order, heldFocus, guard-reset test | Carry → browser e2e (deferred, owner C1) | the rest accepted |
| 49 | 29 | `turnBare` and `.one` untested, aria-current comment, no RED record, browser-only layout | Accept | layout/IO checks go with browser e2e |

## Merge readiness, M2 → M3

The trial merge ran in a fresh clone: `feat/m2-sessions@14a8878` ← `feat/m3-design@b3c98d1`. The merge base is `f765f2a` (= `main`), and M3 adds 83 commits.

**Textual conflicts (8)** — all predicted by the tables except the i18n.test.ts modify/delete:

| File | Conflict | Resolution used in the trial |
|---|---|---|
| `AGENTS.md` | topic-notes line | union: (`daemon`, `sessions`, `auth`; UI: `web.md`) + M2 rulings pointer |
| `apps/daemon/src/daemon.ts` | migration `sources`; handler table | `[KERNEL, AUTH, POLICY, SESSIONS, SETTINGS]`; `{system, policy.rpc, sessions.rpc, settings.rpc}` + `createSettingsModule` (re-run Prettier on the line) |
| `apps/web/src/features/sessions/SessionScreen.test.tsx` | 1 hunk (M3's class edits on cases M2 moved) | take M2's file (rule 5) |
| `apps/web/src/i18n/i18n.test.ts` | modify/delete | delete; move M2's `plural` test into M3's `i18n.test.tsx` (I2c) |
| `budgets.json` | all three numbers | `initialBundleGzipKb` 200 (M3), `sessionOpenPayloadKb` 64, `idleWorkerRssMb` 191 (M2) |
| `packages/contracts/src/methods.ts` | imports | union: M2's import block + `settingsMethods` |
| `packages/contracts/src/permissions.ts` | `DOMAINS` | `["system","auth","sessions","policy","settings"]` |
| `scripts/check-budgets.ts` | output lines | M3's `lazyAssets` listing + M2's two `BUDGET_TEST` lines (drop "not measured in M1") |

Auto-merged cleanly:
- `DESIGN.md` (§9.2 ANSI rule and M3's §3/§7.4 both present)
- `docs/agents/daemon.md`
- `i18n/{en,fr,index}.ts` (M2's `sessions (M2)` block intact; `plural`/`tp` kept)
- `knip.json`
- `contracts/{index,methods.test}.ts`
- `packages/ui/src/primitives/TextField.tsx` (+ test): M3's version already declares and forwards `placeholder` (merged lines 14 and 33), so nothing to re-apply
- `pnpm-lock.yaml`: `--frozen-lockfile --offline` installs, and `--lockfile-only` leaves it byte-identical
- `check-budgets.test.ts`

**Merged-tree gate (after the resolutions above):**

| Step | Result |
|---|---|
| lint | pass |
| knip | pass |
| format:check | 1 file, my hand-joined `daemon.ts` line |
| typecheck | 9 errors in 4 M3 shell test files (I2a) |
| test:unit | 3410/3412 (I2b) |
| build | pass |
| budgets | **191.0 / 200** |
| smoke | ok |
| test:int (env -i) | **291/291** |

**Agreements checked:**
- **Migrations:** `migrate.ts` sorts globally by stamp (then module, then id), so the source-array order is irrelevant. The order holds with no re-stamp: kernel `…10100000` < auth `…0100/0110` < sessions `…0200` < policy `202610110100` < session_name `202610110200` < settings `202610111000`. Caveat: an M3 dev `PAP_HOME` that already applied `settings` refuses M2's two stamps ("sorts before an applied migration"). Recreate the dev homes; `main` never ran any of them.
- **Must-keep @pap/ui API:** `Button`, `TextField`, `Message`, `ApprovalCard`, `cn`, `FOCUS_RING` and `once` compile against M3's `packages/ui`. The only typecheck errors are in M3's own shell tests (I2a).
- **`data-terminal-input` / `panelFocus`:** `CustomPanel.tsx:111` matches M3 `commands/context.ts` (`panelFocus = closest("[data-terminal-input]")`).
- **`data-inline-edit`:** on the rename wrapper (`SessionActions.tsx:98`). The `inlineEditFocus` key is not in M3 yet (post-merge carry). **Extend it to M2's dialog cards (I3).**
- **i18n:** M3's `IDENTICAL_IN_FR` test passes over M2's keys on the merged run; agreement 4 holds.
- **M3 shell vs M2 names:** tabs, palette and rail groups label sessions by `basename(cwd)` and ignore `name`. A rename event does not refresh M3's sessions cache (I2a).
- **Two panes on one session:** check during P3 whether M3 panes can show the same session twice. Two Composers on one session would share the per-session write-ahead `pap.pending.<id>` slot.

**Add to M3's rebase / P-list:** I2a–d, I3, deferred #44 and #46 (P3), M9 (P4).

## Bundle estimate

| Build | Initial JS+CSS, gzip | Lazy `SessionScreen` chunk |
|---|---|---|
| M2 alone | 160.3 KB (budget 180) | — (eager) |
| M3 alone (`b3c98d1`) | 190.4 KB (budget 200) | 5.2 KB gz |
| **Merged** | **191.0 KB** (budget 200, about 9 KB headroom) | **23.6 KB gz** (+18.4 KB, loaded on the first session open) |

M2 adds only about 0.6 KB of initial weight once M3's lazy `SessionScreen` is in place: stores, contract schemas, and M2's i18n block in the eager catalog, offset by chunk regrouping. P6's rule gives `min(ceil(191 × 1.10), 200) = 200`, so no owner question. Moving M2's session strings to a lazy catalog (about 3 KB) remains an optional lever, not needed today.
