# M9 final whole-branch review (Opus): main 91bbe84..8bfe984

Reviewer: Opus, read-only. Scope: cross-task seams and what a per-task review could not see. Method: diff by area, plus direct reads of the daemon (kernel/git, kernel/forge, modules/worktrees, modules/lanes, the sessions seams, trust, policy), pi-host policy, contracts, the web lanes feature, docs (lanes.md, ADR 0033–0036, rulings) and the M10 worktree (seams only). I ran no test suite. The final gate was running in parallel. Parked items in `progress.md` and `sweep-candidates.md` are not re-raised, except T13-7, which I judge worse than parked (see I3).

## Strengths

- **Git runs no program the repository chose.** The allowlist has exact options and exact call shapes (`allowlist-lanes.ts`). Every lane call pins `--git-dir` from pap's stored record and pins `--work-tree`, so a rewritten `.git` file or a `core.worktree` cannot redirect a call. `SAFE_CONFIG` turns off hooks, fsmonitor, pagers, gpg programs and auto maintenance. `guardFilters` empties the repository's filter drivers on every subcommand that runs filters, and only `push` gets the remote profile. I found no path where pap's own git runs code a repository chose.
- **The push target is the one the owner sees.** The repository config is scanned with `--show-scope` (system and global scopes pass), exactly one origin URL and one push URL are required on the same host and repository, the refspec names the same branch on both sides with no `+`, `GIT_ALLOW_PROTOCOL=https:ssh` applies, and `push.pushOption=` is emptied. The SSH agent reaches only this one attended call.
- **Tokens cannot run, approve or send code.** One filter excludes `lanes:admin` from tokens. A token-created lane keeps its setup `pending`. Script approval needs a browser session and the password step-up, and it is bound to the sha256 of the text shown. The runner re-reads the file before each spawn and passes exactly the approved text to `bash -c`.
- **Destructive paths hold.**
  - Two-phase creation with inline undo, and recovery before the server listens.
  - A crash during an archive resumes with `force=false`, so a dirty lane goes back to `active`.
  - The archive busy check runs again under the lane lock, and `releaseIn` reporting `busy` refuses the archive.
  - Restore never deletes what `undo` did not hold, skips paths the target's ignore rules cover, and Undo is a swap. Three real-git rounds stand behind this.
  - `removeLaneFolder` refuses anything that is not a direct, non-symlinked, lane-named child of the real worktrees folder.
- **The R97 narrowing is tight.**
  - The own lane is derived from the session's real folder and must have a lane-shaped name. Both spellings of pap's home are handled.
  - Protected names (`.git`, `.pi`, `.agents`, hooks) still ask, and so does a hard link.
  - Another lane, `worktrees/` itself and the rest of `$PAP_HOME` stay protected.
  - The daemon refuses to start a worker in another owner's lane (`assertOwnLane` in `launch`).
  - The policy scope alias stays per owner.
- **The forge is boxed in.**
  - `gh` runs from an empty folder whose real path sets the git ceiling, with every value joined to its flag by `=`, the PR body on stdin, and a token-free environment.
  - `findPr` ignores fork pull requests.
  - A PR creation that times out is treated as unknown and reconciled, never blindly retried.
  - The issue host binding is checked again at `lanes.create`.
  - The fence id is random and the issue text is cleaned on the server (Cf, C0 and C1 characters).
- **The web surfaces deliberate safety behaviour.** Hidden characters are escaped in the approval box, the logs and the restore list. The destructive confirmation has a press guard and locks the options during the tainted question. The ship store survives a remount and is reset at sign-out.
- **The M10 seams are clean.**
  - `releaseIdle` returns `released`, `busy` or `cold`.
  - `beforePrompt` answers synchronously when it has nothing to do.
  - `unattendedEnv` and `fenceText` live in contracts.
  - The `daemon.ts` budget is respected (339 lines).
  - Every changed file is at 400 lines or fewer.

## Issues

### Critical

None.

### Important

**I1. The trust banner cannot trust a lane, which breaks the documented fallback of the lineage rule.**
- **Where.** `apps/daemon/src/modules/trust/service.ts:87-88` (`folderOf` → `projects.covers`), reached from `status` (`:154`) and `set` (`:165`). `apps/daemon/src/compose-pi.ts:83` hands the trust module the raw `projects.port`. `projects/service.ts:131-137` `covers` knows project roots only.
- **What is wrong.** A lane session's folder is `$PAP_HOME/worktrees/<laneId>`, which is under no project root. `trust.status` and `trust.set` therefore answer `invalid_cwd` for it. `SessionScreen.tsx:158` mounts `TrustBanner` with `cwd={view.cwd}`, so the banner's dialog fails.
- **Why it matters.** Task 18a's ask-instead-of-block ruling (MC18 and the round-2 lineage rule) and `lanes.md:167` promise that "M7's trust banner asks once" when a lane does not inherit trust. That covers:
  - every lane cut from the owner's own unmerged branch;
  - every token lane not cut at HEAD;
  - every lane of a project that was not yet trusted.

  The owner clicks the banner, gets an error, and has no other place to trust the lane folder. The Settings trust UI lists project roots only. The lane runs without its project's Pi extensions and skills, permanently. It fails closed, so this is not a hole, but a documented flow is broken. No test drives `trust.*` RPCs with a lane folder (`daemon.trust.int.test.ts` uses a project root).
- **Fix.** Give the trust module, and `skills`, `mcp` and `models`, which use the same `covers` check, a `covers` that also accepts the caller's lane roots. That is the same union `daemon.ts:181` already builds for the workspace (`allRoots`), wired through `composePi`. Add an int test: a lane cut from an unmerged branch, `trust.status` on its folder, then `trust.set true` with step-up, then a reopened worker loads the project resources.
- **Probe.** Trusted project with `.pi/extensions/x.ts`. Owner creates a lane from local branch `feat-x`, not in HEAD's lineage. Open the lane tab, click the banner: `trust.status { cwd: <worktree> }` answers `invalid_cwd`.

**I2. Archive never clears a lane's Pi trust entry, although the docs say it does.**
- **Where.** `apps/daemon/src/modules/lanes/archive.ts:178` removes the worktree. Only afterwards, at `:194-199`, does it call `trust.clear(ownerId, lane.worktree)`. The helper's `trustSet` starts with `realFolder(ctx.cwd)` (`packages/pi-host/src/helper/ops/trust.ts:30-39`, used at `:241`), which needs the folder to exist.
- **What is wrong.** Every clear fails with `bad_params` and is swallowed as `lane_archive_trust_not_cleared`. The boot resume (`archive.ts:256-267` → `finish`) follows the same order. Unit tests use a fake trust port (`testing/create-bed.ts:202`), so nothing catches it.
- **Why it matters.**
  - `lanes.md:23,167`, M9R40 and the archive comment ("Always: the folder is going") promise the entry goes.
  - Instead, each inherited or banner-trusted lane leaves a `true` entry in Pi's `trust.json` forever. The file grows without bound and Pi reads it at every worker start.
  - The entry becomes live again if the same path reappears. Lane ids are only `<slug>-<4 hex>` and are unique only while the `lanes` rows exist. If pap's database is restored from a backup or reset while `~/.pi/agent` is kept, a new lane with a colliding id is silently trusted, token-created or from a foreign branch included.
- **Fix.** Clear before the folder goes. Move the `trust.clear` call above `worktrees.remove`, still best effort. Alternatively, let the helper clear a `null` decision by the stored path without `realpath`. Add an int test with the real helper: inherit, archive, then assert that `trust.json` no longer names the worktree and that `project_trust_cleared` is audited.

**I3. Force together with Delete branch deletes unpushed, unmerged commits, and the confirmation only mentions uncommitted changes.** This re-raises T13-7, which is worse than parked.
- **Where.** `apps/daemon/src/modules/lanes/archive.ts:189-191` passes `force: params.force` to `worktrees.deleteBranch`. `apps/daemon/src/modules/worktrees/service.ts:193` runs `branch -D` when force is set. The dialog copy is `apps/web/src/i18n/catalog/lanes.ts:82-86`: "Force discards the uncommitted changes and untracked files", then "Archive and lose the uncommitted changes and untracked files in the worktree?".
- **What is wrong.** Force, which the dirty refusal suggests ("commit them, or check Force"), silently upgrades the branch deletion from git's safe `-d` to `-D`.
- **Scenario.** The owner commits the lane's work, leaves a few scratch files, ticks Force to get past `dirty` and ticks "Delete branch pi/x" to tidy up. The commits that were neither pushed nor merged are gone:
  - the branch reflog goes with the branch;
  - the worktree's HEAD reflog goes with its admin folder;
  - the checkpoint refs were deleted one step earlier (`:188`).
- **Why worse than parked.** M9R19's "cost if wrong: lost work under Force (the dialog says so, Task 13)" assumed a dialog that names this loss. It does not, and the DOCS resolution of T13-7 never reached `lanes.md`.
- **Fix, either of:**
  - (a) Always delete with `-d`. Force applies to the worktree only. Report `branchDeleted: false` when git refuses, which is today's no-force behaviour.
  - (b) Keep `-D`, but have the confirmation name the commits from `facts` (`ahead`, `unpushed`): "and N commits on pi/x that are not pushed or merged".

  (a) matches git and the owner's model. Also see M12.

**I4. The script approval box, the exact consent point, states two safety properties that are false.**
- **Where.** `apps/web/src/i18n/catalog/lane-new.ts:52-53` (fr `:120-121`): "…without your SSH agent or keys, and only when you start it from this browser." `docs/agents/lanes.md:124`: "No SSH agent and no keys: a script that clones a private repository over ssh fails."
- **What is wrong.**
  - Scripts run as the owner with `HOME`, `USER` and `XDG_*` (including `XDG_RUNTIME_DIR`) kept (`packages/contracts/src/child-env.ts:7,28`). `ssh` reads `~/.ssh/id_*` directly, so a key without a passphrase works and an ssh clone succeeds.
  - The agent socket is also reachable by path (`$XDG_RUNTIME_DIR/…`, `/tmp/ssh-*`). Only `SSH_AUTH_SOCK` is withheld.
  - "Only when you start it" is false for an approved `test:` script in a fan-out. It auto-runs after the first run, by the owner's choice m9q6 (ADR 0034).
  - ADR 0034 and `skills.md:51` say it correctly ("it can do what the owner can do", "can read … from disk"). The UI and the topic doc contradict them.
- **Why it matters.** The owner approves `pnpm install` for lanes that may be based on someone else's branch (residual 1), believing their keys are out of reach.
- **Fix.** Copy along the lines of: "Runs as you in the lane (no sandbox until M11): it can read your files, keys included; pap only leaves your SSH agent and tokens out of its environment. Runs when you start it, at lane creation for setup, and once after the first run for a fan-out's tests." Then fix `lanes.md:124`.

### Minor

- **M1. `clean -f -d -- .` is allowlisted but no longer used.** Since Task 11's C1 ruling the call is gone (`kernel/git/allowlist-lanes.ts:165`), and `lanes.md:56` still lists it as used by restore. It is the one call that deletes every untracked file. Drop it from the table, the allowlist and the doc, so a future caller has to bring its own injection review (MC17).
- **M2. The `root` checkpoint is one per lane, not one per session.** `modules/lanes/checkpoints.ts:269-274` keys any session whose leaf is null as `root`. A second session from `lanes.newSession` with Pi's default model (no `model_change` entry) overwrites the lane's `root` at its first prompt. After that, session 1's "restore to before the first message" and the `from` of its turn 1 point at session 2's start. Undo recovers, so nothing is lost. Fix: key the root per session, or never replace an existing `root`.
- **M3. A prompt waiting in `beforePrompt` does not keep its worker alive.** Neither the 15 s capture wait nor an uncapped restore hold counts as activity. `idle-release.ts:41-44` and `live-session.ts` `state()` cannot see the lane hooks' `waiting` set. A prompt that arrives in the last 15 s of `PAP_WORKER_IDLE_MINUTES`, or during a long restore, finds its worker released and answers `worker_failed`. Recoverable by sending again. Fix: count `waiting` as busy in the idle state, or touch the worker when `beforePrompt` starts. This is the production twin of the test flake root-fixed in 5989f5a.
- **M4. Restore resets the lane's real index.** `kernel/git/checkpoint.ts:77,152` run `reset --quiet -- .`, which unstages anything the owner staged in the lane's terminal (a partial `add -p` is lost). `lanes.md:132` says "the real index … never written" (about captures) and nothing about restore. Document it, or reset only the restored paths.
- **M5. Read paths write blobs with no disk floor, even on a read-only daemon.** `lanes.review`, `lanes.compare`, `lanes.checkpointStatus` and `lanes.suggestCommit` call `snapshotTree` (`review.ts:101`, `restore.ts:107`, `suggest.ts:59`, `branch-files.ts`). It writes blobs and trees into the owner's repository (`git add`, `write-tree`). Three of these are `lanes:read` and so token-callable. A loop over a lane holding a changing large untracked file fills the disk. Flagged by T15-5 for this review. Fix: run `diskFloor` before the snapshot, skip it on `readOnly`, and memoise per lane as `checkpointStatus` already does.
- **M6. The approval box caps its height without showing the size of the text.** `features/lanes/ScriptTrust.tsx:14` (`max-h-48 overflow-auto`) shows a script padded with hundreds of blank lines as `echo ok` and a scrollbar. Show a line and character count, collapse long runs of whitespace with a marker, and show a line diff for "changed since you approved it".
- **M7. Approval exists only in the New Lane dialog.**
  - `lanes.md:189` says "Open the lane, read the new text, approve again".
  - The lane tab only says "The setup script is not approved yet." (`use-lane-actions.ts:9`) and offers no path.
  - Fix: show `ScriptTrust` with Approve on the lane's Run setup refusal, or correct the doc to "open New lane (⌘⇧L) for the project".
- **M8. "Run setup" on a token-created lane gives no provenance.** `lane-header.vm.ts:88-89`, `use-lane-actions.ts:24-50`: one click runs the setup on files and a base the token chose. The New Lane dialog's "Someone else's branch: its package scripts run in your setup" hint never appears, nor does "created by a token". Ask-instead-of-block: show both before the click.
- **M9. "Push and create" does not name the push target.** `PrPanel.tsx:131-141` (`laneCommit.pr.pushAndCreate`) pushes without naming where. M9R91 has the commit bar name it ("Push ↑n → host/path"). Use the same `→ target`.
- **M10. The default PR body is never shown.** An empty body becomes the stored lane description on the server (`pr.ts:93-94`). The panel only hints at it (`PrPanel.tsx:97`) and never shows the text. For a token-created lane, that is text the owner may never have read, published on GitHub. Show it as the placeholder or a preview.
- **M11. `useComposerPrefill` is not reset at sign-out.** `AppShell.tsx:66-79`, MC34's "every client store". Review batches queued for one account's sessions stay in memory. They are keyed by session id, so no one else sees them.
- **M12. A branch git refused to delete is not reported.** `ArchiveDialog.tsx:56` closes on `ok` and drops `branchDeleted: false`. The owner believes the branch is gone.
- **M13. Force archive, close losers and PR creation leave no audit row.** `archive.ts`, `close-losers.ts` and `pr.ts:136-158` write nothing, while `lane_pushed` exists. These are the owner's work-destroying and external-write actions.
- **M14. The disk-floor seam is unsafe for M10's rebase.**
  - `compose-lanes.ts:74` (`diskFloor?: (path) => void`) and the `void` types in `create.ts:62`, `checkpoints.ts:221` and `worktrees/service.ts:34` accept M10's `kernel/disk.ts` `diskFloor(path, floorMb)`, which returns `{ ok } | { ok: false, freeMb }`, without a compile error. Wired that way, the floor never refuses.
  - Agreement 13 and the M10 plan (`…m10…md:467,3687,4436`) also name `modules/lanes/compose-lanes.ts`. The file is `apps/daemon/src/compose-lanes.ts`, and the value has to come through `daemon.ts`'s `composeLanes({…})` call.
  - Fix in M9: type the seam `(path: string) => undefined`, which a function returning an object cannot satisfy, and add a hand-off line: "wire `createDiskGuard({ path: <PAP_HOME>/worktrees, … })`".

Minor count: 14.

## Declined to judge

- The restore and capture algorithms in detail: three real-git fix rounds and re-reviews stand behind them; I checked only their seams (lock, undo ref, ignore rule).
- The results of the test suite, the bundle and the budgets: the final gate is running on this head.
- Behaviour of systemd scopes and orphan kills with a lingering manager: this host has none.
- Visual conformity to boards 10/05/12 and DESIGN tokens: the Sonnet web reviews covered it.
- The quality of the French copy.
- Agent reads of other lanes or projects: M5's read model, unchanged by M9.
- Taint carried through files a tainted agent wrote (taint is per session, M5 / ADR 0020).
- An unsandboxed script re-pointing the push between the scan and the push: covered by the "unsandboxed until M11" residual.
- A terminal opened in a lane after the archive's busy check: parked T7-9.
- Single-level undo: parked T15-4.
- Copy and link source TOCTOU: parked T4-1.
- Replacing `e/<leaf>` when branching without a restore: ruled M9R73 (pi-web behaviour).
- Archive deleting ignored files without Force: git's own `worktree remove` semantics.
- A restored root with no `.git` file: parked T11-5.
- Git load from token-callable `lanes:read` calls: the owner's own credential, bounded by the runner's caps.
- Agent edits of `.gitattributes` choosing the owner's global LFS filter: an owner-installed program.
- M10's code: only its seams were read.

## Recommendations

1. Fix I1 and I2 together; they are the same trust ⇄ lanes seam. Add one int test with the real helper pool covering both: lane cut from an unmerged branch, banner trust works, archive clears it.
2. I3: prefer option (a). Force is about the worktree. Branch deletion stays git's safe `-d` unless a separate, explicitly worded "delete unmerged commits" choice is added.
3. I4: one copy change in English and French, plus `lanes.md:124`. Consider a short "What a lane script can reach" paragraph in `lanes.md` that quotes ADR 0034's honest sentence.
4. M10 hand-off (append to the cross-plan notes before the rebase):
   - wire the disk floor through `daemon.ts` with the throwing `createDiskGuard` (M14);
   - widen M10's own `covers`-style cwd checks to lane roots only where intended;
   - keep agreement 16's `$PAP_HOME` refusal independent of `papHomeOpen`;
   - `sessions/index.ts` grew by 26 lines rather than 4 (208 lines, still far from the cap).
5. Ask-instead-of-block follow-ups for M11:
   - show the lane's taint state next to Commit and Push ("an agent that read external content changed these files") rather than gating them;
   - give the lane tab its own script approval box (M7, M8).

## Assessment

**Ready to merge: With fixes.**

The security architecture holds up across the seams I could test by reading.
- No path lets a token run, approve or push code.
- pap's git and gh run nothing a repository chose.
- The R97 narrowing reaches neither pap's home nor another lane.
- The destructive paths keep the owner's uncommitted work unless Force is given, and the restore and undo design is careful.

Four Important items should land first; each is small:
- **I1, the lane trust banner.** A broken flow that the 18a ask-instead-of-block ruling depends on.
- **I2, trust never cleared.** A documented cleanup that silently never happens, leaving trust entries that would become live again if a lane path is reused.
- **I3, Force upgrading to `branch -D`.** Loses committed work behind a confirmation that names a different loss.
- **I4, the approval box.** It misstates what a script can reach, at the consent point.

None is Critical: I1 fails closed, I2 needs a reused path, I3 needs two ticks and a confirmation, and I4 is copy. Each is cheap to fix and test, and leaving them would hurt a real owner.
