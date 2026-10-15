# M9 implementation rulings

Decisions taken while planning and executing [the M9 plan](../plans/2026-10-14-m9-worktrees-lanes.md) (git worktrees and lanes; 2026-10-14 to 2026-10-15). Order: the pre-dispatch ledger M9R1-M9R121 first (red-team applied, owner decisions in), then the controller's rulings during execution (MC1-MC26, from task reviews, fix rounds and the controller), then the places where the merged code differs from the plan. They override the plan text where they differ; the specs stay the authority. Decision log: M9's plan fix appended decision 81 for both milestones (M9 and M10); M9 never edits `decisions-log.md`.

Owner decisions taken during planning (decision 81, 2026-10-14, the M9 + M10 question page, 33 questions, every answer was the recommendation): they are M9R97-M9R111 below. M9 merges first (c1); an Opus implementer at fix rounds 4-5 was pre-approved (c2); Sonnet implementers on every task, never Haiku (c3); Opus reviewers on the security and concurrency tasks (c4); an Opus whole-branch review (c6); one unattended environment for every child nobody watches (c7); GitHub only (m9q5); lane scripts browser-only (m9q9).

Where an execution ruling below is stricter than the pre-dispatch text, the execution ruling wins: MC1 (the git allowlist: no `add -A` or `add -u`, `--no-deref`, `--force`, `--git-dir`), MC3 (the stored git dir, the pinned work tree), MC11-MC13 and MC17 (a restore never deletes what the undo capture did not hold), MC16 (Undo is a swap), MC19 (trust inheritance by lineage).

Withdrawn: M9R51 and M9R52 (GitLab's adapter task) went with owner answer m9q5; the numbers are not reused.

Format: `M9R<n> [tasks] decision - why - cost if wrong`. "(corrected: ...)" marks a planner ruling replaced by a red-team finding, a controller ruling or an owner decision. "(continued)" is a second paragraph of the same ruling. `M9-RT-n` are the red-team findings (`.superpowers/planfix-report-m9.md`). Task numbers are the plan's (1, 2a, 2b, 3, ..., 25). Topic notes: [lanes.md](../agents/lanes.md).

# M9 rulings ledger (pre-dispatch, 2026-10-14)

Source: the plan's "Rulings (pre-dispatch)" blocks and "Owner answers" section. Text is the plan's, kept as ruled; "binding below" and "at a glance" point to sections of the plan.

M9R1 [1] (corrected: M9-RT-01, RT-06; agreements 4, 5; M9R110) One permission domain `lanes` (`read`, `operate`, `admin`), after `pi` in `DOMAINS` (agreement 4: `[…, "terminal", "pi", "lanes", "automation", "usage", "inbox"]`).
  - `TOKEN_PERMISSIONS` stays one filter, with its own term `permission !== "lanes:admin"`.
  - `lanes:admin` holds what approves or runs code, sends code out, reaches a forge or destroys work: `approveScripts`, `runScript`, `restore`, `issue`, `push`, `prCreate`, `prRefresh`, `archive`, `closeLosers`.
  - `lanes.create` stays `lanes:operate`; the service keeps a token-created lane's setup `pending` (M9R110).
  - `auth.test.ts` loses its count (`toHaveLength(22)` at l.14 conflicts with M10's term; agreement 4 prefers a derived assertion), and `lanes:admin` joins its filter copy on its own line. The new `auth.m9.test.ts` pins `lanes:read` and `lanes:operate` in and `lanes:admin` out.

  — why: agreement 5 and M7's final review M2 — cost if wrong: a token pushes the owner's code, runs code the agent wrote, or restores over the owner's work.

M9R2 [1] **M9 adds no error code.** Refusals a person acts on are typed results (`{ ok: false, reason }`), as ADR 0027 does for trust. Transport failures reuse `not_found`, `bad_request`, `conflict`, `limit_reached`, `capacity`, `timeout`, `read_only`, `step_up_required`, `forbidden`, `worker_failed`, `payload_too_large`. After M10's rebase, `lanes.create` also declares M10's `disk_low` (agreement 3, M9R97). — why: no `ERROR_CODES` merge with M10, and the copy of a refusal needs its reason anyway — cost if wrong: one code later.

M9R3 [1] The stream is `lane` (C §4.3), keyed by the caller's own id like `shell` (no key on the wire). Snapshot: every lane of the owner not archived (at most `activePerOwner`), the fan-out groups they belong to, and the archived count; archived lanes page through `lanes.listArchived` — cost if wrong: none.

M9R4 [1] (corrected: M9R110) `deriveLaneStatus` is a pure function in `lane-status.ts` (pi-web's priority, amended after its Lot A review). The order, first match wins:
  1. `archived`;
  2. `setup` (creating, setup `queued` or `running`);
  3. `needs_attention · input_needed`;
  4. `working`;
  5. `done` (PR merged);
  6. `in_review` (PR open);
  7. `needs_attention` (create failed, setup failed, interrupted, unapproved, or `pending`: waiting for the owner's "Run setup");
  8. `idle`.

  The web derives it from a `LaneView` and the shell's session facts; M11 can derive it on the daemon with the same function — cost if wrong: a chip colour.

M9R5 [1] `ReviewDoc.seen` is a list of `{ path, identity }`, never a record keyed by path (`__proto__` stays data; checked in scratch) — cost if wrong: prototype pollution in the browser.

M9R6 [1] (agreement 6) `fenceText` moves to `packages/contracts/src/fence.ts` unchanged (pure). It is the only fence format, with 12-hex ids from `randomBytes(6)`.
  - `packages/pi-host/src/policy/fence.ts` re-exports it and keeps `newFenceId`, `FENCE_PLACEHOLDER` and `UNTRUSTED_RULE`.
  - The daemon fences issue text with it (Task 18a). M10's `automation/prompt.ts` calls it after dropping NULs, and M10's `splitFences` renders M9's issue prompt in a Fence frame (agreement 7).

  — cost if wrong: two fence formats.

M9R7 [1] `modules/lanes/pending.ts`: `PENDING` (a `const` list of every lanes method name) and `pendingHandlers(PENDING)` answering `PapError("internal")`.
  - `modules/lanes/rpc.ts` holds only spreads.
  - `daemon.ts` spreads `lanesPending` in Task 1 (one line, replaced by `lanes.rpc` in Task 3).
  - A test pins that each pending method answers `internal`. Task 24 asserts `PENDING.length === 0` and deletes the file.

  — cost if wrong: a method that answers `internal` in production (the final assertion catches it).

M9R8 [1] Web: `OPENERS.lane` calls `subscribe.lane` with the cursor only (`subscriptions.m9.test.ts`; the old test file is frozen). The token grid shows the `lanes` domain label (`catalog/settings-access.ts`, en + fr) and, by M7R124's filter, only levels some method declares.

M9R9 [2a, 2b] (corrected: M9-RT-11, RT-03) The allowlist is data in two files:
  - `kernel/git/allowlist.ts`: the read table moved from `runner.ts`, the rule types, `prepare`;
  - `kernel/git/allowlist-lanes.ts`: M9's entries, merged over the read table.

  A rule's parts:
  - Option rules are exact strings or `{ prefix, value }`, the value matched in full against a pattern: `--source=<oid>` only.
  - `required` lists options a call must give.
  - `shape` is a predicate over the positionals, split at `--`, and the options given: how many, on which side, and each one's form. The forms are a `BRANCH_PATTERN` branch, an oid, a checkpoint ref, an absolute path, `.` or `./…`.
  - No option may be given twice (by name: `--source=a --source=b` counts twice).
  - `temporaryIndex` refuses `read-tree` without a `GIT_INDEX_FILE`.
  - Nested subcommands (`worktree add`, `remote get-url`) have their own rule.
  - A positional never starts with `-`, after `--` neither.
  - A subcommand marked `remote: true` runs only under the remote profile, and every other only under the local one.

  M8's read rules keep no shape (free reads, unchanged).

  `worktree remove` takes `--force` once. Recovery and undo run `worktree unlock <path>` first; scratch on git 2.53 showed that unlock works on a locked worktree whose folder is gone, after which `remove --force` and `prune` succeed. So there is no `--force --force`.

  — cost if wrong: one table line per new caller, or a call that `reset`s a branch tip or deletes a remote branch (the shapes close both).

M9R10 [2a, 2b] (corrected: M9-RT-11 b, d) Profiles. `local` is every call so far, with M8's `SAFE_CONFIG` and environment, plus:
  - `maintenance.auto=false`, `gc.auto=0` and `submodule.recurse=false`. Scratch: `commit` no longer starts `git maintenance run --auto --detach`, which calls `setsid()` and leaves the runner's group, cap and kill.
  - `GIT_EDITOR=:` and `GIT_SEQUENCE_EDITOR=:`: a planted `core.editor` never runs, even if a shape were wrong.
  - `add`, `commit`, `restore`, `clean` and `reset` run with `--work-tree=<root>`. Scratch: a lane's `config.worktree` with `core.worktree=<victim>` makes `clean -n` name the victim's files, `-c core.worktree=` does not override it, and `--work-tree` does.

  M8's `exec.test.ts` expected argv array and env object gain these entries: the only M8 test edited, named in the report.

  The `remote` profile is Task 2b's (M9R10 continued there).

  — cost if wrong: a commit whose maintenance outlives the runner, or a restore that deletes another folder's files.

M9R10 [2b] (continued; corrected: M9-RT-02, agreement 8) The `remote` profile is for push only:
  - `SAFE_CONFIG` without `protocol.allow=never` and `credential.helper=` (the owner's own helpers must answer), plus `push.recurseSubmodules=no` and `push.followTags=false` (a push never reaches a submodule's remote or adds tags);
  - the environment: M8's, plus the shared `NETWORK_ENV` (proxies, CA bundles) and `SSH_AUTH_SOCK`. The push is the one child that gets the SSH agent: it is the owner's browser click (`lanes:admin`), after the target check. Agreement 8 binds unattended children; M9R103;
  - `GIT_ALLOW_PROTOCOL=https:ssh`, which overrides every `protocol.*.allow` (scratch: `fatal: transport 'file' not allowed`);
  - hooks stay off (`core.hooksPath=/dev/null`, M9R106).

  The protocols are injectable for tests only: `Config.testGitProtocols` from `PAP_TEST_GIT_PROTOCOLS`, honoured only when `PAP_TEST_PROVIDER_SCRIPT` is set too (R130's pattern), else a `ConfigError`. Its tests go in `config.m9.test.ts` (agreement 25; `config.test.ts` has 358 lines). A test pins `[...KEPT, ...KEPT_REMOTE].filter(isNeverPassedEnvKey)` to `["SSH_AUTH_SOCK"]`.

  — cost if wrong: a push that works for no one, or a test seam reachable in production.

M9R11 [2a] Extra environment a caller may pass (`GitRunOptions.env`). Anything else refuses the call before git starts.
  - M8's `GIT_CONFIG_COUNT/KEY_n/VALUE_n`.
  - `GIT_INDEX_FILE`, only as `<indexDir>/idx-<32 hex>`; `indexDir` is `$PAP_HOME/tmp/git-index`, a runner dep, created 0700.
  - `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`, only with pap's identity (`pap`, `pap@users.noreply.invalid`): checkpoint commits are pap's, never the owner's.
  - `GIT_LFS_SKIP_SMUDGE=1`.

  `prepare(args, profile, env)` sees the same env, for `temporaryIndex`. — cost if wrong: a caller that redirects git's index or identity.

M9R12 [2b] `keepStderr: true` returns git's stderr (UTF-8, the first 64 KiB) to the caller for classification only. It is never logged beyond M8's 300 characters and never reaches a client. Used by commit and push. — cost if wrong: a reason shown as `failed`.

M9R13 [2a] `FILTERING_SUBCOMMANDS` gains `add`, `commit`, `restore`, `reset` and `worktree`: they hash or check out working-tree files, so a repository's own clean or smudge filter would run. `guardFilters` keeps its scan, its overrides and the 2.31 floor (MC43); `push` is not in it — cost if wrong: a planted filter runs during a checkpoint.

M9R14 [2b] (corrected: M9-RT-02) Where a push goes. Three exact reads, beside M8's filter scan:
  - `PUSH_SCAN_ARGS`: `--get-regexp` over `core.sshcommand`, `core.askpass`, `core.gitproxy`, `credential.*helper`, `url.*.insteadof`, `url.*.pushinsteadof`, `http.*`, `remote.*.vcs`, `remote.*.proxy`, `remote.*.receivepack`, `remote.*.uploadpack`;
  - `ORIGIN_URLS_ARGS`: `config --get-all remote.origin.url`, every value as configured, before any `insteadOf`, for the forge identity;
  - the allowlisted `remote get-url --push --all origin`: every real push target, after `pushurl`, `insteadOf` and `pushInsteadOf`.

  `repositoryKeys(scan)` returns the keys whose scope is not `system`, `global` or `command`. Scratch: pap's own `credential.helper=` reports as `command`; a key included from the repository's config reports `local`. Any such key → `repo_config`.

  `pushTarget` (binding below) then requires exactly one origin URL and exactly one push URL, naming the same host and repository; else `repo_config`.
  - Scratch on git 2.53: two `pushurl` values push to both remotes while `get-url --push` without `--all` printed only the first; two `url` values did the same.
  - A same-repository ssh `pushurl` beside an https `url` is accepted, and so is an owner-global `insteadOf` that rewrites https to ssh.
  - Under the test seam only, a `file:` URL or a local path is answered as `{ host: "local", path: <last segment> }`.

  — cost if wrong: the owner's credentials push to a repository the button did not name.

M9R15 [2b] (corrected: M9-RT-04, RT-15; M9R107) The URL parsers, all in `kernel/forge/remote.ts` (binding below):
  - `parseRemote(url)` keeps only `https://`, `ssh://`, `git+ssh://` and scp-like `user@host:path` URLs, with 2 to 8 path segments of `[A-Za-z0-9_.-]` and no `.` or `..` segment anywhere in the raw text. Credentials and ports are dropped. Anything else (`file://`, a local path, `ext::`, `http://`) is null.
  - `forgeOf(host, override)`: the known public hosts **win** over a repository's `forge:` line (`github.com` → github, `gitlab.com` → gitlab, `codeberg.org` and `gitea.com` → gitea); else the override, else null.
  - `parseIssueUrl` takes `https://<host>/<repo>/issues/<n>` or the GitLab form `…/-/issues/<n>`: no credentials or port, `n` of 1–10 digits.
  - `issueAllowed(issue, project)` binds every forge call to a host the owner meant: a known public host for an issue of that host's kind, or the project's own origin host with the project's forge kind. A pasted link to another host is refused before any CLI starts.
  - `issueUrl(issue)` rebuilds the canonical URL from the parsed parts: no query, no fragment.

  — cost if wrong: one pasted link sends the owner's forge login to an attacker's host.

M9R16 [3] Path: `join(realpath($PAP_HOME), "worktrees", laneId)`, `laneId` matching `LaneId`; `$PAP_HOME/worktrees` created 0700. The folder is never a symlink (lstat before use and before removal) — cost if wrong: none.

M9R17 [3] (corrected: M9-RT-03, RT-09, RT-23)
  - **Phase 1**, one SQLite transaction, through `WorktreesPort.reserve(ownerId, row, check)`:
    - the caps: `creatingPerOwner` 4 → `capacity`; non-archived lanes `activePerOwner` 64 → `limit_reached`, counted by Task 6b in the same transaction through `reserve`'s callback;
    - then the row `creating` with `created_branch`.
  - **Phase 2**, `create(path)`, which the caller runs after answering, under the repository's lock:
    - the disk floor on `$PAP_HOME/worktrees` (`LanesDeps.diskFloor`, M9R117);
    - `branch --no-track <branch> <baseOid>` (skipped when the lane reuses an existing branch: never in M9);
    - `worktree add --lock --reason=pap-creating <path> <branch>`, with `GIT_LFS_SKIP_SMUDGE=1` and a 120 s deadline.
  - Then the caller's prepare step, then `ready(path)`: `worktree unlock <path>` and the row `ready`.
  - **Any failure after phase 1 runs `undo(path)` inline**, the same sequence as recovery (M9R20): the row is deleted, so the owner's creating slot is free at once. It rejects with `WorktreeFailure { step: "disk" | "git" | "prepare" }`, which the lane turns into `failed` with that reason.

  — cost if wrong: a worktree a concurrent `git worktree prune` removes, or after four failures no lane can be created until a restart (M9-RT-03).

M9R18 [3] One lock per repository: an in-memory promise chain keyed by the real path of `rev-parse --git-common-dir`. It is held around branch + add, unlock + remove + prune, and branch deletion; git's own `index.lock` and `worktrees/` writes race otherwise — cost if wrong: a `fatal: … already exists` under a fan-out.

M9R19 [3] (corrected: M9-RT-03, RT-12) Removal, `remove({ path, force })`:
  - the row `removing`;
  - `worktree unlock <path>` (its failure ignored: an unlocked or unknown worktree answers 128);
  - `worktree remove [--force] <path>`: dirty without force → `{ ok: false, reason: "dirty" }`;
  - if git no longer knows the worktree, the folder is removed by `removeLaneFolder` (binding below, now async: a whole checkout never blocks the event loop) and `worktree prune` runs;
  - the row deleted.

  `deleteBranch({ branch, force })` runs `branch -d` (or `-D` with force) under the lock; a failure is reported (`false`), never thrown. — cost if wrong: lost work under Force (the dialog says so, Task 13).

M9R20 [3] (corrected: M9-RT-03, RT-13) Recovery first: `recover()` runs before the server listens (`daemon.ts`, awaited, 60 s budget; past that it is logged and left for the next boot). The undo sequence:
  1. `worktree unlock` (ignored) and `worktree remove --force` (ignored) if git knows the worktree;
  2. `removeLaneFolder`, then `prune`;
  3. the branch is deleted only when `created_branch = 1` and `rev-parse --verify --quiet refs/heads/<branch>^{commit}` equals `base_oid` (no commit lost); else it is kept, with a log line `worktree_branch_kept`;
  4. the row is deleted.

  Recovery covers:
  - `creating`, through that undo;
  - `removing`, through the same removal;
  - a database the daemon opened read-only (an M9 binary on a newer database): no git call, one log line `worktree_recovery_skipped`, as `backfillProjects` does.

  Each step logs `worktree_recovered { step }`, without the path.

  Accepted residual: a daemon crash during `worktree add` run from a terminal (not systemd) may leave a `git` that finishes after the boot's undo; under the systemd unit, its cgroup is killed with the daemon. The residual is named in `lanes.md`.

  — cost if wrong: a lost commit, or junk folders.

M9R21 [3] The boundary opens the folder: `boundaryConfigOf(...).papHomeOpen = ["worktrees"]` (the deny walk skips it, M8 handoff). `compose-workspace.ts` returns the guarded `git` runner it already builds, so the lanes modules use the same one. `daemon.ts`:
  - replaces Task 1's pending spread by `...lanes.rpc` from `composeLanes(...)`;
  - awaits `lanes.recover()` before `startServer`;
  - `MIGRATION_SOURCES` gains `WORKTREES_MIGRATIONS`.

  — cost if wrong: none.

M9R22 [4] (corrected: M9-RT-12) The file is the **main checkout's** working-tree `.pi/project.yaml` (pi-web). It is read through the M8 boundary's `openRegularFile` (a FIFO or a link out of the repository is `unreadable`), at most 64 KiB, and parsed with `yaml` 2.9.0 `parseDocument` (`schema: "core"`, `uniqueKeys: false`, `maxAliasCount: 0`).
  - The duplicate check is pap's own, one pass over the top-level map: yaml's `uniqueKeys` is quadratic. Measured at the plan fix: 9 000 keys in 63 KiB take 630 ms with it, 86–112 ms without.
  - These refuse the whole file: YAML errors, a duplicate or non-string top-level key, more than 256 top-level keys, an alias, a top level that is not a map.
  - One bad field is dropped and named in `warnings`; unknown keys are ignored.
  - `config-cache.ts` keeps the last read per project root, keyed by `(dev, ino, size, mtimeMs)`: at most 64 entries, the oldest dropped (a pure cache: an eviction costs a re-parse). A token's `lanes.preview` loop never re-parses an unchanged file.

  Why: the owner's checkout, not the base branch, decides what pap runs. A lane from someone else's branch still runs the owner's approved scripts; that branch's `package.json` scripts are a residual named in `lanes.md` and on the approval box (Task 21). — cost if wrong: a script chosen by the base branch, or a synchronous stall that trips M10's monitor (agreement 27).

M9R23 [4] A script runs only when its exact text is approved. `lane_script_approvals` holds one row per (owner, project root, kind), with the SHA-256 of the UTF-8 text and the text itself (≤ 16 KiB, for the "changed since" display of board 10 §3).
  - Approval needs **both** a browser session (`caller.kind === "session"`, else `forbidden`) and a live step-up (`requireStepUp`; M7R133's list gains "approve a lane script").
  - The service re-reads the file and answers `{ ok: false, reason: "changed" }` when a requested hash is not the current one: the decision is bound to what was shown, unlike M7's trust residual.
  - It writes the audit row `lane_script_approved { project, kind, sha256 }` (decision 79's install-audit option, applied).
  - Pi's project trust is not required as well: the hash approval is content-bound and stricter.
  - Approval is not running: when the script runs, and who may run it, is M9R110.

  — cost if wrong: one more click per project, or a script nobody looked at.

M9R24 [4] (corrected: M9-RT-05, RT-09) Copy and link entries:
  - `isCleanRelative` (binding) applies at parse time.
  - At run time the source must exist in the main checkout, its real path must stay inside the main checkout's real path, and `check-ignore -z --stdin --no-index` must report it ignored (pi-web: only ignored files are copied or linked).
  - The destination's parent is created inside the worktree (its real path checked); an existing destination is left alone.
  - `copy` uses `cp(src, dst, { recursive: true, force: false, errorOnExist: false, verbatimSymlinks: true })` with a 256 MiB total cap (the rest skipped with a warning), after the disk floor on the worktree (M9R117; below it the entry is skipped).
  - `link` uses `symlink(realSource, dst)`, then **`check-ignore` on the destination in the worktree** (`./<entry>`). When it is not ignored, the link is removed again, with a setup-log line: "add `/<entry>` (no trailing slash) to .gitignore to link it". Scratch: under the usual `node_modules/` rule a linked `node_modules` is untracked, not ignored, so every lane looked dirty and the commit bar ticked the link.
  - Every skip is a line in the setup log, and the count is a `copy_skipped` lane notice (M9R115).

  — cost if wrong: `~/.ssh` copied into a lane, a `.git` linked, or a link to the owner's disk pushed in a PR.

M9R25 [4] (corrected: M9R107, M9R15) `branchPrefix` defaults to `pi/` (board 10 shows `pi/feat-checkpoints` and `pi/fix-412-high-memory`, validated as shown; pi-web's default too), `""` allowed. `waitForSetup` defaults to true. `forge` names a self-hosted host's kind. The known public hosts win over it (M9R15), and only `github` has an adapter in M9. — cost if wrong: a prefix rename.

M9R26 [4] (corrected: track split) `lanes.preview { projectRoot }`:
  - `projectRoot` must equal one of the caller's project roots and be the top level of a repository's main checkout (`rev-parse --show-toplevel` equal, `.git` a folder), else `repo: false`;
  - refs come from `for-each-ref --format=…%00… --sort=-committerdate --count=500 refs/heads refs/remotes`, with `refs/remotes/*/HEAD` dropped;
  - `current` is the checkout's branch (`rev-parse --abbrev-ref HEAD`), null when detached;
  - the config view (through the cache).

  `remote` and `forge` stay null here: Task 14 fills them after JOIN 1, from `ORIGIN_URLS_ARGS` + `parseRemote` + `forgeOf` (Task 2b, track 2). — cost if wrong: a list one ref short.

M9R27 [5] Spawn (binding below): `/bin/sh -c 'umask "$1" && shift && exec "$@"' pap-lane-<kind> <mask> bash -e -c <approved text> pap-lane-<kind>`.
  - When scopes are on, it is prefixed by a terminal-kind scope (`scopes.next({ kind: "terminal" })`: the same limits, swept like terminals; agreement 9: no new scope kind).
  - cwd is the worktree; `detached: true`, `stdio: maskedStdio(["pipe", "pipe", "pipe"])`, stdin ended at once.
  - The group is tracked with `trackGroup` / `signalGroup` / `releaseGroup` (`kernel/supervisor/process-group.ts`), so a forced stop kills it.

  — cost if wrong: a script that outlives pap or types into a terminal.

M9R28 [5] (corrected: M9-RT-10, owner c7, M9R103) Environment (binding below): `unattendedEnv(base, { keep: [...NETWORK_ENV, ...TOOLING_ENV], set: { PAP_LANE_ID, PAP_LANE_ROOT, PAP_LANE_WORKTREE } })`.
  - Kept: `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_*`, `TZ`, the absolute PATH, `TERM=dumb`, the proxies and CA bundles, `TMPDIR`, `XDG_*`, and the three lane variables (the only `PAP_*` a script sees; documented).
  - Never kept: the SSH agent, provider keys, forge tokens, `GIT_*`, anything else.

  The approval box says what the script reaches (Task 21). — cost if wrong: an approved `pnpm install` on a hostile base exfiltrates the owner's keys through a `postinstall`.

M9R29 [5] Deadlines: setup 30 min, archive 5 min, test 15 min; then SIGTERM to the group, 5 s, SIGKILL, scope reap. `exitCode` is null for a kill.
  - The log is `$PAP_HOME/lanes/<laneId>/<kind>.log` (0600, folder 0700), stdout and stderr interleaved, truncated at 5 MiB with one final line `[pap: log cut at 5 MiB]` (the rest is counted, not written). A new run of a kind replaces its log.
  - `deleteLogs(laneId)` removes the lane's folder; archive calls it (M9-RT-22).
  - `lanes.scriptLog` reads 256 KiB chunks from an offset, cut back to a UTF-8 boundary.

  — cost if wrong: a full disk next to `state.db`.

M9R30 [5] (corrected: M9R110) Concurrency:
  - at most two scripts run at once per owner: the others wait in state `queued`, never refused;
  - one script per lane at a time: a second `run` → `{ ok: false, reason: "running" }`.

  States persist before the spawn (`queued` / `running`) and after the exit (`ok` / `failed` / `passed`), so the boot turns a left-over `running` into `interrupted` and never re-runs it (C §6.2's process-bound class, ADR 0035).

  The runner is a mechanism, not a gate. Who may start a run is the callers' rule:
  - `lanes.runScript` (Task 7) is browser-only;
  - create (Task 6b) runs setup only for a lane a browser created (M9R110);
  - archive (Task 7) and the fan-out auto-run (Task 18b) have their own rules.

  — cost if wrong: two `pnpm install` racing in one lane.

M9R31 [5] (corrected: C3) Daemon log lines: `lane_script_started { laneId, kind }` and `lane_script_ended { laneId, kind, code, signal, ms, logBytes }`, never a line of the script's output (MC57). `shutdown()` kills every running script (SIGTERM, 2 s, SIGKILL). `daemon.ts` puts it in the parallel stop group with `sessions.shutdownAll()`, after M10's `outbox.stop()` and `automation.stop()` (controller ruling C3; the line is Task 7's) — cost if wrong: a slower stop.

M9R32 [6b] `lanes.create` for one model. Fan-out is Task 18b; until then `models.length > 1` answers `bad_request`.
  - `projectRoot` is judged like `lanes.preview`: it must be one of the caller's project roots and a main checkout, else `not_found`.
  - The title is cleaned (`LaneTitle`). The id is `slugOf(title)` (contracts: NFKD, ASCII letters and digits, `-`, ≤ 40, `lane` when empty) + `-` + 4 random hex.
  - The branch is the given `branch`, or `branchPrefix + slug`, suffixed `-2`…`-20` when `refs/heads/<name>` exists; an explicit branch that exists → `conflict`. Every candidate goes through `BranchName`, and `check-ref-format --branch` must echo it unchanged.
  - The base is the given `baseRef`, or `refs/heads/<current>` (HEAD's oid when detached), resolved with `rev-parse --verify --quiet <ref>^{commit}` → `base_oid`; a missing one → `bad_request`.

  — cost if wrong: a branch name surprise.

M9R33 [6b] (corrected: M9-RT-23, RT-03, RT-09, M9R110) The order (§ A lane's life).
  - **Synchronously**:
    1. the checks of M9R32;
    2. the disk floor on `$PAP_HOME/worktrees` (`LanesDeps.diskFloor`: `capacity` until M10's rebase, then `disk_low`, M9R117);
    3. the lane row `creating` (`created_by` from the caller's kind) and the worktree reservation, in one transaction with the caps.

    Then **`lanes.create` answers `{ laneIds, fanoutId }`**: a phone's socket never waits two minutes for `worktree add`.
  - **In the background** (`void`, with a logged `.catch`):
    - `worktrees.create`, copy / link (Task 4, logged into the setup log), `worktrees.ready`, lane `active`.
    - Then the setup:
      - a lane a **browser session** created with an approved setup → queued or running (Task 5);
      - a lane a **token** created with any setup script → `pending`, run only by the owner's "Run setup" (M9R110);
      - no setup → `none`; an unapproved text → `unapproved`.
    - Then the primary session: when `waitForSetup` is false; or when setup ends `ok`, or is `none` or `unapproved`. Setup `failed`, or `pending` with `waitForSetup`, starts no session (needs attention).
  - Any failure in phase 2 → the worktree's inline undo (Task 3), lane `failed` with `failedReason` (`git`, `prepare`, `disk`), slot freed, published.

  — cost if wrong: a lane stuck in `creating`, or a token-created lane whose setup runs code nobody clicked.

M9R34 [6a] (corrected: agreement 10) The primary session goes through `SessionsLanePort.create(caller, worktree, model)`:
  - `SessionsService.create` is called **unchanged** (no signature change; M10 adds its task parameter through its own `automation-port.ts`);
  - then `setModel` / `setThinking` when a model is picked; a refused model leaves Pi's default and returns `modelRefused: true`, which Task 6b turns into a lane notice;
  - then `prompt(caller, id, text)`.

  — cost if wrong: a silent lane, or a merge conflict on `create`.

M9R35 [6a] (M9R104) Membership is by folder (pi-web R1): a session belongs to a lane when its real cwd is the worktree or inside it.
  - `daemon.ts` passes `scopeAlias: (cwd) => lanes.paths.scopeOf(cwd)` to `createPolicyModule`. Policy's `scopeOf` becomes `(cwd) => deps.scopeAlias?.(cwd) ?? projectScopeOf(cwd)` (one dep, one line; agreement 17: M10's `setTaskPolicy` lines are its own).
  - `daemon.ts` passes `roots: (owner) => [...projects.port.roots(owner), ...lanes.paths.roots(owner)]` to the workspace modules, late-bound like `ownerOf`.
  - `lanes.paths` is the empty `LanePaths` from Task 3 until Task 6b fills it.

  A lane session is then filed under its project (⌘B tree), loads the project's always-rules (owner m9q1), and can open the lane's files, changes and terminal. — cost if wrong: one line returns null here.

M9R35 [6b] (continued) `LanePaths` (`modules/lanes/paths.ts`) is in memory, rebuilt from the store at boot and on every create and archive. It is synchronous, on real paths, and replaces Task 3's empty one:
  - `scopeOf(cwd)` → the lane's `project_root`;
  - `roots(ownerId)` → the owner's non-archived worktrees;
  - `laneOf(cwd)`;
  - `closed(cwd)` → `archiving` or `archived` for those lanes' worktrees, else null. The archived set is kept for the life of the daemon and rebuilt at boot.

M9R36 [6b] The `lane` stream:
  - the hub snapshot builds `LaneStreamEvent.snapshot` from the store (non-archived lanes, the fan-outs they name, the archived count; fitted under `PAGE_BYTES`);
  - `publish(laneId)` sends `{ kind: "lane", lane }` after every state change, coalesced per tick like the shell publisher;
  - `subscribe.lane` opens the caller's own key;
  - `lanes.listArchived` pages archived lanes newest first by `(archived_at, id)`.

  `LaneView.remote`, `pushRemote` and `forge` are null until Task 14 fills them. — cost if wrong: none.

M9R37 [6a] (corrected: controller ruling C2, agreement 11) `SessionsLanePort` is a new file, `modules/sessions/lane-port.ts`, exposed as `SessionsModule.lanes`. It is the only way lanes touch sessions; `live-session.ts` is not edited. Its methods:
  - `create`, `prompt` (M9R34);
  - `activityIn(ownerId, folder)` → `{ sessions, busy, needsInput }` (busy = running, starting or a prompt pending);
  - `runState(ownerId, sessionId)` → `{ idle, leafId }` (Task 15's re-check under the lane lock);
  - `archiveIn(caller, folder)`;
  - `releaseIn(ownerId, folder)`: **loops over `releaseIdle`** for the owner's live sessions whose cwd is in the folder;
  - `lastAgentText(sessionId, max)` (Task 18b);
  - `branchPath(caller, sessionId)` → `{ leafId, entries: { id, parentId, user, preview }[] }`: the session's current branch from the root to its leaf (the live leaf for a hot session, the file's for a cold one), read through the transcript reader, at most 10 000 entries with the oldest dropped. Tasks 15 and 16 use it.

  — cost if wrong: none.

M9R38 [6b] `lanes.newSession { laneId }` starts a session in the worktree with the lane's model and no prompt (the board's "New session here"; it becomes the primary one if `primary_session_id` is null). A lane that is not `active` answers `conflict` — cost if wrong: none.

M9R39 [6a] Trust port only (used by Task 18a): `TrustModule.port = { status(folder): Promise<boolean | null>; inherit(ownerId, folder, from): Promise<boolean>; clear(ownerId, folder): Promise<void> }`. It is internal (no RPC, no step-up), and each write is audited (`project_trusted { folder, inheritedFrom }`, `project_trust_cleared { folder }`). `compose-pi.ts` returns it — cost if wrong: none.

M9R40 [7] (corrected: M9-RT-07, RT-22, M9R119) `lanes.archive` (`lanes:admin`, so browser only):
  1. Refusals before anything changes:
     - `busy`: `activityIn(...).busy`, a lane script running, or `terminals.runningIn(ownerId, worktree) > 0` (a new port of the terminal module, one function);
     - `setup_running` while setup runs;
     - `dirty` when `facts.dirty > 0` and not `force` (checked before the archive script, so it never runs for nothing);
     - `tainted` when an archive script will run, a session of the lane is tainted and `confirmTainted` is not set (M9R119).
  2. Lane `archiving`, persisted and published. `LanePaths.closed` now refuses prompts in the folder (M9R114).
  3. The approved archive script (5 min; non-zero → `script_failed` with the last 4 KiB of its log, unless `force`).
  4. **The lane lock is taken, and busy is checked again**: a run that started before step 2 → the lane goes back to `active` and the call answers `busy`.
  5. `releaseIn` (idle workers go, through `releaseIdle`).
  6. `worktrees.remove({ force })` (dirty → `dirty` unless `force`: the lane goes back to `active`).
  7. Every `refs/pap/checkpoints/<laneId>/` ref is deleted (`for-each-ref` + `update-ref -d` each, at most 2 100).
  8. `deleteBranch` when asked (`-d`, or `-D` with force); a failure is reported, never blocking.
  9. `archiveIn` (sessions filed as archived; Undo stays possible).
  10. The worktree's trust entry is cleared (`trust.clear`, always: the folder is going, whoever wrote the entry).
  11. The script logs are deleted (`deleteLogs`, M9-RT-22).
  12. Lane `archived`, with `archived_at`.

  — cost if wrong: lost work, a dangling worktree, or a running agent whose files vanish.

M9R41 [7] (corrected: M9-RT-03, RT-13) Boot recovery, after `worktrees.recover` and the script orphans (M9R116):
  - a lane `creating` whose worktree row is gone → `failed` (`interrupted`);
  - a lane `creating` whose worktree row is `ready` → `active`, with setup `interrupted` when a setup was due, else `none` (the life table's row 4);
  - `archiving` → resumed from the worker release (step 5; the archive script is not re-run);
  - setup or test `running` → `interrupted`.

  A read-only database skips all of it, with one log line. — cost if wrong: a lane stuck in a state with no action.

M9R42 [7] Facts (`LaneFacts`):
  - `status --porcelain=v2 -z --branch`: the dirty count; `ab` against the upstream → `unpushed`, null without an upstream;
  - `merge-base <base> HEAD`, then `rev-list --count <mb>..HEAD` (`ahead`) and `<mb>..<base>` (`behind`);
  - `diff --numstat -z <mb>`: `additions`, `deletions`, tracked files.

  They are refreshed after create, commit, push, restore and every run end (Task 15), on `lanes.refresh`, and for a snapshot whose facts are older than 30 s (in the background, at most two lanes at a time). One refresh runs per lane at a time; a trigger during a run asks for exactly one more. A `GitError` fills `error` and nulls. — cost if wrong: a stale ↑n.

M9R43 [7] `lanes.listArchived` pages by `(archived_at, id)` descending, 100 per page. An archived lane's view keeps its PR and branch for the record — cost if wrong: none.

M9R44 [8] Only the session's **own** lane is opened: when the session folder's real path is inside `<papHome>/worktrees/<name>` with `<name>` matching `LaneId`, that folder (in every spelling of pap's home: as given and resolved) stops being under a protected root for this session. Another lane, `worktrees` itself, a folder not named like a lane, and the rest of pap's home stay protected; protected names (`.git`, `.pi`, `.husky`, …) still ask everywhere, so the worktree's `.git` file and `.pi/project.yaml` ask. Reads are unchanged (`read-target.ts` never treated a lane as sensitive) — why: an agent may edit its lane without asking, and nothing else in pap's home — cost if wrong: every edit in a lane asks (too narrow), or pap's state is writable from a lane (too wide; the tests below pin both).

M9R45 [8] The check needs no new init field: pi-host already knows `papHome` (stage 03 passes it as a protected root); `checkEditTarget` takes it as a fourth argument and `stage-approval.ts` passes `deps.papHome` (one line). The lane id pattern is duplicated from contracts as `LaneId` (pi-host imports `@pap/contracts`) — cost if wrong: none.

M9R46 [9] The forge CLI runs from `$PAP_HOME/tmp/forge` (an empty folder, 0700, created at boot), never from the repository: no repository config, hook or `.git` is reachable, and `gh pr create` cannot push (it has no repository to push from). Repository and branches go through flags (`--repo=<host>/<path>`, `--head=`, `--base=`), every value joined with `=`, so a title starting with `-` stays a value; the real `gh` 2.46 parsed every form in scratch, with the network blackholed. The PR body goes on stdin (`--body-file=-`) — cost if wrong: a CLI that reads a hostile repository's config.

M9R47 [9] (corrected: owner c7, M9-RT-04, RT-21) The environment is `forgeEnv(base, forgeDir)` (binding below): `unattendedEnv` with `NETWORK_ENV`, `TOOLING_ENV` and `GH_CONFIG_DIR` kept, then fixed quiet and promptless values.
  - **No token variable reaches gh** (`GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and the rest are never passed, agreement 8). gh answers from its own login, its config under `XDG_CONFIG_HOME` or `GH_CONFIG_DIR`, so a token can never be handed to a host the owner did not mean. A token kept only in `GH_TOKEN` is not seen: run `gh auth login` once on the host (ADR 0036, the owner checks; a systemd user service does not inherit a shell's variables anyway).
  - `GIT_CEILING_DIRECTORIES` is the forge folder: gh's own git children never discover a repository above it, such as a home dotfiles repository (M9-RT-21).

  — cost if wrong: a CLI that prompts and hangs, or a token handed to another tool.

M9R48 [9] `runForge`: `spawn` with `shell: false` and `detached: true` (its group killed at the deadline and at stop), `stdio: maskedStdio(...)`, stdin ended after the input.
  - Deadline 30 s (create 60 s). stdout is capped at 4 MiB (`too_large` past it); stderr is kept to 64 KiB, for classification only.
  - Outcomes:
    - `forge_missing` (ENOENT);
    - `not_signed_in` (exit ≠ 0 with `gh auth login`, `not logged`, `authentication` or `HTTP 401` in stderr);
    - `not_found` (`Could not resolve to`, `HTTP 404`, `not found`);
    - `timeout`, `failed`.
  - The daemon log gets `forge_failed { forge, op, outcome, code }` and at most 300 characters of stderr (MC57).

  — cost if wrong: a reason shown as `failed`.

M9R49 [9] JSON from a CLI is external content. It is parsed with the zod schemas below (`looseObject`, bounded) and mapped to the contract's `PrView` / `IssueView` (titles clipped to 256, bodies to 20 000 with `truncated`, labels to 20 × 64); a parse failure is `failed`.
  - Checks: `SUCCESS`, `NEUTRAL`, `SKIPPED` passed; `FAILURE`, `TIMED_OUT`, `CANCELLED`, `ACTION_REQUIRED`, `ERROR`, `STARTUP_FAILURE` failed; anything else pending.
  - `mergeable: CONFLICTING` → conflicts true, `MERGEABLE` → false, else null.

  — cost if wrong: a wrong chip.

M9R50 [9] (corrected: M9R107) The port: `Forge { kind; findPr(repo, head); createPr(repo, input); viewPr(repo, number); viewIssue(repo, number) }`, each answering `{ ok: true, value } | { ok: false, outcome }`.
  - `forgeFor(kind)` returns the GitHub adapter for `github`, and null for `gitlab` and `gitea` (owner m9q5).
  - `testing/stub-forge.ts` writes an executable stub `gh` (`#!/usr/bin/env node`) that records argv, cwd, stdin and the environment's keys (never values) to a JSON file and prints a canned answer: the only way tests meet a forge.

  — cost if wrong: none.

M9R53 [11] Refs:
  - `refs/pap/checkpoints/<laneId>/e/<entryId>` (a Pi entry id matching `EntryId`);
  - `…/root` (a session that had no entry yet);
  - `…/undo` (one slot, replaced by the next restore).

  Checkpoint commits carry pap's identity (`PAP_IDENTITY` env, M9R11) and the message `pap checkpoint <laneId>/<key>` on stdin, with parent `HEAD` when it exists. The allowlist's `update-ref` shape accepts these refs only (M9R9). — cost if wrong: a ref name collision (the `e/` level prevents `undo`/`root` clashes).

M9R54 [11] (corrected: M9-RT-09, RT-17) `snapshotTree(root, paths?)` (binding sequence below):
  1. The temporary index `<indexDir>/idx-<32 hex>` is seeded by copying `rev-parse --git-path index` (mtime kept with `utimes`), or, when that does not exist, by `read-tree HEAD` (`read-tree --empty` on an unborn branch).
  2. **The untracked list:** `ls-files -z --others --exclude-standard` under the temporary index. Each entry is lstat-ed (never followed), and entries larger than `LANE_LIMITS.checkpointFileBytes` (50 MiB) are left out and counted as `skipped`. Scratch: a 500 MB `dev.db` would otherwise add its blob to the owner's object store on every turn.
  3. `add -u -- .` (or `-- ./paths`) for the tracked files.
  4. `add --pathspec-from-file=- --pathspec-file-nul` with the kept untracked list on stdin (skipped when empty), under `--literal-pathspecs`; a name like `-rf` stays a path.
  5. `write-tree`.

  The temporary file is removed in `finally`, and the result is `{ tree, skipped }`. If `add` fails on the copied index (a split index: its shared file lives beside the real one), the temporary index is rebuilt with `read-tree` and the adds run once more. The real index, `HEAD` and the worktree are never written; the scratch run also showed the left-out file's blob absent from the object store.

  — cost if wrong: a checkpoint that stages the owner's files, or a disk filled one turn at a time.

M9R55 [11] `restoreCheckpoint(root, commit)`:
  1. recreate the worktree root if it was removed;
  2. `restore --source=<commit> --worktree --staged -- .` (an empty-tree checkpoint works: scratch-verified);
  3. `clean -f -d -- .` (ignored files stay: `.env` survived in scratch);
  4. `reset --quiet -- .` (the index back to `HEAD`).

  The runner pins `--work-tree=<root>` on all three (M9R10). The caller captured `undo` first and holds the lane lock (Task 15). — cost if wrong: deleted work with no undo.

M9R56 [11] `diffList(root, from, to)`:
  - `diff --raw -z -M --no-abbrev <from> <to> --` and `diff --numstat -z -M <from> <to> --`, merged by path into `ReviewFile`: the status letter from `--raw`, the rename score dropped, identity = the to-side blob or `deleted`, binary when numstat says `-\t-`;
  - at most 2 000 files, with `truncated`;
  - paths that fail `RepoPath` or match `INVISIBLE` are dropped and counted in a log line (`review_path_dropped`).

  — cost if wrong: a file missing from a review (logged).

M9R57 [11] `turnRanges(path, checkpoints)` and `checkpointTarget(path, checkpoints)` are pure (pi-web §9).
  - `path` is the session's branch from the root to the leaf (`{ id, parentId, user, preview }[]`); `checkpoints` is the set of entry ids with a ref (`root` counts as before the first entry).
  - A turn starts at a user message U:
    - `from` = the nearest strict ancestor of U with a checkpoint (or `root`);
    - `to` = the nearest ancestor-or-self with a checkpoint of the entry before the next user message (or the leaf), provided it is a descendant of U; else `live`.
  - The target is the nearest ancestor-or-self of the leaf with a checkpoint; `exact` when it is the leaf.

  — cost if wrong: a turn diff that starts one turn early.

M9R58 [12] `stores/lane-store.ts` is a zustand store, fed only by `stores/lane-feed.ts` from the `lane` stream (as `vcs-feed.ts`): `lanes: Map<id, LaneView>`, `fanouts`, `archived`. The reducer is pure and tested. Sign-out wipes it: the `AppShell` cleanup of MC34 gains one entry; agreement 21: each plan adds its own resets — cost if wrong: one account's lanes shown to another.

M9R59 [12, 13] (corrected: M9-RT-19) Item kinds `{ kind: "lane"; id }` and `{ kind: "compare"; id }`:
  - `itemKey` is `lane:<id>` or `compare:<id>`; `item-path.ts` encodes them;
  - a stale id renders "This lane was archived", with a link to the archived-lanes list, rather than an error;
  - the tab title (boards 05 and 10) is the lane's branch with a status dot coloured by `deriveLaneStatus` (`working` agent, `needs_attention` attention, `in_review` you, `done` ok, `idle` none) and the status word for screen readers (colour is never alone, DESIGN §2);
  - the compare tab reads "Compare · <n> lanes";
  - **the ⌘B tree ends with "Archived lanes (n)"** (n from the snapshot's `archived`), which opens Task 13's lazy `ArchivedLanes` list (`lanes.listArchived`, page by page). It is the archive shelf decision 30 and M9R43 promised, and the read path of `listArchived` and of the archived count.

  — cost if wrong: an archived lane nobody can find.

M9R60 [12] Session facts for the status come from the shell store (`ShellSession.status`, `needsInput`, `cwd`): a session belongs to a lane when its `cwd` is the worktree or under it (`lib/lane-sessions.ts`, pure). `deriveLaneStatus` is the contract's — cost if wrong: none.

M9R61 [12] ⌘K: a "Lanes" group (title, branch, status word; archived lanes excluded) before Sessions; an action "New lane" bound to ⌘⇧L (board 10 §3), registered in `features/commands/defaults.ts`; `palette-items.ts` grows by its lines only. The ⌘B tree (`features/projects/tree.vm.ts`): under each project, its non-archived lanes (status dot and word, title, branch, `+n` ahead, `●n` dirty, `#n` PR), each expandable to its sessions (by folder); sessions of a lane no longer appear loose under the project; a "New lane" item in the project menu. Opening a lane row opens the lane tab — cost if wrong: none.

M9R62 [13] (M9R109) Layout (board 10, owner m9q7): the lane tab is `LaneScreen { laneId }`, with the header and two panes.
  - Left: the chat of the lane's current session (the primary one, or the session picked in a header menu listing the lane's sessions).
  - Right: a pane with a segmented Review / Changes / Terminal (board 10's pane header), and ⊞ to split it once more (board 05's three-pane arrangement is reachable that way).
  - The split ratio and right-pane choice persist per lane in `localStorage` (`pap.lane-layout.v1`, at most 200 lanes, oldest dropped: a cache).

  — cost if wrong: a layout change.

M9R63 [13] Features never import each other: `pane-renderers.tsx` renders the lane tab with render props `chat(sessionId, beforeComposer)`, `changes(root)` and `terminal(root)`, built from the existing session, changes and terminal renderers. Review and the commit bar are Task 19's and Task 20's components inside `features/lanes`, placed by named slots in `LaneScreen` — cost if wrong: none.

M9R64 [13] (corrected: M9-RT-18, RT-06) `SessionScreen` gains an optional `beforeComposer?: ReactNode`, rendered right above the composer (≤ 3 lines; no other edit). The lane tab passes `<CheckpointBanner laneId sessionId/>`, which:
  - calls `lanes.checkpointStatus` **only while the session is idle**: on a leaf change seen while idle, on focus, at most once a second. During a run the banner keeps its last answer, and never makes the daemon snapshot every two seconds;
  - shows nothing when `differs` is false;
  - "Restore files" asks inline, without a count: "Restore the files to this point? Undo stays possible until the next restore.", then `lanes.restore`;
  - `changed: false` → "The files already match this point"; after a restore it shows Undo (`undoAvailable`);
  - `busy` says "Stop the agent or the script first";
  - is never a modal. Restore is browser-only (`lanes:admin`), and the banner exists only in the browser.

  — cost if wrong: none.

M9R65 [13] (corrected: M9R110, M9R115, M9R119) The header:
  - the status chip, a word and a tone: working → run, needs_attention → att, in_review → you, done → ok, idle → mut. The reason is a second word: "setup failed", "setup not approved", "setup waits for you", "input needed", or "create failed: <git / prepare / disk / interrupted>";
  - the external-content chip (dashed attention, "external content") when `source.kind === "issue"`;
  - `branch → baseLabel · ↑ahead ↓behind · +additions −deletions` in tabular figures (`—` for null);
  - the PR badge: `#n · open/draft/merged/closed`, checks `✓ n` / `✗ n` / `… n`, "conflicts"; an `error` shows its word and a Retry calling `lanes.prRefresh`;
  - **notices** (`LaneView.notices`, `LaneNotices.tsx`): one muted line each, newest first, dismissed locally. Their words: "<n> large files left out of checkpoints", "A checkpoint was skipped: the prompt could not wait", "Checkpoints are full for this lane", "Disk almost full: checkpoints paused", "<n> copy or link entries skipped (see the setup log)", "The model was refused; Pi's default runs", "The session could not start: Start session".

  The actions:
  - Setup log: a dialog reading `lanes.scriptLog` 256 KiB at a time, plain text, mono.
  - **Run setup**, when setup is `pending` (a token created the lane), `failed`, `interrupted` or `unapproved`: `lanes.runScript { kind: "setup" }`. A `tainted` answer shows `TaintedConfirm` inline and sends again with `confirmTainted: true`.
  - New session here (`lanes.newSession`); Archive (dialog).

  Opening the tab calls `lanes.prRefresh` once when the lane has a PR (60 s cache on the daemon). — cost if wrong: none.

M9R66 [13] (corrected: M9R119) The archive dialog has Force and Delete branch checkboxes, unchecked. The refusal reasons in words:
  - "A session, a script or a terminal of this lane is running";
  - "Uncommitted changes would be lost: commit them, or check Force";
  - "The archive script failed:" + its last lines as text;
  - "Setup is running";
  - `tainted` → `TaintedConfirm`, then Archive again.

  Force names what it loses ("uncommitted changes and untracked files in the worktree"). Archive is `danger` only when Force is checked (DESIGN §9.1: danger for irreversible actions). — cost if wrong: none.

M9R67 [13] Phone (DESIGN §8, board 12): one pane at a time with Chat / Review / Term; the header shrinks to `branch · status · ↑n · PR`; actions in a sheet — cost if wrong: none.

M9R68 [14] (M9R106) `lanes.commit { laneId, paths, message }` runs under the lane lock (Task 7):
  - `add -A -- ./<p>…`, then `commit --file=- --no-gpg-sign --quiet -- ./<p>…` (60 s each; `keepStderr`; `--work-tree` pinned by the runner);
  - the message goes on stdin, followed by a blank line and the trailer `Pap-Lane: <laneId>` (pi-web R4; scratch-run: the trailer is in the commit).

  The outcomes:
  - exit 1 with "nothing to commit" or "no changes added" → `nothing_to_commit`;
  - "Please tell me who you are" / "unable to auto-detect email" → `identity_missing`;
  - "unmerged" / "conflict" → `conflicted`;
  - anything else → `failed`.

  The owner's identity is git's own (global or repository `user.*`). Commits are not signed and hooks do not run (owner m9q4). Facts refresh after. — cost if wrong: a reason shown as `failed`.

M9R69 [14] (corrected: M9-RT-02, RT-08) `lanes.push { laneId }` takes **a per-lane push mutex, not the lane lock**: a push never writes the worktree, and holding the lane lock for 120 s let a late "before" capture tear a checkpoint. Then:
  1. Read `ORIGIN_URLS_ARGS` and `remote get-url --push --all origin` (exit 2 → `no_remote`), and feed both to `pushTarget` (Task 2b): `no_remote`, `unsupported_remote`, `repo_config`. The test seam's `file` target is accepted only when the test protocols include `file`.
  2. `PUSH_SCAN_ARGS` → any `repositoryKeys` → `repo_config`. The keys' names go in the log line, never their values: a URL can carry a token.
  3. Only then `push --porcelain --set-upstream origin refs/heads/<b>:refs/heads/<b>` under the remote profile (120 s, `okCodes: [0, 1, 128]`, `keepStderr`).

  The outcomes:
  - a `!` line in the porcelain output, `[rejected]`, `non-fast-forward` or `fetch first` → `rejected`;
  - `Authentication failed`, `Permission denied (publickey`, `could not read Username`, `terminal prompts disabled`, `403` → `auth`;
  - `Could not resolve host`, `Connection refused`, `timed out`, `Network is unreachable`, `unable to access` → `network`;
  - else `failed`.

  Success answers the effective target `{ host, path }`, writes the audit row `lane_pushed { laneId, host, path }` (an external write by the owner), and refreshes the facts. — cost if wrong: a push to a place the owner did not see.

M9R70 [14] (corrected: M9-RT-02, track split) **Remote facts**, `remote-facts.ts`, kept in memory beside the facts:
  - `LaneView.remote` comes from `ORIGIN_URLS_ARGS` (exactly one value) → `parseRemote`; `forge` from `forgeOf(host, config.forge)`; `pushRemote` from `pushTarget` (null when refused);
  - they are refreshed after create, push and `lanes.refresh`;
  - `lanes.preview`'s `remote` and `forge` come from the same function.

  The Push button names `pushRemote` **before the first push** (Task 20). `lanes.prCreate { title, body, draft }`:
  - `facts.unpushed === null` (no upstream yet) → `not_pushed` (the bar pushes first);
  - `forgeFor(kind)` null → `unsupported_remote`; `forge_missing` when the CLI is missing;
  - an open PR for the branch (`findPr`) is reused; else `createPr`, with head = the branch and base = the base ref's branch name (`refs/heads/main` → `main`, `refs/remotes/origin/main` → `main`; a commit base sends no base, and the forge uses its default branch);
  - then `viewPr`; `pr_number` and `pr_url` are stored, the `PrView` is cached 60 s in memory, and the lane is published.

  — cost if wrong: two PRs for one lane (`findPr` prevents it).

M9R71 [14] `lanes.prRefresh` reads the cache unless it is older than 60 s, then `viewPr`. A lane without a PR answers `{ pr: null }`; a forge error keeps the last state with `error` set. Nothing polls in the background (C §9.4): the lane tab calls it when it opens (Task 13) and on Refresh — cost if wrong: none.

M9R72 [15] (corrected: the slot moved to Task 6a, M9R114) This task completes the hooks Task 7 registered: in the `sessions.setLaneHooks(...)` call of `compose-lanes.ts`, `beforePrompt` and `afterRun` now come from `modules/lanes/checkpoints.ts`, while `closed` and `holdsFiles` stay Task 7's. It edits no sessions file — cost if wrong: none.

M9R73 [15] (corrected: M9-RT-08, RT-09) The lanes side, for a session whose real cwd is in a lane:
  - **"before"**, `beforePrompt(info, released)`, under the lane lock:
    1. re-check with `SessionsLanePort.runState` that the session is still idle with the same leaf, else skip (two prompts racing on one idle session make one capture);
    2. the disk floor (M9R117; below → skipped, `disk_low` notice);
    3. `captureCheckpoint` with key = the leaf (`root` when null);
    4. **if `released.value` is true by then, the ref is not written**: the existing `e/<leaf>` stays, and a `checkpoint_before_late` notice is added;
    5. else `update-ref`, replacing that ref when it exists (pi-web's behaviour: the next turn starts from the files as they are when the prompt goes, hand edits between runs included).
  - **"after"**, `afterRun(info)`, under the lane lock: key = the leaf at the run's end.
  - In both:
    - an entry id that fails `EntryId` is skipped and logged;
    - `skipped > 0` adds `large_files_skipped { count }`;
    - at `checkpointsPerLane` (2 000), captures are refused (logged once per lane, `checkpointsFull` set and published), never evicted.
  - After an "after" capture: `first_run_ended_at` is set once, the facts refresh, the lane is published, and the `afterRun` listeners run (Task 18b joins them).

  — cost if wrong: a torn "before" checkpoint that restores half of an agent's edits, or a lane whose history silently stops.

M9R74 [15] `lanes.checkpointStatus { laneId, sessionId }`: the session must be the caller's and in the lane, else `not_found`. `branchPath` (Task 6a's port) + `laneRefs` → `checkpointTarget`. `differs` says whether the target commit's tree (`rev-parse <commit>^{tree}`) differs from `snapshotTree(worktree)` (the snapshot memoised per lane for 2 s); `undoAvailable` says whether the `undo` ref exists. The web asks only while the session is idle (M9R64) — cost if wrong: a banner that flickers (the memo bounds it).

M9R75 [15] (corrected: M9-RT-06, M9R1) `lanes.restore` is `lanes:admin` (browser only).
  1. Refused `busy` when a lane session is running or starting (`activityIn`) or a lane script runs; `no_checkpoint` when there is no target.
  2. Under the lane lock, with `holdsFiles` answering this restore's promise (a prompt waits for it without the cap, M9R114): **busy is checked again**.
  3. **When the target's tree equals the current snapshot, the answer is `{ ok: true, changed: false }`, and nothing is captured, so `undo` keeps the owner's work** (two restores in a row no longer lose it).
  4. Else: capture `undo` from the current files, `restoreCheckpoint(target)`, facts, publish, `{ ok: true, changed: true }`.

  `{ undo: true }` restores the `undo` ref, with no new undo captured and the same no-op rule. A terminal open in the worktree does not refuse: it is the owner's shell, a residual in `lanes.md`. — cost if wrong: a restore under a running agent, or the owner's work lost after two clicks.

M9R76 [16] `lanes.review { laneId, scope }`: branch → `from` = `merge-base <base> HEAD` (labelled with `baseLabel`), `to` = `live` with `snapshotTree(worktree)`; turn → the session (owned, in the lane) and `turnRanges`, the turn of `userEntryId` (unknown → `not_found`), `from`/`to` its checkpoint commits or `live`; then `diffList`. The browser asks each file's texts with `vcs.fileDiff { root: worktree, path, oldPath, from: { kind: "commit", oid: from }, to: live ? { kind: "worktree" } : { kind: "commit", oid } }` (M8's boundary judges every side; a tree oid works where M8 says `commit`: `<oid>:<path>`) — cost if wrong: none.

M9R77 [16] `lanes.turns { laneId, sessionId }`: `turnRanges` over `branchPath`, newest first, at most 500 (`truncated`), each with its user message's 120-character preview (plain text, `INVISIBLE` stripped) — cost if wrong: none.

M9R78 [16] Review state: `lane_reviews` with compare-and-set (`baseRevision` 0 inserts, a mismatch → `conflict`, the settings pattern); the doc is the contract's `ReviewDoc` (≤ 1 MiB stored, `payload_too_large` beyond); the row stays with an archived lane, as its record — cost if wrong: none.

M9R79 [17] A pi-host command `suggest_commit { id, diff }` (`contracts/pi-host.ts`: the record and its response `{ message }`; `dispatch.ts`: one case; `suggest-commit.ts` on `auto-name.ts`'s pattern): the session's current model, `completeSimple`, a system prompt asking for a Conventional Commits message for the diff (subject ≤ 72 characters, body optional, no code fences), `maxTokens` 400, 30 s; the answer stripped of fences and clipped to 2 000 characters. No tool runs, so the policy has nothing to judge; the diff goes to the provider the session already talks to — cost if wrong: a poor message.

M9R80 [17] (corrected: M9-RT-24, controller ruling C1) The daemon side: `SessionsLanePort.suggestCommit(caller, sessionId, diff)` (one method in `lane-port.ts`; a cold primary session's worker is started, like `autoName`). `lanes.suggestCommit { laneId, paths }`:
  - no primary session → `no_session`;
  - the diff = `snapshotTree(worktree, paths)`, then `diff --no-color -U3 -M HEAD <tree> --`, each file's part clipped to 20 000 characters and the whole to 200 000 (Orca's per-file clipping);
  - empty → `nothing`; a model error → `model_failed`.

  The method is a mutation (`idempotent: false`): a client retry with the same command id gets the receipt, never a second paid model call. Like Pi's `auto_name`, the call is a side call that M10's runs registry and daily budget do not count (C1); `lanes.md` and M10's `finops.md` say so. — cost if wrong: a model call paid twice, or a spend the budget cannot see.

M9R81 [18b] (corrected: M9-RT-14) `lanes.create` with 2–4 models:
  - one `lane_fanouts` row (16 random hex), whose `prompt` is **the rendered first prompt**: `issuePrompt` for an issue fan-out, else `# <title>

M9R82 [18a] (corrected: M9-RT-04, RT-15, RT-16; M9R107) `lanes.issue { projectRoot, url }`:
  1. `parseIssueUrl(url, config.forge)`, else `unsupported_url`;
  2. **`issueAllowed(ref, { remote, forge })`** with the project's remote facts (Task 14), else `unsupported_url`, and the stub is never called (M9-RT-04);
  3. `forgeFor(kind)` null (GitLab, Gitea: owner m9q5) → `unsupported_url`, shown as "not supported yet";
  4. `viewIssue` → `IssueView`.

  `lanes.create` with an `issue` (a browser's from `lanes.issue`, or a token's own):
  - re-checks `parseIssueUrl(issue.url, issue.forge)`, `issueAllowed` and `ref.number === issue.number`, else `bad_request`: a token cannot point the prompt at another host;
  - the first prompt is `issuePrompt` (binding below): the title and body inside `fenceText` with a fresh 12-hex id, and outside it only the canonical URL rebuilt from the parsed parts (`issueUrl`: no query, no fragment, M9-RT-15);
  - `source` = `{ kind: "issue", forge, url: issueUrl(ref), number }`;
  - the primary session is tainted right after it is created and before the prompt (`PolicyPort.markTainted(ownerId, sessionId)`, audit `tainted_issue`): M5's rule for external content (ADR 0020), so no question was asked;
  - sessions started later in the lane are not tainted (they never saw the issue; forks inherit through M5).

  The int test asserts the effect, not only the policy view: the scripted provider's first tool call is network-capable and raises an approval whose reason is the taint (M9-RT-16; M5 delivers the taint update to the worker over the same IPC channel before the prompt).

  — cost if wrong: an issue's injected instructions reach an untainted session, or a pasted link sends a request to another host.

M9R83 [18a] (M9R105) Trust inheritance (owner m9q2 = b). After the worktree is ready, `trust.inherit(ownerId, worktree, projectRoot)` writes `true` for the worktree (audited, with `inheritedFrom`) when both hold:
  - Pi's store says the project root is trusted (`trust.status`, a helper read; an error counts as untrusted);
  - `rev-parse --verify --quiet <base_oid>:.pi` equals `rev-parse --verify --quiet HEAD:.pi` of the main checkout, and the same holds for `.agents/skills` (both missing counts as equal).

  Otherwise nothing is written, and M7's trust banner shows in the lane's session when needed. Archive (Task 7) always clears the worktree's entry. — cost if wrong: a lane from someone else's branch loads its `.pi/extensions` unasked (the tree comparison prevents it).

M9R84 [18b] (corrected: M9-RT-01, M9R108, M9R119) Tests: `lanes.runScript { kind: "test" }` (Task 7) runs the approved `test:` script (Task 5; 15 min), and `tests.state` is passed or failed by exit code. The auto-run (`auto-test.ts`, an `afterRun` listener of Task 15) runs a fan-out lane's approved test script once, when its primary session's first run ends, **only if all three hold at that moment**:
  - `created_by = 'session'`;
  - `source.kind !== "issue"`;
  - `taintedIn(lane)` is false.

  Otherwise nothing runs; the compare chip says "Run tests", and the click goes through the tainted confirmation. A lane without an approved test shows "no tests". — cost if wrong: code the agent wrote, after reading an issue, runs with no click.

M9R85 [18b] (corrected: controller ruling C1, agreement 14) `lanes.compare { fanoutId }`, per lane:
  - `summary` = the primary session's last assistant text (`lastAgentText`, 600 characters, plain text);
  - `files` / `additions` / `deletions` = `diffList(merge-base, snapshotTree)` totals (bounded by 2 000);
  - `durationMs` = `first_run_ended_at − created_at` (null while the first run goes on);
  - `costUsd` = `deps.sessionCost?.(primarySessionId) ?? null`. That is **M10's `RunsPort.sessionCost`**: the sum of the session's `runs.cost_usd` plus the live cost of its open run, null without runs. The second merger (M10 under c1) wires it with one `compose-lanes.ts` line, and adds the "API-equivalent" label for a subscription (DESIGN §11, from `billing`).

  No verdict, no ranking (decision 30). — cost if wrong: none.

M9R86 [18b] (corrected: M9R119) `lanes.closeLosers { fanoutId, winner, confirmTainted? }`:
  - `winner` must be in the group (`bad_request`);
  - every other lane is archived with `force: true, deleteBranch: false`: its uncommitted work goes, its commits stay on its branch;
  - listed in `refused` and left alone: a busy lane, one whose setup runs, and **one whose archive script would run while a session is tainted and `confirmTainted` is not set** (`tainted`). The browser confirms once, then sends again for those.

  — cost if wrong: lost work (the dialog says what goes, Task 22).

M9R87 [19] `@pap/ui/code` gains `ReviewDiffView { before, after, language, labels, comments, onComment(line, side), onOpenComment(id) }` in the same lazy subpath (`code.ts`), built from S5's glue: `unifiedMergeView` (`collapseUnchanged: { margin: 3, minSize: 4 }`, `mergeControls: false`), `lineNumbers`, a comment gutter, a `mousedown` listener on `view.dom` for deleted lines (`.cm-deletedChunk` / `.cm-deletedLine`, `getChunks` + `getOriginalDoc`), and block widgets for comments (after-side under their line, before-side under their deleted chunk: S5's stated limit). Colours from tokens only (`--you-tint`, `--you-line`, `--you-text`, `--diff-add`, `--diff-del`, `--ok`, `--err`); the gutter `+` is always shown at the muted tone (no hover-only control: touch has no hover, S5's trap), a tap or click on it or on a line number opens the editor; comment text goes into widgets as `textContent` only — cost if wrong: comments unreachable on a phone.

M9R88 [19] `ReviewPane { laneId, worktree }` (fills `LaneScreen`'s `review` slot): the scope segmented Branch / Turn (Turn opens a menu of `lanes.turns` previews, newest first, "Turn n · <preview>"), the list from `lanes.review` (Conflicts, then by path; a row: Seen box, path, `+a −d` or "binary", the word of its status), "Seen n / m" with a progress bar and the comment count; selecting a row loads both texts with `vcs.fileDiff` (the sides of M9R76); `binary` → "Binary file changed"; `truncated` → "Too large to show here" with Open in Files (the `onOpenFile` render prop). Seen ticks store `{ path, identity }`; a file whose identity changed shows unticked — cost if wrong: none.

M9R89 [19] Comments: an inline editor under the line (textarea, Save, Cancel; Escape cancels; at most 4 000 characters), the list per file with Edit (clears `sentAt`), Resolve, Delete; the review document saved with `lanes.reviewState.set` (compare-and-set; a `conflict` re-reads, merges by comment id and Seen by path, and retries once, the settings pattern). Excerpt: the commented line's text (500 characters) — cost if wrong: none.

M9R90 [19] Send (pi-web §10, Orca's `formatDiffComment`): `formatReviewBatch(comments)` (pure) — `Review comments on the current changes:` then, per unresolved unsent comment, `File: <path>` / `Line: <n>` (`Line: <n> (removed)` for the before side) / `Code: <excerpt>` / `User comment: "<body with \\, ", \r, \n escaped>"`, blocks separated by a blank line. "Send to <session>" appends it to that session's composer through `stores/composer-prefill.ts` (`use-composer.ts` takes it once, appending after the current text with a blank line, and focuses the field: ≤ 3 lines there) and opens the lane's chat; "New session" calls `lanes.newSession` then does the same for the new session. The sent comments get `sentAt` — cost if wrong: a batch typed over the owner's draft (appending prevents it).

M9R91 [20] (corrected: M9-RT-02, M9R106) `CommitBar { laneId, worktree }` fills `LaneScreen`'s `commitBar` slot, under the review:
  - the changed files come from the `vcs` store of the worktree (M8's stream: `subscribe.vcs` with the worktree as root), all ticked by default; a "n of m files" toggle opens the checklist. A `link:` destination is ignored by construction (M9R24), so it never appears;
  - the message field: mono, multi-line, Mod-Enter commits;
  - ✦ Suggest: `lanes.suggestCommit` with the ticked paths; it fills an empty field and asks before replacing a typed one;
  - Commit: `lanes.commit`. Each refusal in words: "Nothing to commit in the ticked files", "Git needs your name and email: set user.name and user.email in the terminal", "Resolve the conflicts first", "Commit failed: see the daemon log";
  - **Push ↑n → host/path**: n = `facts.unpushed` after a first push, else `facts.ahead`. **The target is `LaneView.pushRemote`, shown before the first push**; without one, the button says why (the push refusal below).
  - Each push refusal in words:
    - `repo_config`: "This repository's own git config names a program, or sends pushes elsewhere (a pushurl, a second url). Push from the terminal, or remove those keys.";
    - `rejected`: "The remote has commits this lane does not have: pull them in the terminal first";
    - `auth`, `network`, `no_remote`, `unsupported_remote`.
  - Busy states follow DESIGN §7.3: disabled at once, a stage label after 3 s.

  — cost if wrong: none.

M9R92 [20] `PrPanel`: without a PR, a form (title = the lane title, body = the lane's description, Draft box) and Create PR (`lanes.prCreate`; `not_pushed` offers "Push and create", which pushes then creates); with a PR, the badge's details (state, draft, checks passed / failed / pending, conflicts, the error word with Retry), Refresh (`lanes.prRefresh`) and "Open on <forge>" (`window.open(url, "_blank", "noopener,noreferrer")`, only `https:` URLs). Forges missing or unsupported say what to do: "Run `gh auth login` in a terminal" (gh answers from its own login, M9R47), or "GitLab and Gitea are not supported yet" (owner m9q5) — cost if wrong: none.

M9R93 [21] (corrected: M9R107, M9R111, M9-RT-10) The fields:
  - "Issue or description": a textarea. When its whole text is one URL that `parseIssueUrl` would take (the same rule, ported to the web as a pure function in `features/lanes/issue-url.ts`), a Fetch button calls `lanes.issue`. `unsupported_url` says "Only GitHub issues of this project's forge can be fetched; paste the text instead".
  - The issue card is an external-content card: **DESIGN §2's dashed attention frame, label `UNTRUSTED · <forge> issue`** (owner m9q10, decision 29's pattern), with title, repository, state, labels and the body collapsed to three lines, all as text.
  - Title: prefilled from the issue title or the description's first line, editable. Board 10 draws only the issue case; pi-web's plain case has a title.
  - Branch: prefilled `branchPrefix + slugOf(title)` (`slugOf` from contracts); edited text is checked against `BranchName`.
  - From: the preview's refs, the current branch first. **A remote-tracking ref of another branch** (`refs/remotes/<r>/<b>`, where `<b>` is not the current branch) carries a note: "Someone else's branch: its package scripts run in your setup".
  - Model per lane: the project's enabled models from `models.overview { cwd: projectRoot }`, plus "Pi's default".
  - Fan-out 1–4: each added lane adds a model row; the model is "Agent and model" without the agent until M11.
  - The footer says "GitHub issues only for now" (owner m9q5).

  — cost if wrong: none.

M9R94 [21] (corrected: M9-RT-10, M9R110) Script trust (decision 30, board 10 §3). For each script of the preview not approved, a dashed attention box:
  - "Setup script · new", or "· changed since you approved it", with the old and new texts side by side when `previous` exists (mono, plain text, scrollable);
  - **what it reaches**: "Runs in the lane with the files of the base you pick (package scripts included), without your SSH agent or keys, and only when you start it from this browser";
  - "Approve script" runs the step-up runner (`useStepUpRunner`), then `lanes.approveScripts` with the shown hashes; `changed` → "The script changed while you read it", and the preview reloads.

  Create stays possible without approving: the lane is made, and its setup says "not approved". — cost if wrong: none.

M9R95 [21] Opening: ⌘⇧L and the command palette's "New lane" open it for the switcher's project (else the active tab's project); the project menu of the ⌘B tree opens it for that project. Create calls `lanes.create` and opens the new lane's tab (or the compare tab for a fan-out) — cost if wrong: none.

M9R96 [22] (corrected: M9R108, M9R119, C1) `CompareScreen { fanoutId }` replaces Task 12's placeholder. The columns come from the lane store and `lanes.compare`:
  - the tests chip by `tests.state`: passed "tests ✓" ok; failed "tests ✗ (exit n)" attention; running "testing" agent; queued "waiting" muted; none "no tests" muted; unapproved "tests not approved" muted; interrupted;
  - "Run tests" (`lanes.runScript { kind: "test" }`) shows when no auto-run happened (issue, token-created or tainted lanes, owner m9q6); a `tainted` answer opens `TaintedConfirm` (Task 13);
  - Duration `6m40`, or "running";
  - Cost `$0.38`, or "—" with the note "cost comes with M10" while null (after M10's rebase, a subscription's figure says "API-equivalent", agreement 14);
  - the summary as plain text;
  - "View diff" opens the lane tab on Review (branch scope); "Pick · PR" marks the winner (outline) and opens its lane tab with the commit bar;
  - "Close losers" (enabled once a winner is picked) confirms by naming each other lane and what goes ("uncommitted changes; the branch and its commits stay"), then calls `lanes.closeLosers`. A `tainted` refusal opens `TaintedConfirm` and sends again for those lanes; other refusals are listed;
  - "Run again" opens the new lane dialog with the models, and the prompt, or the issue URL of an issue fan-out (from the first lane's `source`).

  On a phone the columns stack. — cost if wrong: none.

M9R97 [all, merge notes] (c1 = a) **M9 merges first.** M10 rebases once and re-dates nothing of M9's: its migrations are already `2026101420xx` (agreement 2). The exception: M10 passes its Opus final review more than one working day before M9; then the mirror applies, and M9 re-stamps after M10's newest. The second merger:
  - wires M10's `diskFloor` and `RunsPort.sessionCost` into `compose-lanes.ts`, one line each (agreements 13, 14);
  - adds `disk_low` to `lanes.create`'s errors;
  - runs every gate.
  — why: M9 is on the critical path (M8 → M9 → M11 → M12 → M13) — cost if wrong: M9 rebases instead (≈ 1.5 h).

M9R98 [all] (c2 = a) An Opus implementer at fix rounds 4–5 is pre-approved for this wave, logged in the ledger — cost if wrong: none.

M9R99 [all] (c3 = a) Sonnet implementers on every task, never Haiku — cost if wrong: none.

M9R100 [model table] (c4 = a) M9's Opus reviewers are the planner's list with the red-team's additions: Task 1, both halves of Tasks 2, 6 and 18. GitLab's Task 10 was dropped by m9q5; the c7 retrofit (the new Task 10) gets Opus by the controller's ruling. 19 Opus reviewer lines — cost if wrong: one more Opus review per misjudged task.

M9R101 [—] (c5 = a) M10's reviewer list, with its red-team's additions (T8b, T12, T5a/T7a). It sets M10's table only; nothing in M9 changes.

M9R102 [final] (c6 = a) An Opus whole-branch review of M9, as of M10 — cost if wrong: none.

M9R103 [1, 2a, 5, 9, 10] (c7 = a) **One allowlisted environment for every child pap starts that no person watches**: lane scripts, `gh`, M7's `npx` / `npm` / `git` installs, and M10's precheck. The helper:
  - is `unattendedEnv(base, extra)` in `packages/contracts/src/child-env.ts` (binding code in Task 1). It lives in contracts because M7's install children are spawned inside pi-host's helper, which imports only `@pap/contracts`; `apps/daemon/src/kernel/child-env.ts` re-exports it under the home and name of agreement 8, so M10 imports it from there;
  - keeps `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_*`, `TZ`, the absolute PATH entries (else `/usr/local/bin:/usr/bin:/bin`) and `TERM=dumb`;
  - adds the names a caller lists in `keep` (`NETWORK_ENV`: proxies and CA bundles; `TOOLING_ENV`: `TMPDIR`, `XDG_*`; M10's per-trigger names, m10q7 = b) and pap's own constants in `set`;
  - **never passes** a name `isNeverPassedEnvKey` matches, even when named: the daemon-only keys, the SSH agent, `GIT_*`, `LD_*`, the model providers' families and any credential-looking name (`*_TOKEN`, `*_API_KEY`, `*SECRET*`, `*PASSWORD*`, …).

  M8's git runner keeps its own narrower allowlist (M8R21: no `TZ`, `LC_*`, `TERM`); a test pins that it holds no never-passed name except `SSH_AUTH_SOCK` on the push profile. That push is the owner's browser click, not an unattended child (M9R10). This closes decision 79's env option for M7's children too.

  Friction the owner accepted:
  - a registry token kept only in an environment variable (`NPM_TOKEN`) is not seen; put it in `~/.npmrc`;
  - tool variables such as `JAVA_HOME`, `GOPATH` or `NVM_DIR` do not reach a lane script; export them in the script;
  - a private plugin source over ssh needs the terminal;
  - gh answers from its own login (`gh auth login`), never from `GH_TOKEN`.

  — why: one rule instead of a denylist per child — cost if wrong: a child sees a secret it should not, or a tool misses a variable (the test tables pin both).

M9R103 [1] (continued; owner c7) `child-env.ts` (binding below) holds the one unattended environment. `apps/daemon/src/kernel/child-env.ts` is a re-export of `unattendedEnv`, `NETWORK_ENV`, `TOOLING_ENV`, `isNeverPassedEnvKey`, `FALLBACK_PATH` and the `EnvSource` / `UnattendedExtra` types (agreement 8's home). contracts has no Node types, so `EnvSource` is a plain record; the web never imports the file, and Rollup tree-shakes it (`sideEffects: false`).

M9R104 [6a] (m9q1 = a) A lane shares its project's always-rules and is filed under its project (the scope alias of M9R35). Filing a lane under its project was already settled by decision 25 — cost if wrong: one line returns null in `scopeAlias`.

M9R105 [18a] (m9q2 = b) A new lane inherits its project's Pi trust when the base's `.pi` and `.agents/skills` trees equal the main checkout's committed ones (M9R83); otherwise M7's trust banner shows once — cost if wrong: a lane loads another branch's extensions unasked (the tree comparison prevents it).

M9R106 [14] (m9q4 = a) pap's commit and push run no git hook and sign nothing. Husky and commitlint run when the owner or the agent commits in a terminal; signed-commit repositories commit from the terminal — cost if wrong: a later task with its own review.

M9R107 [2b, 9, 18a, 21] (m9q5 = a) **GitHub only.** GitLab's Task 10 is dropped, with its rulings M9R51–M9R52, and `glab` is never spawned. `forgeFor` has an adapter for `github` alone. GitLab and Gitea issue URLs answer `unsupported_url`, shown as "not supported yet". The page's reason: Gitea / Forgejo and Linear need a token pap would hold, so they wait for M11's vault; GitLab is deferred for scope. — cost if wrong: one adapter task later.

M9R108 [18b] (m9q6 = a) **A fan-out lane auto-runs its approved test script once, after its primary session's first run, only when:**
  - a browser session created the lane (`created_by = 'session'`);
  - its source is not an issue;
  - no session of the lane is tainted at that moment.

  Otherwise the compare chip says "Run tests", the owner clicks, and in a tainted lane confirms inline. The page said it plainly: the test run executes code the agent wrote, with the script's environment, outside the policy. — cost if wrong: an issue's injected test runs with no click (the mutation check pins it).

M9R109 [13] (m9q7 = a) The lane tab follows board 10: the chat, plus one pane with Review / Changes / Terminal and ⊞ to split it once more (board 05's three panes on demand); the layout is remembered per lane — cost if wrong: a layout change.

M9R110 [1, 5, 6b, 7, 13] (m9q9 = a) **Lane scripts are browser-only.** `lanes.runScript` is `lanes:admin`. A lane created by a token keeps its setup `pending` (status needs attention, "Run setup" in the browser) and never runs it by itself, whatever was approved. With `waitForSetup`, its session starts after the owner's run ends `ok`. Friction: an API client cannot run lane tests or setups. — cost if wrong: a token gets code execution (Scenario B of M9-RT-01).

M9R111 [21] (m9q10 = a) The issue card uses DESIGN §2's dashed attention frame with `UNTRUSTED · <forge> issue` (decision 29's pattern), not board 10's solid box. Friction: two dashed boxes in the dialog when a script also needs approval. — cost if wrong: a frame change.

M9R112 [1] (M9-RT-20) The contract is split from the start, each file well under 400 lines after prettier:
  - `lanes.ts`: limits, ids, views, notices, events, preview, issues;
  - `lanes-review.ts`: review shapes, turns, checkpoint status, compare column;
  - `lane-status.ts`: the derived status.

  — cost if wrong: a split under pressure in a fix round.

M9R113 [6a] (controller ruling C2) `releaseIdle(ownerId, sessionId): boolean` is added to the sessions module, since M9 merges first:
  - it lives in `restart-folder.ts`, which already holds the live map and the "idle and not busy" test;
  - it stops the worker when the session is the owner's, live, idle and not busy, and answers true; otherwise it leaves the worker alone and answers false;
  - it is exposed as `SessionsService.releaseIdle` (`service.ts` +1, `service-types.ts` +1) and `SessionsModule.releaseIdle` (`index.ts` +1).

  M10's task end calls it after its rebase (agreement 11). — cost if wrong: a one-function move at the rebase.

M9R114 [6a] (corrected: M9-RT-06, RT-07, RT-08; M9R72) The lane hooks slot, a new file `modules/sessions/lane-hooks.ts`. The lanes module fills it through `SessionsModule.setLaneHooks(hooks)` (`index.ts` +1): Task 7 first, with `closed` and `holdsFiles` and no-op capture hooks; Task 15 then swaps in the captures. It mounts in `service.ts` by two lines:
  - in `prompt`, right before `session.prompt(...)`: `await laneHooks.beforePrompt(row, session, input.streamingBehavior)`;
  - in `onPublished`: `laneHooks.published(sessionId, event)`.

  `beforePrompt` does, in this order:
  1. When `hooks.closed(row.cwd)` answers `archiving`, it throws `PapError("session_busy")`; for `archived`, `PapError("not_found")` (both declared by `sessions.prompt`). This is the only throw, and no prompt starts in a lane being removed (M9-RT-07).
  2. A steer or follow-up, a session that is not `idle`, or a prompt already pending: no hook.
  3. When `hooks.holdsFiles(row.cwd)` returns a promise (a restore runs), it awaits that first, without the cap (restores are bounded by their own git deadlines, M9-RT-06).
  4. `hooks.beforePrompt(info, released)` raced against `BEFORE_PROMPT_CAP_MS` (15 s, the kernel `Clock`). When the cap fires first, `released.value = true` and `checkpoint_before_late` is logged once; the lanes side then never writes its ref (M9-RT-08). A hook that throws lets the prompt go.

  `published` remembers each session's last status and calls `afterRun` on `running → idle` (void, `.catch` logged); the entry goes when the session goes cold (at most one entry per live session).

  Lines: `service.ts` +3 (the await, the `published` call, the `releaseIdle` export); `index.ts` +4 (`lanes`, `setLaneHooks`, `releaseIdle`, the type export). Agreement 10 counted +2 and +3; C2's primitive adds one line to each, recorded in the merge notes.

  — cost if wrong: a prompt delayed forever, a capture missed, or a run in a folder being deleted.

M9R115 [6b] (M9-RT-09, RT-18 completeness) Lane notices (`modules/lanes/notices.ts`) live in memory: per lane, the newest 8 `{ kind, at, count }`, published with the `LaneView`, gone at a restart (a display buffer per lane, bounded by `LANE_LIMITS.notices`; never security state). The kinds:
  - `model_refused` (M9R34), `session_failed` (the primary session refused with `capacity` or `worker_failed`: "Start session");
  - `copy_skipped` (Task 4);
  - `checkpoint_before_late`, `checkpoints_full`, `large_files_skipped`, `disk_low` (Task 15).

  Notices carry counts, never names: names stay in the setup log or the daemon log. — cost if wrong: an event the owner never sees.

M9R116 [5] (M9-RT-13) Right after the spawn, in the same tick as the `running` row, the lane row stores `script_pgid` and `script_proc = <boot id>:<start time>`. These come from `/proc/sys/kernel/random/boot_id` and field 22 of `/proc/<pid>/stat`, parsed with `kernel/pty/kill.ts` `parseProcStat`.

  At boot (`script-orphans.ts`, before the server listens): for each row still `running`, when the stored boot id equals the current one and `/proc/<pgid>/stat` shows the same start time, the group gets SIGKILL (scopes off) or its scope is stopped. Then the row turns `interrupted`; a mismatch only marks it `interrupted`. The columns are cleared at every exit.

  — why: with scopes off, or with the daemon run from a terminal, a detached script group survives a crash, and a "Run setup again" would race it — cost if wrong: a stray `pnpm install` beside a new one.

M9R117 [3, 4, 6b, 15] (M9-RT-09, agreement 13) **The disk floor.**
  - `LanesDeps.diskFloor?: (path: string) => void`, which throws when the filesystem of `path` is under the floor.
  - The default (`modules/lanes/disk-floor.ts`) is `localDiskFloor`: `statfsSync(path)`, `bavail × bsize` under 1 GiB → `PapError("capacity")`, an unreadable `statfs` → no refusal (M10's rule: `freeMb` answers null on failure).
  - Its callers:
    - `lanes.create`, synchronously;
    - `worktrees.create`, before `worktree add` (lane `failed`, `disk`);
    - each copy (skipped, notice);
    - each checkpoint capture (skipped, `disk_low` notice).
  - M10 owns `PAP_MIN_FREE_DISK_MB` and `kernel/disk.ts`'s `diskFloor`. The second merger (M10, under c1) replaces the default with one `compose-lanes.ts` line that throws `PapError("disk_low")`, and adds `disk_low` to `lanes.create`'s errors (agreement 3).

  — cost if wrong: SQLite writes fail on a full disk, next to `state.db`.

M9R118 [10] (owner c7, M9R103) `installEnv(base, home)` (binding below) becomes `unattendedEnv` with the network and tooling names, pap's quiet constants and `HOME` = the helper's home. `withInstallEnv` is unchanged: it swaps `process.env` for that object (plus `GIT_TERMINAL_PROMPT=0`) around the one operation and puts every variable back. The npx install keeps its `npm_config_before`.
  - What changes for the owner: provider keys, the SSH agent and `NPM_TOKEN`-style variables no longer reach installs.
  - A private registry works through `~/.npmrc` (HOME is kept); an https plugin source works; a private plugin source over ssh needs the terminal (`pi install`).
  - The fallback PATH grows from `/usr/bin:/bin` to `/usr/local/bin:/usr/bin:/bin` (the shared `FALLBACK_PATH`).

  — cost if wrong: an install sees the owner's keys (the test pins it), or an install that worked needs `~/.npmrc` (the copy says so in `skills.md`).

M9R119 [7, 13, 18b, 22] (M9-RT-01, M9R108, M9R110) **`lanes.runScript` and the tainted confirmation.** `lanes.runScript { laneId, kind: "setup" | "test", confirmTainted? }` is `lanes:admin`:
  - the lane must be `active` → else `not_active`;
  - a session of the lane is tainted (`PolicyPort.sessionPolicy(...).taint.tainted` over `activityIn(...).sessions`) and `confirmTainted` is not true → `tainted`; nothing runs, and the browser shows the inline warning, then sends again with `confirmTainted: true`;
  - then the runner's own refusals (`none`, `unapproved`, `running`).

  The same check guards the archive script (M9R40) and each loser's archive script in `closeLosers` (M9R86). The warning reads: "Runs this lane's files, which an agent that read external content may have changed".

  — cost if wrong: an issue's injected `postinstall` or test runs on a click that did not say so.

M9R120 [7] (M9-RT-06, RT-07, RT-08) The lane lock, `modules/lanes/lane-lock.ts`:
  - `laneLock(laneId).run(kind, fn)` is a per-lane promise chain. Archive, commit, restore and checkpoint captures each take it, one at a time; push does not (M9R69).
  - While a `restore` holds it, `holdsFiles(cwd)` returns the lock's promise, so a prompt waits for the restore without the 15 s cap (M9R114). An archive instead marks the lane closed (M9R40).
  - Tasks 14, 15 and 18b use the lock; nobody builds a second one.

  — cost if wrong: a capture, a commit and an archive interleaving in one worktree.

M9R121 [13, 22] (M9-RT-19, M9R119)
  - `ArchivedLanes` is a lazy list, opened from the ⌘B tree's "Archived lanes (n)" and from a stale lane tab. It reads `lanes.listArchived` page by page; a row is title, branch, PR link, archived date; Load more.
  - `TaintedConfirm` is one inline confirmation, never a modal: "Runs this lane's files, which an agent that read external content may have changed", with Run anyway / Cancel. Tasks 13 and 22 reuse it.

  — cost if wrong: none.

# M9 execution rulings (controller, 2026-10-14)

Source: the controller's rulings file (MC1-MC4) and the "Ruling:" lines of the execution ledger (MC5-MC26, numbered here in ledger order). Format: `MC<n> [tasks] ruling - why`. Each is written in plain words; the review findings it answers are in the task review reports.

MC1 [2a, 3, 11, 14] The Task 2a review found four Important defects, all demanded by the plan and all reproduced on git 2.53. All four are fixed in 2a, as defence in depth (each needs a write under a protected `.git` segment first).
  - `update-ref` requires `--no-deref`, so a symbolic ref under `refs/pap/checkpoints/` can never move or delete a branch.
  - `worktree remove` requires `--force`. The "dirty" test of Task 3 uses the guarded `status --porcelain ... --ignore-submodules=dirty` at the lane root, never git's own dirty check, which would run a lane `config.worktree` filter.
  - The `add -u -- .` and `add -A -- .` forms are removed. Staging (checkpoints, commits) takes explicit paths from the guarded status, deletions included, through `add --pathspec-from-file=- --pathspec-file-nul` with `GIT_LITERAL_PATHSPECS=1`; the list has a cap (4096 paths, 512 KiB).
  - Every lane call pins `--git-dir=<common>/worktrees/<name>` as well as `--work-tree`, both from pap's own record of the lane, never from the lane's `.git` file. A rewritten `.git` file can then neither redirect the index nor a commit.
  - `BRANCH_PATTERN` also refuses `HEAD`, `FETCH_HEAD`, `ORIG_HEAD` and `MERGE_HEAD`.
  - Why: owner security-first; each fix is small.

MC2 [3, 11, 14] Carries from MC1, binding on those tasks: every lane git call passes the git dir pap stored (`isLaneGitDir` checks the shape only); the guarded-status path list fed to the stager leaves out gitlinks (nested repositories and submodules), so no nested filter runs; Task 3's dirty test uses the guarded status. Tasks 11 and 14 drop mode-160000 entries and test a gitlink whose nested repository has a clean filter.

MC3 [3, 2a runner, 6b, 11, 14] Task 3 review fixes.
  - The dirty check pins `--untracked-files=normal`, because the owner's `status.showUntrackedFiles=no` made a lane with new files look clean.
  - The runner pins `--work-tree` whenever `gitDir` is given, for every call, not only for the writers, because a `core.worktree` in the lane's `config.worktree` must not redirect anything.
  - The lane's git dir is read from git after `worktree add`, under the lock, checked (its `gitdir` file points at the lane path), and stored with the lane. `gitDirOf(lane)` on the port is the only source. Git appends a counter when the name is taken (reproduced), so no path is derived from the folder name.
  - Carry to Task 6b: `shutdown()` joins the daemon's closers, since a 120 s `worktree add` can outlive a stop.

MC4 [2b, 9, 14, 18a] Task 2b review fixes and a carry.
  - `push.pushOption=` (empty) joins the remote-only config, so a repository's own push options never reach the forge. An int test sees none on a real push.
  - `issueAllowed` accepts any repository on github.com only; every other host must match the project's origin host.
  - One kernel helper runs the whole push sequence (scan, both `get-url` reads, push) from the lane root with the stored git dir; it refuses on a non-empty scan before asking for the target and takes `allowFile` from `Config.testGitProtocols`. Why: a `pushurl` in the lane's `config.worktree` hides a redirect when `get-url` runs from the main root.

MC5 [4] Task 4 fix round 1. Copy and link sources go through M8's boundary judge and deny set on their real path (a copy of a home-level `.ssh`, or a hard link laundered into `$PAP_HOME/worktrees`, was possible); a link is judged including above-denied folders. After the copies, one batched `check-ignore` checks every copied entry; a copy that is not ignored is removed and skipped (it would be committed, pushed and put in checkpoints). Carry to 6b: a deadline and a file cap on the copy step.

MC6 [4] Task 4 fix round 2. The link ancestor check covers every denied folder of the deny set (a prefix check, no walk). If removing a not-ignored copy fails, lane preparation fails; it never leaves the file silently. A 10 000-entry probe minor stays parked.

MC7 [9] Owner security-first. The forge adapter also strips invisible format characters (bidi controls, zero-width characters, Unicode tag characters U+E0000-E007F) and C0/C1 control characters (tab and newline kept) from issue text. It stays local to the adapter; moving the shared fence is a final-review item for both milestones.

MC8 [9] Task 9 review fixes. `GIT_CEILING_DIRECTORIES` is the parent of the forge folder (the folder itself does not stop discovery from itself, git 2.53). A deadline ends the call after a pipe grace even if a stray process holds the pipe. `findPr` ignores pull requests from forks (`isCrossRepository`).

MC9 [10] Task 10 minor. The install environment sets `PI_CODING_AGENT_DIR` to the agent folder: it restores a variable the old whole-environment pass carried (not a secret), and skills would otherwise land in `~/.pi/agent` for an owner with a custom agent folder.

MC10 [6a] Task 6a fix round. `beforePrompt` answers `undefined` synchronously when there is nothing to do (the M2R88 busy rule). The closed check is repeated after any wait. A "waiting" set lets the lane port see a prompt held in the hooks (busy for run state, activity and release; no parallel capture). Compact, navigate, set-model and trust-restart during a capture go to Task 15 with named tests. `releaseIdle` adds no dialog, panel or queue, and answers `released`, `busy` or `cold`. `daemon.ts` keeps its budget (M9 adds at most 10 lines, the file at most 355) by exporting `LANE_MIGRATIONS` from `compose-lanes.ts`, one `lanes.bind` line after `composePi`, and `lanes.shutdown()` in the existing parallel stop group. `service.ts` at 334 lines is accepted; the merge notes tell M10.

MC11 [11] Task 11 review, data loss beats the plan's sequence. A restore never deletes a file the undo capture did not hold. `clean -f -d` is replaced by a targeted removal: only untracked paths present in the undo tree and absent from the target are removed (NUL lists, raw bytes); everything undo skipped stays and is reported as left in place. A capture never fails as a whole on one file: it skips the entry with a reason and goes on (raw-byte paths, tracked paths under a link staged as removals, unreadable files skipped); the size check applies to every untracked entry, including those under a folder that replaced a tracked file.

MC12 [11] Task 11 re-review 1. A restore leaves in place, and reports as left, any path whose current content undo did not hold: a folder that contains left-in-place entries (the target's file at that path is not written) and an unreadable modified tracked file.

MC13 [11] Task 11 re-review 2. Before a target file replaces a lane folder, the folder is walked (bounded; over the bound is a conflict). The folder is kept and reported `conflict` if it holds any entry the undo capture did not hold: ignored, large, unreadable or undecodable.

MC14 [7] Task 7 review. Recovery resumes start from `bind()` (after sessions exist), with a test composing in the daemon's order. Any session that is not quiet (`releaseIdle` answers `busy`) makes archive refuse `busy` and revert under the lock. The taint check includes the lane's archived sessions.

MC15 [14] Task 14 review. One kernel helper, called after every add (commit and checkpoint capture), lists index entries of mode 160000 absent from the base tree and force-removes them from the index; they are reported as "nested repository left out". The int test bed allows the file protocol only. `prRefresh` writes nothing on a read-only daemon.

MC16 [15] Task 15 review. Hooks gate on the session being idle, not on the presence of a field (a streaming behavior only matters while streaming). Undo is a swap: before applying, the fresh capture is written to the `undo` ref, so Undo of Undo returns exactly and nothing is lost. This overrides the plan's "no new undo captured": data loss beats the plan text.

MC17 [15] Task 15 round 2. A restore or undo never removes a path the target tree's ignore rules ignore: it was outside that checkpoint's scope. It stays and is reported `ignored` (the reviewer's `.env` probe: after Undo the file is still there).

MC18 [18a] Task 18a review (ask instead of block). The first prompt is exactly `issuePrompt(issue)`; the description stays on the row. No trust inheritance when the base is a remote-tracking ref of another branch. A token-created lane inherits only when its base commit equals the main checkout's HEAD; otherwise the trust banner asks when the owner opens the lane. A browser-created issue lane inherits under the same conditions. The inheritance audit row names the token for a token lane. Residual documented: extension event hooks see issue text and taint does not gate them.

MC19 [18a] Task 18a round 2. Lineage, not ref names: a lane inherits only when its base equals the main checkout's HEAD or is an ancestor of it (`merge-base --is-ancestor <base> HEAD`, one guarded call before `trust.status`). Tokens keep the stricter equality with HEAD. Cost: the owner's own unmerged branches get the banner (one click, nothing blocked).

MC20 [18b] Task 18b review. One synchronous guard right before the launch of the auto-run re-reads the lane row and requires state `active`, `created_by = 'session'`, a non-issue source and no tainted session (archived sessions count). `closeLosers` is serialised per fan-out group; another owner's group answers `not_found`. A shared helper with review is left to JOIN 2.

MC21 [12, 19-22] Parallelism. Track 1 was idle while track 2 still had the end of Task 17 and Tasks 19-22. Task 21 (new lane dialog) and Task 22 (compare tab) moved to track 1; shared web files were unioned at JOIN 2.

MC22 [17] Task 17 review. The paid suggest call is coalesced per lane (concurrent calls share one in-flight promise) and capped at 2 concurrent calls per owner; a third answers `capacity`.

MC23 [20] Parallelism. Task 20 (commit bar and PR panel) moved to track 1 (new files, one slot line in the lane screen, the lanes catalog), in parallel with track 2's Task 19.

MC24 [20] Task 20 review. The "unknown/found" PR state is lifted into a store keyed by lane id (it survives close and reopen). `lanes.prCreate` uses the lane's stored description when the body is empty, server-side; the UI field says "empty: the lane's description is used". One shared pending guard covers all push paths.

MC25 [24] Task 24 review. The lanes smoke subscribes after the first prompt starts, so a dialog opened earlier is only in the snapshot and the wait timed out; fixed by accepting a dialog already in the snapshot. Step 2 stops on a terminal setup or lane state (60 s bed timeout); the forge call sequence and the stdin body are pinned; stale "Removed from PENDING" comments were removed. Minors m2, m4, m6, m7, m8 stay parked.

MC26 [25] Parallelism. Task 25 (docs only) starts on track 2 at `2da9608` while Task 23's fix round runs on track 1; no shared files. Its Step 2 final gates are replaced by JOIN 3's single full gate.

# Where the merged code differs from the plan

The code wins. Each line names the plan text and what the code does.

1. **Git allowlist table (plan "The git allowlist at a glance").** `add` takes only the stdin pair; `-A` and `-u` are not allowed (MC1). `rm --cached -f --quiet` plus the stdin pair exists (the nested-repository clean-up, MC15). `diff` also allows `--cached`; `merge-base` allows `--is-ancestor <oid> HEAD` (trust lineage, MC19); `for-each-ref` allows `--merged=HEAD`; `update-ref` requires `--no-deref`; `restore` has two exact forms (index with `--staged -- .`, or the stdin list). `worktree remove` requires `--force`.
2. **`releaseIdle` (M9R113).** The plan said `boolean`; the code answers `released`, `busy` or `cold` (MC10).
3. **Trust inheritance (M9R83, M9R105, and the plan's tree-equality wording).** The code needs the base to be the main checkout's HEAD or an ancestor of it, a trusted project, and equal `.pi` and `.agents/skills` trees; a token's lane needs the base to equal HEAD (MC18, MC19). The first-round text ("the base commit must equal HEAD") was relaxed to lineage for the owner's own lanes.
4. **Restore and Undo (M9R55, M9R75).** The plan removed untracked files with `clean` and captured no new undo. The code removes only what the undo capture held, leaves and lists everything else (`left` with a reason, at most 50 plus `leftTotal`), and Undo is a swap (MC11-MC13, MC16, MC17).
5. **Staging (M9R9, M9R54).** Plan: `add -A`/`-u` forms. Code: explicit paths on stdin (MC1), gitlinks left out (MC2), nested repositories removed from the index after every add (MC15).
6. **The git dir (M9R17, M9R18).** Plan: derived from the folder. Code: read from git after `worktree add`, checked, stored in `worktrees.git_dir`, passed as `--git-dir` with `--work-tree` on every lane call (MC3).
7. **`push.pushOption=` (M9R10).** Added to the remote profile (MC4). The push is run through one helper from the lane root.
8. **Contracts.** `truncated` is a required boolean in the stream snapshot, `lanes.review`'s `ReviewList` and `lanes.turns` (JOIN 2). `ReviewList` has no conflict ordering and no "not captured (left)" files, so the review pane cannot show conflicts first (follow-up; no contract field in M9). The `forge` key of `project.yaml` and `ForgeKind` still accept `gitlab` and `gitea` so a file and a pasted link can be named; only `github` has an adapter (M9R107).
9. **Sizes.** The plan's table gave setup 30 / archive 5 / test 15 minutes, 2 scripts per owner, 5 MiB logs: the code matches. The disk floor is `localDiskFloor` (1 GiB, `capacity`) until M10 replaces it; it is checked synchronously before `lanes.create` answers.
10. **Daemon wiring.** `compose-lanes.ts` exports `LANE_MIGRATIONS`, `bind`, `recover` and `shutdown`; `daemon.ts` is 339 lines (M9 added 10 lines against `main`, the limit being 10 and 355). `PENDING` is empty at JOIN 2; Task 24 deletes `pending.ts`.
11. **Task order.** Tasks 20, 21 and 22 ran on track 1, not track 2 (MC21, MC23).
12. **Umask on checked-out files.** The plan named it for the ADR only. The code does not wrap git in the starting umask: files git checks out follow the daemon's 077; scripts and terminals use the starting umask (ADR 0033).
13. **Bundle.** Initial bundle 213.8 KB gzip at JOIN 2 (budget 300; the brief stops at 250). Task 25 adds no code.
