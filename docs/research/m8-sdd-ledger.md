# M8 SDD ledger (archived 2026-10-14)

Controller ledger of the M8 subagent-driven run (25 tasks, the final review, its single fix round and the final re-review), copied verbatim from the git-ignored SDD workspace. Rulings: [m8-rulings.md](m8-rulings.md); final review: [m8-final-review.md](m8-final-review.md).

# SDD ledger — plan: docs/plans/2026-10-13-m8-files-git-terminal.md

Started 2026-10-13. Plan at 24117ab (planner 0fb31c0 → Opus red-team 0 C / 12 I / 29 m → owner page, all recos → Opus plan fix). Spec: C + A + DESIGN.md (binding). Cross-plan: .superpowers/m7-m8-cross-plan-agreements.md (24 items + owner amendments). M8 merges FIRST (c1).
Model table (owner Q9, decision 75): 25 Sonnet implementers; Opus reviewers on 2 3a 3b 4 6a 6b 7 8 10b 11 12 13 14; Sonnet on the rest; Opus final review. Opus escalation at fix rounds 4–5 is PRE-APPROVED for wave 1.
Workflow (decision 73): the controller re-verifies small test- or comment-only fixes; test:int only for runtime tasks; no Haiku.

## Pre-flight conflict scan (the plan's own table, checked by the red-team and planfix; adopted)
## Pre-execution conflict scan

Tasks run one at a time, in order: 1, 2, 3a, 3b, 4, 5, 6a, 6b, 7, 8, 9, 10a, 10b, 11, 12, 13 … 22. Pairs below share files or interfaces; the later task builds on the earlier one's result and must not undo it. Files shared with M7 are listed in "Merge order and conflict notes" (agreements 1–24).

| Tasks | Shared file or interface | Rule |
|---|---|---|
| 1 → all | `permissions.ts`, `errors.ts`, `handlers.ts` (`BinaryChannel`), `protected-paths.ts` | Task 1 adds only; later tasks read them. |
| 2 → 11, 12, 14 | `binary-frames.ts` codec, `HandlerContext.binary`, `BinaryStream.send` / `BinarySink` | Task 2 freezes the layout and the channel API; 11 uses fakes of it, 12 wires it, 14 decodes the same frames in the browser. |
| 3a → 3b | `within`, `judgeName`, `Scope`, `BoundaryConfig` | 3b re-runs 3a's pure name judgement on the descriptor; it never adds a rule of its own to it. |
| 3a → 5, 6a, 6b, 7, 9, 10b, 12 | `judgePath()`, `gateWrite()`, `Scope`, `Protection`, `ProjectsPort.roots()` | Every path from a client goes through `judgePath` with the caller's kind; every write through `gateWrite`; no task reimplements containment, protection or token rules. |
| 3b → 5, 6a, 6b, 7, 9 | `openRegularFile()`, `openFolder()`, `writeAtomic()`, `OpenGuard`, `createDenySet()` | Every open of a client path goes through these with one shared deny set (built in `compose-workspace.ts`, Task 5). |
| 4 → 5, 9 | `GitRunner.run()`, `gitArgs()`, `gitEnv()`, porcelain and numstat parsers | `files` (check-ignore, ls-files) and `vcs` (status, diff, cat-file) both run git through the runner only. |
| 5 → 6a, 6b, 7, 21 | `modules/files/index.ts` `createFilesModule`, `compose-workspace.ts`, `contracts/files.ts` | 5 creates the module and the composition helper; 6a, 6b and 7 add methods, routes and stores to it; 21 calls `files.search`. |
| 6a → 6b, 7 | `kernel/http/caller.ts` (`HttpCaller`), `content-disposition.ts` | 6b and 7 reuse the caller; the disposition is 6a's. |
| 6b → 7 | `receiveBody()`, `createInflight()`, the explicit `requestTimeout` | 7 reuses them for `POST /upload`, with its own pending reservation. |
| 7 → 8 | `AttachmentsPort.claim()` / `release()` | 8 claims at `sessions.prompt`; 7 never knows sessions. |
| 8 (pi-host) | `dispatch.ts`, `commands.ts`, `host.ts` | M8 adds `papHome` and the prompt queue; M7 adds its own `case` lines in `dispatch.ts` (agreement 8). |
| 9 → 14, 19 | `VcsStreamEvent`, `subscribe.vcs`, `vcs.fileDiff`, `DiffSide`, `VcsFile.folder` | 14 reduces the stream, 19 renders it. |
| 10a → 10b | `loadNodePty()`, the installed `node-pty` | 10b spawns through the loaded module only. |
| 10b → 11, 12 | `PtyProcess` (with `start`), `spawnPty()`, `ptyKill()`, `sessionMembers()` | 11 tests against a fake `PtyProcess`; 12 passes the real one. |
| 11 → 12 | `TerminalRegistry`, `Terminal.attach/detach/input/ack/resize/close`, stale streams | 12 adds the RPC, the list stream and wiring only. |
| 12 → 14, 20 | `terminal.attach` result, `terminal.create { requestId }`, `TerminalStreamEvent`, CAPABILITIES `terminal` | 14's channel and 20's pane follow them. |
| 14 → 17, 19, 20, 21 | `runtime/terminal-channel.ts` (visibility detach, input split), `runtime/upload.ts`, `vcs-store`, `terminal-store` | screens use them, never the socket. |
| 15 → 17, 18, 19, 20 | `ItemRef` kinds `files`, `changes`, `terminal`, `PANE_RENDERERS`, `SurfaceBar` | 15 mounts placeholder lazy panes; 17/19/20 replace the placeholder files by name; 18 adds the files pane's lazy entry in `routes/shell/` (step-up). |
| 16 → 17, 18, 19 | `@pap/ui/code` (`CodeEditor`, `DiffView`, `languageFor`) | lazy subpath only, never the eager barrel. |
| 17 → 18 | `features/files/FileViewer.tsx`, `use-open-file.ts` | 18 adds edit mode to the same viewer. |
| 17 → 21 | drag type `application/x-pap-path` | 17 sets it on tree rows; 21 reads it on the composer. |
| 21 (web) | `TextField` props, `composer/menus.ts` (`ComposerMenu`, `composerFieldProps`) | the only key path of the composer field; M7's `useComposerCommands` plugs into it (agreements 7, 22). |
| 1, 3a, 5, 6a, 9, 10b, 12 → 22 | `docs/agents/files.md`, `terminal.md`, `policy.md` | 22 writes them from the final code. |

## Controller rulings (pre-dispatch)
- MC1 [21, M7 Task 27, rebase] Composer menus share M8's `ComposerMenu` shape (`open`, `close`, `onKeyDown`, `combobox`) and compose through `composerFieldProps([mentions, …])`. M7's `useComposerCommands` returns that shape (plus its `menu` element) and joins the list at M7's rebase on M8. — why: one key path, one combobox, one menu open at a time (agreements 7, 22) — cost if wrong: a rebase hunk.
- MC2 [10b, 12] `Config.userHome` in `kernel/config.ts` and `testing/harness.ts` merges as a union (amends agreement 10). — cost if wrong: none.
- MC3 [8] M8's one line in `packages/pi-host/src/host.ts` merges as a union (amends agreement 8). — cost if wrong: none.
- MC4 [6b, 7] Keep Node's 300 s request timeout for uploads (25 MiB needs about 700 kbit/s), stated explicitly. No owner question: a 4G upload is several times faster. Revisit only if the owner reports a failed slow upload. — cost if wrong: one config value.
- MC5 [10b] If node-pty 1.1.0 hands a daemon file descriptor to the shell, stop and report BLOCKED, as the plan says. The controller rules then. — cost if wrong: n/a.
- MC6 [3b, 6a, 6b, 8, 12] The residuals the planfix wrote down are accepted and documented in `docs/agents/*.md` by Task 22: a case-insensitive filesystem spelling of a fresh Pi session file, the folder-swap window between the temp check and the rename, check-then-rename without hard links, and the generic `prompt_rejected` when Stop drops a text prompt. — why: each needs an unusual filesystem or a race with the owner's own action — cost if wrong: a documented residual.

## Progress
Task 1: dispatched implementer (Sonnet), BASE 24117ab, brief task-1-brief.md
Task 1: implementer DONE (bff373a) — gate green, 6361 unit; notes: edited 3 permission-count tests (M7 merge carry), typecheck needs build first (env). Review dispatched (Sonnet).
Task 1: review (Sonnet) Approved — 0 C / 0 I; minors parked: commit body lacks bundle before→after line; TokenCreate.tsx:105 RISK_NOTES between imports; two stale test titles; no render test for files:read/operate notes; HOOK_CONFIG_NAME not cross-checked against pi-host regex
Task 1: complete (bff373a)
Task 2: dispatched implementer (Sonnet), BASE bff373a, brief task-2-brief.md
Task 2: implementer DONE_WITH_CONCERNS (87ce0d4) — unit 6397, int 408+1 skip, smoke ok; concerns: checklist not itemised, malformed covers 2 reasons, int test drives system.ping params.mode (test hook?), ws-server.ts 372 lines. Review dispatched (Opus).
Task 2: review (Opus) Approved — 0 C / 0 I; mutation probe: revoke closeAll and server-close loop untested, throwing-auth catch, cross-connection isolation, ok:false path, vacuous assertion :117, test client drops undecodable frames, no bundle line. Ruling: test-only fix round 1 (decision 73: controller re-verifies). Resumed implementer.
Task 2: test-only fix round 1 DONE (71c1520) — controller re-verified: ws-server.binary.int 10/10 green; mutation 'binary.closeAll() removed from revoke' → 'closes with 4401 … between two binary frames' FAILS; restored clean. Bundle 87ce0d4: +0 KB (codec not imported by web). Nits left: index.ts export order, explicit ack branch.
Task 2: complete (87ce0d4, 71c1520)
Task 3a: dispatched implementer (Sonnet), BASE 71c1520
Task 3a: implementer DONE (0b313a0) — unit 6436; added boundary-bed.ts + fake-projects roots. CARRY to Task 5: add Config.userHome (M8R118, MC2) where BoundaryConfig is built. Review dispatched (Opus).
Task 3a: review (Opus) Needs fixes — 0 C / 2 I / 9 m. Spec ✅; userHome correctly left to Task 5.
- I1: the "stricter of both spellings" protection (boundary.ts:143-145) is untested; a one-spelling mutant passes every test.
- I2: with a project rooted at `/`, a token reads `/proc/<pid>/environ`. Probe confirmed.
- Ruling MC7 [3a, 3b, 5] (I2): for a token caller, `judgeName` answers `token_hidden` for any path, spelled or real, under `/proc`, `/sys`, `/dev`, `/run` or `$XDG_RUNTIME_DIR` (when set). Browser sessions are unchanged: they can open a terminal anyway (f1). Test with root `/` for each prefix, both spellings, plus a mutation check. Why: pseudo-filesystems and runtime sockets hold process secrets and are never project content. Cost if wrong: a token cannot browse /dev or /run, which is no loss.
- CARRY to Task 5: pass BOTH spellings of the home folder (as typed and realpath) into BoundaryConfig, with a test where `~` is a symlink: `~/.bashrc` stays protected and `~/.ssh` is hidden from tokens (review minor).
Task 3a: fix round 1/5 → resume implementer (I1, I2/MC7, minors except the Task-5 carry)
Task 3a: fix round 1 DONE (6b274f6) — I1 tested + mutations; MC7 via required BoundaryConfig.runtimeDirs (CARRY to Task 5: supply runtimeDirs + both home spellings). Scoped re-review dispatched (Opus).
Task 3a: re-review 1 (Opus) All addressed — 0 open C/I.
Task 3a: complete (0b313a0, 6b274f6)
Task 3b: dispatched implementer (Sonnet), BASE 6b274f6
Task 3b: implementer DONE (34b97c7) — 74 focused tests, unit 6473; tests use a fake clock ±1h (same-ms hard-link refusal); 6 mutations (one survivor fixed by a swapped-folder test). Review dispatched (Opus).
Task 3b: review (Opus) Needs fixes — 0 C / 7 I (6 plan-mandated) / 9 m, all probe-confirmed. Spec ❌: Step 4's refresh mutation check is not met; a loop-only mutation passes all 26 tests.
- Ruling MC8 [3b, 5, 10b]:
  - I1: the deny set remembers a private key (`dev:ino:birthtimeNs`) for the daemon's lifetime, so a file renamed away or a rotated backup alias stays refused.
    - Cap at 100 000 keys. A full set marks the walk unable to vouch, and every file with nlink > 1 is then refused. Never evict.
    - CARRY to Task 5: `PRAGMA wal_checkpoint(TRUNCATE)` before closing `state.db` and `search.db`.
    - Document the remaining window in `files.md` (Task 22).
  - I2: any walk error other than ENOENT marks the walk unable to vouch (`capped = true`).
  - I3: the deny set walks ALL of `$PAP_HOME` except the `papHomeOpen` exclusions it is given. That covers `search.db` and its `-wal`/`-shm`. CARRY to Task 5: supply them.
  - I4: on Linux, any `/proc/self/fd` readlink failure throws `BoundaryError("moved")`. The path-only fallback stays only where `/proc` is absent.
  - I5: `O_NOCTTY` on every open in `safe-open.ts`, asserted by a test. CARRY to Task 10b: an integration test opening a pty slave through the boundary once node-pty lands.
  - I6: the ctime refresh tests follow the review's recipe, with the converse case. Rerun the loop-only mutation.
  - I7: judge the final destination name (`join(dirname(where), basename(input.real))`), never the temp name. Add a token test with roots `[home]`.
  - Minors: apply those for 3b; record the review's carry notes for Tasks 5/6 here.
  - Why: each finding is a probe-confirmed way to serve private data or to stop the daemon. Cost if wrong: n/a.
- Side note (preview ops): systemd's `Restart=on-failure` treats SIGHUP/SIGTERM/SIGINT/SIGPIPE as clean exits. Consider `Restart=always` for pap-preview later (owner ops, not M8).
Task 3b: fix round 1/5 → resume implementer
Task 3b: fix round 1 DONE (d5715d3) — 84 kernel/fs tests, unit 6483; I1–I7 + 3b minors; DenySources {files, folders, skip}.
- Ruling MC9 [6b]: uploadName additionally refuses `\p{Default_Ignorable_Code_Point}` (local to names, the shared INVISIBLE is untouched) — CARRY to Task 6b.
- Ruling MC10 [5, 22]: the deny set's `files`/`folders` also cover the owner's usual secret stores: ~/.ssh, ~/.gnupg, ~/.aws, ~/.config/gh, ~/.kube, ~/.docker/config.json, ~/.netrc, ~/.git-credentials. CARRY to Task 5 (wiring). Other hard links to non-pap secrets are a files.md residual (Task 22) — why: hard links into a project otherwise serve them to tokens — cost if wrong: a slightly longer walk at boot.
- CARRY to Task 5: papHomeOpen skip list; WAL checkpoint(TRUNCATE) before closing state.db/search.db; both home spellings; runtimeDirs; Config.userHome. Tasks 5/6: map BoundaryError + errno to not_found. Task 10b: pty-slave integration test. Task 22: FUSE open without deadline, walks not rate limited.
Scoped re-review dispatched (Opus).
Task 3b: re-review 1 (Opus) Open — N1 (Important, regression of I3): full $PAP_HOME walk never follows symlinks (deny-set.ts:81-83); symlinked backups/secrets/exports/state.db fall out (probe: alias served). Ruling MC11 [3b]: follow a symlinked entry once (visited dev:ino set against cycles, counted in the same cap, fail-closed when full) AND keep M8R103's named entries in addition to the full walk. Fix round 2/5 → resume implementer.
Task 3b: fix round 2 DONE (1409833) — follows links once (visited dev:ino:birthtime), named entries kept; mutations fail. Scoped re-review 2 dispatched (Opus).
Task 3b: re-review 2 (Opus) Approved — N1 addressed; 5 minors → CARRY to Tasks 5 and 22 (see task-3b-rereview-2.md).
Task 3b: complete (34b97c7, d5715d3, 1409833)
Task 4: dispatched implementer (Sonnet), BASE 1409833
Task 4: implementer DONE_WITH_CONCERNS (9823dca) — 38 unit + 15 int (real git 2.53); concerns: clean filters run on status/diff (M8R20 residual); diff drivers run unless caller passes --no-ext-diff/--no-textconv; blank diff.external fails safe; pager untestable without tty.
- Ruling MC12 [4, 9]: the runner itself adds `--no-ext-diff --no-textconv` to every `diff`, `log`, `show` invocation (never relies on Task 9), with real-git tests that a planted diff.<driver>.command / textconv never runs through any of them — cost if wrong: none (pap never wants external diffs).
- Ruling MC13 [post-merge]: repository-local filter drivers (filter.*.clean/smudge/process, except M7's exact git-lfs entries) still run when the daemon runs `git status` for the Review pane — a planted .git/config needs a prior write, same threat as M7 m3. After BOTH merges, the vcs runner should consult M7's repo config guard and, on refusal, report "this repository's config runs programs" with a one-time "run git anyway" in the Review pane. Not in M8 (M7's guard is not on this branch): residual documented by Task 22, follow-up proposed to the owner for the M7 rebase or M9.
Review dispatched (Opus).
Task 4: review (Opus) Needs fixes — 0 C / 5 I (all real-git probes with positive controls) / 9 m. Spec ❌.
- I1: MC12 missing; log -p, show and diff ran planted drivers.
- I2: log.showSignature + gpg.program ran a program.
- I3: diff.submodule=diff ran a submodule's driver.
- I4: GIT_NO_LAZY_FETCH needs git ≥ 2.44; repo protocol.*.allow overrides -c protocol.allow=never, and a promisor ran a program.
- I5: a no-.git project folder holding a bare-repository layout of ordinary files ran a planted filter on status.
- Ruling MC14 [4]: apply the reviewer's fixes.
  - I1: insert `--no-ext-diff --no-textconv` after the subcommand for diff/log/show. Refuse argument arrays where a non-flag position starts with `-` beyond the runner's own flags, as the review says. Real-git tests and a mutation check.
  - I2: `log.showSignature=false` goes into SAFE_CONFIG.
  - I3: `diff.submodule=short` goes into SAFE_CONFIG, and `--submodule=diff` is refused.
  - I4: `GIT_ALLOW_PROTOCOL: ""` in gitEnv, with a promisor int test and a mutation check.
  - I5: `safe.bareRepository=explicit` in SAFE_CONFIG, with an int test; normal repos, submodules and linked worktrees keep working.
  - Two minors that affect later tasks are applied now: on timeout, kill git's whole process group (spawn detached, kill -pgid, bounded); stdin is /dev/null unless an `input` option is given (Task 5 uses it for `check-ignore --stdin`).
  - The other minors are applied when local to the runner.
  - MC13's premise is re-confirmed: with I5 fixed, a repository-local filter again needs a `.git/config` write, which M5 confirms.
  - Why: each finding is a probe-proven program execution by the daemon. Cost if wrong: n/a.
Task 4: fix round 1/5 → resume implementer
Task 4: fix round 1 DONE_WITH_CONCERNS (8d90ac5) — I1–I5 + minors; git int 31/31 with positive controls; spawn detached + pgid kill; stdin empty unless input. No orphan processes found (controller ps check).
- Ruling MC15 [5]: `check-ignore --stdin` is incompatible with `--literal-pathspecs` (exit 128). The runner drops `--literal-pathspecs` (and does not set GIT_LITERAL_PATHSPECS) for `check-ignore` only — stdin lines are path names matched against ignore rules, not pathspecs — with a test that a `:(glob)`-looking name is treated literally (no magic) — CARRY to Task 5 (runner change in Task 5, Opus review). Task 22: the clean-filter residual names `diff` as well as `status`.
Scoped re-review dispatched (Opus).
Task 4: implementer stopped by controller (stray background timers kept waking it); resume by message if needed. implementer-common.md now forbids background work.
Task 4: re-review 1 (Opus) Open — N1 (I2 partly): repo `format.pretty=format:%G?` (or a caller's --show-signature / %G?) still runs a planted gpg.program / gpg.x509.program / gpg.ssh.program through log/show. N2 (new): refusals only scan arguments before the first `--`; `--decorate-refs --` lets a later --ext-diff/--textconv/--submodule=diff through (4 probes).
- Ruling MC16 [4]: blank `gpg.program=`, `gpg.x509.program=`, `gpg.ssh.program=` in SAFE_CONFIG (int test: %G?, --show-signature, format.pretty, each program kind silent); refusal scans EVERY argument (a pathspec literally named like a refused option is refused — fail-closed), tests for the decorate-refs shapes. Mutation checks.
Task 4: fix round 2/5 → resume implementer (stopped earlier; resume by message)
Task 4: fix round 2 DONE (d18d22c) — gpg blanks (18 controls), every-arg refusal; git int 48/48; unit 6549. Ruling MC17 [4]: the runner accepts only an explicit subcommand allowlist (rev-parse, status, diff, log, show, cat-file, ls-files, check-ignore, hash-object); any other subcommand (blame, range-diff, grep, …) is refused before git starts — a later task that needs one adds it with its own injection review. Folded into round 2 as a small follow-up before the re-review.
Task 4: MC17 follow-up DONE (6b672a2) — subcommand allowlist, 16 refused rows, 9 smokes; int 48/48. Scoped re-review 2 dispatched (Opus) over 8d90ac5..6b672a2 (round 2 + MC17).
Task 4: re-review 2 (Opus) Open. N1, N2 and MC17 are addressed, but three allowed subcommands still start a planted program from one caller option:
- I1: `--remerge-diff`, or `--diff-merges=remerge` / `r`, or `-m` with log.diffMerges=remerge, runs the merge driver.
- I2: `--alternate-refs` runs core.alternateRefsCommand.
- I3: `status -v` runs textconv, and git has no `status --no-textconv`.
- Ruling MC18 [4] (bound the problem as M7 did):
  - Per-subcommand OPTION allowlist. The runner accepts only the exact options (and value shapes) its planned callers use: derive them from the plan text of Tasks 5, 9 and 19, listed in the report. Every other option is refused before git starts, and so is any cluster containing a non-allowed letter.
  - Defence in depth: add `-c log.diffMerges=separate` and `-c core.alternateRefsCommand=` to SAFE_CONFIG.
  - Tests: I1–I3 shapes refused, each planned caller's exact argv accepted (one smoke each), a real mutation check.
  - A later task needing a new option extends the allowlist with its own injection review.
  - Why: three review rounds each found new option vectors. Cost if wrong: one allowlist line per new caller option.
Task 4: fix round 3/5 → resume implementer
Task 4: fix round 3 DONE (db867f9) — exact per-subcommand option allowlist (table with plan refs), log/show accept only runner flags, hash-object no positional; SAFE_CONFIG +2; int 52/52; unit 6629. Residuals: FIFO stalls (m10), core.worktree redirect (m11, needs .git/config write), clean filters. Scoped re-review 3 dispatched (Opus).
Task 4: re-review 3 (Opus) All addressed — 49 allowed argv run no planted program (only the accepted MC13 filter residual); minors m14, m6 parked; m15 → Task 5.
Task 4: complete (9823dca, 8d90ac5, d18d22c, 6b672a2, db867f9) — 3 fix rounds + MC17 follow-up
- Ruling MC19 [5]: Task 5 now wires security code (deny-set sources, BoundaryConfig, WAL checkpoint, check-ignore runner change) → reviewer upgraded Sonnet → Opus under the owner-approved table (Opus for security tasks). Carries collected in task-5-carries.md.
Task 5: dispatched implementer (Sonnet), BASE db867f9, carries task-5-carries.md
Task 5: implementer DONE_WITH_CONCERNS (a18478d) — 10 carries done (WAL pragma mutation equivalent: SQLite empties log on close); unit 6735, int 468+1, bundle 195.9; deferred module fields to 6a/6b/7; non-UTF-8 → editable:false; inner-repo listing note → Task 22. Review dispatched (Opus, MC19).
Task 5: review (Opus) Needs fixes — 0 C / 3 I / 12 m; spec ❌ (I1 plan-mandated M8R29; readOnly not passed from daemon.ts; deny-set deadline starts at first open, not boot). I1: missing Pi folder + symlinked typed path → real spelling unprotected (probe read auth.json, session and token). I2: @ ranking unbounded CPU (up to 214 s). I3: non-git walk has no deadline/cancel/folder cap; expired cache starts a second build (dead NFS hangs).
- Ruling MC20 [5]: apply the reviewer's fixes — I1 resolve a missing path through its nearest existing parent (realpath(parent)+rest) and recompute while missing, test not_found after Pi creates the file post-walk; I2 score only the tail (~256 chars or name+parent), reuse arrays, per-search budget → truncated:true, crossing test; I3 Clock deadline answering partial with truncated:true, folder cap / per-folder read cap, join an in-flight build regardless of TTL, deadline test; spec: pass readOnly from daemon.ts, start the deny-set deadline at boot; make the WAL test discriminating (reader SELECT before insert, per review); apply the other minors local to Task 5. Real mutation checks.
Task 5: fix round 1/5 → resume implementer
Task 5: fix round 1 DONE (7ea3a53) — I1 parent-resolved Pi folder at boot (residual: parent turning into symlink later), I2 tail scoring + 25M-cell budget, I3 5 s Clock deadline + caps + join in-flight; readOnly passed; deny walk at composition; WAL test discriminating; unit 6747, int 468+1. Scoped re-review dispatched (Opus).
Task 5: re-review 1 (Opus) Open — N1 (new): rank.ts:975-985 charges cells for paths the quick check rejects → exact-name search misses on 100k index. N2 (spec M8R28): daemon.ts +11 lines (329) vs ≤10. Fix round 2/5: charge only scored cells (test: exact name found on a 100k ordinary index within budget); move the extra wiring into compose-workspace so daemon.ts adds ≤10 lines (agreement 24 budget).
Task 5: fix round 2 DONE (6d2ed46) — budget charges scored cells only + 200k visit cap; daemon.ts +4 (322). Scoped re-review 2 dispatched (Sonnet: small non-security fix).
Task 5: re-review 2 (Sonnet) All addressed; controller re-ran rank.test.ts: 12/12 green.
Task 5: complete (a18478d, 7ea3a53, 6d2ed46) — 2 fix rounds
Task 6a: dispatched implementer (Sonnet), BASE 6d2ed46
Task 6a: implementer DONE (fbccd51) — unit 6793, int 469+1, bundle 196.0; createWorkspaceModules(deps, workerUmask); Judged.exists added. Review dispatched (Opus).
Owner (2026-10-13 ~13:40 UTC): keep option A — full rigor (Opus reviews and re-reviews on security tasks), no scope cut; revised ETA M8 ~02:00 UTC, M7 ~10:00 UTC 14 Oct.
Task 6a: review (Opus) Approved — 0 C / 0 I.
Task 6a: complete (fbccd51)
Task 6b: dispatched implementer (Sonnet), BASE fbccd51; carry MC9 (uploadName \p{Default_Ignorable_Code_Point})
Task 6b: implementer DONE_WITH_CONCERNS (31be0e0) — unit 6824, int green; upload.ts added; success meta minimal; requestTimeout pinned at 300000; files.md/web copy → Task 22 + web tasks. Review dispatched (Opus).
Task 6b: review (Opus) Approved — 0 C / 0 I; 10 minors parked (task-6b-review.md).
Task 6b: complete (31be0e0)
Task 7: dispatched implementer (Sonnet), BASE 31be0e0
Task 7: implementer DONE_WITH_CONCERNS (2a0f87c) — unit 6861, int 470+1, bundle 196.1; attachments/ skipped in deny walk but refused to files routes; claims re-open via deny set; brief defect (60 MiB vs 25 MiB cap) handled with injected limits; short-body refusal added; retention until M10. Review dispatched (Opus).
Task 7: review (Opus) Approved — 0 C / 0 I; 9 minors parked.
- Ruling MC21 [5, 7] (amends MC8 I3): `$PAP_HOME/attachments/` is skipped by the deny walk (otherwise a re-walk marks every pending upload private and claims answer not_found); it stays refused to the files routes and outside papHomeOpen; claims re-open the pending file through the deny set (hard link to state.db → not_found, tested) — cost if wrong: attachments readable only via claims.
Task 7: complete (2a0f87c)
Task 8: dispatched implementer (Sonnet), BASE 2a0f87c
Task 8: implementer DONE_WITH_CONCERNS (9ad8b84) — unit 6901, int 477+1, smoke ok, bundle 196.1; queue deviation: start() may return a promise, an image prompt settles when Pi answered (prompts behind it wait); prescribed-code fixes (papHome, logged prepare, byte()); prompt in service.ts + prompt-attachments.ts. Review dispatched (Opus).
Task 8: review (Opus) Needs fixes. The queue deviation is endorsed: "answered" means preflightResult, never the end of the turn, and M2 steering holds (probe P1).
- I1: Stop does not release the in-flight wait (probe P3: a text after Stop sits 8 s).
- I2: Pi's user-message echo carries the image base64 past the 4 MiB IPC cap (probe P4: 12.6 MB message_start/end dropped, two extension_error notices, the user message missing from the live view); missed by plan M8R41.
- Ruling MC22 [8]: apply the reviewer's fixes.
  - I1: `dropWaiting()` also releases the in-flight wait (race with a stop signal). Unit test plus int test (`/block` + image → abort → text `started`), with a mutation check. Task 22 documents the residual "an image on an extension command blocks until it ends or Stop".
  - I2: `toWireEvent` replaces every image block with `{type:"image", mimeType, omitted:true, bytes}`, and wire-clip keeps `bytes` when there is no data. Int test with 3 noise PNGs and no extension_error.
  - Minors now:
    - 1: refuse `stat.nlink !== 1` and read at most MAX+1 bytes;
    - 3: settle the hold in a finally;
    - 4: fix the overclaiming comments.
  - The other minors are parked.
Task 8: fix round 1/5 → resume implementer
Task 8: fix round 1 DONE (9341302) — Stop generation reset (race redundant per mutation), image blocks omitted in echoes, nlink!==1, bounded read, finally; unit 6906, int 479+1, smoke ok. Scoped re-review dispatched (Opus).
Task 8: re-review 1 (Opus) All addressed — P3/P4 re-run green. Pre-existing Important (P5): a tool result with an image (Pi read on a 1500×1500 PNG) → tool_execution_end 8.4 MB > 4 MiB record cap, dropped (extension_error, daemon never sees the end). Ruling MC23 [8 follow-up]: toWireEvent omits image data in tool results too (tool_execution_end and any tool-result content block → {type:'image', mimeType, omitted:true, bytes}); int test with a read of a large noise PNG → no extension_error, the end event arrives; mutation check. Small follow-up on Task 8, Sonnet scoped re-review.
Task 8: MC23 follow-up DONE (eb180cb) — depth-bounded (6) walk strips every image block (content + structuredContent) in tool results and echoes; int 480+1. Scoped re-review (Sonnet).
Task 8: follow-up re-review (Sonnet) All addressed; minors (depth>6 residual, non-plain objects) parked.
Task 8: complete (9ad8b84, 9341302, eb180cb)
Task 9: dispatched implementer (Sonnet), BASE eb180cb
Task 9: implementer DONE (868ad35) — unit 6987, int 482+1, bundle 196.6; 28 mutations; runner untouched; :0:<path> index side; line-counts.ts; subfolder-of-repo root → repo:false; failed/git_missing → internal; token-scope line counts. Review dispatched (Sonnet, per plan).
Task 9: review (Sonnet) Needs fixes — 1 I: one shared status object per root; a token with vcs:read sees names/kinds/line counts of files its boundary calls not_found (.mcp.json, .pi/mcp.json, home dot-entries).
- Ruling MC24 [9]: a separate token view keyed per caller scope (e.g. `token:<root>`), entries dropped where judgeName(token scope) refuses the path or oldPath, totals recomputed; the owner view keeps every file and real counts. Token test + mutation check. Also minor: arm the poll when a subscription finds a fresh cache and no timer (watch/openSubscription order), with a test; add a real-git test of the index and commit sides and a path with a colon.
Task 9: fix round 1/5 → resume implementer
Task 9: fix round 1 DONE (cbea164) — token:<root> filtered stream (path + oldPath), owner full; poll armed before subscription; real-git index/commit/head sides with colon paths; unit 6994, int 482+1. Scoped re-review dispatched (Opus — token visibility).
Task 9: re-review 1 (Opus) Open — N1 (new): owner-scope line counter counts an untracked symlink (innocent -> .mcp.json) → token sees additions:7 for a hidden target (probe). Ruling MC25 [9]: untracked symlinks are never line-counted (count null for everyone); test + mutation. Fix round 2/5.
Task 9: fix round 2 DONE (b822306) — lstat first, links never counted; unit 6995, int 482+1. Scoped re-review (Sonnet, small).
Task 9: re-review 2 (Sonnet) All addressed.
Task 9: complete (868ad35, cbea164, b822306) — 2 fix rounds
Task 10a: dispatched implementer (Sonnet), BASE b822306
Task 10a: implementer DONE (5c23cf7) — node-pty 1.1.0 built (gcc 15.2, 4.2 s), lazy loader, boot probe, smoke check; frozen install ok; unit 6998, int 482+1. Review dispatched (Sonnet).
Task 10a: review (Sonnet) — supply chain ok; 1 I: daemon.ts +12 over a29d52a vs cap 10 → move the boot probe into compose-workspace. Fix round 1 (small; controller verifies line count + gates).
Task 10a: fix (616235d) — controller verified: daemon.ts numstat vs a29d52a = 9/0; probe in compose-workspace.ts:111.
Task 10a: complete (5c23cf7, 616235d)
Task 10b: dispatched implementer (Sonnet), BASE 616235d; carries: MC8 I5 pty-slave integration test via the boundary; MC5 daemon-fd leak → BLOCKED
Task 10b: implementer DONE_WITH_CONCERNS (dcdef7e) — unit 7021, int 489+1, smoke ok; only terminal fds (MC5 clean), MC8 I5 test; trap-HUP job killed under dash/bash/zsh; 7 mutations; controller ps check: no orphans. Concerns: dash holds /dev/tty too (test accepts), sweep() does not reset pap-<h>-term-* units, I5 test needs python3+setsid. Review dispatched (Opus).
Task 10b: review (Opus) Needs fixes — spec ✅ (MC5 clean). 3 I, all probe-confirmed:
- I1: one EPERM (sudo in the terminal) aborts ptyKill. Later processes are never signalled, there is no SIGKILL, and the timer stays armed.
- I2: the single SIGKILL pass misses children forked during the /proc read (23–25 survivors in 6/6 runs without scopes).
- I3: the shell inherits the daemon's umask 077, so files are 0600 and folders 0700, against R114.
- Ruling MC26 [10b]:
  - I1: EPERM is treated like "gone" per process: skip it, log `pty_kill_denied` once per step, continue. Unit test.
  - I2: repeat the SIGKILL pass until a fresh read finds nobody, at most 8 passes inside the 5 s wait. Unit test with a late-appearing process.
  - I3: the shell gets the daemon's STARTING umask (R114) through the fixed wrapper `/bin/sh -c 'umask "$1" && shift && exec "$@"' pap-shell <mask> <shell> [-l]`. The process umask is never flipped around the spawn. Unit case plus an int test printing the umask.
  - Minors now: strip MANAGERPIDFDID; `sweep()` also resets failed `pap-<h>-term-*` units; exit signals are reported by name.
  - Task 22 carries: without scopes, setsid jobs survive Close; systemd-run --user jobs survive by design; nohup jobs are killed at 2 s.
Task 10b: fix round 1/5 → resume implementer
Task 10b: fix round 1 DONE_WITH_CONCERNS (403c574) — EPERM skipped + logged, SIGKILL ≤ 8 passes, umask wrapper, minors; unit 7027, int 491+1; ps clean. CARRY to Tasks 11/12: pass workerUmask to ptySpec. Residual: fork-faster-than-8-passes without scope (scope reap covers) → terminal.md (Task 22). Scoped re-review (Opus).
Task 10b: re-review 1 (Opus) All addressed — 4 minors N1–N4 parked (task-10b-rereview-1.md).
Task 10b: complete (dcdef7e, 403c574)
Task 11: dispatched implementer (Sonnet), BASE 403c574; carry: ptySpec needs the sessions module's workerUmask
Task 11: implementer DONE_WITH_CONCERNS (426b06d) — unit 7089, int 491+1; 30 mutations; detach(connectionId, streamId) (CARRY Task 12: pass ctx.connectionId); modules/terminal/index.ts added; registry.create takes launch() (Task 12 builds ptySpec with workerUmask); stale partial ack can hold the PTY up to 2 s (judge vs RT-06). Review dispatched (Opus).
Task 11: review (Opus) Needs fixes. Spec ❌; the detach(connectionId, streamId) change is correct and Task 12 adopts it.
- I1: any ack on a paused stream restarts the 2 s timer and clears stale. Probe: a hidden tab keeps the PTY paused 98.8% of the time (RT-06 / f2 / M8R57 violated).
- I2: resuming at `exit` is too late with node-pty 1.1.0 (it destroys a paused socket after 200 ms before emitting exit). Real-PTY probe: the last 703 bytes are lost (M8R58).
- Ruling MC27 [11, 12]:
  - I1: the 2 s count from the START of the pause. An ack that does not resume the stream only advances `acked`, and `offset === acked` acks are ignored. A stream leaves `stale` only when an ack actually resumes it (lag ≤ 256 KiB), and its next pause restarts at 0. Invert flow.test.ts:174, add the review's tests plus a mutation.
  - I2: while the PTY is paused, check every 50 ms on the Clock whether the shell is alive (injected `alive()`, /proc/<pid>/stat start compared with pty.start) and resume as soon as it is dead. The fake PTY must model node-pty's paused-exit behaviour. CARRY to Task 12: a real-PTY int test proving the shell's output arrives before the `exit` frame.
  - Minors: the scope reap on a natural shell exit kills `nohup` jobs; this is ACCEPTED (safe) and documented in terminal.md by Task 22 (escape hatch: systemd-run --user). Align `AttachInfo.start` with the first frame if cheap, else note it.
Task 11: fix round 1/5 → resume implementer
Task 11: fix round 1 DONE (ba50554) — stale from pause start, alive() poll 50 ms, faithful fake PTY; unit 7098, int 491+1; mutations killed. CARRY Task 12: real-PTY int test. Scoped re-review (Opus).
Task 11: re-review 1 dispatched (Opus), diff review-426b06d..ba50554.diff
Task 11: re-review 1 (Opus) All addressed — Minor N1: poll re-arm untested ('poll once' mutant survives) → CARRY Task 12 (kill the shell after an alive tick).
Task 11: complete (426b06d, ba50554)
Task 12: dispatched implementer (Sonnet), BASE ba50554; carries: detach(ctx.connectionId), ptySpec workerUmask (compose-workspace.ts:109), real-PTY paused-exit int test, poll re-arm test (Task 11 N1), umask int test via wiring
Task 12: implementer DONE_WITH_CONCERNS (8a477e7) — unit 7155, int 506+1, smoke ok, bundle 196.9; carries a/b/c done (mutants fail). Concerns: stop-order line in daemon.ts not pinned by a test (workspace closer repeats shutdown); used sessions.shutdownAll → wk.shutdown → killAllWorkerGroups → closers (M7 helpers.stopAll → REBASE-BRIEF M7); AGENTS.md PAP_MAX_TERMINALS → Task 22. Review dispatched (Opus).
Task 12: review (Opus) Needs fixes — I1 create during stop spawns a shell that outlives pap (probe spawned 2 killed 1); I2 daemon.ts +11 > +10. Ruling MC28 [12] (I1 closed flag + refusal, I2 trim, minors m1–m6 applied).
Task 12: fix round 1/5 → resume implementer
Task 12: fix round 1 DONE (196650c) — closing flag refuses create (capacity) incl. pending judge; daemon.ts 328; m1–m6; unit 7158, int 507+1. Concerns: try/log in compose-workspace untested; reconnect loop no mutant. Scoped re-review (Opus).
Task 12: re-review 1 (Opus) Approved — n1 service-side refusal unpinned (expect(bed.judged)) → CARRY Task 13; n2 daemon.md:9 STOP_DEADLINE_MS 15 s → 22 s → CARRY Task 22.
Task 12: complete (8a477e7, 196650c)
Task 13: dispatched implementer (Sonnet), BASE 196650c; carry: Task 12 n1 (expect(bed.judged) pin + mutant)
Task 13: implementer DONE_WITH_CONCERNS (6393dd3) — 35 int tests (33 + 2 it.fails), 22 mutations, int 540+2 fails+1 skip. Concern 1 SECURITY: node-pty master fd inherited by workers (bash tool sees /dev/ptmx → can type into owner's shell). Ruling MC29 [13, 22, M7 rebase]: worker closes inherited ptmx/pts fds at entry; shell/git residuals → Task 22. Pre-review fix → resume implementer, then Opus review of 196650c..HEAD.
Task 13: pre-review fix DONE (9176e3f) — worker closes inherited ptmx/pts at entry; worker repro passes; unit 7161, int 541+1 fails+1 skip; build+smoke ok. Review dispatched (Opus) on 196650c..9176e3f.
Task 13: review (Opus) Needs fixes — MC29 fix compliant; I1 %2e%2e row can never fail; I2 token at Pi folder not covered end to end (answers not_found). Ruling MC30 [13] (I1, I2 not_found, minors m1–m8, m10; m9 parked).
Task 13: fix round 1/5 → resume implementer
Task 13: fix round 1 DONE (56b43e4) — MC30 applied; extra R/%2e%2e/work/ok.txt row; unit 7161, int 545+1 skip; build+smoke ok. Scoped re-review (Sonnet, test-only + import).
Task 13: re-review 1 (Sonnet) Approved — all addressed.
Task 13: complete (6393dd3, 9176e3f, 56b43e4)
Task 14: dispatched implementer (Sonnet), BASE 56b43e4 (reviewer Opus per model table)
Task 14: implementer DONE_WITH_CONCERNS (4858aa4) — unit 7218, bundle 197.0; concerns: sink reset ordering vs queued writes (CARRY Task 20), attach refused (capacity) → offline state, no refused state; upload client caps only 25 MiB; windowTimers export. Review dispatched (Opus).
Task 14: review (Opus) Needs fixes — spec ✅; I1 stale attach answer on same socket detaches the shared stream (StrictMode → blank dead terminal). Ruling MC31 [14, 20] (I1 + m3–m11; m1, m2 CARRY Task 20).
Task 14: fix round 1/5 → resume implementer
Task 14: fix round 1 DONE (b5ad39b) — one attach in flight per socket, server-faithful bed, clamp resize, abort-safe uploads, split terminal-types/entry; unit 7228, bundle 197.0. CARRY Task 17/20: import TerminalHandle from terminal-types.ts. Scoped re-review (Opus, concurrency).
Task 14: re-review 1 (Opus) Approved — minor test gaps (reconnect during in-flight attach, answer while hidden) → CARRY Task 20.
Task 14: complete (4858aa4, b5ad39b)
Task 15: dispatched implementer (Sonnet), BASE b5ad39b; design hygiene (label-hud, aria-current, DESIGN.md selection mark)
Task 15: implementer DONE_WITH_CONCERNS (ccaa88f) — unit 7260, build-output 26; bundle 197.0 → 199.7 (+2.7 vs +0.8 predicted, unexplained); early terminal click may double-create; unavailable module → enabled button + error. Review dispatched (Sonnet).
Task 15: review (Sonnet) Approved w/ I1 recommended (early click → second terminal). Ruling MC32 [15, 20]. Fix round 1 → resume implementer; controller re-verifies.
Task 15: fix round 1 DONE (8045d73) — controller verified diff: ready gate on first snapshot, recent map kept, cap test, aria-current; unit 7266, bundle 199.9. Concern (stream never answers → busy forever) only if subscribe.terminal fails (browser sessions always subscribe; launch errors surface on create) → accepted.
Task 15: complete (ccaa88f, 8045d73)
Task 16: dispatched implementer (Sonnet), BASE 8045d73
Task 16: implementer DONE_WITH_CONCERNS (9aa3d33) — unit 7299, build-output 27, single @codemirror/state; editor 117 KB / diff 110 KB gzip lazy; CARRY Task 17: app-level keepsLazyOnly check for cm-editor/cm-mergeView once the files pane imports @pap/ui/code. Review dispatched (Sonnet).
Task 16: review (Sonnet) Approved — CARRY Task 17: app-level keepsLazyOnly (cm-editor, cm-mergeView); token overrides for CodeMirror base-theme panels/buttons (.cm-panel, .cm-button, search) under night/hc; viewer size cap per files.read limits. Minor parked: DiffPane rebuild on prop change.
Task 16: complete (9aa3d33)
Task 17: dispatched implementer (Sonnet), BASE 9aa3d33; carries: app keepsLazyOnly cm markers, CM base-theme token overrides, viewer size cap
Task 17: implementer DONE_WITH_CONCERNS (600769b, 3f65501) — unit 7352, build-output 28, bundle 200.1; CARRY Task 19: add cm-mergeView to keepsLazyOnly; CARRY Task 18: lift unsaved buffers (FileViewer keyed by path), replace NO_DIRTY; viewer cap 2 MiB (8 chunks). Review dispatched (Sonnet).
Task 17: review (Sonnet) Approved — minors → CARRY Task 18: folder evicted from 40-cache then reopened spins (use-folders.ts), keep Preview/Source mode across tab switch, disambiguate same-basename tab titles; docs/agents/web.md files-pane note → Task 22.
Task 17: complete (600769b, 3f65501)
Task 18: dispatched implementer (Sonnet), BASE 3f65501; carries: Task 17 minors a–c, lift buffers, NO_DIRTY
Task 18: implementer DONE_WITH_CONCERNS (4361e5f) — unit 7393, bundle 200.1 (files chunk 16.1); no Compare (M8R78 Reload/Overwrite only); stepUp prop optional; web.md → Task 22. Review dispatched (Sonnet).
Task 18: review (Sonnet) Approved — minors; Ruling MC33 small fix round (Mod-s stale draft, pane close drops dirty buffers, per-file busy, stale banner kept); controller verifies.
Task 18: fix round 1/5 → resume implementer
Task 18: fix round 1 DONE (cec3e60) — controller verified: editor text saved, per-file lock, dirty-pane close confirm (native window.confirm; split replace / project removal unguarded → parked, polish lot); unit 7401, bundle 200.2.
Task 18: complete (4361e5f, cec3e60)
Task 19: dispatched implementer (Sonnet), BASE cec3e60; carry: cm-mergeView keepsLazyOnly
Task 19: implementer DONE_WITH_CONCERNS (f41aece) — unit 7441, build-output 28 (cm-mergeView added), bundle 200.3 (changes 7.3 lazy); Open in Files doesn't preselect the file; pane subscribes feedVcs itself; retry keeps old error. Review dispatched (Sonnet).
Task 19: review (Sonnet) Needs fixes — I: vcs store never reset on sign-out (account leak). Ruling MC34 [19, 20, 21] (reset all M8 stores in AppShell cleanup). Fix round 1 → resume implementer; controller verifies.
Task 19: fix round 1 DONE (2d8afdb) — controller verified: AppShell cleanup resets vcs, terminal (+recent/inFlight/unknownOutcome), unsaved-files, folder memory; signout test + mutants; unit 7442, bundle 200.7.
Task 19: complete (f41aece, 2d8afdb)
Task 20: dispatched implementer (Sonnet), BASE 2d8afdb; carries MC31 m1/m2, Task 14 re-review test gaps, MC34 reset, xterm lazy markers
Task 20: implementer DONE_WITH_CONCERNS (53f5172) — unit 7497, build-output 29, bundle 200.9 (terminal 117.4 lazy); carries a–e; split-pane terminal Close does nothing; report lacks full checklist table. No stray processes. Review dispatched (Sonnet).
Task 20: review (Sonnet) Needs fixes — I1 loadAddon outside try (WebGL failure kills pane); I2 split-pane Close dead. Ruling MC35 [20].
Task 20: fix round 1/5 → resume implementer
Task 20: fix round 1 DONE (776efa9) — loadAddon in try + dispose, split Close unsplits, replayEnd cleared, single feeder pinned; unit 7503. Scoped re-review (Sonnet).
Task 20: re-review 1 (Sonnet) Approved.
Task 20: complete (53f5172, 776efa9)
Task 21: dispatched implementer (Sonnet), BASE 776efa9; MC1, MC34, cross-plan composer limits
Task 21: implementer DONE_WITH_CONCERNS (f6021d3) — unit 7565, bundle 201.2 (session chunk 43.2); ComposerMenu gains optional fieldRef/dropPath (REBASE-BRIEF M7); no release RPC (pending expires); paste rule text/plain wins. Review dispatched (Sonnet).
Task 21: review (Sonnet) Approved w/ 1 I (send ignores failed attachment chip). Ruling MC36 [21]. Fix round 1 → resume implementer; controller verifies.
Task 21: fix round 1 DONE (1081537) — failed chip blocks send, clears only carried, fresh ids on Edit, stray drops prevented; unit 7571. Controller: composerFieldProps now holds useEffect behind an eslint-disable → Ruling MC37 rename to useComposerFieldProps. Fix round 2 (tiny) → resume implementer.
Task 21: fix round 2 DONE (14f85e8) — controller verified: no composerFieldProps / rules-of-hooks directive left.
Task 21: complete (693af85 [= f6021d3 reworded: bundle line added, same tree], 1081537, 14f85e8)
Task 22: dispatched implementer (Sonnet), BASE 14f85e8; carries in task-22-carries.md
Task 22: implementer DONE (886ae7c) — docs + ADRs 0030–0032 + m8-rulings; gates all green: unit 7571, int 550+1, smoke, budgets 201.2 KB. Review dispatched (Sonnet).
Task 22: review (Sonnet) Needs fixes — I: terminal.md:49 claimed repository-local filters refused (false: MC13). Controller fixed docs directly (fdcb3b2): terminal.md + m8-rulings.md + rulings.md MC29 corrected; OOM wording. 400-line cap is ESLint ts/tsx only → docs fine.
Task 22: complete (886ae7c, fdcb3b2)
FINAL REVIEW: dispatched (Opus), a29d52a..fdcb3b2 → final-review.md
FINAL REVIEW (Opus): Ready after fixes — 0 C, 4 I (I1 upload answer decode, I2 no M7 rebase brief, I3 attachments readable cross-session undocumented, I4 git-child PTY mask), 11 minors. Ruling MC38. I2 done by controller (.superpowers/m7-rebase-brief.md). Final fix dispatch (Sonnet, fresh).
FINAL FIX: DONE (15ebcad..6e59520, 9 commits) — I1, I3 docs, I4 git stdio mask, m1–m10; gates all green (unit 7582, int 551+1, smoke, budgets 201.2). Scoped final re-review (Opus).
FINAL RE-REVIEW (Opus): Ready — MC38 all addressed; N1 (fd-mask /dev/pts/*) + N2 (path-lock test order) fixed by controller (047f506 → 8c93459 after rebase), 5× green.
REBASE: on main 1eeb3f9, clean (66 commits). Branch ready to merge — awaiting owner OK.
