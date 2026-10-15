# ADR 0033 — Lane worktrees live under `$PAP_HOME/worktrees`, created in two phases

Status: accepted · Date: 2026-10-14 · Spec: C §1.2 (state under `$PAP_HOME`), C §6 (lanes) · Rulings: M9R16-M9R21, M9R44, M9R45, M9R117, M9-RT-03, MC1-MC3 (the R97 here is M8's handoff, not M9R97)

## Context

A lane needs a git worktree. Putting it next to the project would write into the owner's code folder, break on read-only or synced folders, and leave pap no single place to clean up. Spec C keeps pap's state under `$PAP_HOME`. But M5 and M8 treat `$PAP_HOME` as protected: the path boundary hides it and the edit policy asks before every edit there. A worktree under it would be unreadable to the explorer and every agent edit would raise a dialog.

`git worktree add` is also slow (up to 120 s on a big checkout) and touches the repository's shared state. A crash in the middle must not leave a half-registered worktree, a locked registration or a branch nobody owns.

## Decision

- **Where.** `$PAP_HOME/worktrees/<laneId>` (real path, folder 0700, never a symlink). The lane id is `<slug>-<4 hex>`. One folder per lane; nothing else lives in `worktrees/`.
- **Two phases with an inline undo.** Phase 1 writes the lane row and the `worktrees` row `creating` in one transaction and `lanes.create` answers. Phase 2 runs under a per-repository lock (one promise chain keyed on the real path of `--git-common-dir`): `git branch --no-track`, then `git worktree add --lock --reason=pap-creating`, then pap reads back the admin dir git created and checks that its `gitdir` file points at the lane. Prepare (copy and link) follows, then `worktree unlock` and the row `ready`. Any failure undoes inline: unlock, `remove --force`, delete the folder, `prune`, delete the branch if pap made it and it still points at the base, delete the row. Boot runs the same undo for any row left in `creating` or `removing`, before the server listens. The lock makes git's `index.lock` and `worktrees/` writes safe between lanes of one repository.
- **The git dir is stored.** Git appends a counter when the admin name is taken, so the name is not derived from the folder. Every later lane call passes the stored `--git-dir` and `--work-tree` (MC1, MC3). A lane's own `.git` file is never trusted.
- **`papHomeOpen`.** The path boundary gets `papHomeOpen: ["worktrees"]` (`compose-workspace.ts`): under `$PAP_HOME`, `worktrees/` is judged like any project folder, and the deny walk skips it. The explorer shows a lane's files; the lane roots are added to the owner's file roots (`LanePaths.roots`).
- **The R97 narrowing.** In `packages/pi-host/src/policy/target-path.ts`, when a session's folder is inside `<papHome>/worktrees/<lane>` that lane is the session's own folder, not a protected root. The rest of `$PAP_HOME`, other lanes and `worktrees/` itself stay protected, and protected names (`.git`, hooks, editor tasks) stay protected inside the lane. The sessions module refuses to start a worker in another owner's lane (`forbidden`). Result: an agent edits its own lane without a dialog and nothing else under pap's home.
- **Umask.** The daemon runs with umask 077, so files git checks out are owner-only (0600 and 0700). That is harmless for the owner's own tools. Scripts and terminals run under the umask the daemon was started with (R114), so what they create has the owner's usual modes.

## Consequences

- Deleting `$PAP_HOME` deletes the lanes' uncommitted work. The branch survives in the project's repository.
- The disk floor (1 GiB free) is checked before the checkout; a full disk fails the lane with `disk`.
- A `git` started from a terminal-run daemon can finish after the boot undo (the systemd unit kills its cgroup). Residual in `docs/agents/lanes.md`.
- Another project's backup tools see the checkout as part of `$PAP_HOME`. Exclude `worktrees/` from pap's own backups if that matters.
