# ADR 0032 — The `vcs` stream is keyed by project root and polls while somebody watches

Status: accepted · Date: 2026-10-14 · Spec: C §4.3 (streams: `vcs{cwd}`) · Rulings: M8R44-M8R49, M8R79, MC24, MC25

## Context

Spec C §4.3 lists the stream `vcs{cwd}`: one status per session folder. Two sessions in one project, or a folder and its sub-folder, would run the same `git status` twice and show two answers. Git has no change feed a daemon can subscribe to without watching the whole tree, and a status run costs CPU on a large repository.

## Decision

- The key is the caller's project root (M4: the git root of a session's folder, or the folder itself outside git), never a session's `cwd`. `subscribe.vcs`, `vcs.refresh` and `vcs.fileDiff` take `root` and answer `not_found` unless it is exactly one of the caller's roots and the path boundary lets the caller list it (`modules/vcs/service.ts`). A root that is a sub-folder of a bigger repository answers `repo: false`: git cannot climb above the root (`GIT_CEILING_DIRECTORIES`).
- The status is read by one `git status --porcelain=v2 -z --branch --ignore-submodules=dirty` and one `git diff --numstat -z HEAD`, through the safe runner (`kernel/git/`). No `--untracked-files` flag: the repository's own setting decides (`normal` by default, so an untracked folder is one `dir/` entry and `status.showUntrackedFiles=no` lists none).
- A subscription starts a run when the cached status is older than 2 s (`FRESH_MS`) and arms a poll every 15 s (`VCS_LIMITS.pollMs`) for as long as at least one subscriber is listed on the root. Nobody watching means no timer. `vcs.refresh` runs now, or once more at the end of a run in flight. The web asks for a refresh on window focus (at most once a second) and when a session of the folder goes from running to idle.
- A run that times out (10 s) doubles the wait before the next poll up to 5 minutes and skips line counts until a run succeeds; a success resets both. Line counts are bounded (200 file reads per run, 2000 cached) and never follow links.
- At most 32 roots keep a cached status; the oldest root nobody watches makes room, and a watched root is never evicted (`capacity`).
- A status is pushed only when it changed (a digest without its timestamp).
- A token gets its own key `token:<root>` and a copy of the status without the entries its path boundary would call `not_found` (`.mcp.json`, `.pi/mcp.json`, home dot-entries, links); the owner's copy is untouched (MC24, MC25).
- `vcs.fileDiff` takes two sides (`worktree`, `index`, `head`, or `commit` with a full oid), up to 400 KiB each; the working-tree side is read through the same checked open as the explorer.

## Consequences

- Several sessions of one project share one poll and one answer. The cost of a watched large repository is one status run per 15 s, at most four git processes at once for all roots (the runner's cap).
- A changed file is seen after at most 15 s unless a refresh trigger fires; there is no file watcher in M8.
- `cwd` is not part of the contract: a client that wants the changes of a session sends its project root.
- A repository-local filter driver (`filter.*.clean`) still runs when git compares files for `status` and `diff` (the accepted residual MC13; it needs a prior write to `.git/config`, which M5 confirms). M7's repository config guard can refuse such a repository later.
