# Final review: an agent's files in the explorer

Range `ae24cbd3..74f5753d` (7 commits), worktree `/home/ubuntu/Workspace/soulkyu/pap-agent-files`, branch `feat/agent-files`.
Spec `docs/specs/2026-10-26-agent-files-explorer-design.md`, plan `docs/plans/2026-10-26-agent-files-explorer.md` (R1-R5), ledger `progress.md`.
I read the code and did not run anything: every claim below comes from the code.

## Strengths

- **Prefix swap without leaks.** `box-backend.ts` turns the pap path into the guest path at each call (`guestPath`). `read` rewrites `meta.path` to the pap form, and `write` and `upload` build their meta from the pap path. Directory entries carry names and a link class (`inside`/`outside`/`broken`), never a target. No response or log line carries `/agent` or the process root. The `JSON.stringify(read)` check in `agent-backend.test.ts` pins this.
- **R2 is enforced twice and proven.**
  - `matchAgent` runs before the box and host match for list, read, write, search and upload, and `openRaw` refuses `underAgents`.
  - `agent-backend.test.ts` mocks `node:fs/promises` with a call counter and shows zero host calls for six odd spellings across all six entry points.
  - Spellings that `underAgents` misses (`//agents`, `/./agents`) fail the host's `canonical()` before any file-system call.
- **The token, foreign-agent and unknown-id refusals give nothing away.** A token is refused in `matchAgent` before any guest call. A foreign id and an unknown id both answer `not_found`. A member who names another user's agent gets `forbidden` from the gate in both cases, so a member cannot tell existence either.
- **The member gate is narrow.** After the T2 fix it applies only to the `files.*` RPCs and the files HTTP routes (`dispatcher.ts`, `httpCaller(..., "files")`). Every other `ClientPath` method still refuses an agent path for a member (`agent-gate.test.ts`).
- **The guest is a second line of defence.**
  - `.pi` and `lost+found` are refused for any spelling (`segmentsOf` plus a catch that answers `not_found`).
  - The search walk leaves them out at the source (the `git ls-files` exclude pathspec and the `rg --glob !/name`), not only in a filter after the cap.
  - The project-only ops answer `not_found`.
  - The `main.ts` switch is safe: `githubDeps` is set exactly when `layout.project` is.
- **Production wiring matches the int test.**
  - Kata's `layoutOf("kata").root` is `/agent`, and the guest's `KATA_LAYOUT.root` is the same.
  - `createBoxOps(runtime, clock, "agent")` is built once in `compose-boxes-wiring.ts`.
  - `ownerOf` is bound (`daemon.ts:255`) before `listen` (`daemon.ts:368`). Until then every agent is nobody's, so every request is `not_found`: the code fails closed.
  - `agents.startBox` is bound through `bindVm` before the server listens.
  - The int test goes through `createDaemon` on the process backend, the same composition with a different backend.
- **Starting the VM never comes from browsing.**
  - `BoxOps.call` answers `box_stopped` when the thread VM is not running, and never touches or starts it (`box-ops.test.ts`, "createBoxOps for agents").
  - The Files tab has no subscription and no timer.
  - `agents.openThread` starts no worker.
- **`agents.startBox` mirrors `box-control`.**
  - The launch registry runs the steps, two calls share one in-flight start, and the launch ends on every way out.
  - It rechecks the agent after the image wait.
  - Its refusals are `BOX_LIFE_ERRORS`. It has an m14 probe, and a token gets `forbidden`.
  - The int test spies on `launches.open` and `runtime.start` for the second START.
- **Version skew (R4) holds in practice.** A boot `stopAll` means a stale guest is never running under a new daemon. START then goes through the bundle-skew gate, and the person reads the agent copy for `vm_bundle_stale` ("Run `sudo pap vm setup`…"), not a raw error.
- **The web gives every declared code its own words.** `agentBoxFailure` covers every declared code of `agents.startBox` in EN and FR. `stopped` is silent, as for a project. The `CODE_COPY_KEYS` entries are registered.
- **Repo rules hold.**
  - `daemon.ts` is at exactly 400 lines, and every changed code file is under 400.
  - There are no ESLint directives, and module imports stay within kernel, `index.ts` and contracts.
  - pi-host imports `@pap/contracts/pi-host` only, and the commits carry no AI attribution.

## Issues

### Critical

None.

### Important

**I1. START is a silent no-op while only an isolated task VM of the agent runs.**
- **Where:** `apps/daemon/src/modules/agent-vm/agent-start.ts:46` returns early on `deps.runtime.phase(box) === "running"`.
- **Cause:**
  - `runtime.phase()` (`runtime.ts:293-296`) answers with the thread VM's phase, and falls back to `mine[0]`, which can be an isolated task VM of the same `{kind:"agent", id}` box.
  - `BoxOps.call` asks `runtime.link(box)`, which looks only at the thread key, and so still answers `box_stopped`.
- **Scenario:** a cron agent's isolated trigger task is running, which is the spec's own "digest" case.
  1. The person opens Files and sees "VM stopped".
  2. They press START. `agents.startBox` returns `ok` with no launch and no VM.
  3. With no launch, `useIsLaunching` never flips, so nothing lists again. The panel stays "VM stopped" with START enabled, and every click does the same nothing until the task ends.
- **Same gap on the web:** after START resolves `ok` without a launch (VM already running, stale panel), `use-box-action.ts:29-43` and `BoxStopped.tsx` never list again until a window focus.
- **Fix:**
  - Test the thread VM itself, for example `runtime.link(box) !== undefined`, or a thread-only phase.
  - Have the agent's stopped panel list again after a successful START.
  - Add a unit test with a running isolated VM and no thread VM.

**I2. The hidden-credential set is "what pap holds now", not "what sits in the VM home". A removed credential's content shows in the explorer.**
- **Where:**
  - `compose-agents-vm-rpc.ts:120` builds `importedOf` from `agentFiles.list(agentId)` only.
  - `agentFiles.remove` deletes the host copy at once.
  - Removing the file from the VM home waits for the next worker (`pendingRemovals`). A VM started by `agents.startBox`, or an idle VM, has none.
- **Scenario:**
  1. The owner presses Remove on `.kube/config`, for example while rotating a leaked kubeconfig.
  2. The credentials table drops it, and its hint still says "Content is never shown here".
  3. The explorer above now lists `home/.kube/config`, and opening it shows the kubeconfig. This is the spec's first anti-goal ("a secret on screen") and breaks the Goal "their content is never shown".
- **Same root cause, two more cases:**
  - After a plain `pap backup` and `pap restore`, `secrets/` is empty. Every credential already in a VM home is then visible (`agents-vm.md` "Backup" says such files stay there).
  - `walk()` (`agent-files.ts:101-106`) swallows read errors and returns `[]`, so the hidden set fails open.
- **Fix:**
  - Hide `list ∪ pendingRemovals(agentId)`.
  - Refuse the request when the import folder cannot be read, instead of hiding nothing.
  - Document the restore case as a known limit, in `agents-vm.md` "Files" and `files.md`.

**I3. Unsaved edits in the agent's explorer are lost silently. The guard the spec names ("the unsaved-edits guard behave as in a project") is not wired for the agent tab.**
- **Where:**
  - `AgentScreen.tsx:151-154`: `openTab` switches Files to Thread or Settings with no check, and the Files subtree unmounts (`AgentScreen.tsx:256-268`). `useBuffers` is local state, so the drafts are dropped.
  - `routes/shell/tab-actions.ts:34-36`: `mayDiscard` asks only for workspace items of `kind === "files"`, so closing the agent tab never asks either. `FilesPane` does call `setUnsavedFiles("/agents/<id>", true)`, but nothing reads it for an agent item.
- **Scenario:** the person edits `knowledge/index.md` in the Files tab, then clicks Thread to ask the agent about it. The edit is gone with no prompt. In a project, Files is its own pane, often split beside the session, so this switch rarely happens. Here Files and Thread exclude each other, which makes this the common path.
- **Fix:** do one of these:
  - keep the Files subtree mounted (hidden) across the inner tabs;
  - ask with `files.edit.discardPane` when `hasUnsavedFiles(\`/agents/${id}\`)`.

  Either way, extend `mayDiscard` to agent items.

### Minor

- **M1. The agent START still says "box".** `BoxStart.tsx:36,45` uses `boxes.stage` ("Starting the box…" / « Démarrage de la box… ») as the stage label and as the status line after 3 s, beside the "VM stopped" copy. Add an agent key.
- **M2. The agent copy is off for two cases.**
  - `boxes.agentError.not_found` says "This agent no longer exists… pick another agent". It is also what an agent with an unreadable profile gets (`agentOf` returns null when `input === null`, `compose-agents-vm.ts`).
  - `boxes.agentError.agent_paused` says "Resume the agent from its screen". A quarantined agent is resumed from its Settings tab, and the header's Resume is disabled for it.
- **M3. The docs drift from the code.**
  - `docs/agents/web.md:273` says "the failure words are `boxFailure`'s". They are `agentBoxFailure`'s since 74f5753d.
  - `agents-vm.md` lists "the gate's `sandbox_unavailable`, `vm_bundle_stale` and `disk_low`". `capacity` (the memory cap, from `runtime-start.ts`) also applies, and `disk_low` comes from pap-vmd, not from the gate.
  - The credentials hint "writes each file into the home at every VM start" is no longer true for a VM started by START. Its files arrive with the first worker.
- **M4. A member gets `forbidden`, not the spec's `not_found`, for another user's agent.** This is through the transport (`client-path-gate.ts:34`), for RPC and for `/files/raw`. The service answers `not_found`, but the gate answers first. Unknown ids get the same answer, so nothing leaks: this is a spec deviation only. Plan Review Focus 4 reads "not_found", and the unit test bypasses the gate.
- **M5. The guest's root filter is an exact string compare.** `packages/pi-host/src/guest/ops/agent.ts:29` filters `.pi` and `lost+found` only when `op.path === root`. An `fs.list` of `${root}/` would show the two names (not their content). The daemon never sends that, so only defence in depth is affected. Compare with `segmentsOf(root, op.path).length === 0`.
- **M6. `createAgentStart` checks the account only in the gate.** It does not check `account_disabled` again right before `runtime.start`, unlike `guardedLaunch`. Disabling a member while their START waits on an image build can let the VM start, and only the disable's own stop then removes it.

## Declined to judge

- **Bundle budgets.** I did not re-run `pnpm build` or `pnpm budgets`. `agent-pane-entry.tsx` now imports `FilesPaneEntry` statically. That should stay in the lazy agent chunk, but I did not measure it.
- **Kata itself.** I could not check the real `/agent` disk contents, the guest as run under Kata, or whether `rg` is in the agent image (the `fs.search` fallback outside git). Running the kata project is forbidden here, and the web does not call `files.search`.
- **Visual layout.** I did not check the explorer and credentials split (`max-h-1/2`, padding around `FilesPane`) or the phone stacking: there is no browser on this host.
- **Upload.** `FilesPane` has no upload UI in projects either, so this predates the branch. Upload works at the API and route level only.
- **Permission.** The files routes check `files:*`, not `agents:admin` as spec §4.1 says. Every browser role holds both today, and tokens are refused outright, so no person sees a difference.
- **Idle resets.** A window focus and every launch end list again with `call`, which resets the idle timer. The spec says a list uses `call`, so I did not count this.

## Verdict

**Ready after fixes.** The three Important issues need fixing first. I2 is the security one, and it costs a few lines (add the pending removals and fail closed). I1 and I3 are functional and cost a few lines each.
