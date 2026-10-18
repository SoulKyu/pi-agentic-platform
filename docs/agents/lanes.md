# Lanes, worktrees and forges (M9)

A lane is one task in its own git worktree, with its own branch and its own sessions. Code: daemon `apps/daemon/src/modules/worktrees/` (the git side of a worktree), `modules/lanes/` (the lane, its scripts, checkpoints, review, push and PR), `kernel/git/` (the runner and its lane entries), `kernel/forge/` (`gh`), `compose-lanes.ts` (wiring); contracts `packages/contracts/src/{lanes,lanes-methods,lanes-review,lane-status,child-env,fence}.ts`; web `apps/web/src/features/lanes/` (see `web.md`). ADRs 0033-0036. Rulings: `docs/research/m9-rulings.md` (M9R1-M9R121, then the execution rulings MC1-MC26).

Where files live:

- `$PAP_HOME/worktrees/<laneId>`: the worktree (0700 folder; a lane id is `<slug>-<4 hex>`).
- `$PAP_HOME/lanes/<laneId>/<kind>.log`: script logs (0600, 5 MiB each).
- `$PAP_HOME/tmp/git-index/idx-<32 hex>`: temporary index files of a capture, removed when the capture ends (a crash can leave one behind, see Residuals).
- `refs/pap/checkpoints/<laneId>/{e/<entryId>,root,undo}`: checkpoints, as refs in the project's repository.
- Tables: `worktrees` (`202610141000`), `lanes`, `lane_fanouts`, `lane_reviews`, `lane_script_approvals` (`202610141010`). M10 uses `2026101420xx`.

## A lane's life

| Step | What runs | A failure at runtime | A crash right after leaves | Boot (recovery runs before the server listens; skipped on a read-only database) |
|---|---|---|---|---|
| 1. create | Caps and the disk floor are checked; lane row `creating` and worktree row `creating` are written in one transaction. `lanes.create` answers here | `limit_reached`, `capacity`, `disk_low` | rows, nothing on disk | worktree row goes to step 3's undo; lane row becomes `failed` (`interrupted`) |
| 2. branch | `git branch --no-track <branch> <baseOid>` (`created_branch = 1`) | inline undo; lane `failed` (`git`) | a branch at the base | branch deleted if it still points at the base, else kept and logged |
| 3. checkout | `git worktree add --lock --reason=pap-creating <path> <branch>` under the repository lock, 120 s | inline undo; lane `failed` (`git` or `disk`) | a locked worktree | the same undo (unlock first: a locked registration survives `remove` and `prune`) |
| 4. prepare | copy and link from `project.yaml`; worktree `ready` and `worktree unlock` | inline undo; lane `failed` (`prepare`) | a ready worktree, lane `creating` | lane becomes `active`; setup `interrupted` when one was due, else `none`; a token-created lane gets `pending` |
| 5. setup | browser-created lane: the approved setup runs. Token-created lane: setup stays `pending` | setup `failed` | a running script | `running` becomes `interrupted` after the orphan group is killed; never re-run |
| 6. session | `sessions.create`, model, first prompt | `primary_session_id` stays null, a notice | a session without its prompt | none: "Start session" (`lanes.newSession`) |
| 7. archive | lane `archiving` (prompts refused), archive script, lane lock and a second busy check, workers released, `worktree remove`, refs deleted, branch if asked, sessions archived, trust entry cleared, logs deleted, lane `archived` | a refusal puts the lane back to `active` | a half-archived lane | resumed from the worker release; the archive script is not re-run |

- Creation is two-phase on purpose: the row exists before git touches anything, so a crash always leaves something recovery can find. `lanes.create` answers after phase 1; the `lane` stream shows `creating` then `active` or `failed`.
- A `failed` lane has no worktree. Its creating slot is free at once; it counts toward the 64 open lanes until the owner archives it (archive only moves it out of the open list).
- A fan-out is 2 to 4 models in one `lanes.create`: one lane per model, one `fanoutId`, the same first prompt.
- Branch names: `<branchPrefix><slug>`, then `-2` to `-20`; past that `limit_reached`. `BRANCH_PATTERN` refuses `@` (git 2.53 `check-ref-format --branch` prints `@` back as the previous branch, so a name with `@` could mean something else), `..`, `//`, `/.`, `.lock`, and `HEAD`, `FETCH_HEAD`, `ORIG_HEAD`, `MERGE_HEAD`.
- Caps: 64 open lanes per owner (the 65th is `limit_reached`), 4 creations in flight (the fifth is `capacity`), 1 GiB free disk (`PAP_MIN_FREE_DISK_MB`, `0` = off; `disk_low` from `lanes.create`, `lanes.restore`, `lanes.review`, `lanes.checkpointStatus`, `lanes.suggestCommit` and `lanes.compare`; the checkpoint hooks show the notice `disk_low` instead).

## Permissions

- Domain `lanes`. `lanes:read`: the stream, preview, review, turns, compare, checkpoint status, script log, archived list. `lanes:operate`: create, new session, commit, suggest commit, review state. `lanes:admin`: approve scripts, run script, restore, issue, push, PR create and refresh, archive, close losers.
- A token never holds `lanes:admin` (one filter, `TOKEN_PERMISSIONS`). Why: `admin` approves or runs code, sends code out, reaches a forge or destroys work. `lanes.create` is `operate`, so a token can start a lane; its setup stays `pending`.
- M9 adds no error code of its own (`disk_low` is M10's). A refusal a person acts on is an answer `{ ok: false, reason }`.

## The git allowlist and the profiles

Code: `kernel/git/allowlist.ts` (M8's nine read subcommands) and `allowlist-lanes.ts` (M9). Every option is spelled exactly, none twice, and a call must match its shape (the `--` rule: paths come after `--`, and a commit's paths are `./`-prefixed). Config, environment, process group and caps are M8's (`files.md`).

| Subcommand | Options (exactly) | Shape | Used by |
|---|---|---|---|
| `rev-parse` | `--show-toplevel` `--abbrev-ref` `--git-common-dir` `--git-path` `--verify` `--quiet` | free | create, facts, trust |
| `check-ref-format` | `--branch` (required) | one name | create |
| `branch` | `--no-track <branch> <oid>`, or `-d` / `-D <branch>` | one option | create, archive |
| `worktree add` | `--lock --reason=pap-creating` (both required) | `<absolute path> <branch>` | create |
| `worktree unlock` / `remove` / `prune` / `list` | none / `--force` (required) / none / `--porcelain -z` | one absolute path, or none | create, archive, recovery |
| `for-each-ref` | two `--format` strings, `--sort=-committerdate`, `--count=500`, `--merged=HEAD` | `refs/...` patterns | preview, archive, checkpoints |
| `rev-list`, `merge-base` | `--count --left-right`; `--is-ancestor` | `merge-base --is-ancestor <oid> HEAD` | facts, trust |
| `read-tree`, `write-tree`, `commit-tree` | `--empty`; none; `-p` | only under a temporary index (`read-tree`) | checkpoints |
| `update-ref` | `--no-deref` (required), `-d` | a checkpoint ref and an oid, or `-d` and a checkpoint ref | checkpoints |
| `add` | `--pathspec-from-file=- --pathspec-file-nul` (both required) | none; paths on stdin, NUL-separated, at most 4096 paths and 512 KiB | commit, checkpoints |
| `rm` | `--cached -f --quiet` and the stdin pair | none | nested-repo clean-up |
| `commit` | `--file=- --no-gpg-sign` (required), `--quiet` | `-- ./path...` | commit |
| `restore` | `--source=<oid> --worktree` plus either `--staged -- .` or the stdin pair | one of the two forms | restore |
| `reset` | `--quiet` | `-- .` only | restore |
| `diff` | M8's plus `--raw -M --no-renames --no-abbrev --no-color -U3 --cached` | free (read) | review, suggest |
| `remote get-url` | `--push --all` (both required) | `origin` | push |
| `push` | `--porcelain --set-upstream` (both required) | `origin refs/heads/<B>:refs/heads/<B>`, same branch both sides | push (remote profile only) |

Call shapes that matter:

- `-A` and `-u` are not allowed. Staging always lists explicit paths from the guarded status, gitlinks left out, with `--literal-pathspecs`. Why: `add -A -- .` walks into a nested repository and runs its clean filter (MC1).
- Every lane call also passes `--git-dir=<common>/worktrees/<name>` and `--work-tree=<root>`. The git dir is the one pap stored after `worktree add` (git adds a counter to the name when it is taken), never read from the lane's `.git` file. A rewritten `.git` file or a `core.worktree` in `config.worktree` cannot redirect a call.
- A lane's dirty test is `status --porcelain=v2 -z --ignore-submodules=dirty --untracked-files=normal`. The owner's `status.showUntrackedFiles=no` would otherwise make a lane with new files look clean.
- `GIT_INDEX_FILE` is accepted only as `<indexDir>/idx-<32 hex>`, where `indexDir` is `$PAP_HOME/tmp/git-index`. Author and committer for checkpoint commits are fixed (`pap <pap@users.noreply.invalid>`). `GIT_LFS_SKIP_SMUDGE=1` is accepted for `worktree add`.
- `commit` runs under the owner's git identity (global config). A missing identity is the typed refusal `identity_missing`.

Profiles:

- `local` (default): M8's safe config plus `maintenance.auto=false`, `gc.auto=0`, `submodule.recurse=false` (`commit` would otherwise start a detached `git maintenance`, which leaves the runner's process group). No transport: `GIT_ALLOW_PROTOCOL` is blank.
- `remote`: `push` only. Drops `protocol.allow=never` and `credential.helper=` (the owner's helpers must answer), adds `push.recurseSubmodules=no`, `push.followTags=false`, `push.pushOption=` (a repository's own push options would reach the forge, for example a GitLab merge request). Environment adds the proxies and CA variables and `SSH_AUTH_SOCK`. `GIT_ALLOW_PROTOCOL` is `https:ssh`; tests may add `file` through `PAP_TEST_GIT_PROTOCOLS` (needs `PAP_TEST_PROVIDER_SCRIPT`; never set in production). The push runs on the owner's click, so the SSH agent is allowed here and nowhere else.
- Both profiles run with the daemon's umask (077), so files git checks out in a worktree are owner-only. Scripts and terminals run under the umask the daemon started with.

## The push target and the scans

`readPushTarget` (`kernel/git/push-lane.ts`) is the one sequence for the push button's fact, the preview and `lanes.push`. It runs from the lane root with the stored git dir:

1. Scan the repository's own config for keys that run a program or redirect: `core.sshCommand`, `core.askPass`, `core.gitProxy`, `credential.*.helper`, `url.*.insteadOf` and `pushInsteadOf`, `http.*`, `remote.*.vcs|proxy|receivepack|uploadpack|mirror`. Keys from `system` and `global` scope are the owner's and pass. Any hit: `repo_config`.
2. Read every `remote.origin.url` as configured (the forge identity) and `remote get-url --push --all origin` (where a push really goes).
3. Exactly one of each, and both name the same host and repository (a same-repository ssh `pushurl` beside an https `url` is fine). Otherwise `repo_config`; a URL that is not a forge URL is `unsupported_remote`; none is `no_remote`.
4. `push --porcelain --set-upstream origin refs/heads/B:refs/heads/B`, 120 s. The refusal is classified from git's output: `rejected`, `auth`, `network`, else `failed`. A timeout is an unknown outcome and passes up as `timeout`.

The UI names the real target ("Push feat-x to github.com/acme/app") before the click. `LaneView.remote` is the origin as configured, `pushRemote` is where the push would go.

## `project.yaml`

The file is `.pi/project.yaml` of the owner's main checkout (not of the base branch). Why: the owner's checkout decides what pap runs. 64 KiB at most. Keys:

| Key | Meaning |
|---|---|
| `setup`, `archive`, `test` | scripts, up to 16 384 characters each |
| `copy`, `link` | up to 100 relative paths each: copied (256 MiB, 100 000 files at most) or linked into the worktree |
| `branchPrefix` | prefix of new branches; default `pi/` |
| `waitForSetup` | the first prompt waits for the setup to end `ok` |
| `forge` | `github`, `gitlab` or `gitea`; public hosts are known by name and win over this line. Only `github` has an adapter in M9 |

- Parser: YAML core schema, no alias, no custom tag, no duplicate or non-scalar top-level key, at most 256 keys. A bad file is refused whole (`invalid_yaml`, `too_large`, `not_a_map`); one bad field is dropped and named in `warnings`. A cache keyed on device, inode, size and mtime keeps a token's `lanes.preview` loop from reparsing.
- Copy and link sources go through M8's boundary judge and deny set on their real path (a copy of `~/.ssh` or a link above a denied folder is refused). A copied entry must be ignored by the lane's ignore rules, else it is removed (it would be committed and pushed). A link whose destination is not ignored is undone.

## Scripts: approval and who may run them

- Approval is pap's table `lane_script_approvals` (one row per owner, project and kind), bound to the sha256 of the exact text. `lanes.approveScripts` takes the hashes the owner saw, re-reads the file, and answers `changed` if any hash is not the current one. It needs a browser session (a token is `forbidden`) and the password step-up. Audit: `lane_script_approved`. Editing the file un-approves the script; the UI shows "changed since you approved it" with the previous text.
- The runner runs only the text the owner approved, as it is now in the file. Not Pi's `trust.json`: that is about extensions, not shell text (ADR 0034).
- Who may run what:

| Script | Browser | Token |
|---|---|---|
| setup, in a browser-created lane | runs by itself after prepare | n/a |
| setup, in a token-created lane | `pending`; the owner clicks "Run setup" | never; `lanes.runScript` is `lanes:admin` |
| test | click on "Run tests" | never |
| archive | runs inside `lanes.archive` | never |
| test, fan-out auto-run | once, after the primary session's first run, only if `created_by = 'session'`, the source is not an issue and no session of the lane (archived ones included) is tainted at that moment; judged again right before the spawn | never |

- Tainted lane: `lanes.runScript` and `lanes.archive` (with an archive script) answer `tainted` until the owner repeats the call with `confirmTainted: true` after reading "Runs this lane's files, which an agent that read external content may have changed". An unbound sessions or policy port counts as tainted.
- Spawn: `/bin/sh -c 'umask "$1" && shift && exec "$@"' pap-lane-<kind> <mask> bash -e -c <script>`, cwd the worktree, stdin closed, own process group, in a `systemd-run --user --scope` when the worker scopes are on, output merged into the log. Deadlines: setup 30 min, test 15 min, archive 5 min; TERM, then KILL after 5 s. Two scripts per owner at once (more wait as `queued`). A script that backgrounds work is killed with its group.
- Environment: `unattendedEnv` (ADR 0034): `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_*`, `TZ`, the absolute `PATH` entries, `TERM=dumb`, the proxies and CA variables, `TMPDIR`, `XDG_*`, and `PAP_LANE_ID`, `PAP_LANE_ROOT`, `PAP_LANE_WORKTREE`.
- Boot: a lane whose script was `running` gets its recorded process group killed when the `<boot id>:<start time>` tag still matches, then the state is `interrupted`.

### The unattended environment and its friction

One rule for every child pap starts that nobody watches: lane scripts, `gh`, M7's `npx`, `npm` and `git` installs, and M10's precheck. Names that never pass, even when a caller lists them: the SSH agent (`SSH_AUTH_SOCK`), `GIT_*`, `LD_*`, the model providers' families, anything credential-shaped (`*_TOKEN`, `*_API_KEY`, `*SECRET*`, `*PASSWORD*`), pap's daemon-only keys. What the owner notices:

- No SSH agent, but the keys on disk are readable: a script runs as the owner, with `HOME` kept, and there is no sandbox: M11 sandboxes agents' shells, not lane scripts. `ssh` reads `~/.ssh/id_*` itself, so a key without a passphrase works, and the agent socket is still reachable by its path. pap keeps your SSH agent and tokens, among others, out of its environment. A script that clones a private repository over ssh may therefore succeed; do not approve what you would not run yourself. Scripts run when the owner starts them, and a fan-out's test script also runs once after each lane's first run (ADR 0034).
- Tokens in the environment are dropped. Registry token: put it in `~/.npmrc`. Forge: `gh auth login` once (gh answers from its own login, never from `GH_TOKEN`).
- Tool variables (`JAVA_HOME`, `GOPATH`, `NVM_DIR`, `CARGO_HOME`) do not reach a script: export them inside the script, or put them in the tool's config.
- A private plugin source over ssh needs the terminal.
- Debug: a script that works in the terminal and fails here: print `env | sort` in the script and compare.

## Checkpoints, run hooks and the lane lock

- A checkpoint is a tree of the worktree's files, taken through a temporary index (the real index, `HEAD` and branches are never written), stored as a commit under `refs/pap/checkpoints/<laneId>/e/<entryId>` (the leaf entry of the session when the run ended), `root` (before the session's first message; per lane, so a second session's "before the first message" points to the lane's start, and restoring it also rolls back the first session's changes) and `undo`. Ignored files are not captured; an untracked file over 50 MiB is left out and shown as `large_files_skipped`; nested repositories are left out as `nested_repo_left_out`. One odd file never sinks a capture.
- If the copied index is a split index (its shared file lives beside the real one) and `add` fails, the temporary index is rebuilt with `read-tree` and the adds run once more.
- `before` is taken when a prompt reaches an idle worker, `after` when the run ends. The prompt waits up to 15 s for `before` (`BEFORE_PROMPT_CAP_MS`); a late capture writes nothing and raises `checkpoint_before_late`. A prompt to a busy worker never waits (steer and follow-up are untouched).
- Cap: 2000 checkpoint refs per lane. At the cap, new captures are refused, replacing ones too (`checkpoints_full`, `checkpointsFull` on the view). Archive deletes the lane's checkpoint refs; while the lane is open, nothing else frees room. Why: refusing is simpler than choosing which checkpoint to lose.
- The lane lock (`lane-lock.ts`) is one promise chain per lane. Archive, commit, restore and the checkpoint captures take it. Push does not. A prompt waits for a restore with no cap.
- Restore (`lanes.restore`, `lanes:admin`, browser only): refuses `busy` when a session of the lane is not idle, or while a setup, test or archive script is queued or running. It first captures the current files to `undo`, then resets the lane's real index (`reset --quiet -- .`): anything staged in the lane's terminal is unstaged, a partial `add -p` included. The files themselves are untouched by that reset. Undo is a swap: Undo of Undo returns exactly what was there. It removes a path only when the undo capture held it and the target checkpoint does not, tracked or not. Anything undo did not hold stays and is listed in `left` with a reason (`large`, `unreadable`, `ignored`, `conflict`): a folder the target replaces by a file is kept when it holds any such entry, and a path the target's ignore rules ignore is never removed. `left` is a result field with at most 50 entries, plus `leftTotal`; it is not a notice. `changed: false` when the files already were the target's (the second Restore is a no-op).
- Large directories: stage lists are batched (4096 paths / 512 KiB per call).

## Review, turns and compare

- `lanes.review { scope }`: `branch` (merge base to the lane's live tree) or `turn` (one user message's checkpoint range). Lists at most 2000 files; `truncated` says more. Each file has an `identity` (its to-side blob, or `deleted`); a file is "Seen" while the stored identity equals it. `lanes.reviewState.get|set` keeps Seen and comments (500 comments, 4000 characters each, 1 MiB) with a revision; a stale `baseRevision` is `conflict`.
- `ReviewList` has no conflict ordering ("conflicts first") and no "not captured (left)" files. Known gap; a follow-up, not added in M9 (no contract field).
- `lanes.turns { sessionId }`: the session's user messages with their checkpoint ranges (500 at most, preview 120 characters).
- `lanes.compare { fanoutId }`: one column per lane (summary, files, additions, deletions, duration; `costUsd` is M10's `RunsPort.sessionCost` of the lane's primary session and `billing` its `RunsPort.sessionBilling` (`api`, `subscription`, `unknown`), both null for a lane without a run; the column labels a subscription's figure API-equivalent). `lanes.closeLosers { fanoutId, winner }` archives the others one by one, per fan-out serialised; each refusal is listed (`busy`, `script_failed`, `setup_running`, `tainted`).

## Commit, suggest, push, PR

- `lanes.commit { paths, message }`: stages exactly the chosen paths (renames count both sides), leaves gitlinks out (`nested_repo_left_out`), appends the trailer `Pap-Lane: <laneId>`, commits with no hooks and no signature (`--no-gpg-sign`, `core.hooksPath=/dev/null`). Refusals: `nothing_to_commit`, `identity_missing`, `conflicted`, `failed`. Husky, commitlint and signed commits run only from a terminal.
- `lanes.suggestCommit`: asks the lane's primary session's model for a message from the selected diff (each file clipped at 20 000 characters, 200 000 in all). One call per lane at a time (a second shares it), at most 2 lanes in flight per owner (a call for a third lane answers `capacity`), diff over 32 MiB answers `capacity`. The model call times out after 30 s in the worker; the daemon's git diff has a 60 s deadline. Side call: M10's budget does not count it, nor Pi's `auto_name` (C1).
- `lanes.push`: see the push target above. The result carries the real remote.
- `lanes.prCreate { title, body, draft }`: needs a pushed branch (`not_pushed`). An empty body uses the lane's stored description, clipped to `LANE_LIMITS.prBody` (60 000), on the server. The panel shows that text under the empty body from `LaneView.descriptionPreview` (first `LANE_LIMITS.descriptionPreview` = 2000 characters, `descriptionTruncated` says more follows; the full text stays off the lane stream, whose snapshot has a frame budget), hidden characters escaped. `lanes.prRefresh` reads number, state, draft, conflicts and checks; a read is cached 60 s.
- Facts (`dirty`, `ahead`, `behind`, `unpushed`, additions, deletions) are refreshed after create, commit, push, restore, every run end, `lanes.refresh`, and in the background when older than 30 s (two lanes at a time).

## Forges

- GitHub only (owner m9q5). `forgeFor` has one adapter. A GitLab or Gitea issue URL answers `unsupported_url`, shown as "not supported yet". GitLab, Gitea and Linear come later: Gitea and Linear need a token pap would hold, so they wait for M11's vault.
- `gh` runs with `--repo=<host/owner/repo>` (built from a parsed remote only), every value joined to its flag with `=`, the PR body on stdin, from an empty folder (`$PAP_HOME/tmp/forge`, 0700) that is never a repository (`GIT_CEILING_DIRECTORIES` is its parent), with `forgeEnv`: the unattended environment plus `GH_CONFIG_DIR`, `NO_COLOR`, `GH_PROMPT_DISABLED=1`, no update notifier. Timeouts 30 s (create 60 s), stdout 4 MiB.
- Outcomes: `forge_missing` (no `gh`), `not_signed_in` (`gh auth login` once), `not_found`, `timeout`, `too_large`, `failed`.
- Host binding: an issue link must be on github.com (any repository) or on the project's own forge host (its `remote.origin.url` as configured). Any other host is refused before a CLI starts. `findPr` ignores fork pull requests.

## Issues, taint and trust

- `lanes.issue` (admin) reads the issue once. The title and text are external content: control and invisible format characters are removed, the text is clipped (title 256, body 20 000).
- `lanes.create` with an issue re-judges the link (host, number, kind) and stores the first prompt as `issuePrompt`: a fixed sentence, then the text inside `<untrusted source="github-issue" id="<random>">...</untrusted id="<random>">` (`fenceText`, in contracts). The description stays on the row. The lane's primary session starts tainted (sticky taint, ADR 0020): see `policy.md`.
- Taint does not gate extension event hooks: they see the issue text (residual).
- Trust inheritance: a new worktree inherits the project's Pi trust only when Pi's store trusts the project root, the base commit is the main checkout's HEAD or an ancestor of it (`merge-base --is-ancestor`), and `.pi` and `.agents/skills` have the same tree id at the base and at HEAD. A token's lane needs the base to equal HEAD. Otherwise nothing is written and M7's trust banner asks once. Cost: the owner's own unmerged branch gets the banner (one click). Each inheritance is audited (`project_trusted { inheritedFrom }`); archive clears the worktree's entry.

## Notices

In memory, the newest 8 per lane, gone at a restart: `model_refused`, `session_failed`, `checkpoint_before_late`, `checkpoints_full`, `large_files_skipped`, `disk_low`, `copy_skipped`, `nested_repo_left_out`, `auto_test_dropped`. A notice carries a kind and a count, never a file name.

## The agent's note (M11a, `lane.note`)

- A session whose folder is inside an open lane of the owner is type `lane` and may call the platform op `lane.note` (tool `lane_note`, ADR 0047). The note is one line: hidden characters (controls but tab and new line, format, line and paragraph separators) removed, trimmed, cut to 2 000 UTF-16 units; the wire accepts up to 8 000 so it is cleaned and clipped rather than refused (W5-R20); empty clears it. 60 an hour per lane (`rate_limited`); another owner's lane, an archived lane or no lane is `not_found`. Lanes are matched by folder with a prefix-aware test, so `/w/a` and `/w/ab` stay apart.
- Stored in `lanes.note` and `note_at` (migration `202610151150_lane_note.sql`), published on the lane stream (`LaneView.note`), shown by the desktop lane header as text on one clipped line with the whole note in a tooltip and the label "from the agent". The phone header shows none. The note is the agent's text: never a title, never markup.

## Residuals (accepted, named)

- A lane from someone else's branch runs that branch's package scripts through an approved `pnpm install`: the approved setup is the owner's, what it installs is not. The hint is in the New lane dialog (`laneNew.from.foreign`), not in the approval box.
- Archive: Force applies to the worktree only (it discards uncommitted changes and untracked files). Delete branch always uses `git branch -d`, so a branch goes when its commits are merged or pushed (after a lane push `git branch -d` checks the upstream; the commits stay on the remote). Otherwise it is kept and the answer is `branchDeleted: false`. The archived lane leaves the store before the answer, so the dialog is gone: the notice "Branch pi/x kept: it has commits that are neither merged nor pushed" is kept per lane in the lane ship store (`keptBranch`) and shown under the archived-lane empty state.
- An archive refused as `dirty` (or failed to remove) after its script ran has already cleared the lane's Pi trust entry: the lane goes back to `active` without it, and the trust banner asks again. An archive script that writes into the worktree makes this happen every time.
- A terminal open in the worktree during a restore keeps writing; it is the owner's shell. Archive does refuse while a terminal runs there.
- LFS pointers: `GIT_LFS_SKIP_SMUDGE=1` on checkout, so large files appear as pointers until the owner runs `git lfs pull` in the terminal. A checkpoint holds the pointer text.
- Commits are unsigned and hooks are off (M9R106).
- The 15 s prompt wait: after it the prompt goes without its `before` checkpoint.
- The split-index fallback (above) costs one more `read-tree` and `add` pass.
- A `git worktree add` started when the daemon runs from a terminal (not systemd) can finish after the boot undo; under the systemd unit its cgroup dies with the daemon (M9R20). Run `git worktree prune` and delete the orphan folder by hand.
- An unsandboxed script: a lane script runs as the owner with the unattended environment, outside the policy. M11's sandbox covers agent shells and agent prechecks only; the consent copy says so ("agents' shells run in a sandbox, lane scripts do not").
- Extension event hooks see issue text (above).
- No boot sweep empties `$PAP_HOME/tmp/git-index/`: a crash during a capture can leave one `idx-*` file there. It is harmless; delete it while the daemon is stopped.

## Troubleshooting

- Lane stuck in `creating` after a crash: restart the daemon; recovery undoes or finishes it. Look for `worktree_undo_failed` in the log.
- "Needs attention: setup unapproved": the file's script text changed. Open New lane (⌘⇧L) and pick the project: the box shows the new text beside the approved one; approve again (password). The lane tab only says the script is not approved and offers no approval.
- Push refused `repo_config`: the repository's own config sets `url.*.insteadOf`, a credential helper or another key from the scan list, or a `pushurl` that names another host or repository (a same-repository ssh `pushurl` is fine). Fix the repository's `.git/config`, or push from the terminal.
- `forge_missing`: install `gh`. `not_signed_in`: `gh auth login` as the daemon's user.
- `identity_missing`: `git config --global user.name` and `user.email` as the daemon's user.
- Restore says `left`: those files were not in the checkpoint's scope; they are untouched.
- Disk: under the floor (1 GiB by default), create answers `disk_low` and captures show the notice `disk_low`.
