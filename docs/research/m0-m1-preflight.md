# M0 + M1 pre-flight conflict scan (archived 2026-10-11)


Scope: plan `docs/plans/2026-10-10-m0-m1-spikes-skeleton.md` (12 383 lines, all read), spec C, DESIGN.md, decisions-log, roadmap. Read-only. Nothing installed, built or run. Line numbers are plan lines unless prefixed `spec` or `DESIGN`. Not verified (needs the SDK or the tools): Pi SDK signatures (`hidden`, `bindExtensions({onError})`, `SessionManager.open` on a missing file), exact knip, Prettier and Playwright behaviour. Those rows say "predicted".

Legend: OK = consistent; NOT OK = mismatch, with plan lines and a one-line resolution.

## 1. Task pairs (shared file or interface)

| # | Tasks | Produces to consumes | Finding | Resolution |
|---|---|---|---|---|
| P01 | 1, 9 | `.gitignore` rewritten whole by T1 (l.163-168) and T9 (l.1669-1680); HEAD 3c9c278 has `.superpowers/` and `.worktrees/` | NOT OK: both drop `.worktrees/`; `dist-*/` (T7 vite outDir l.1337) never ignored; eslint `ignores` (l.2188) lacks `.worktrees/**` | append lines instead of replacing; add `dist-*/`; add `.worktrees/**` to eslint ignores |
| P02 | 1, 2 | `spikes/s2/scripted.ts` copied by `cp` (l.484) | OK | none |
| P03 | 1, 20 | script `{modelId, steps[{text, toolCalls[{name,args,id?}], stopReason, errorMessage}]}` (l.217-226) to zod `ProviderScript` (l.6974-6982) | OK same keys; T20 adds `modelId` default | none |
| P04 | 1, 27 | same format to `e2e/fixtures/approval-script.json` (l.12102) | OK | none |
| P05 | 1, 23 | script object in `startTestDaemon(script)` (l.9472) | OK, parsed by T20 parser | none |
| P06 | 1, 20/23/27 | S2 note "Consequences" (option names, retry) (l.433-435) | OK, conditional on the note; no M1 test uses a quota step | none |
| P07 | 2, 4 | `spikes/s1/host.ts` init `{cwd,agentDir,script,order,builtins}`, `ready`, `prompt`, `agent_settled`, `shutdown` (l.612-620, 698) to `measure.ts` (l.1005-1036) | OK; `../s1/host.ts` path correct | none |
| P08 | 2, 19 | S1 inline-extension `path` to `POLICY_EXTENSION_PATH` (l.6478) | OK for the path (T19 says use the S1 value); NOT OK: S1 only probes `{name, factory}` (l.524-569) but T19 uses `hidden: true` (l.6536) | add `hidden` to the S1 probe or drop it |
| P09 | 2, 19/20/21 | S1 FALLBACK "apply Spike fallback lines of Tasks 19, 20 and 21" (l.858) | OK, lines exist (l.6288, 6808-6810, 7554) | none |
| P10 | 3, 14 | gate "finish S3 before Task 14" (l.60) vs T14 "S3 FALLBACK does not change M1" (l.3633) | OK but gate is redundant | drop S3 from the gate or say why |
| P11 | 4, 13 | `WORKER_BUDGET_MB` (l.990, 1079) to `config.ts` (l.3480) | NOT OK: l.3599 labels this mandatory update "Spike fallback / S4" but S4 has no fallback (l.982); "update the third `defaultMaxWorkers` expectation" is moot, the test passes 600 explicitly (l.3280-3282) | relabel "Apply S4 result"; drop the test clause |
| P12 | 4, 23 | `idleWorkerRssMb` (l.990, 1081) to `budgets.json` (l.9255) | NOT OK: same mislabel at l.9258 | relabel |
| P13 | 5, 20 | `ProjectTrustStore.get/set`, `hasTrustRequiringProjectResources` (l.1127-1134) to `open-session.ts` (l.7335-7346) | OK | none |
| P14 | 5, 7 | pi-web read by relative path: `pi-web/node_modules/...` (l.1152) vs `../pi-web` (l.1355, git and cp) | NOT OK: root is stated as the main checkout (l.45) but work happens in `.worktrees/feat-m0-m1`; `../pi-web` resolves to `.worktrees/pi-web`; the two tasks use different forms | define `PI_WEB=/home/ubuntu/Workspace/soulkyu/pi-web` once and use it |
| P15 | 8, 24 | S6 token vocabulary (l.1569-1596) to tokens `@theme` (l.9869-9890) | OK all names exist; both map `you` to a left rule (see S13) | none |
| P16 | 9, 10 | root scripts (l.1690-1701), vitest include `eslint/**/*.test.js` (l.1791) | OK names; NOT OK: T9 declares `zod` in contracts (l.1933) and `@pap/contracts` in pi-host (l.1899-1902) but nothing imports them until T12/T19; T10 Step 7 "knip report nothing" (l.2290) is predicted to fail (unused dependencies) | run knip only from T26, or `ignoreDependencies` until used |
| P17 | 9, 11 | catalog lines (l.1712-1714) match `bumpCatalog` test input (l.2326-2327); `dist/` outputs match upload paths (l.2445-2447) | OK | none |
| P18 | 9, 12 | `PROTOCOL_VERSION` (l.1977) re-exported via frames.ts (l.2734) and barrel (l.3069-3078) | OK; T12 Step 7 reruns the T9 test | none |
| P19 | 9, 19/20 | pi-host package.json (l.1884-1903) gains deps (l.6292) | OK | none |
| P20 | 9, 10, 27 | root package.json and lockfile touched by T10 (listed) and T27 Step 1 | NOT OK (low): T27 Files (l.12007-12011) omits them but Step 10 adds them (l.12358) | list them |
| P21 | 9, 26 | AGENTS.md `Dev:` line (l.1825) replaced (l.10990) | OK | none |
| P22 | 10, 11 | T11 Step 6 runs `format:check` and `knip` (l.2493) | NOT OK: T10 commits unformatted files (no `pnpm format`, l.2293-2297; lines over 110 chars, e.g. l.2188, 2247) so `format:check` fails; knip as P16 | add `pnpm format` before each commit from T10 on |
| P23 | 10, 24 | `pap/no-raw-colors` on `packages/ui/src/**` (l.2255-2261) vs `tokens.test.ts` hex literals (l.9831) | NOT OK: T24 Step 6 `pnpm lint` (l.9145) fails with 8 errors | exempt `*.test.ts` in the config or read the list from a JSON fixture |
| P24 | 10, 12-26 | ELEMENTS patterns (l.2170-2184) vs every import in T12-T27 | OK, no forbidden edge found (module-to-kernel, web-routes-to-features, daemon-root-to-testing all allowed) | none |
| P25 | 10, 16 | spec 8.2 gates vs T10 tests (l.2058-2072) | NOT OK (low): `boundaries/element-types` and `entry-point` have no test | add a `lintText` case (a module importing another module's non-index file) |
| P26 | 11, 27 | jobs checks/unit/integration/build (l.2409-2441) and artifact `dist` to appended `e2e`, `budgets` with `needs: build` (l.12317-12347) | OK | none |
| P27 | 12, 16 | `methods`, frames, `HandlerTable`, `HandlerContext`, `PapError`, `Cursor`, `StreamName`, `CAPABILITIES`, `MAX_FRAME_BYTES` | OK all exported | none |
| P28 | 12, 19 | `PolicyRules`, `ToolCategory`, `AuditEntry`, `UiResponseRecord` | OK; audit decision enum matches `record()` calls | none |
| P29 | 12, 20 | `DaemonToWorker`, `InitRecord`, `PolicyRules`; `ResponseRecord.command` required (l.3016) vs commands.ts (l.7375, 7389, 7398) | OK | none |
| P30 | 12, 21 | `parseWorkerRecord`, `CommandInput`, `ResponseRecord`, `PapError` | OK | none |
| P31 | 12, 22 | `GetStateData`, `Dialog`, `UiRequestRecord`, `SessionStreamEvent`, `ReadyRecord`, `InitRecord` | OK | none |
| P32 | 12, 23 | `methods` (ws-client), `HandlerTable` (daemon) | OK, 8 handlers = 2 system + 6 sessions | none |
| P33 | 12, 25 | `methods`, `ResponseFrame`, `EventFrame`, `HelloFrame`, `MAX_FRAME_BYTES` | OK | none |
| P34 | 12, 26 | `SessionStreamEvent`, `ERROR_CODES`, `Dialog`, `SessionSummary`, `DialogResponse` | OK; all 14 codes have en and fr keys (l.11245-11258, 11309-11322) | none |
| P35 | 13, 14 | `Clock`, `createFakeClock`, `Logger`, `silentLogger` | OK | none |
| P36 | 13, 15 | `Logger` | OK | none |
| P37 | 13, 16 | `Clock`, `TimerHandle`, `Logger` | OK | none |
| P38 | 13, 17 | `randomToken`, `sha256Hex`, `newId` | OK | none |
| P39 | 13, 21 | `Clock`, `createFakeClock` | OK | none |
| P40 | 13, 22 | `Config` Pick fields (l.9179) all exist (l.3486-3502) | OK | none |
| P41 | 13, 23 | `Config` 15 fields (harness l.9417-9432), `loadConfig`, `ConfigError`, `VERSION` (first import l.9584) | OK semantics; NOT OK for knip in T17-T22: `kernel/version.ts` has no importer until T23 (predicted unused file) | see P16 resolution |
| P42 | 13, 14/15/16/17/18/22/23 | `apps/daemon/package.json` edited incrementally (build script l.4080) | OK | none |
| P43 | 14, 16 | `ReceiptStore.find/save` vs dispatcher (l.4734, 4752-4753) | OK | none |
| P44 | 14, 17 | `migrate`, `KERNEL_MIGRATIONS`, `MigrationSource`, `Db`; stamps 202610100000 < 100100 < 100110 < 200200 | OK FK order holds | none |
| P45 | 14, 22 | same | OK | none |
| P46 | 14, 23 | `ensureInstallTimestamp`, `createReceiptStore`, `migrate` result `{db, readOnly}`; `copySql` copies `modules/*/migrations` | OK | none |
| P47 | 15, 16 | `originAllowed`, `startServer`, `RunningServer` | OK | none |
| P48 | 15, 17 | `createHttpApp({mount, wsProbe, ...})` | OK | none |
| P49 | 15, 23 | `createHttpApp`, `startServer({onUpgrade})` | OK | none |
| P50 | 16, 22 | `StreamHub.registerSnapshot/publish` (snapshot returned synchronously) | OK | none |
| P51 | 16, 23 | `createDispatcher`, `createStreamHub`, `createWsServer`, `systemHandlers` signatures | OK | none |
| P52 | 16, 25 | hello frame, `{sub,epoch,seq,event}`, cursor, client ping 5 s, silent 15 s | OK shapes; NOT OK semantics: server marks a peer dead after up to 30 s (l.4973-4982) vs client 15 s vs spec 4.2 (15 s); no keepalive test | single deadline: terminate when no frame or pong for 15 s; add a fake-clock test |
| P53 | 16, 26/27 | `/ws?proto=` probe 426/401/200 | OK | none |
| P54 | 17, 18 | `startSession`, `authenticate`, `AuthStore`, `errorResponse`, `setSessionCookie`, `readJson`, `SESSION_COOKIE` | OK all exported | none |
| P55 | 17, 23 | `createAuthModule`, `AUTH_MIGRATIONS`, `setupUrl`, `authenticateCookieHeader`, `mount` | OK | none |
| P56 | 17, 26 | `/auth/status\|setup\|login\|logout` bodies and status codes vs `auth-api.ts` | OK; UX: bad setup token gives 401 `unauthenticated`, shown as "Sign in first." (l.11638) | map setup failures to a dedicated message |
| P57 | 18, 26 | passkey `{flowId, options}` and `{flowId, response}` | OK | none |
| P58 | 18, 27 | rpId `localhost`, origins filtered by rpId (l.6100) | OK | none |
| P59 | 19, 20 | `createPapPolicyExtension`, `movePolicyLast`, `createUiBridge`, `PLAIN_THEME` | OK | none |
| P60 | 19, 22 | confirm dialog fields vs `Dialog` schema | OK | none |
| P61 | 19, 26 | title and message to ApprovalCard `detail` (l.11857) | OK; e2e text "echo pap-e2e-ok" present | none |
| P62 | 20, 21 | `init`, `response`, `shutdown{graceMs}` | OK | none |
| P63 | 20, 22 | `InitRecord` fields; `PI_CODING_AGENT_DIR` | NOT OK (low): l.6806 says T21 `workerEnv` sets it; it is set in T22 `index.ts` (l.9204) | fix the sentence |
| P64 | 20, 23 | `PI_HOST_MAIN`/network-guard paths vs harness (l.9426-9427) | OK | none |
| P65 | 20, 26 | wire events (`message_update` text_delta, `message_end`) vs reducer | OK | none |
| P66 | 21, 22 | `spawnWorker`, `WorkerHandle`, `workerEnv`, `describeExit`, `createFakeWorker` | OK | none |
| P67 | 22, 23 | `createSessionsModule`, `SESSIONS_MIGRATIONS`, `.rpc/.shutdownAll/.inspect` | OK; knip: `createSessionsModule` unused until l.9590 (predicted, T22 Step 9 l.9216) | see P16 |
| P68 | 22, 26 | stream events snapshot/status/pi/dialog_open/dialog_closed/notice vs reducer | OK | none |
| P69 | 23, 25 | `GET /ws?proto=N` vs `probeServer` | OK | none |
| P70 | 23, 26 | `apps/web/dist` found via `../../web/dist/` (l.9687) | OK from both `src/` and `dist/` | none |
| P71 | 23, 27 | log lines `setup_url`/`listening`, flags, env vars | OK | none |
| P72 | 24, 26 | `Button`, `TextField`, `Message`, `ApprovalCard` props | OK props; NOT OK use: Stop button `danger` (l.11888), see S05 | see S05 |
| P73 | 25, 26 | `getRuntime`, `useConnectionState`, `getJson`, `postJson`, `RpcError`, `Runtime` | OK; NOT OK doc: Interfaces (l.10172) list `probeServer` and `randomId` as `index.ts` exports, they are not (l.10943-10946) | fix the list |
| P74 | 26, 27 | e2e accessible names (l.10978) vs en.ts, components | OK all present, `exact: true` used for "Sign in" | none |
| P75 | 10, 23, 25, 26 | `knip.json` edits (l.2276, 9260, 10211, 10990) | OK, T26 replaces the T25 entry | none |
| P76 | 9, 11, 14, 27 | `scripts/**/*.test.ts` include (l.1791) | OK | none |
| P77 | 16, 19, 20 | ADR 0003/0002/0001 files | NOT OK: `Date: [today]` placeholders (l.5059, 6770, 7517); premises stale vs amended spec (ADR 0001 says spec 2.3 has no boot record; 0002 quotes "loaded first"; 0003 says cursor is last `seq`) | fill dates; reword as "as first drafted, amended by decision 34" |
| P78 | 20, 27 | `PAP_TEST_PROVIDER_SCRIPT` absolute path | OK | none |
| P79 | 21, 23 | network-guard path in tests | OK | none |
| P80 | 22, 25 | stream cursor semantics: subscribe response then snapshot (l.5018) vs `open()` (l.10780-10789) | NOT OK: a listener that leaves and returns before the first `subscribe.session` reply (React StrictMode double mount, l.11984) starts a second `open()`; both subs get stored in `bySub`, events are delivered twice (doubled text deltas), the first sub leaks | give each entry an `opening` flag or generation counter; unsubscribe stale replies |

## 2. Per task: does the task agree with itself

| Task | Verdict | Findings (plan lines) | Resolution |
|---|---|---|---|
| 1 S2 | NOT OK (low) | Files (l.154-157) omit `results.json` (l.401) and `pnpm-lock.yaml` (l.186) that `git add spikes/s2` commits (l.445); `.gitignore` replace (P01). Tests/fixtures/code agree: 3 fixtures x 2 routes = 6 entries, 120 runs, U+2028 present in text.json | list the files; append to `.gitignore` |
| 2 S1 | NOT OK (low) | `afterRunRssMb` (l.800) reads `tree2.rssMb` captured before the panel and probe runs (l.788); `results.json` not in Files. Scenario has 5 steps, driver consumes exactly 5 | rename to `afterThreePromptsRssMb` |
| 3 S3 | OK | `results.json` (l.943) not in Files, harmless | none |
| 4 S4 | OK | Decision fixed to GO (l.1083) matches "fallback: none" | none |
| 5 S7 | NOT OK (low) | pi-web path (P14); `results.json` and lockfile not in Files | see P14 |
| 6 S8 | OK | probe.sh has 4 probes = 4 matrix columns; matrix has 7 rows = 6 docker + podman | none |
| 7 S5 | NOT OK | `git add spikes/s5` (l.1529) commits `dist-codemirror/` and `dist-pierre/` (vite `outDir` l.1337, not ignored); `../pi-web` path (P14); `main.tsx` statically imports both candidates (l.1444-1446), so each bundle measurement may include the other library | ignore `dist-*/`; dynamic-import per candidate |
| 8 S6 | NOT OK | Step 1 redirects to `spikes/s6/repo.json` (l.1549) before the directory is created (l.1557) and no earlier step creates it; `repo.json`, `paths.txt` not in Files | `mkdir -p spikes/s6/upstream` first |
| 9 workspace | NOT OK | `.gitignore` (P01); `pnpm format` (l.1990) will rewrite `DESIGN.md` (unaligned markdown tables; root file not in `.prettierignore` l.1763-1773) and `git add` (l.1991) does not include it, so the tree stays dirty and CI `format:check` fails; unused `zod`/`@pap/contracts` (P16); `pnpm-lock.yaml` not in Files | add `DESIGN.md` to `.prettierignore` (or commit it formatted) |
| 10 eslint+knip | NOT OK | no `pnpm format` before commit (l.2293-2297); Step 7 knip claim (P16); boundaries untested (P25); `pnpm-lock.yaml` not in Files | format step; defer knip |
| 11 CI | NOT OK | Step 6 expects `format:check` and `knip` to pass (l.2493): they fail (P22) | as P22 |
| 12 contracts | OK | tests match code (checked each assertion: methods keyed, 3 mutations, frames, worker records, `@ts-expect-error` lines on the right line). Notes: Interfaces (l.2513-2520) omit `STREAMS`, `PiEvent`, the `extension_ui_closed` record; `TOOL_CATEGORIES` has no `unknown` (S01) | optional doc fix |
| 13 kernel basics | NOT OK | l.3599 mislabel and moot test clause (P11); `version.ts` unreachable until l.9584 | relabel |
| 14 sqlite | NOT OK | `migrate.test` "rolls back a failing migration" (l.3737-3744) calls `source("a", A1)` again, but the helper (l.3700-3705) never deletes files, so `202601010002_bad.sql` is still in `root/src/a` and the second `migrate()` throws `MigrationError`: the test fails. Everything else matches (WAL, nested transaction, snapshot, read-only, receipts, copy-sql) | delete the bad file (or use a new `root`) before reopening |
| 15 http | OK | tests match code (headers, 403 Origin, immutable assets, SPA fallback, traversal, ephemeral port, EADDRINUSE) | none |
| 16 ws | NOT OK | `receipts.find` is outside the try/catch in the dispatcher (l.4752) and `onText` is fired with `void` (l.5024): a DB error is an unhandled rejection that kills the daemon, against "a handler failure fails only its own request" (spec 4.2); keepalive 15+15 s (P52); `reject()` calls `socket.end()` then `socket.destroy()` at once (l.4951-4954), the status line may not flush (flaky 401/403/426 assertions); ADR placeholders (P77) | wrap the whole dispatch in try/catch returning `internal`; `end()` then destroy on `finish`; fix keepalive |
| 17 auth | OK | tests match code (scrypt prefix, throttle 1000/2000/60000, race, sliding, cookies, 413). Only knip (P16/P41) | none |
| 18 passkeys | OK | tests match code (flow consumed even on wrong user, 5 min expiry, rpId null for IP). Only knip | none |
| 19 policy | NOT OK | l.6445 says spec 5.3 does not classify unknown tools (it does: row "unknown", decision 34) and `TOOL_CATEGORIES` (l.2955) has no `unknown`; `edit`/`write` allowed for any path although spec 5.3 says "in cwd or worktree"; Step 10 claims all new exports are imported by this task's tests (l.6780) but `createPapPolicyExtension` is not (predicted knip failure); `hidden: true` (P08); ADR (P77) | add `unknown`; path check or documented deferral to M5; run knip later |
| 20 worker | NOT OK | `ipc.onMessage(dispatch)` is registered only after `await openSession` (l.7487): any record sent between `init` and `ready` is dropped silently; l.6806 attribution (P63); test "exits when its parent dies" polls with 50 ms sleeps (l.7280) against "no sleeps" (l.42), justified at l.7290; ADR (P77) | register the dispatcher before `openSession` and queue |
| 21 supervisor | NOT OK (low) | `fake-worker.ts` (test double) sits in `kernel/supervisor/` and is compiled into `dist` (build excludes only tests and `src/testing/**`, l.3147); tests/code otherwise agree (kill ladder timing traced with the fake clock) | move it to `src/testing/` or exclude it |
| 22 sessions | NOT OK | `create()` (l.9075-9082) never records its in-flight launch (`checkCapacity` l.9004-9006 counts `live` and `launching`, but only `ensureLive` fills `launching`; `live.set` happens after `await session.ready`): concurrent creates exceed `maxWorkers`; l.8463 says spec 2.4 is silent about "probe never sees idle" (amended spec 2.4 states it); reopening a created-but-never-prompted session may hit `ready.sessionId !== row.id` (l.9053-9056) if Pi only writes the JSONL after the first assistant message (predicted, verify in S1); `createSessionsModule` knip (P67) | track launches in a counter; verify lazy file in S1; reword l.8463 |
| 23 composition | NOT OK (low) | l.9258 mislabel (P12); in `--dev` the printed setup URL (l.9646) points to the daemon port, where no SPA is served (Vite is on 5173, l.10990) | print the Vite URL in dev or document it |
| 24 ui | NOT OK | lint failure (P23); token mismatches vs DESIGN (S11-S13); `ApprovalCard` captures `props.onAnswer` once (l.10109-10114), safe only because T26 keys the card by dialog id (l.11855); `package.json` exports (l.9770) lack the `development`/`default` convention (l.40) | see S11-S13; add the `development` condition or note the exception |
| 25 runtime | NOT OK | double-subscribe race (P80); `open()` swallows `subscribe.session` errors (l.10788), so a `not_found` is never shown; Interfaces mismatch (P73); tests match code (backoff, silent peer, nudge, mutation-only commandId, cursor resume). `flush` uses real `setTimeout(0)` (l.10266, 10631) | handle the error; fix doc |
| 26 web app | NOT OK | Stop uses `variant="danger"` (l.11888); login form is above the passkey button (l.11684-11696) although spec 4.4 calls passkeys "the default login"; bad setup token message (P56); `AccountBar` concatenates around a variable (l.11713, DESIGN 11); tests match code | see S04, S05 |
| 27 e2e | NOT OK | plan expects WebKit may fail on the always-`Secure` cookie over `http://localhost` (l.12017, 12310) while the M1 exit criterion (l.1653, 12353) needs it green: undecided before execution; Files omit root `package.json`/lockfile (P20); Step 1 installs browsers without `--with-deps` (l.12021) while CI uses it (l.12329); Step 9 `format:check` (P22); `pnpm typecheck` covers only workspace packages, so `scripts/`, `e2e/`, `playwright.config.ts`, `vitest.config.ts` are never type-checked (spec 8.2) | decide the cookie policy first; add a root tsconfig |

## 3. Things the plan mandates that a reviewer would call a defect

| # | Tasks | Defect | Resolution |
|---|---|---|---|
| D01 | 10-26 | `pnpm format` only at T9 Step 9 (l.1990); `format:check` is a CI gate (l.2415) and T27 Step 9 (l.12352); the M1 exit criterion list (l.1653) omits `format:check` while Step 9 includes it | add a format step to every commit step; align the two lists |
| D02 | 16, 19, 20 | `Date: [today]` placeholders in three committed ADRs (l.5059, 6770, 7517) | write the date |
| D03 | 12 | `handler-table.test.ts` (l.2556-2566): runtime asserts are `toBeDefined()` and `toBe("x.y")`; the real check is a `@ts-expect-error` that only `pnpm typecheck` runs | state it in the test name or add a runtime case |
| D04 | 20 | `scripted-provider.test.ts` second case asserts `toBeDefined()` on the provider (l.6895) | assert one scripted step round-trips |
| D05 | 24 | `ApprovalCard.test.tsx` only checks static markup (l.9844-9853); the answer-once behaviour (Review Focus 5) is covered by `once.test.ts` and the e2e double click, not at component level | add a click test or accept |
| D06 | 17, 18 | verbatim helper `const badRequest = ...` in `http.ts` (l.5728) and `passkey-http.ts` (l.6192) | export once |
| D07 | 26 | `registerPasskey` and `loginWithPasskey` (l.11559-11583) are the same options-start-verify block twice | extract one function |
| D08 | 16, 21, 22, 25 | test helpers duplicated: `codeOf` (l.8526, 8658), `flush` (l.10266, 10631), manual timers (l.10549, 10625-10627) | move to a shared test helper |
| D09 | 20, 25 | tests that poll or yield on real timers despite l.42: l.7280 (50 ms poll), l.10266/10631 (`setTimeout(0)`) | keep the justification or use event waits |
| D10 | 10, 16 | gates without tests: boundaries (P25) and server keepalive (P52) | add tests |
| D11 | 22 | capacity check races (T22 row) | counter |
| D12 | 27 | a known-red WebKit step is planned as "stop and record" (l.12310) inside the exit criterion | decide before execution |
| D13 | 1-8 | spike tasks commit generated files (`results.json`, lockfiles, T7 `dist-*`) not listed in Files | list or ignore |
| D14 | all | file size: none over 400 lines (largest ~166, sessions `service.ts` l.8958-9123); AGENTS.md stays under 150 | none |
| D15 | 24, 26 | Global Constraint "no raw colours": hex literals in a linted test (P23); "Cancel is never destructive" (spec 7.4) violated by Stop (S05) | see P23 and S05 |

## 4. Contradictions with the binding spec (amended text) and DESIGN.md

| # | Tasks | Spec or DESIGN says | Plan says | Resolution |
|---|---|---|---|---|
| S01 | 12, 19 | spec 5.3 row `unknown`: ask, block when unattended (decision 34) | `TOOL_CATEGORIES` has five values (l.2955); l.6445 "spec C 5.3 does not classify them" | add `unknown`, fix the sentence |
| S02 | 19 | spec 5.3 edit: "edit, write in cwd or worktree" allowed | every `edit`/`write` allowed, no path test (l.6454-6459) | resolve against cwd, ask outside; or record the deferral |
| S03 | 16, 25 | spec 4.2: peer silent for 15 s is dead | server needs a missed pong in the next 15 s window (up to 30 s) | single 15 s deadline |
| S04 | 26 | spec 4.4: passkeys are "the default login"; decision 32: "passkey first, password second" | password form first, passkey button second (l.11684-11696) | swap the order |
| S05 | 26 | spec 7.4 "Cancel is never destructive"; DESIGN 9.1 "Cancel is never danger", danger = error colour | Stop button `variant="danger"` (l.11888); danger is pink (l.9982) | use `secondary` for Stop |
| S06 | 27 | spec 4.4 cookie `Secure`; default bind is HTTP on localhost; Review Focus 1 expects login to survive a reload in Safari | plan keeps `Secure` always and expects WebKit to possibly fail (l.12017) | owner decision and ADR before M1 starts (for example `Secure` only on https or non-loopback origins) |
| S07 | 22 | spec 2.4: if the probe never sees idle the run stays open until the next `agent_settled` | l.8463 says the spec is silent | reword |
| S08 | 16, 19, 20 | amended spec already has `{epoch,seq}` cursor (4.3), `init` and `extension_ui_closed` (2.3), policy last (5.1) | ADR texts describe the old drafts as the current spec (P77); spec 4.2 table row (spec l.188) still shows `{sub, seq, event}` | fix ADR wording; fix spec l.188 to `{sub, epoch, seq, event}` |
| S09 | 14 | spec 3.4 receipts kept 7 days | no purge, and no roadmap milestone mentions it | add a purge or a roadmap line |
| S10 | 9, 11, 27 | spec 8.2 `tsc --noEmit` strict as a blocking gate | root `scripts/`, `e2e/`, config files have no tsconfig (T27 row) | add `tsconfig.json` at root and a `typecheck` script |
| S11 | 24 | DESIGN 3.2 day `--surface` = `#FFFFFF`, `#F3F1EC` is `--bg-side`; night `--surface` = `#1A1724` | `--pap-panel` night `#1a1724` (l.9896) but day `#f3f1ec` (l.9914, 9932): inconsistent role mapping while the plan claims "same values" (l.9758) | map day panel to `#ffffff` |
| S12 | 24 | DESIGN 3.1/3.2 primary (you) ink `--you-ink` = `#1B0D00` in both modes | `--pap-on-fill` night `#110f18`, day `#1c1917` (l.9904, 9922, 9940) | `#1b0d00` |
| S13 | 24 | DESIGN 4: label 10-10.5 px, tracking 0.1-0.12em, Buttons mono uppercase; 9.2 Message-you is a right-aligned tinted box; 9.2 ApprovalCard answers listed Deny first; fonts self-hosted woff2 | label 11 px (l.9885) with `tracking-wider` (l.10041, 10085); Button `font-sans` (l.9994); Message-you = orange left rule (l.10074); Allow first; Manrope and JetBrains Mono named but never loaded | accept as M1 subset only if the plan says so (it does for names, not for component rules); otherwise align |
| S14 | 22 | spec 2.1 `releasing` state and 30-min idle release; spec 3.4 audit table; spec 4.3 coalescing and `toolOutput` | absent from M1 | OK: recorded in roadmap M2 and M5, no action |
