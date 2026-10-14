# M7 SDD ledger, part 1 (archived 2026-10-14)

Controller ledger of the M7 subagent-driven run, copied verbatim from the git-ignored SDD workspace, agent ids removed. Part 1: the set-up and Tasks 1a–7. Part 2: [m7-sdd-ledger-2.md](m7-sdd-ledger-2.md). Rulings: [m7-rulings.md](m7-rulings.md) and [m7-rulings-after-join.md](m7-rulings-after-join.md); final review: [m7-final-review.md](m7-final-review.md).

# SDD ledger — plan: docs/plans/2026-10-13-m7-models-tools.md

Started 2026-10-13. Plan at 0ac40f0 (planner e61fef9 → Opus red-team 0 C / 2 I / 5 m → owner page, all recos plus 2 notes → Opus plan fix). Spec: C + A + DESIGN.md (binding). Cross-plan: .superpowers/m7-m8-cross-plan-agreements.md (24 items + owner amendments). M8 merges first (c1); M7 rebases.
Model table (owner Q9, decision 75): 35 Sonnet implementers; Opus reviewers on 1a 1b 1c 2a 2b 3 4 5 6a 6b 11 12a 12b 15 17 18 19 22 24 25; Sonnet on the rest; Opus final review. Opus escalation at fix rounds 4–5 is PRE-APPROVED for wave 1.
Workflow (decision 73): the controller re-verifies small test- or comment-only fixes; test:int only for runtime tasks; no Haiku.

## Pre-flight conflict scan (the plan's own table, checked by the red-team and planfix; adopted)
## Pre-execution conflict scan

Tasks run one at a time, in order: 1a, 1b, 1c, 2a, 2b, 3, 4, 5, 6a, 6b, 7 … 11, 12a, 12b, 13 … 30. The files shared with M8 are listed in "Merge order and conflict notes".

| Tasks | Shared file or interface | Rule |
|---|---|---|
| 1a → 1b | `policy/git-config-guard.ts` `repoConfigRefusal(start, guard)`, `gitGuard(home)`, the `GIT_*` reasons | 1a ships the check standalone. 1b calls it from `judgeGit` for each folder git may run in, with one `GitGuard` per command line. 1b never changes 1a's reading. |
| 1b → 1c → 2a | `policy/command-cover.ts` `coverCommand(command, CoverContext)`, `ShellFacts` (with `gitEnv`) | 1b ships the engine with `prefixes` support unused. 1c wires read-only commands in stage 03 and adds `UNKNOWN_SHELL`. 2a passes prefixes from the grant check. Neither later task changes 1b's matching. |
| 1c → 2a, 15 | `PolicyRules` (`readOnlyCommands`, then `alwaysPrefixes` and `alwaysTools`, then `readOnlyPreset`) | Each adds its own keys with defaults; the strict schema stays strict. |
| 2a → 2b | `ApprovalRequestRecord.alwaysScopes`, `approval_response.scope`, `Dialog.alwaysScopes`, `DialogResponse.scope` | 2a defines them on the worker side and in contracts; 2b stores and shows them. |
| 3 | `search/{extract,scanner-file}.ts`, `sessions/scan-port.ts` | 3 only. It calls `markTainted` through the policy port the sessions module already holds, so `daemon.ts` gets no line. |
| 4 → 5, 15, 19 | `packages/pi-host/src/builtins.ts` `piBuiltins(options)` | 4 creates it. 15 leaves it out for `chat`. 19's Test session builds its own MCP extension with the same factory. |
| 6a → 6b, 8, 10, 11, 12a, 12b, 17, 18, 19, 22, 24, 25 | `kernel/helper/pool.ts` `HelperPool.run`, `contracts/pi-helper.ts` `HelperRun`, the helper `ops/index.ts` op table, `apps/daemon/src/compose-pi.ts` | 6a ships the pool, the protocol, one `ping` op and `compose-pi.ts`. Each later task adds its op to the table, its schemas to `pi-helper.ts` (one entry each) and its module to `compose-pi.ts`. None changes the protocol or `daemon.ts`. |
| 6b → 8, 10, 12a, 17, 18, 22, 24, 25 | `helper/pi-file.ts` `readPiFile`, `writePiFile` | 6b creates the bounded reader and the atomic writer, right after 6a. Later ops reuse them unchanged. |
| 7 → 9, 15, 16, 22 | `session-loadout.ts` `SessionLoadout`, the worker `loadout` record, snapshot `loadout`, event `loadout`, `stores/session-reducer.ts` `SessionView.loadout` | 7 defines the record with `preset: "configured"`; 15 fills `preset` and `tools`. Task 7's ≤ 6 lines are M7's whole budget in `live-session.ts` (agreement 13). |
| 8 → 9, 10, 11, 12a, 12b, 13, 14, 29 | `modules/models/index.ts` `ModelsModule`, the `models.overview` result | 8 creates the module; later tasks add methods and service functions in their own files. |
| 12a → 12b | `modules/models/{service,rpc}.ts`, `helper/jsonc.ts` | 12a adds the editor methods; 12b adds discover, test and pricing, and reads the `models` setting through the settings port. |
| 12b → 14 | `ModelsSettings` (`contracts/settings.ts`, key `models`), `settings.get` / `settings.set` | 12b defines the key and the daemon refusal; 14 renders the switch. |
| 17 → 18, 19, 22 | `helper/mask.ts` `maskMcpEntry`, `helper/ops/mcp-read.ts` `readMcpFiles` | 17 creates them; 18 writes through the same reader; 22 lists project servers with it. |
| 13 → 14, 29 | `features/models/` components (`ProviderList`, `SignInFlow`) | 29 reuses them inside the stepper (lazy). |
| 13 | `apps/web/src/runtime/subscriptions.ts` `OPENERS.login` | 13 adds the opener; its tests go in `subscriptions.m7.test.ts` (agreement 11). |
| 2b, 28 | `features/policy/ApprovalsPanel.tsx`, `RulesByProject.tsx`, `i18n/catalog/settings-approvals.ts` | 2b adds rule kinds; 28 adds the mode list and the read-only switch. |
| 9, 27 | `features/sessions/Composer.tsx` | 9 adds `<ModelBar …/>`. 27 adds the `useComposerCommands` call and `{commands.menu}`, and gives the field `inputRef`, `onKeyDown` and `combobox` (M7R122). M7's whole budget is 3 added lines (agreements 7, 22), and nothing in `use-composer.ts`. |
| 27 | `packages/ui/src/primitives/TextField.tsx` | 27 lands M8R83's six props on this branch, with M8R83's names and semantics. The rebase onto an M8-first `main` keeps `main`'s copy (merge notes). |
| 16, 23 | `features/sessions/SessionScreen.tsx` | One mounted line each (`<SessionTools …/>`, `<TrustBanner …/>`). |
| 13, 20, 26 | `routes/settings/sections.tsx`, `features/workspace/model.ts` `SETTINGS_SECTIONS` | 13 adds `models`, 20 `mcp`, 26 `skills`: one renderer line and one list entry each, each section its own lazy chunk. |
| 7, 15, 2b | `apps/daemon/src/modules/sessions/{snapshot,service-launch,grants}.ts` | Each adds its own lines; `snapshot.ts` stays ≤ 360. |
| 18, 20, 21, 24, 25, 26 | `confirmProtected` on every project-scope Pi method (M7R133) | One rule: a project target requires `confirmProtected: true`. Each task adds it to its own methods' params and its own UI ask. |


## Controller rulings (pre-dispatch)
- MC1 [27, merge] The composer mount budget counts `<ModelBar/>`, the `useComposerCommands` call and the menu. The textarea ref and the three `TextField` field props are the shared plumbing of agreement 7: whichever branch merges first lands them, and at M7's rebase on M8 M7 drops its copy and uses M8's. — why: agreement 7 already allocates the primitive change — cost if wrong: one rebase hunk.
- MC2 [project-scope saves, rebase] A project-scope Pi save without the confirmation flag answers `bad_request` during M7's execution, so M7 does not depend on M8's codes. At the rebase on M8, switch to M8's `protected_path`; this is a rebase-brief item. The web always confirms before sending, so only API misuse ever sees the code. — cost if wrong: one error-code change at the rebase.
- MC3 [12b] A token with `settings:operate` may flip the models.dev switch. It only shows a lookup control in the browser, and no code or request runs from the switch itself. — cost if wrong: a token can enable a UI button.
- MC4 [1a] Usability relaxations of the owner's git rule:
  - (a) `core.fsmonitor` set to a boolean (`true`/`false`/`yes`/`no`/`on`/`off`/`1`/`0`) is allowed, because it uses git's own daemon; any other value asks.
  - (b) The exact standard git-lfs entries are allowed: `filter.lfs.clean = git-lfs clean -- %f`, `filter.lfs.smudge = git-lfs smudge -- %f`, `filter.lfs.process = git-lfs filter-process`, `filter.lfs.required = true`. Any other filter value asks. PATH entries inside the session folder are already refused by 1b.
  - (c) Read only the configs of the repository git would discover: the nearest `.git` dir or gitfile, then its `gitdir:` / `commondir`, `config` and `config.worktree`, and their includes. Never read every ancestor: an outer repository does not make inner ones ask. Unresolvable discovery asks.
  - (d) Submodules may keep asking (a residual, written in `policy.md`).
  - Why: the owner weighs usability as much as security (decision 71, memory), and these values run nothing planted. Cost if wrong: one more prompt class, which fails safe.
- MC5 [25] Plugins follow the same project / global scope rule as skills. — why: same Pi packages mechanism — cost if wrong: none.
- MC6 [12a] The `scanJsonc` masking is not spelled out in the plan: the Task 12a implementer writes it test-first against the plan's masking table, with real mutation checks, and an Opus reviewer. — why: the planfix could not run it — cost if wrong: a fix round.

## Progress
Task 1a: dispatched implementer (Sonnet), BASE 0ac40f0, brief task-1a-brief.md; carries MC4 (git rule relaxations)
Task 1a: implementer
Carry (from M8 planfix, MC1 of M8 ledger) [27, rebase]: useComposerCommands returns M8's ComposerMenu shape (open, close, onKeyDown, combobox) + menu, and joins composerFieldProps([mentions, …]) at the rebase on M8.
Task 1a: implementer DONE_WITH_CONCERNS (f764f90) — 137 tests; concern: unrecognised .git skipped → ancestor read (violates MC4c fail-closed?)
Task 1a: review dispatched (Opus), package review-0ac40f0..f764f90.diff → task-1a-review.md
Task 1a: review (Opus) Needs fixes — 1 C / 2 I (plan-mandated) / 6 m. C1: the guard's git-dir check differs from git's both ways; 9 probes with real git 2.53 ran a planted hook while the guard returned null. I1: `git status` runs `.git/hooks/post-index-change` with a clean config. I2: `git status` runs the config of an embedded repo recorded only as an index gitlink (160000).
- Ruling MC7 [1a] (C1): the guard accepts only a strict SUBSET of what git accepts, so that any doubt asks.
  - Per level, git's order applies: `dir/.git`, then `dir` itself as a bare repo.
  - A `.git` (dir or gitfile → gitdir) is accepted only when all of these hold:
    - HEAD is a regular file (lstat) of at most 255 bytes, matching exactly `^ref: refs/[^\0\s]+\n?$` or `^[0-9a-f]{40}\n?$`; a symlink HEAD whose target starts with `refs/` and exists is also accepted;
    - `objects/` and `refs/` are directories passing access(X_OK);
    - a gitfile holds exactly `gitdir: <path>\n?`, and its target and its `commondir` pass the same check.
  - A `.git` entry, or a bare-looking folder (any of HEAD, objects, refs present), that is not fully accepted gives `GIT_UNREADABLE` and the command asks. The walk continues upward only when no `.git` entry and none of HEAD/objects/refs exist at that level.
  - Tests: one per reviewer probe, in both directions, plus the reviewer's 9 cases.
  - Why: a stricter-than-git acceptance can only add questions, never skip a repository git uses. Cost if wrong: extra asks on unusual repos.
- Ruling MC8 [1a] (I1): ask when the repository-local config sets `core.hooksPath`, or when a `post-index-change` file exists in `<gitdir>/hooks/` or `<commondir>/hooks/`. Other hooks, like `pre-commit`, do not run on status/diff/log and do not make it ask. A global `core.hooksPath` is the owner's own config and stays trusted. Why: a precise list avoids asking in every repo using pre-commit. Cost if wrong: one hook class missed, needing a new probe.
- Ruling MC9 [1a] (I2): parse the index read-only and ask on any 160000 gitlink entry, which is consistent with MC4(d) "submodules ask".
  - Supported index versions are 2, 3 and 4, including v4 prefix compression.
  - Cap 64 MiB or 1 000 000 entries, otherwise ask. A split index (`link` extension, `sharedindex.*`), an unknown version, a bad signature or a truncation asks. A missing index is fine.
  - Full code, with tests built from real `git update-index --cacheinfo 160000,…` fixtures for v2, v3 and v4.
  - Why: same threat model as a planted config. Cost if wrong: a parser bug, which fails closed.
- Minors: apply the 6 from task-1a-review.md (the `seen` cache key, the GIT_OBJECT_DIRECTORY handoff note for 1b, …).
Task 1a: fix round 1/5 → resume implementer with C1/I1/I2 + MC7–MC9 + minors
Task 1a: fix round 1 DONE (5f003cb) — 204 guard tests, 15 mutations; split into git-fs/git-discovery/git-index/fixtures; handoff to 1b: GIT_OBJECT_DIRECTORY joins ShellFacts.gitEnv. Scoped re-review dispatched (Opus).
Task 1a: re-review 1 (Opus): C1, I1, I2 and M1–M6 addressed; all 11 real-git probes pass in both directions. New issues: N1 (index entry boundaries differ from git: v2/v3 use NUL instead of the name-length field, v4 skips the strip-length and name-length checks, an over-long varint is accepted), N2 (git does not verify the index checksum on status; a sha256 repository has a different entry layout), N3 (gitdir/commondir/include paths decoded as lossy UTF-8 while git uses raw bytes). Minors N4–N7, among them a skipHash / manyFiles index rejected, so every git read asks there.
- Ruling MC10 [1a]:
  - N1: walk entries exactly as git does.
    - v2/v3: the name length comes from flags & 0x0FFF; when it is 0x0FFF, scan to the NUL. The entry ends padded to 8 bytes from its start, with the extended-flags word when flag 0x4000 is set (v3+). Ask when the NUL is not where the length says.
    - v4: strip length varint, then a NUL-terminated suffix. Ask when strip > previous name length, or when the varint is over-long or overflows.
  - N2: ask when any read config sets `extensions.objectFormat` to anything but `sha1`, or a `.git/objects` layout says sha256. Never rely on the index checksum: accept an all-zero trailer (skipHash, N4), and ask only on structural errors.
  - N3: decode every path read from gitdir, commondir, include.path and the index with a fatal UTF-8 decoder. Invalid bytes ask.
  - Apply N5–N7.
  - Why: MC7 means stricter-than-git, never different-from-git. Cost if wrong: more asks in exotic repositories.
Task 1a: fix round 2/5 → resume implementer
Task 1a: fix round 2 DONE (300cc2a) — 229 guard tests; N1–N7 per MC10. Scoped re-review 2 dispatched (Opus).
Task 1a: re-review 2 (Opus) Open — CRITICAL NEW-1: crafted v4 index hides a 160000 gitlink (guard null, git ls-files lists it); v4 suffix sized by scanning to NUL instead of git's name-length field (read-cache.c:1871). N1 v2/v3 + N2–N7 addressed; minor NEW-2 (whole-config fatal UTF-8 broader than git, fail-safe, accepted). Fix round 3/5 → resume implementer: v4 suffix length = (field==0xFFF ? strlen : field - copy_len), NUL required exactly there, else ask.
Task 1a: fix round 3 DONE (67b3a0b) — v4 sized by name-length field, NUL exact; 235 guard tests; mutations fail. Scoped re-review 3 dispatched (Opus).
Task 1a: re-review 3 (Opus) Open. NEW-1 is addressed. NEW-3 (Critical, from git's source: read-cache.c:2253-2293): with `index.threads` > 2 and an EOIE extension, git loads entries through the IEOT offset table, not in order. The guard walks in order, so git can load gitlinks the guard never sees. A crafted probe could not be built: a safety filter blocked the reviewer.
- Ruling MC11 [1a]: stop chasing divergences one at a time.
  - (a) Index extensions are an allowlist of the ones that never change which entries git loads: `TREE`, `REUC`, `UNTR`, `FSMN`. Any other signature asks: `EOIE`, `IEOT`, `link`, `sdir`, unknown ones. The extension headers are walked exactly as git does (4-byte signature, 4-byte big-endian size, bounds-checked, ending exactly at the trailer).
  - (b) A deterministic differential test against real git. A seeded PRNG builds and mutates at least 300 v2, v3 and v4 indexes, from valid fixtures plus byte and field mutations, with and without gitlinks. For each, when the guard answers "clean", `git ls-files -s` on the same `.git` must succeed and list no 160000 entry. Bounded runtime, fixed seed, temp dirs.
  - (c) The Opus implementer audits git's read-cache.c paths (do_read_index, the EOIE/IEOT loaders, create_from_disk) once more and lists every remaining divergence in the report, each either closed or proven unable to hide an entry.
  - Why: three rounds each found a new parser divergence. An allowlist plus a differential oracle bound the problem. Cost if wrong: asks in repos with index.threads set, which is rare.
- Fix round 4/5 → FRESH Opus implementer (escalation pre-approved, decision 75 Q9).
Task 1a: round 4 Opus implementer
Task 1a: fix round 4 (Opus implementer) DONE_WITH_CONCERNS (2871352) — NEW-3 reproduced end-to-end (index.threads=4 ran a hidden embedded repo's hook) and closed; extension allowlist; differential test 1500 seeds vs real git (~6 s; round-3 reader failed 127); 17-item read-cache audit; unit 6728.
- Ruling MC12 [1a]: accept UNTR → asks (deviation from MC11(a)): a crafted untracked-cache extension corrupts git 2.53's heap; stricter is allowed by MC7 — cost: asks in repos with core.untrackedCache / feature.manyFiles. Cache-tree contents not read: accepted residual (git dies, loads nothing). CARRY to 1b: GIT_INDEX_FILE joins ShellFacts.gitEnv (with GIT_OBJECT_DIRECTORY).
- Controller cleanup: removed stray ignored packages/pi-host/.vitest/ report (made format:check fail) and /var/crash/_usr_bin_git.1000.crash (probe artefact).
Scoped re-review 4 dispatched (Opus).
Task 1a: re-review 4 (Opus) All addressed — NEW-3 addressed; 1 minor M-R4-1 parked (see task-1a-rereview-4.md).
Task 1a: complete (f764f90, 5f003cb, 300cc2a, 67b3a0b, 2871352) — 4 fix rounds (round 4 Opus)
Task 1b: dispatched implementer (Sonnet), BASE 2871352; carries: GIT_OBJECT_DIRECTORY + GIT_INDEX_FILE join ShellFacts.gitEnv; guard API after 1a rounds
Task 1b: implementer
Task 1b: implementer DONE (e559af3) — 196 new tests, unit 6924; 26 mutations (3 gaps closed with rows). Review dispatched (Opus).
- Ruling MC13 [1a guard, applied in Task 1b's fix round] (from M8 Task 4's real-git probes): the guard's command keys also ask on:
  - `extensions.partialClone`, any `remote.*.promisor`, `remote.*.uploadpack`, `remote.*.receivepack`: a partial clone's lazy fetch runs a transport program on diff/cat-file;
  - `protocol.*.allow`, `core.gitProxy`, `core.alternateRefsCommand`, `uploadpack.packObjectsHook`;
  - `log.showSignature` (gpg.program already asks).
  - A bare-repository layout of ordinary files in a no-.git folder is already covered: MC7 asks unless it is a valid repo, and a valid one has its config read.
  - Why: the agent-run git has none of the daemon runner's -c flags or env pins. Cost if wrong: asks in partial clones, which are rare.
Task 1b: review (Opus) Needs fixes. 1 I (plan-mandated, verified): `date -f <file>` / `--file <file>` in separate-word form is covered, because the rule has operands null and only attached option values are judged; date echoes the protected file's lines on stderr. 2 minors: the refused() substring scan over-asks on glued clusters (`date -Iseconds`, `sort -T/opt/tmp`); no crossing test for the PATH cap.
- Ruling MC14 [1b]:
  - date's `-f` / `--file` ask, whether glued or separate.
  - Add an invariant test: every rule whose operands are null declares no option that reads a file, or the engine judges its separate-word value.
  - Fix the cluster parse so that a value-taking letter ends the cluster. `date -Iseconds` and `sort -T/opt/tmp` stay covered, with tests.
  - Add the PATH-cap crossing test.
  - Apply MC13's guard keys.
  - Each change gets a real mutation check.
  - Why: a separate-word option value read nowhere is a leak class, not a one-off. Cost if wrong: n/a.
Task 1b: fix round 1/5 → resume implementer (incl. MC13)
Task 1b: fix round 1 DONE (4d29e54) — date -f all forms, invariant test, cluster parse (valued), PATH crossing, MC13 guard keys; unit 6983; mutations fail. Scoped re-review dispatched (Opus).
Task 1b: re-review 1 (Opus) Open:
- N1 (Critical, a regression from MC14's cluster rule): tree is not getopt. A value letter takes the NEXT word and the rest of the cluster is still flags, so `tree -Lo 1 ~/.bashrc .`, `-fLo`, `-LR`, `-Ho` were covered and tree 2.3.1 overwrote README.md in scratch.
- P1 (Important, pre-existing): `file -f` / `--files-from LIST` is covered while the names in the list are never judged; with an agent-written magic file (`-m`), `file` printed a secret's content.
- Ruling MC15 [1b]:
  - (a) `valued` only for tools verified to parse options with getopt (GNU date, sort, file). tree is removed, so a tree cluster containing any refused letter asks again.
  - (b) An invariant test lists the allowed getopt tools explicitly.
  - (c) file's `-f` / `--files-from` and `-m` / `--magic-file` ask in every form.
  - (d) The table header rule "options that read a list of files are refused" gets an invariant test over all rules: every option known to take a file list or a program/magic file must be listed refused.
  - Hostile rows for all four tree forms and both file forms, with real mutation checks.
  - Why: the cluster grammar is per tool, not global. Cost if wrong: n/a.
Task 1b: fix round 2/5 → resume implementer
Task 1b: fix round 2 DONE (2ae16d4) — tree out of valued, file -f/-m ask, date -r asks, two invariants (getopt set, dangerous options; hand lists); 238 cover tests, unit 7007. Scoped re-review 2 dispatched (Opus).
Task 1b: re-review 2 (Opus) All addressed — sweep found no leaking option; minors: df existence oracle (M1, accepted), RIPGREP_CONFIG_PATH not modeled (M2).
- Ruling MC16 [1c]: RIPGREP_CONFIG_PATH set in the command's assignments (already refused) or in the session env facts makes rg uncovered, like ShellFacts.gitEnv — CARRY to Task 1c; df metadata oracle accepted (no content).
Task 1b: complete (e559af3, 4d29e54, 2ae16d4) — 2 fix rounds
Task 1c: dispatched implementer (Sonnet), BASE 2ae16d4; carry MC16
Task 1c: implementer
Task 1c: implementer DONE_WITH_CONCERNS (acd8a1d) — unit 7038, int 405+1 skip, smoke ok, bundle 195.3; tests switched echo → env echo / readOnlyCommands:false in beds; relative PATH entry → asks; shell-facts.ts extracted (rgConfig, gitEnv +2); run-guard asserts 5th call. Review dispatched (Opus).
Task 1c: review (Opus) Needs fixes — spec ✅ (run-guard 5th call is right; the brief was wrong). 1 Important (reproduced on the real worker): Pi runs same-message tool calls in parallel, and a write to a hand-made non-.git repo dir is auto-allowed. An injected agent plants `fsmonitor` and runs `git -C dir status` in one message; the guard read the config before the write, and the program ran unasked. Minors: the new int test was not seen RED; a stale `echo exfil` comment at taint.int.test.ts:20; no owner-facing reason when coverage fails.
- Ruling MC17 [1c] (STRICTER than owner m2; report it to the owner):
  - (1) In a TAINTED session, git segments are never covered and ask. Other covered commands keep m2.
  - (2) In any session, a git segment is covered only when the guard finds an EXISTING valid repository with a clean config at evaluation time. "No repository found" asks.
  - (3) The remaining untainted-session race (a concurrent plain-file write to an existing bare-layout repo's config) is documented in policy.md next to the parallel-execution note.
  - Why: a reproduced unasked program run through a check-then-use race; taint is M5's marker for injected content. Cost: `git status` asks after the session read external content, until Clear.
Task 1c: fix round 1/5 → resume implementer (MC17 + the minors, including an owner-facing reason when coverage fails if the card already has a reason slot)
Task 1c: fix round 1 DONE (9f84644) — MC17 (tainted → git asks; no repo → asks; policy.md residual); real-worker race int test asks; unit 7040, int 407+1. CARRY to Task 28: ApprovalAsk reason slot to show why coverage failed. Scoped re-review dispatched (Opus).
Task 1c: re-review 1 (Opus) Open. The race is only partly fixed: inside an enclosing repository (the usual case), an empty or missing `-C` / `cd` target is still covered by the parent repo's clean config, and same-message writes can turn the target into a bare repository that git then reads. The comments and policy.md overstate the fix.
- Ruling MC18 [1c]: pi-host pins `safe.bareRepository=explicit` for every git the agent runs. At worker boot, before any tool runs, it APPENDS it to the process env through `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`, keeping any existing entries and their count.
  - It is done in pi-host, not in the daemon's `supervisor/env.ts`, which M8 owns (agreement 14).
  - git 2.53 honours it from the environment (reviewer checked). A planted bare layout is then never discovered, and a real `.git/` write is protected and asks.
  - Fix the overstated comment (`command-cover-git.ts:70-71`), policy.md and the commit wording.
  - Tests: the reviewer's inside-a-repo variant at engine level, plus a real-worker int test with the bed inside a repository (writes plus `git -C empty status` in one message → the plant never runs), with a positive control. Real mutation check: drop the env pin and the int test fails.
  - Why: a general neutraliser beats chasing discovery races. Cost: the agent's git ignores bare repositories unless given `--git-dir`, which is rare.
Task 1c: fix round 2/5 → resume implementer
Task 1c: fix round 2 DONE (8f8e85a) — GIT_CONFIG_COUNT pin of safe.bareRepository=explicit in runHost (host.ts) before the session opens; invalid count → worker refuses to start (exit 70); docs/comment corrected; bare-repo int test inside a repo; unit 7055, int 410+1. Scoped re-review 2 dispatched (Opus).
Task 1c: re-review 2 (Opus) All addressed — race closed on real workers; 4 minors parked (task-1c-rereview-2.md).
Task 1c: complete (acd8a1d, 9f84644, 8f8e85a) — 2 fix rounds. MC17 is stricter than owner m2 → report to owner.
Task 2a: dispatched implementer (Sonnet), BASE 8f8e85a
Task 2a: implementer
Task 2a: implementer DONE_WITH_CONCERNS (f3de091) — unit 7159, int 410+1, smoke ok, bundle 195.4; fix to prescribed code: patternGrant null when tainted (MC17); proposePrefix shapes not pinned. Review dispatched (Opus).
Task 2a: review (Opus) Approved — 0 C / 0 I; taint guard in patternGrant judged necessary (bare prefix match skips judgeSegment's git-in-taint refusal); 2 minors parked.
Task 2a: complete (f3de091)
Task 2b: dispatched implementer (Sonnet), BASE f3de091
Task 2b: implementer
Task 2b: implementer DONE_WITH_CONCERNS (e1ca238) — unit 7218, int 411+1, smoke ok, bundle 195.5; AlwaysScopes.toolSource + Dialog.tool added (2a shapes); scope with non-always answer → bad_request; int-bed path option. (Controller checked: no .superpowers file committed.) Review dispatched (Opus).
Task 2b: review (Opus) Approved — 0 C / 0 I.
Task 2b: complete (e1ca238)
Task 3: dispatched implementer (Sonnet), BASE e1ca238
Task 3: implementer
Task 3: implementer DONE_WITH_CONCERNS (a2ca024) — unit 7240 (1 unidentified flaky failure, 2 reruns green), int 412+1; fail-open gaps: restart gap (CLI append while daemon down), markTainted throw loses taint (cursor advanced); audit kind policy reason tainted_outside. Review dispatched (Opus).
Owner (2026-10-13 ~13:40 UTC): keep option A — full rigor (Opus reviews and re-reviews on security tasks), no scope cut; revised ETA M8 ~02:00 UTC, M7 ~10:00 UTC 14 Oct.
Task 3: review (Opus) Needs fixes — spec ✅. 2 I:
- I1 (plan-mandated, ruling M7R27(c)): writes older than the daemon's start count as pap's own, so a CLI append while pap was down is never tainted.
- I2: a throwing markTainted loses the taint, because the scanner position is saved first.
- Minors include another fail-open case: an append not yet read when a pap worker starts is never tainted.
- Ruling MC19 [3] (amends M7R27(c) for the taint decision only; the Q13 notice is unchanged):
  - (a) a new migration adds `sessions.pap_wrote_at`, written at worker exit and on fork/clone. The test becomes `!isLive && at > max(workerEndedAt, papWroteAt)`, with no startedAt term. Agreement 2 is amended: M7 adds a third migration; M8 has none, so nothing is re-stamped.
  - (b) taint first in `touched`. When tool results were found, `touched` runs before the position is saved, and a throw keeps the position so the next pass retries within 60 s. A bounded set (cap, refuse-when-full means taint-now) remembers failed sessions. Replace the test pinning the fail-open behaviour.
  - (c) before starting a pap worker on a session, scan that session file's unread bytes first and taint as needed.
  - Tests RED first and real mutation checks for (a), (b) and (c).
  - Why: each case lets outside tool results reach the agent untainted. Cost if wrong: a migration and one scan per worker start.
Task 3: fix round 1/5 → resume implementer
Task 3: fix round 1 DONE_WITH_CONCERNS (b012fb2) — migration 202610131020_pap_wrote_at (pap_wrote_at + pap_wrote_size), taint-first + owed set (cap 1024), pre-spawn read since pap_wrote_size; unit 7263, int 412+1; 12 mutations. (c) reads from pap_wrote_size (not the scanner offset); unstamped rows not checked at launch.
- Ruling MC20 [15]: Task 15's planned migration `202610131010_tool_preset` is re-stamped `202610131030_tool_preset` (after 1020; the migrator refuses an older stamp after a newer one) — CARRY to Task 15's dispatch.
Scoped re-review dispatched (Opus).
Task 3: re-review 1 (Opus) Open. I1 and I2 are fixed.
- MC19(c) is only partly fixed: unstamped rows are never scanned before a worker starts.
- N1 (new): a Clear made while the session has no worker is undone at the next start, because the re-read from pap_wrote_size re-taints and writes a second audit row.
- Ruling MC21 [3]: the pre-start check uses the reviewer's mtime gate:
  - skip when the file mtime ≤ max(updated_at, pap_wrote_at);
  - else, when the row has no stamp, taint;
  - else read from pap_wrote_size as today.
  - Tests:
    - (1) an unstamped row with an outside append before start → tainted;
    - (2) an unstamped row unchanged since pap last saw it → NOT tainted (no friction for pre-M7 sessions);
    - (3) Clear while closed, then reopen with no new append → stays cleared, no second audit row;
    - (4) Clear, then an outside append, then reopen → tainted.
  - Real mutation checks. Update the test that pins "unstamped → skip".
  - Why: closes the gap without tainting every pre-M7 session. Cost if wrong: mtime granularity, so equal mtimes skip; say so in docs.
Task 3: fix round 2/5 → resume implementer
Task 3: fix round 2 DONE (b6046ab) — mtime gate (MC21), tests 1–4 + symlink; unit 7267, int 412+1; residuals in sessions.md (mtime granularity, text-only append after Clear). Scoped re-review 2 dispatched (Opus).
Task 3: re-review 2 (Opus) All addressed; minors N10–N12 parked. CARRY to Task 30 docs + backlog: N10 — a first scanner index bumps updated_at without judging; fix before any SEARCH_SCHEMA_VERSION bump (sessions.md note).
Task 3: complete (a2ca024, b012fb2, b6046ab) — 2 fix rounds; migration 202610131020_pap_wrote_at
Task 4: dispatched implementer (Sonnet), BASE b6046ab
Task 4: implementer
Task 4: implementer DONE_WITH_CONCERNS (b106583) — unit 7277, int 416+1, smoke ok; SDK probe: builtin:mcp / builtin:codemode / builtin:tool-search, models undefined in codemode, a trusted project extension replacing /mcp → its tools classify unknown. Review dispatched (Opus).
Task 4: review (Opus) Needs fixes — 3 I:
- I1: codemode store()/load() returns an MCP result unfenced; it persists in the session file across a Clear, while the taint holds.
- I2: Pi already shows the sign-in URL in rpc mode, so pap's notice duplicates it and the docs overclaim "withheld" (plan-mandated, M7R31).
- I3: no test that an untrusted project .pi/mcp.json never starts its server.
- Ruling MC22 [4]: apply the reviewer's fixes.
  - I1: every codemode result is treated as external (fenced) while the session is tainted. The leftover case is written in policy.md: a stored value outlives a Clear and returns unfenced after it. Int test and mutation check.
  - I2: pap's notice becomes the "paste the redirect" instruction, never repeating the URL. The mapping moves into builtins.ts with a unit test of both branches. Correct policy.md and amend M7R31.
  - I3: int test in both directions (untrusted → the server never starts; trusted → it starts), with the mutation check that `projectTrusted: true` in open-session.ts makes it fail.
  - Apply the minors local to Task 4.
Task 4: fix round 1/5 → resume implementer
Task 4: fix round 1 DONE_WITH_CONCERNS (5dcbe7d) — codemode results fenced when tainted (ToolKind.codemode by source), notifier without URL, project mcp.json trust both ways (real gate = projectTrustResolver); unit 7278, int 419+1, smoke ok. M7R31 amended. CARRY to Task 15: review minor M6 (a preset cannot restrict codemode / deferred MCP tools through the active set). Scoped re-review dispatched (Opus).
Task 4: re-review 1 (Opus) All addressed.
Task 4: complete (b106583, 5dcbe7d)
Task 5: dispatched implementer (Sonnet), BASE 5dcbe7d
Task 5: implementer
Task 5: implementer DONE (04a25bb) — 5 real-worker int tests (mcp-taint 4, codemode-nested 1), RED with built-ins off; unit 7278, int 424+1; exfil via env echo (echo is covered, M7R135); ADR 0020 stale sentence updated. Review dispatched (Opus).
Task 5: review (Opus) Needs fixes — 1 I (plan gap): no real-worker test that a nested codemode call asks/denies in a tainted session. Test-only fix round 1 (controller re-verifies per decision 73).
Task 5: test-only fix (004da8a) — controller re-verified: codemode-nested.int 2/2 green; mutation exposed=false → 'asks about a second nested MCP call…' FAILS ('run ended without a card'); restored + rebuilt.
Task 5: complete (04a25bb, 004da8a)
Task 6a: dispatched implementer (Sonnet), BASE 004da8a
Task 6a: implementer
Task 6a: implementer DONE_WITH_CONCERNS (814bb26) — unit 7345, int 439+1, smoke ok, bundle 195.5; 17 mutations; no orphans; codes project_scope/config_invalid/config_path_refused mapped to helper_failed until 8/12a; token grid pi row until Task 28; helper kills own group on IPC close; hang test deadline 800 ms. Review dispatched (Opus).
Task 6a: review (Opus) Approved — 0 C / 0 I; 10 minors parked; step-up for code-running/credential/redirect ops is checked in the RPC tasks (11, 12a/b, 17–19, 22, 24, 25) — reviewers of those tasks must verify it.
Task 6a: complete (814bb26)
Task 6b: dispatched implementer (Sonnet), BASE 814bb26
Task 6b: implementer
Task 6b: implementer DONE (0cf3edb) — 23 pi-file tests, unit 7368; extras: /proc/self/fd re-check, nlink>1 refused (also hard-linked dotfiles), O_NOCTTY, bounded read; prescribed-code temp leak fixed; residual: check→rename race, non-Linux. Review dispatched (Opus).
Task 6b: review (Opus) Needs fixes — 3 I:
- I1: the descriptor re-check re-resolves the roots, so swapping the agent folder (a root) for a link is accepted. Probe: the secret was written to /outside/auth.json.
- I2 (plan-mandated, M7R40b): a dangling link on a parent folder reads as "no file".
- I3: the nlink>1 refusal blocks reading hard-linked dotfiles, for near-zero security value.
- Ruling MC23 [6b]:
  - I1: resolve the roots once in `locate` and check against that list. Read and write tests with roots [agent, home] that swap `agent`.
  - I2: on ENOENT, lstat the missing folder; a symlink throws `PiFileRefused("link-dangling")`. One read test and one write test.
  - I3: a hard-linked file is READ normally. A WRITE to a file with nlink > 1 is refused with a distinct reason `hard-link`, because temp+rename would silently split the link and the other name would keep the old content. This adds a reason value to the interface; later tasks map it to a fixed message.
  - Apply the minors local to 6b.
Task 6b: fix round 1/5 → resume implementer
Task 6b: fix round 1 DONE (9f1960f) — roots resolved once, link-dangling on parents, hard-link write reason; 32 pi-file tests; unit 7377. CARRY to tasks using pi-file (12a, 17, 18, 22, 24, 25): map 'hard-link' to a fixed message (review minor M8 = caller recommendation). Scoped re-review dispatched (Opus).
Task 6b: re-review 1 (Opus) — I1–I3 addressed; open Minors only. CARRY to Task 12a (first pi-file caller): root check compares realpath(root) — '//', '/.', '/tmp/..' or a link to '/' must be refused (one line + test); document the check→rename hard-link residual; folder fsync failure after rename should not report the write as failed.
Task 6b: complete (0cf3edb, 9f1960f)
Task 7: dispatched implementer (Sonnet), BASE 9f1960f
Task 7: implementer
Task 7: implementer DONE (fa25683) — unit 7436, int 449+1 (run 1: one flaky failure in kernel/helper/pool.int.test.ts, untouched by this task → CARRY to Task 8: harden that test, likely its real 800 ms deadline), smoke ok, bundle 195.8; live-session.ts +6 (393); STREAMS 'login' not in 7's file list (left for its task); preset 'configured' until Task 15. Review dispatched (Sonnet).
Task 7: review (Sonnet) Needs fixes — 1 I: handleSetModel checks isIdle before awaiting listedModels → a prompt in the window makes the model switch mid-run (M7R43). Fix round 1: re-check isIdle right before setModel → WORKER_BUSY (unit test with getAvailable resolving after idle flips + mutation); minors: fit the model list by bytes, cold event clears SessionView.loadout.
Task 7: fix round 1 DONE (866cd5b) — isIdle re-check before setModel, list cut at 600 kB, cold clears loadout; unit 7439, int 449+1. Residual accepted (Pi SDK internal): setModel awaits checkAuth before switching → document in sessions.md (Task 30). Scoped re-review (Sonnet).
Task 7: re-review 1 (Sonnet) All addressed.
Task 7: complete (fa25683, 866cd5b)
