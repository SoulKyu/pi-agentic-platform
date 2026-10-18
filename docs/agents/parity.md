# Parity audit: every v1 feature points to a proof

Written by M13 P3 (M13R20, M13R30) from the final code. The source is `docs/research/pi-web-inventory.md` (D01 to D22), the additions of spec A section 5.2 and the items spec C section 7.3 keeps. `scripts/parity-doc.test.ts` fails the gate on a domain with no row, a proof file that does not exist (full repository paths only), a verdict that is not `green`, `dropped (owner ...)` or `after v1 (...)`, a reference to a ruling or a decision that does not exist, and on the word `gap`.

- Row: `P<domain>-<n>`. D07 to D10 (models, tools, MCP, skills) keep their rows in `docs/agents/models.md`, section Parity (M7R129); the test reads both files.
- Proof: a unit or integration test that asserts the behaviour, an e2e journey (`scripts/e2e/j<nn>-*.e2e.ts`, run by the container runner, see `docs/agents/e2e.md`) or a smoke script. A journey is listed beside the tests that assert the same behaviour at a lower level.
- Verdict `green`: the behaviour exists and the proof asserts it. `dropped (owner ...)`: the owner removed it from v1. `after v1 (...)`: the owner moved it after v1; the proof cell then names the document that records the decision.
- Owner answers of M13 are cited as `owner q<n>` with the ruling that carries them (M13R20 is the parity ruling). The answers are in the owner decisions page of 2026-10-18; they are not in the repository.

## Decisions recorded by this audit

| Item | Verdict | Owner answer |
| --- | --- | --- |
| Completion sound | green (built by B7, off by default, M13R21) | q5 |
| Lane archive Undo (the archive removes the worktree: nothing is left to restore) | after v1 | q6 |
| Plannotator links, visit digest, dated default folder, linked-directory allow-link | after v1 | q7 |
| Inbox digest row | after v1 | q9 |
| iOS status-bar style | keep `default` (green row in D19) | q10 |
| Replacing pi-web | no cutover, pap and pi-web coexist (`docs/agents/sessions.md`) | q12 |
| GitLab, Gitea and Linear issues | after v1 | m9q5 (M9R107) |
| Open in the OS file manager | dropped | m8 (M8R97) |
| Exact system prompt in Chat only, PowerShell switch | dropped, in `docs/agents/models.md` | m10 (M7R143) |

## Differences from pi-web that are not gaps

- The project tree shows 20 rows per project and "Show more" instead of a virtualized list (P02-5); projects and pins move by menu, with no drag and drop (M4R98).
- UI state lives in SQLite rows with a command id per change, not in a JSON file with a lock and a corrupt backup (P02-6, spec C).
- There is no file watcher: a 15 s status poll and Refresh keep the Changes pane and the viewer current (P04-4, ADR 0032).
- The Tron palette is replaced by the E1 Night and Day themes (spec A section 5.3); the gallery, reduced motion and tokens stay (P20).

## Rows

### D01 Sessions and chat

| Row | pi-web behaviour | Proof | Verdict |
| --- | --- | --- | --- |
| P01-1 | Browse Pi sessions read-only from the JSONL files | `apps/daemon/src/modules/sessions/transcript.test.ts`, `apps/daemon/src/modules/sessions/sessions.reads.int.test.ts`, `apps/daemon/src/modules/search/session-file.test.ts` | green |
| P01-2 | Start and drive a live session through the SDK, any command | `apps/daemon/src/modules/sessions/sessions.int.test.ts`, `apps/daemon/src/modules/sessions/live-session.commands.test.ts`, `packages/pi-host/src/host.commands.int.test.ts` | green |
| P01-3 | Event stream and reconnect without loss | `apps/web/src/runtime/connection.resume.test.ts`, `apps/web/src/stores/session-reducer.test.ts`, `scripts/e2e/j05-reconnect.e2e.ts` | green |
| P01-4 | Transcript rendering: user, assistant, tool calls paired with their results, system and usage rows. | `apps/web/src/features/sessions/Transcript.test.tsx`, `apps/web/src/features/sessions/transcript.vm.test.ts`, `apps/web/src/features/sessions/ToolItemCard.test.tsx`, `apps/web/src/features/sessions/transcript.tools.test.ts` | green |
| P01-5 | Branching: in-session branch navigator, edit from an earlier message | `apps/web/src/features/sessions/BranchSwitcher.test.tsx`, `apps/web/src/features/sessions/branches.vm.test.ts`, `apps/daemon/src/modules/sessions/sessions.commands.int.test.ts`, `apps/daemon/src/modules/sessions/branch.test.ts` | green |
| P01-6 | Fork from an entry and clone the current branch on disk | `apps/daemon/src/modules/sessions/sessions.forks.int.test.ts`, `apps/daemon/src/modules/sessions/forks.test.ts`, `apps/daemon/src/modules/sessions/service.forks.test.ts` | green |
| P01-7 | Paged context loading of older rows | `apps/daemon/src/modules/sessions/branch.test.ts`, `apps/daemon/src/modules/sessions/sessions.transcript.int.test.ts`, `apps/daemon/src/modules/sessions/transcript.lazy.test.ts` | green |
| P01-8 | Compaction, with the summary row shown and the history kept | `packages/pi-host/src/session-commands.test.ts`, `apps/daemon/src/modules/sessions/sessions.commands.int.test.ts` | green |
| P01-9 | Export to HTML, served once as an attachment | `apps/daemon/src/modules/sessions/sessions.export.int.test.ts`, `apps/daemon/src/modules/sessions/export-http.test.ts`, `apps/daemon/src/modules/sessions/exports.test.ts` | green |
| P01-10 | Auto-name and rename | `packages/pi-host/src/auto-name.test.ts`, `apps/daemon/src/modules/sessions/sessions.commands.int.test.ts`, `apps/daemon/src/modules/sessions/live-session.names.test.ts` | green |
| P01-11 | Search over sessions (FTS5, spec A 5.2) | `apps/daemon/src/daemon.search.int.test.ts`, `apps/daemon/src/modules/search/query.test.ts`, `scripts/e2e/j12-search.e2e.ts` | green |
| P01-12 | Steering and follow-up queue | `apps/daemon/src/modules/sessions/live-session.queue.test.ts`, `apps/daemon/src/modules/sessions/sessions.queue.int.test.ts`, `apps/web/src/features/sessions/QueueStrip.test.tsx`, `apps/web/src/features/sessions/queue.vm.test.ts`, `packages/pi-host/src/prompt-queue.test.ts` | green |
| P01-13 | Abort with Esc | `apps/web/src/routes/shell/session-keys.test.tsx` | green |
| P01-14 | Drafts persisted locally, one per session | `apps/web/src/stores/drafts.test.ts` | green |
| P01-15 | Completion sound: a short tone when a run settles and the tab is hidden or unfocused, off by default (B7, owner q5, M13R21) | `apps/web/src/features/appearance/completion-sound.test.ts`, `apps/web/src/features/appearance/AppearancePanel.test.tsx`, `apps/web/src/features/sessions/SessionScreen.live.test.tsx` | green |
| P01-16 | Chat minimap | `apps/web/src/features/sessions/Minimap.test.tsx`, `apps/web/src/features/sessions/minimap.vm.test.ts`, `apps/web/src/features/sessions/Transcript.minimap.test.tsx` | green |
| P01-17 | Codemode card: script preview, nested calls, wall time, cleaned output. Owner 2026-10-18: build it in M13 (task C9). The controller flips this verdict to green, with C9's test as proof, when C9 merges | `apps/daemon/src/security/codemode-nested.int.test.ts` | after v1 (pending C9, owner 2026-10-18, M13R20) |

### D02 Sidebar and projects

| Row | pi-web behaviour | Proof | Verdict |
| --- | --- | --- | --- |
| P02-1 | Project groups by folder or repository | `apps/daemon/src/modules/projects/service.test.ts`, `apps/daemon/src/daemon.projects.int.test.ts`, `apps/web/src/features/projects/tree.vm.test.ts` | green |
| P02-2 | Custom project order (Move up and Move down in the menu, no drag and drop: M4R98) | `apps/web/src/features/projects/organise.test.ts`, `apps/web/src/features/projects/ProjectTree.test.tsx`, `apps/daemon/src/modules/projects/rpc.test.ts` | green |
| P02-3 | Pins section, at most 50, ordered by rank | `packages/contracts/src/marks.test.ts`, `apps/daemon/src/modules/sessions/service.marks.test.ts`, `apps/web/src/features/projects/tree.vm.test.ts` | green |
| P02-4 | Archive a session and Undo it, restoring the place among the pins | `apps/web/src/features/projects/organise.test.ts`, `apps/daemon/src/modules/sessions/service.marks.test.ts`, `apps/daemon/src/modules/sessions/sessions.marks.int.test.ts` | green |
| P02-5 | Large tree stays usable: 20 rows per project and Show more replace the virtualized list | `apps/web/src/features/projects/tree.vm.test.ts`, `apps/web/src/features/projects/ProjectTree.test.tsx` | green |
| P02-6 | UI state kept by the server with a revision per command (SQLite rows replace the JSON file, its lock and its corrupt backup: spec C) | `apps/daemon/src/modules/sessions/marks-store.test.ts`, `apps/daemon/src/kernel/db/migrate.test.ts`, `apps/daemon/src/kernel/db/receipts.test.ts`, `packages/contracts/src/shell.test.ts` | green |
| P02-7 | New session project and worktree picker | `apps/web/src/features/home/ProjectHome.picker.test.tsx`, `apps/web/src/features/lanes/NewLaneDialog.test.tsx`, `apps/web/src/features/lanes/new-lane.vm.test.ts` | green |
| P02-8 | Default dated working folder (~/pi-cwd/YYYYMMDD) | `docs/plans/2026-10-18-m13-v1-hardening.md` | after v1 (owner q7, M13R20) |
| P02-9 | Folder validation when a project is added | `apps/daemon/src/modules/sessions/cwd.test.ts`, `apps/daemon/src/modules/projects/service.add.test.ts`, `apps/web/src/features/projects/add-project.vm.test.ts`, `apps/web/src/features/projects/AddProjectDialog.test.tsx` | green |
| P02-10 | Settle and snooze a session (spec A 5.2) | `apps/daemon/src/modules/sessions/organiser.test.ts`, `apps/web/src/features/projects/snooze.test.ts`, `apps/web/src/features/projects/menus.test.tsx`, `apps/daemon/src/modules/sessions/sessions.marks.int.test.ts` | green |

### D03 Worktrees and lanes

| Row | pi-web behaviour | Proof | Verdict |
| --- | --- | --- | --- |
| P03-1 | Git worktrees: list, create, delete, project grouping | `apps/daemon/src/modules/worktrees/service.test.ts`, `apps/daemon/src/modules/worktrees/service.int.test.ts`, `apps/daemon/src/modules/worktrees/recover.int.test.ts` | green |
| P03-2 | Lane = branch + worktree + its sessions | `apps/daemon/src/modules/lanes/create.int.test.ts`, `apps/daemon/src/modules/lanes/store.test.ts`, `apps/daemon/src/modules/lanes/lanes.journey.int.test.ts`, `scripts/e2e/j03-lane-pr.e2e.ts` | green |
| P03-3 | .pi/project.yaml read only when the project is trusted | `apps/daemon/src/modules/lanes/project-config.test.ts`, `apps/daemon/src/modules/lanes/trust-inherit.test.ts`, `apps/daemon/src/modules/lanes/lanes.trust.int.test.ts` | green |
| P03-4 | Setup and archive scripts, waitForSetup, script log | `apps/daemon/src/modules/lanes/scripts.int.test.ts`, `apps/daemon/src/modules/lanes/scripts.test.ts`, `apps/daemon/src/modules/lanes/create.setup.test.ts`, `apps/daemon/src/modules/lanes/run-script.test.ts`, `apps/daemon/src/modules/lanes/script-log.test.ts` | green |
| P03-5 | Copy and link gitignored files into a lane | `apps/daemon/src/modules/lanes/copy-link.test.ts`, `apps/daemon/src/modules/lanes/copy-link.int.test.ts`, `apps/daemon/src/modules/lanes/copy-link.deny.test.ts` | green |
| P03-6 | Derived lane status (setup, needs attention, working, in review, done, idle) from the lane facts | `packages/contracts/src/lane-status.test.ts`, `apps/daemon/src/modules/lanes/facts.test.ts`, `apps/web/src/features/lanes/lane-header.vm.test.ts` | green |
| P03-7 | Commit, push and pull request through the forge CLI | `apps/daemon/src/modules/lanes/commit.int.test.ts`, `apps/daemon/src/modules/lanes/push.int.test.ts`, `apps/daemon/src/modules/lanes/pr.int.test.ts`, `scripts/e2e/j03-lane-pr.e2e.ts` | green |
| P03-8 | Trailers Pi-Lane and Pi-Session on lane commits | `apps/daemon/src/modules/lanes/commit.test.ts`, `apps/daemon/src/modules/lanes/commit.int.test.ts` | green |
| P03-9 | Archive order: dirty check, archive script, remove the worktree | `apps/daemon/src/modules/lanes/archive.test.ts`, `apps/daemon/src/modules/lanes/archive.int.test.ts`, `apps/daemon/src/modules/lanes/archive.recover.int.test.ts`, `apps/web/src/features/lanes/ArchiveDialog.test.tsx` | green |
| P03-10 | lane_note tool | `apps/daemon/src/modules/lanes/note.test.ts` | green |
| P03-11 | Hardened git execution: no shell, hooks off except commit and push | `apps/daemon/src/kernel/git/exec.test.ts`, `apps/daemon/src/kernel/git/exec.int.test.ts`, `apps/daemon/src/kernel/git/allowlist-lanes.test.ts`, `apps/daemon/src/security/lanes-hostile.int.test.ts`, `apps/daemon/src/security/lanes-repo-config.int.test.ts` | green |
| P03-12 | Per-turn checkpoints on hidden refs | `apps/daemon/src/modules/lanes/checkpoints.test.ts`, `apps/daemon/src/kernel/git/checkpoint.int.test.ts`, `apps/daemon/src/modules/lanes/checkpoints.race.int.test.ts` | green |
| P03-13 | Turn diff against branch diff | `apps/daemon/src/kernel/git/turn-range.test.ts`, `apps/daemon/src/modules/lanes/view.test.ts`, `apps/daemon/src/modules/lanes/stream.test.ts` | green |
| P03-14 | Restore files to a checkpoint and undo the restore | `apps/daemon/src/modules/lanes/restore.int.test.ts`, `apps/daemon/src/modules/lanes/restore.undo.int.test.ts`, `apps/web/src/features/lanes/CheckpointBanner.test.tsx` | green |
| P03-15 | Review: seen files, line comments, send a batch to the composer or a new session | `apps/daemon/src/modules/lanes/review.test.ts`, `apps/daemon/src/modules/lanes/review.int.test.ts`, `apps/web/src/features/lanes/ReviewPane.comments.test.tsx`, `apps/web/src/features/lanes/review-batch.test.ts` | green |
| P03-16 | Commit message suggestion | `apps/daemon/src/modules/lanes/suggest.test.ts`, `apps/daemon/src/modules/lanes/suggest.int.test.ts`, `packages/pi-host/src/suggest-commit.test.ts` | green |
| P03-17 | Fan-out: one prompt over N lanes, compare, close the losers (spec A 5.2) | `apps/daemon/src/modules/lanes/fanout.int.test.ts`, `apps/daemon/src/modules/lanes/compare.test.ts`, `apps/daemon/src/modules/lanes/close-losers.test.ts`, `apps/web/src/features/lanes/CompareScreen.test.tsx` | green |
| P03-18 | Issue to lane for GitHub issues (spec A 5.2) | `apps/daemon/src/modules/lanes/issue.int.test.ts`, `apps/daemon/src/modules/lanes/issue.test.ts`, `apps/daemon/src/modules/lanes/issue-prompt.test.ts`, `apps/web/src/features/lanes/issue-url.test.ts` | green |
| P03-19 | Forges beyond GitHub (GitLab, Gitea) and Linear issues: GitHub only, a GitLab or Gitea URL answers unsupported_url (owner m9q5, M9R107) | `apps/daemon/src/kernel/forge/port.test.ts`, `apps/daemon/src/kernel/forge/remote.test.ts` | after v1 (owner m9q5, M9R107) |
| P03-20 | Lane archive Undo: the archive removes the worktree, nothing is left to restore (owner q6) | `docs/plans/2026-10-18-m13-v1-hardening.md` | after v1 (owner q6, M13R20) |

### D04 Files

| Row | pi-web behaviour | Proof | Verdict |
| --- | --- | --- | --- |
| P04-1 | File explorer tree with git-ignore visibility | `apps/web/src/features/files/Explorer.test.tsx`, `apps/daemon/src/modules/files/list.test.ts`, `apps/daemon/src/modules/files/service.test.ts` | green |
| P04-2 | Viewer tabs | `apps/web/src/features/files/ViewerTabs.test.tsx`, `apps/web/src/features/files/FilesPane.tabs.test.tsx` | green |
| P04-3 | Download, preview and metadata of a file | `apps/daemon/src/modules/files/raw-http.test.ts`, `apps/daemon/src/modules/files/read.test.ts`, `apps/web/src/features/files/FileViewer.test.tsx` | green |
| P04-4 | Watch a file: pap has no file watcher, a 15 s status poll and Refresh replace it (ADR 0032) | `apps/daemon/src/modules/vcs/poller.test.ts`, `apps/web/src/features/vcs/use-refresh.test.tsx` | green |
| P04-5 | Uploads and chat drag and drop (folders marked) | `apps/daemon/src/modules/files/upload-http.test.ts`, `apps/daemon/src/modules/files/attachments-store.test.ts`, `apps/web/src/features/sessions/composer/drop.test.ts`, `apps/web/src/features/sessions/composer/use-attachments.test.tsx` | green |
| P04-6 | @-mention file index | `apps/daemon/src/modules/files/rank.test.ts`, `apps/daemon/src/modules/files/search-index.test.ts`, `apps/web/src/features/sessions/composer/use-mentions.test.tsx`, `apps/web/src/features/sessions/Composer.files.test.tsx` | green |
| P04-7 | File access allowlist as the security boundary | `apps/daemon/src/kernel/fs/boundary.test.ts`, `apps/daemon/src/kernel/fs/boundary.hostile.test.ts`, `apps/daemon/src/security/files-traversal.int.test.ts`, `apps/daemon/src/security/files-protected.int.test.ts`, `apps/daemon/src/security/files-origin.int.test.ts` | green |
| P04-8 | In-app file editing with CodeMirror 6 (spec A 5.2), save with a base etag | `packages/ui/src/code/CodeEditor.test.tsx`, `apps/web/src/features/files/FilesPane.edit.test.tsx`, `apps/daemon/src/modules/files/write.test.ts`, `scripts/e2e/j11-files-terminal.e2e.ts` | green |
| P04-9 | Linked-directory allow-link (owner q7) | `docs/plans/2026-10-18-m13-v1-hardening.md` | after v1 (owner q7, M13R20) |
| P04-10 | Open in the OS file manager (dropped, M8R97) | `docs/research/m8-rulings.md` | dropped (owner m8q8, M8R97) |

### D05 Git changes

| Row | pi-web behaviour | Proof | Verdict |
| --- | --- | --- | --- |
| P05-1 | Changed files and per-file diff for a folder | `apps/daemon/src/modules/vcs/vcs.int.test.ts`, `apps/daemon/src/modules/vcs/diff.test.ts`, `apps/daemon/src/modules/vcs/status.test.ts`, `apps/web/src/features/vcs/ChangesPane.test.tsx` | green |

### D06 Terminal

| Row | pi-web behaviour | Proof | Verdict |
| --- | --- | --- | --- |
| P06-1 | PTY terminal sessions, resize and kill | `apps/daemon/src/modules/terminal/terminal.real.int.test.ts`, `apps/daemon/src/modules/terminal/terminal.int.test.ts`, `apps/daemon/src/kernel/pty/spawn.int.test.ts`, `apps/daemon/src/modules/terminal/service.test.ts` | green |
| P06-2 | xterm tabs and the stream, replay after a reconnect | `apps/web/src/features/terminal/TerminalPane.test.tsx`, `apps/daemon/src/modules/terminal/terminal.reconnect.int.test.ts`, `apps/daemon/src/modules/terminal/ring.test.ts`, `scripts/e2e/j11-files-terminal.e2e.ts` | green |
| P06-3 | What a shell inherits from the daemon (boundary) | `apps/daemon/src/security/terminal-boundary.int.test.ts`, `apps/daemon/src/modules/terminal/terminal.umask.int.test.ts` | green |

### D11 Subagents

| Row | pi-web behaviour | Proof | Verdict |
| --- | --- | --- | --- |
| P11-1 | Subagent toggle and maxConcurrent | `apps/daemon/src/modules/subagents/index.test.ts`, `apps/daemon/src/modules/settings/service.agents.test.ts`, `apps/web/src/features/agents/SubagentsSettings.test.tsx`, `apps/daemon/src/modules/subagents/service.refusals.test.ts` | green |
| P11-2 | Agent profiles editor | `apps/daemon/src/modules/subagents/profiles.test.ts`, `apps/daemon/src/modules/subagents/profiles.int.test.ts`, `packages/pi-host/src/helper/ops/agent-profiles.test.ts`, `packages/pi-host/src/host.agent-profiles.int.test.ts` | green |
| P11-3 | Run status of children in the parent and the tree | `apps/web/src/features/sessions/SubagentBar.test.tsx`, `apps/web/src/features/projects/tree.vm.subagents.test.ts`, `packages/contracts/src/streams.children.test.ts`, `apps/daemon/src/modules/subagents/subagents.int.test.ts` | green |
| P11-4 | Child answer returned to the parent, child approvals surfaced in the parent | `apps/daemon/src/modules/subagents/subagents.int.test.ts`, `apps/daemon/src/modules/sessions/children.test.ts`, `apps/web/src/features/sessions/dialogs/ApprovalCardFor.host.test.tsx` | green |
| P11-5 | Stop on the parent cancels the children, cost rolls up | `apps/daemon/src/security/subagents-stop.int.test.ts`, `apps/daemon/src/modules/subagents/service.stop.test.ts`, `scripts/e2e/j08-subagents.e2e.ts` | green |

### D12 Long-term agents

| Row | pi-web behaviour | Proof | Verdict |
| --- | --- | --- | --- |
| P12-1 | Agent registry: profile, avatar, home folder, delete | `apps/daemon/src/modules/agents/service.test.ts`, `apps/daemon/src/modules/agents/store.test.ts`, `apps/daemon/src/modules/agents/homes.test.ts`, `apps/daemon/src/modules/agents/service.delete.test.ts`, `apps/web/src/features/agents/AgentForm.test.tsx`, `apps/web/src/features/agents/NewAgentDialog.test.tsx` | green |
| P12-2 | Pinned trusted thread with its re-snapshot rule | `apps/daemon/src/modules/agents/threads.test.ts`, `apps/daemon/src/modules/agents/thread-link.test.ts`, `apps/daemon/src/modules/agents/agent-sessions.int.test.ts`, `apps/daemon/src/modules/sessions/agent-gate.test.ts` | green |
| P12-3 | Unread marker and the rail with badges | `apps/daemon/src/modules/agents/unread.test.ts`, `apps/daemon/src/modules/agents/rail-state.test.ts`, `apps/web/src/features/agents/rail.vm.test.ts`, `apps/web/src/routes/shell/AgentRail.test.tsx` | green |
| P12-4 | Agent inbox rows | `apps/daemon/src/modules/inbox/service.agent.test.ts`, `apps/daemon/src/modules/inbox/agent-items.test.ts`, `apps/web/src/features/inbox/AgentInboxRow.test.tsx` | green |
| P12-5 | Navigate to an agent from the palette and the shell | `apps/web/src/routes/shell/palette-items.agents.test.ts`, `apps/web/src/routes/shell/item-title.agents.test.ts`, `apps/web/src/routes/shell/MobileShell.agents.test.tsx` | green |
| P12-6 | agent.notify (push or Inbox) | `apps/daemon/src/modules/agents/ops-notify.test.ts`, `apps/daemon/src/modules/platform/dispatch.test.ts` | green |
| P12-7 | agent.approve (confirm) | `apps/daemon/src/modules/agents/ops-approve.test.ts`, `apps/web/src/features/agents/RequestCards.test.tsx`, `apps/daemon/src/security/platform-ops.int.test.ts` | green |
| P12-8 | agent.delegate (queue a task for an opted-in agent) | `apps/daemon/src/modules/agents/ops-delegate.test.ts`, `apps/daemon/src/modules/agents/ops-delegate.back.test.ts`, `apps/daemon/src/security/agent-delegate.int.test.ts` | green |
| P12-9 | agent.remind (one-shot reminder) | `apps/daemon/src/modules/agents/ops-remind.test.ts` | green |
| P12-10 | @Name task mention from the composer | `apps/web/src/features/sessions/Composer.handoff.test.tsx`, `apps/web/src/features/sessions/composer/use-mentions.handoff.test.tsx`, `apps/web/src/features/agents/hand-off.test.ts` | green |
| P12-11 | Thread reset | `apps/daemon/src/modules/agents/threads.test.ts`, `packages/contracts/src/agents-thread.test.ts` | green |
| P12-12 | Quarantine: pause, cancel, archive, rotate secrets | `apps/daemon/src/modules/agents/quarantine.test.ts`, `apps/daemon/src/modules/agents/quarantine.int.test.ts`, `apps/daemon/src/security/agent-quarantine.int.test.ts`, `apps/web/src/features/agents/QuarantineDialog.test.tsx` | green |
| P12-13 | Prompt chips from the agent's prompts folder | `apps/daemon/src/modules/agents/prompts.test.ts`, `apps/web/src/features/agents/PromptChips.test.tsx` | green |
| P12-14 | MEMORY.md in an agent home that is a git repository, recent memory in the status panel | `apps/daemon/src/modules/agents/homes.test.ts`, `apps/daemon/src/modules/agents/agents.int.test.ts`, `apps/web/src/features/agents/RecentMemory.test.tsx` | green |
| P12-15 | Permissions sheet and lethal-trifecta check | `apps/daemon/src/modules/agents/permissions.test.ts`, `apps/web/src/features/agents/PermissionsSheet.test.tsx`, `packages/contracts/src/agents.safety.test.ts` | green |
| P12-16 | Usage per agent | `apps/daemon/src/modules/runs/agent-spend.test.ts`, `apps/web/src/features/agents/StatusPanel.test.tsx`, `apps/web/src/features/agents/status.vm.test.ts` | green |
| P12-17 | Pending requests strip | `apps/web/src/features/agents/PendingStrip.test.tsx`, `apps/daemon/src/modules/agents/requests.test.ts` | green |
| P12-18 | Conversation view: cards between rows by time | `apps/web/src/features/agents/thread-items.vm.test.ts`, `apps/web/src/features/agents/EventCard.test.tsx`, `apps/web/src/features/agents/AgentScreen.test.tsx`, `scripts/e2e/j07-agents.e2e.ts` | green |
| P12-19 | Visit digest on opening an agent (owner q7) | `docs/plans/2026-10-18-m13-v1-hardening.md` | after v1 (owner q7, M13R20) |

### D13 Automation

| Row | pi-web behaviour | Proof | Verdict |
| --- | --- | --- | --- |
| P13-1 | Task store: immutable terminal states, claim, recovery after a crash | `apps/daemon/src/modules/automation/store.test.ts`, `apps/daemon/src/modules/automation/runner.boot.test.ts`, `apps/daemon/src/security/automation-crash.int.test.ts` | green |
| P13-2 | FIFO runner: slots, one deadline, steer and cancel | `apps/daemon/src/modules/automation/admit.test.ts`, `apps/daemon/src/modules/automation/runner.test.ts`, `apps/daemon/src/modules/automation/runner.cancel.test.ts`, `apps/daemon/src/modules/automation/automation.runner.int.test.ts` | green |
| P13-3 | Scheduled triggers (RRULE, missed fires, catch-up) | `apps/daemon/src/modules/automation/scheduler.test.ts`, `apps/daemon/src/modules/automation/scheduler.catchup.test.ts`, `packages/contracts/src/rrule.test.ts`, `apps/daemon/src/modules/automation/due-timer.test.ts` | green |
| P13-4 | Webhook triggers: secret header, throttle, size cap | `apps/daemon/src/modules/automation/hook-auth.test.ts`, `apps/daemon/src/modules/automation/hook-rate.test.ts`, `apps/daemon/src/modules/automation/hooks-http.test.ts`, `apps/daemon/src/security/webhook.int.test.ts`, `scripts/e2e/j04-webhook-inbox.e2e.ts` | green |
| P13-5 | Alertmanager and Grafana payload mapping, dedup | `apps/daemon/src/modules/automation/payload.test.ts`, `apps/daemon/src/modules/automation/hooks-http.mapping.test.ts` | green |
| P13-6 | RSS and Atom feeds | `apps/daemon/src/modules/automation/feed-parse.test.ts`, `apps/daemon/src/modules/automation/feed-poll.test.ts`, `apps/daemon/src/modules/automation/feed-fetch.int.test.ts`, `apps/daemon/src/modules/automation/net-guard.test.ts` | green |
| P13-7 | Dry-run | `apps/daemon/src/modules/automation/dry-run.test.ts`, `apps/web/src/features/automation/DryRunPanel.test.tsx` | green |
| P13-8 | Manual fire | `apps/daemon/src/modules/automation/manual.test.ts`, `apps/daemon/src/modules/automation/rpc.fire.test.ts` | green |
| P13-9 | Fire journal | `apps/daemon/src/modules/automation/journal.test.ts`, `apps/daemon/src/modules/automation/hook-journal.test.ts`, `apps/web/src/features/automation/FireJournal.test.tsx` | green |
| P13-10 | Run guard: identical calls, tool-call and turn caps | `packages/pi-host/src/policy/run-guard.test.ts`, `packages/pi-host/src/host.guard.int.test.ts`, `apps/daemon/src/modules/automation/runner.limits.test.ts` | green |
| P13-11 | Daily token and cost budget, per owner and per agent | `apps/daemon/src/modules/automation/gates.test.ts`, `apps/daemon/src/modules/automation/agent-budget.test.ts`, `apps/daemon/src/security/agent-budget.int.test.ts`, `apps/daemon/src/modules/runs/limits.test.ts` | green |
| P13-12 | Quiet hours and the digest push | `apps/daemon/src/modules/push/delivery/quiet.test.ts`, `apps/daemon/src/modules/push/delivery/digest.test.ts`, `apps/daemon/src/daemon.push.quiet.int.test.ts` | green |
| P13-13 | Pause | `apps/daemon/src/modules/automation/gates.test.ts`, `apps/daemon/src/modules/automation/manual.test.ts` | green |
| P13-14 | Free-memory floor before a worker starts | `apps/daemon/src/kernel/config.test.ts`, `apps/daemon/src/modules/sessions/service.test.ts` | green |
| P13-15 | Health gauges: tasks, effects, event loop | `apps/daemon/src/modules/automation/metrics.test.ts`, `apps/daemon/src/kernel/observability/sampler.test.ts`, `apps/daemon/src/kernel/observability/stall.test.ts` | green |
| P13-16 | Precheck gate on triggers (spec A 5.2) | `apps/daemon/src/modules/automation/precheck.test.ts`, `apps/daemon/src/modules/automation/precheck.int.test.ts`, `apps/daemon/src/modules/automation/precheck.sandbox.int.test.ts`, `apps/daemon/src/modules/automation/precheck.env.test.ts` | green |
| P13-17 | Auto-resume when a provider quota resets (spec A 5.2) | `apps/daemon/src/modules/runs/resume.test.ts`, `apps/daemon/src/modules/runs/resume.int.test.ts`, `apps/daemon/src/daemon.push.resume.int.test.ts` | green |
| P13-18 | Inbox and the tasks board | `apps/daemon/src/modules/inbox/service.test.ts`, `apps/web/src/features/inbox/InboxPanel.test.tsx`, `apps/web/src/features/automation/TasksBoard.test.tsx`, `scripts/e2e/j14-automation.e2e.ts` | green |
| P13-19 | Inbox digest row (owner q9) | `docs/plans/2026-10-18-m13-v1-hardening.md` | after v1 (owner q9, M13R20) |

### D14 Memory

| Row | pi-web behaviour | Proof | Verdict |
| --- | --- | --- | --- |
| P14-1 | pi-mem0 scopes: user, project, agent snapshot | `apps/daemon/src/modules/memory/snapshots.test.ts`, `apps/daemon/src/modules/memory/service.test.ts`, `apps/daemon/src/modules/memory/mem0-files.test.ts` | green |
| P14-2 | Staged-memory approval queue | `apps/daemon/src/modules/memory/review.test.ts`, `apps/web/src/features/memory/ReviewList.test.tsx`, `apps/daemon/src/security/memory-trust.int.test.ts`, `scripts/e2e/j09-memory.e2e.ts` | green |
| P14-3 | Forget, promote and correct through save and forget requests | `apps/daemon/src/modules/memory/mem0-files.test.ts`, `apps/daemon/src/modules/memory/service.partial.test.ts`, `apps/web/src/features/memory/MemorySettings.test.tsx` | green |

### D15 Security

| Row | pi-web behaviour | Proof | Verdict |
| --- | --- | --- | --- |
| P15-1 | Web password with throttling | `apps/daemon/src/modules/auth/passwords.test.ts`, `apps/daemon/src/modules/auth/throttle.test.ts`, `apps/daemon/src/modules/auth/http.int.test.ts`, `scripts/e2e/j01-setup.e2e.ts` | green |
| P15-2 | Project trust | `apps/daemon/src/modules/trust/service.test.ts`, `apps/daemon/src/daemon.trust.int.test.ts`, `apps/web/src/features/trust/TrustDialog.test.tsx`, `packages/pi-host/src/helper/ops/trust.test.ts` | green |
| P15-3 | Approval policy: default auto-accept edits, ask for exec, network and external writes | `packages/pi-host/src/policy/decide.matrix.test.ts`, `apps/daemon/src/modules/policy/session-service.test.ts`, `apps/web/src/features/policy/ApprovalsPanel.test.tsx`, `scripts/e2e/j02-approval.e2e.ts` | green |
| P15-4 | Bubblewrap sandbox with an optional network | `apps/daemon/src/security/sandbox.int.test.ts`, `apps/daemon/src/security/sandbox.escape.int.test.ts`, `apps/daemon/src/kernel/sandbox/probe.test.ts`, `apps/daemon/src/modules/agents/sandbox.test.ts` | green |
| P15-5 | Egress host allowlist | `apps/daemon/src/modules/egress/proxy.connect.test.ts`, `apps/daemon/src/modules/egress/host.egress.int.test.ts`, `apps/daemon/src/security/agent-egress.int.test.ts`, `packages/pi-host/src/policy/egress.allowlist.test.ts` | green |
| P15-6 | Command denylist | `packages/pi-host/src/policy/denylist.test.ts`, `packages/pi-host/src/policy/denylist.bypass.test.ts`, `packages/pi-host/src/policy/denylist.hostile.test.ts` | green |
| P15-7 | Secrets vault (0600, injected into the environment) | `apps/daemon/src/modules/secrets/vault-store.test.ts`, `apps/daemon/src/modules/secrets/vault.int.test.ts`, `apps/daemon/src/security/vault-leaks.int.test.ts` | green |
| P15-8 | Secret redaction in tool results and streams | `packages/pi-host/src/policy/redact.test.ts`, `packages/pi-host/src/policy/results.test.ts`, `packages/pi-host/src/redact-stream.test.ts`, `packages/pi-host/src/redacting-ipc.test.ts` | green |
| P15-9 | Audit journal with redacted arguments | `apps/daemon/src/modules/audit/service.test.ts`, `packages/pi-host/src/policy/audit-args.test.ts`, `apps/daemon/src/security/audit-stages.int.test.ts`, `apps/web/src/features/policy/AuditLog.test.tsx` | green |
| P15-10 | Untrusted-content fencing | `packages/pi-host/src/policy/fence.test.ts`, `packages/contracts/src/fence.test.ts`, `apps/web/src/features/sessions/MessageRow.fence.test.tsx` | green |
| P15-11 | MCP and other child processes get a sanitized environment | `apps/daemon/src/kernel/child-env.test.ts`, `packages/contracts/src/child-env.test.ts`, `apps/daemon/src/security/mcp-taint.int.test.ts` | green |
| P15-12 | secret.request with one-use references (spec A 5.2) | `apps/daemon/src/modules/secrets/secret-request.int.test.ts`, `apps/daemon/src/modules/secrets/requests.test.ts`, `apps/daemon/src/modules/secrets/refs.test.ts`, `apps/web/src/features/inbox/SecretDialog.test.tsx` | green |
| P15-13 | Dynamic taint rule (spec A 5.2) | `packages/pi-host/src/policy/taint.test.ts`, `apps/daemon/src/security/taint.int.test.ts`, `apps/daemon/src/daemon.outside-taint.int.test.ts` | green |
| P15-14 | Passkeys, devices and tokens | `apps/daemon/src/modules/auth/passkey-ceremony.test.ts`, `apps/daemon/src/modules/auth/devices.test.ts`, `apps/daemon/src/modules/auth/tokens.test.ts`, `apps/web/src/features/auth/TokensPanel.test.tsx` | green |

### D16 FinOps and observability

| Row | pi-web behaviour | Proof | Verdict |
| --- | --- | --- | --- |
| P16-1 | Run registry with tokens, provider cost and API-equivalent cost | `apps/daemon/src/modules/runs/store.test.ts`, `apps/daemon/src/modules/runs/service.test.ts`, `apps/daemon/src/modules/runs/export-jsonl.test.ts`, `packages/contracts/src/usage.test.ts` | green |
| P16-2 | Log rotation of the trace and run files | `apps/daemon/src/kernel/observability/rotating-file.test.ts`, `apps/daemon/src/kernel/observability/tracer.test.ts` | green |
| P16-3 | Prometheus /metrics, token-gated | `apps/daemon/src/modules/runs/metrics.test.ts`, `apps/daemon/src/modules/runs/metrics-auth.test.ts`, `apps/daemon/src/security/metrics.int.test.ts`, `apps/daemon/src/kernel/observability/prometheus.test.ts` | green |
| P16-4 | OTLP export, opt-in | `apps/daemon/src/kernel/observability/otlp.test.ts`, `apps/daemon/src/kernel/observability/otlp.int.test.ts` | green |
| P16-5 | Spending panel and budgets in the browser | `apps/web/src/features/usage/SpendingPanel.test.tsx`, `apps/web/src/features/usage/spending.vm.test.ts`, `apps/daemon/src/modules/runs/usage-rpc.test.ts` | green |
| P16-6 | Trace summary command | `apps/daemon/src/cli/trace-summary.test.ts`, `apps/daemon/src/cli/trace-summary.int.test.ts` | green |
| P16-7 | Loki and Grafana guide: no such guide exists in `docs/agents/finops.md` (owner 2026-10-18) | `docs/agents/finops.md` | after v1 (owner 2026-10-18, M13R20) |
| P16-8 | Plannotator link detection (owner q7) | `docs/plans/2026-10-18-m13-v1-hardening.md` | after v1 (owner q7, M13R20) |

### D17 Notifications

| Row | pi-web behaviour | Proof | Verdict |
| --- | --- | --- | --- |
| P17-1 | Web Push (VAPID), self-hosted | `apps/daemon/src/modules/push/transport/vapid.test.ts`, `apps/daemon/src/modules/push/transport/sender.test.ts`, `apps/daemon/src/modules/push/transport/service.test.ts`, `apps/daemon/src/daemon.push.e2e.int.test.ts`, `scripts/e2e/j13-push.e2e.ts` | green |
| P17-2 | Needs-input push after 60 s unattended | `apps/daemon/src/modules/push/delivery/source-sessions.test.ts`, `apps/daemon/src/daemon.push.sessions.int.test.ts` | green |
| P17-3 | Budget-reached push, once a day | `apps/daemon/src/modules/push/delivery/source-budget.test.ts`, `apps/daemon/src/daemon.push.budget.int.test.ts` | green |
| P17-4 | Quiet-hours digest | `apps/daemon/src/modules/push/delivery/digest.test.ts`, `apps/daemon/src/modules/push/delivery/quiet.test.ts` | green |
| P17-5 | Service worker: show, click, shell cache, update | `apps/web/sw/sw.push.test.ts`, `apps/web/sw/sw.fetch.test.ts`, `apps/web/sw/sw.update.test.ts`, `apps/web/src/features/pwa/sw-register.test.ts` | green |
| P17-6 | Notification settings and the landing page | `apps/web/src/features/notifications/NotificationsPanel.test.tsx`, `apps/web/src/features/notifications/Landing.test.tsx`, `apps/web/src/features/notifications/push-client.test.ts` | green |
| P17-7 | Completion sound (see P01) | `apps/web/src/features/appearance/completion-sound.test.ts` | green |

### D18 Extension UI

| Row | pi-web behaviour | Proof | Verdict |
| --- | --- | --- | --- |
| P18-1 | Dialog queue: select, confirm, input, editor | `apps/daemon/src/modules/sessions/dialogs.test.ts`, `apps/web/src/features/sessions/dialogs/DialogList.test.tsx`, `apps/web/src/features/sessions/dialogs/InlineEdit.test.tsx`, `apps/web/src/features/sessions/SessionScreen.dialogs.test.tsx`, `packages/pi-host/src/ui-bridge.test.ts` | green |
| P18-2 | Custom panels | `packages/pi-host/src/custom-panels.test.ts`, `packages/pi-host/src/host.panels.int.test.ts`, `apps/daemon/src/modules/sessions/panels.test.ts`, `apps/web/src/features/sessions/CustomPanel.test.tsx` | green |
| P18-3 | Status bar with command: buttons | `packages/ui/src/ai/StatusBar.test.tsx`, `apps/web/src/features/sessions/SessionScreen.extension.test.tsx`, `packages/pi-host/src/ui-bridge.test.ts` | green |
| P18-4 | Widgets and extension decorations | `packages/pi-host/src/widget-components.test.ts`, `packages/ui/src/extensions.test.ts`, `apps/daemon/src/modules/sessions/sessions.d18.int.test.ts` | green |

### D19 Mobile and PWA

| Row | pi-web behaviour | Proof | Verdict |
| --- | --- | --- | --- |
| P19-1 | Safari and iOS 16.4 floor, pinned | `apps/web/src/browser-floor.test.ts` | green |
| P19-2 | Viewport and mobile keyboard handling | `apps/web/src/routes/shell/use-viewport-height.test.ts`, `apps/web/src/routes/shell/MobileShell.phone.test.tsx` | green |
| P19-3 | Bottom sheets | `packages/ui/src/primitives/Dialog.test.tsx`, `packages/ui/src/primitives/Popover.test.tsx`, `apps/web/src/routes/shell/MobileShell.home.test.tsx` | green |
| P19-4 | 44 px touch targets | `apps/web/src/routes/shell/MobileShell.conformance.test.tsx`, `packages/ui/src/primitives/Button.test.tsx` | green |
| P19-5 | Installable PWA: manifest, icons, standalone frame | `apps/web/src/pwa-assets.test.ts`, `apps/web/src/routes/shell/AppShell.pwa.test.tsx`, `scripts/e2e/j06-mobile.e2e.ts` | green |
| P19-6 | iOS status-bar style stays default (owner q10) | `apps/web/src/pwa-assets.test.ts` | green |

### D20 Settings and design system

| Row | pi-web behaviour | Proof | Verdict |
| --- | --- | --- | --- |
| P20-1 | Settings panels: Models, MCP, Skills, Plugins, Agents, Memory, Tools | `apps/web/src/routes/settings/SettingsScreen.test.tsx`, `apps/web/src/routes/settings/sections.test.tsx`, `apps/web/src/routes/settings/settings-catalog.test.ts`, `scripts/e2e/j15-settings.e2e.ts` | green |
| P20-2 | Stacked dialogs and Escape | `packages/ui/src/primitives/Dialog.test.tsx` | green |
| P20-3 | Design system: themes (Night, Day), tokens, contrast, density | `packages/ui/src/tokens.test.ts`, `apps/web/src/features/appearance/derive.test.ts`, `apps/web/src/features/appearance/contrast.test.ts`, `apps/web/src/features/appearance/AppearancePanel.test.tsx`, `scripts/token-classes.test.ts` | green |
| P20-4 | Reduced motion | `packages/ui/src/tokens.test.ts`, `apps/web/src/features/sessions/Minimap.test.tsx` | green |
| P20-5 | /dev/ui gallery | `apps/web/src/gallery/Gallery.test.tsx`, `apps/web/src/gallery/register-gallery-catalog.test.ts` | green |
| P20-6 | Shortcuts: Esc, Ctrl+Alt+N, Alt+Up and Down, Ctrl+Alt+1 to 9, and the keybindings editor | `apps/web/src/features/commands/keys.test.ts`, `apps/web/src/features/commands/resolve.test.ts`, `apps/web/src/features/commands/defaults.test.ts`, `apps/web/src/routes/shell/AgentRail.test.tsx`, `apps/web/src/features/commands/ShortcutsHelp.test.tsx`, `apps/web/src/features/commands/editor/ShortcutsEditor.test.tsx`, `apps/web/src/routes/shell/session-keys.test.tsx` | green |
| P20-7 | Command palette | `apps/web/src/features/commands/palette/CommandPalette.test.tsx`, `apps/web/src/features/commands/palette/rank.test.ts`, `apps/web/src/routes/shell/palette-search.test.tsx` | green |

### D21 Install and update

| Row | pi-web behaviour | Proof | Verdict |
| --- | --- | --- | --- |
| P21-1 | Install channels: checkout script, offline archive, npm package, image | `scripts/install.test.ts`, `scripts/archive-install.test.ts`, `scripts/build-npm.test.ts`, `scripts/container.test.ts`, `scripts/smoke-install.test.ts` | green |
| P21-2 | systemd user service install | `apps/daemon/src/cli/service/service.int.test.ts`, `apps/daemon/src/cli/service/unit.test.ts`, `apps/daemon/src/cli/service/systemd.test.ts` | green |
| P21-3 | Update check, apply, automatic rollback and recover | `apps/daemon/src/update-check.test.ts`, `apps/daemon/src/cli/update/check.test.ts`, `apps/daemon/src/cli/update/apply.int.test.ts`, `apps/daemon/src/cli/update/rollback.int.test.ts` | green |
| P21-4 | Backup, restore and doctor | `apps/daemon/src/cli/backup.int.test.ts`, `apps/daemon/src/cli/backup/restore.int.test.ts`, `apps/daemon/src/cli/doctor.int.test.ts` | green |
| P21-5 | Internationalisation, English and French | `apps/web/src/i18n/i18n.test.tsx`, `apps/web/src/i18n/catalog-keys.test.ts`, `apps/web/src/i18n/catalog/vous-register.test.ts`, `scripts/literal-coverage.test.ts` | green |
| P21-6 | Release gates: version, licence, shrinkwrap, assets | `scripts/release-check.test.ts`, `scripts/release-assets.test.ts`, `scripts/npm-shrinkwrap.test.ts` | green |

### D22 Lanes backport

| Row | pi-web behaviour | Proof | Verdict |
| --- | --- | --- | --- |
| P22-1 | Lanes backport: lots A and B are in scope and shipped as D03 | `apps/daemon/src/modules/lanes/lanes.journey.int.test.ts`, `scripts/e2e/j03-lane-pr.e2e.ts`, `scripts/smoke-lanes.ts` | green |

D07 to D10: see `docs/agents/models.md`, section Parity.
