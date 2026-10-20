# Agents in microVMs, sub-project 1: final review (archived 2026-10-20)

The Opus whole-branch review (range b1eb34af..2ce84594), then the Opus re-verification of the final fix dispatch (2ce84594..4ee38008). The residual round (4ee38008..f2ec3699) was checked by the controller and by GitHub CI on PR #7.

## Final review

## Final whole-branch review: agents in microVMs, sub-project 1

Reviewer: Opus, read-only. Range `b1eb34af..2ce84594` (130 commits). Worktree `.worktrees/feat-avm1`.

How I worked, in passes (the diff is too large for one read):
1. The security boundary, end to end: contracts (`agents-vm.ts`, `socket-frames.ts`, `vmd.ts`, `agents-net.ts`, `relay-ipc.ts`), the daemon's `agent-vm` module (gateway, guest link, VM worker, tokens, runtime, kata backend, vmd client, relay link, listener owner, mirror inputs and paths, trash, kata images), the sessions seams (`vm-launch`, `vm-gate`, `vm-rules`, `vm-init`, `agent-surface`, `service-launch`, dialogs), pap-vmd (`server`, `ops*`, `argv`, `net`, `state`, `locks`, `safe-tree`, `dockerfile`, `exec`, `netns-sweep`), the guest (`main`, `scrub`, `guest`), the VM shell (`argv`, `ops`, `tool`), the VM file judge (`vm-paths`, `vm-stage`, `kernel-path`), the relay (`server`, `routes`, `keys`, `policy`, `headers`, `relay-key`).
2. Root surface: `cli/vm/{setup,uninstall,assets,real-deps,configs,units}.ts`, `scripts/release-vm-assets.ts`, `release.yml`, `release-please-config.json`.
3. Integration: sessions and the mirror readers, policy and taint, agents module (delete, quarantine, purge, pause, crash pause), web (form, status, trash, token, approval card), doctor, config, composition order in `daemon.ts`, host mode.
4. Repo rules, mechanically (`wc -l`, `rg`).
5. Docs truth against the code; plus the GitHub CI run the branch last pushed (`39433703865`, head `08cc7163`) and the diff since.

Read whole: spec, global constraints (R1-R38), `progress.md`, the S2 brief and its "Not in S2" list, the topic note, ADR 0078, the risk-checks record. Owner decisions AVM-E53, AVM-E61, AVM-E66 are taken as final.

### Strengths

- **The root boundary is narrow and honest.** pap-vmd takes one schema-checked request per connection on a 0600 socket owned by pap's uid (`server.ts`), builds every argv itself with no shell and a fixed environment (`exec.ts`, `argv.ts`), renders the Dockerfile outside the context (`dockerfile.ts`), copies the user's build context with per-component `O_NOFOLLOW`, an owner check on every entry and byte/entry bounds (`safe-tree.ts`), keeps the gateway token out of every argv (R8 env file, removed in `finally`), and fails closed on an unknown container status (`ops-vm.ts:41-64`).
- **The network guard is real and was proven on the real stack.** The inet table answers 7841/7842 to `pap0` only and drops everything else from or forwarded to `pap0`; the bridge table pins `{port . mac . ip}` per VM, drops IPv6 and VM-to-VM (`agents-net.ts`). Port identity uses the interface index and a snapshot under the global start lock (AVM-E37), a VM that will not die blocks the next start (`retryUnremoved`), and `vm.start` refuses without the ruleset and bridge. T20a/T20b measured spoofing, routed legs and host reachability on KVM.
- **The gateway is bounded before trust.** 4 KiB until the hello, per-source and total pending caps, a byte window, constant-time token compare after an exact-shape check, one guest per launch for its lifetime, workers bound to slots the daemon asked for, ping liveness, power-of-two refusal logs (`gateway.ts`, `guest-link.ts`, `tokens.ts`).
- **Secrets stay out of the box.** R24's re-exec scrub plus a parked 0600 file and fd 3 for workers; the shell's environment is a fixed allowlist and `/run`, `/agent/.pi` and the worker's processes are out of its view (`vm-shell/argv.ts`); the relay key binds to the VM's address; no vault, one-use value or memory reaches a VM, checked at three layers (`vmInitOf`, `agent-surface`, pi-host dispatch).
- **Fail-closed wiring at the seams.** `vmBranchOf` refuses any disagreement between the row predicate and the gate; `setAgentPorts` and `vmPortsOf` stop the boot when a VM predicate is unwired; `vmInitOf` refuses host paths, always-rules and rules not composed for a VM; the boot stops every listed VM before any spawn and fails when pap-vmd is absent, naming `sudo pap vm setup`; host mode composes nothing.
- **The transcript mirror treats the VM as hostile.** Line checks, a byte scanner for the top-level id, an id index so open never parses the transcript, a parse thread for long lines, a quota, R14's kept copy with notice and taint, and the "not sent from pap" mark that survives snapshot clipping.
- **Repo rules hold mechanically.** No changed file over 400 lines (largest 397, a test); no ESLint block disable; no enum, namespace or parameter property; relative imports keep `.ts`; every new RPC method declares a permission; module imports stay within `@pap/contracts`, `kernel/` and other modules' `index.ts`; `apps/vmd` imports only contracts and Node built-ins; no raw colours or arbitrary values in the web diff.
- **Process.** Security test files name their mutants; real-stack measurements are recorded; every Opus-reviewed security task went through scoped re-reviews until clean.

### Issues

#### Critical (Must Fix)

**C1. pap-vmd's version is a constant that no release bumps, so every VM launch is refused after the next release, and the documented remedy cannot fix it.**
- Where: `apps/vmd/src/ops.ts:14` (`VMD_VERSION = "1.0.0"`), `apps/vmd/src/main.ts:46`; compared with pap's version at `apps/daemon/src/modules/agent-vm/status.ts:48` (launch gate, `agents.vmStatus`) and in `pap doctor` `vm.vmd`. `release-please-config.json:11` bumps only `package.json` and `apps/daemon/package.json`.
- Why it matters: the branch's `feat:` commits make release-please propose a new version. Once that release PR merges, pap reports e.g. `1.1.0` while every pap-vmd (release artefact or `--dev-from-tree`) reports `1.0.0`. `assessStack` then says "pap-vmd is at version 1.0.0, pap at 1.1.0: run `sudo pap vm setup`", every VM launch is refused `sandbox_unavailable`, and running setup reinstalls a pap-vmd that still says `1.0.0`. The version gate is also what R6 relies on to keep an old agent bundle off a new daemon, so it must carry the real release version, not a constant. The T13b review parked this as a duplication minor (M6); its user impact was missed.
- Fix: derive pap-vmd's version from a file the release bumps (read `apps/vmd/package.json` at start and add it to `extra-files`, or a version constant in contracts that release-please updates), and add a test that pins the two versions equal.

#### Important (Should Fix)

**I1. The test suite is red at HEAD: two integration tests fail deterministically, and three unit files fail on GitHub CI.**
- Where and what:
  - `apps/daemon/src/cli/doctor.int.test.ts:72-98` expects the doctor list without `vm.listeners` and `Array(7).fill("skip")`; the registry has eight VM checks since T20b (`cli/doctor/checks-vm.ts:259`). Failed in CI run 39433703865 (integration 1/4); neither file changed after it.
  - `packages/pi-host/src/host.vm.int.test.ts:205,207` expect "blocked this call: link."; since S1 the judge answers "outside this agent's folders" for a link leaving the folders (`policy/vm-paths.ts:135-145`). Failed in the same run (integration 3/4); neither file changed after.
  - `mirror-parse.test.ts`, `mirror.test.ts` ("a 12 MiB line ..."), `mirror.scan.test.ts` fail on the GitHub unit shards: the parse thread is a `Worker` whose `execArgv` replaces the parent's (`apps/daemon/src/modules/agent-vm/mirror-parse.ts:26-30`), and its module graph imports `@pap/contracts` (`mirror-line.ts:2`). Without `--conditions=development` that resolves to `packages/contracts/dist`, which the CI unit job never builds (`.github/workflows/ci.yml` unit job). The thread fails to load, every long line is refused `not_json`. Locally it passes only because a built `dist` exists. The same trap hits `pnpm --filter @pap/daemon dev` (it runs with `--conditions=development`, which the worker drops): with a missing or stale contracts `dist`, every transcript line over 1 MiB is refused and the VM worker is killed at the first pasted image.
- Why it matters: merging turns `main`'s CI red (the project's gate since M13), and the last full `test:int` ran at `a7111efc`, before T18, S1, T20a, T20b, T21 and S2; AVM-E61's pre-merge gate is the full `test:unit` only.
- Fix: update the two int expectations (add `vm.listeners`, eight skips; "outside this agent's folders" for c and e); make the thread hermetic (pass `--conditions=development` when the entry is `.ts`, or remove the contracts import from the thread's graph); then run the full clean-env `test:int` and a draft PR for GitHub CI before the merge.

**I2. Images are never pruned: each profile change and each weekly base rebuild leaves a full profile image behind, without bound.**
- Where: `image.prune` exists in pap-vmd (`apps/vmd/src/ops-image.ts:215-229`) but nothing in the daemon calls it (`rg 'image\.prune' apps/daemon` finds no caller). The profile tag follows the sanitised `settings.json`, `enabledModels` included (`modules/agent-vm/profile-allowlist.ts:24`), and the weekly base week (`policy.baseKey`); the profile layer is one `COPY` of the whole Pi profile (`dockerfile.ts`).
- Why it matters: the owner's package closure is large (`~/.pi/agent/npm` is 641 MB; `@anthropic-ai` alone 240 MB, copied because the bridge needs it), so every model toggle in Settings followed by an agent start, and every ISO week, adds a new profile layer of hundreds of MB to `/var/lib/pap-vm`, plus the same tree copied to `$PAP_HOME/vm/build/profile`. Spec §17 notes 11 GB free on this host. `vm.disk` does not count images, and the only documented way out is `pap vm uninstall --purge`, which also deletes every agent disk. The ledger never tracked a caller for prune.
- Fix: after a successful build (and on the weekly tick) call `image.prune` with `keep` = the current base tag, the newest profile and agent tags, and every tag a running VM uses (pap-vmd already skips images a container uses); count images in `vm.disk`; document it.

**I3. RT-22's second half is neither fixed nor documented: `sudo pap vm setup` runs pap's user-writable code, and its compiled pins, as root.**
- Where: `apps/daemon/src/cli/vm/setup.ts:216` runs from the user's install; the Kata, nerdctl and Node pins come from `cli/vm/assets.ts:141` (`vm-assets.json` in the same user-writable tree). Docs: `docs/agents/install.md:237`, `docs/agents/agents-vm.md:103` name only `--dev-from-tree` as the residual; ADR 0078 says setup installs "from pinned artefacts, R19".
- Why it matters: the red-team's RT-22 said "the `pap` that sudo runs is itself pap-user code. A compromised daemon user plants code once and gets root at the next setup", with the fix "the guide says to run setup from the downloaded release archive; document the residual if not". The docs tell the owner to rerun `sudo pap vm setup` after every `pap update`, so any compromise of pap's user (a malicious Pi package running in a host-mode worker or helper, for instance) becomes root at the next routine setup. The `--assets` root-ownership check (AVM-E35) gives no protection while the program and the other pins are user-writable. The owner reads the known limits to decide the security posture.
- Fix: at least add the residual to the known limits, install.md and ADR 0078, and tell the owner to run setup from a freshly downloaded, verified release archive. Cheap enforcement: setup refuses (without `--dev-from-tree`) unless its own entry, its `vm-assets.json` and the running Node are root-owned and not group/other-writable, the same rule `--assets` already applies.

**I4. Each cold VM start copies, scans and hashes the whole Pi profile synchronously on the daemon's event loop.**
- Where: `kata-images.ts:152-174` (`prepare`, called from `profileNow` whenever the last preparation is older than `PROFILE_TTL_MS` = 30 s, `kata-images.ts:15`) runs `prepareProfileContext` (`image-inputs.ts:312-381`): `copyFileSync` of the package closure, `scanTree` (`secret-scan.ts:86-99`: every 64 KiB chunk searched for every needle and its JSON-escaped form), then `treeDigest` reading every file again. `baseTagNow` hashes the whole agent bundle the same way once an hour (`kata-images.ts:114-124`).
- Why it matters: with the owner's profile (hundreds of MB, ~23k files under `npm/`) and tens of needles, this is likely several seconds, possibly tens of seconds, of a frozen daemon at almost every thread VM start after idle and every isolated task: every WebSocket, terminal, stream and RPC stalls meanwhile. AVM-E49 carried this (M10b) to T20a for a measurement; T20a's Kata bed uses a tiny probe package and no measurement was recorded, so the carry was dropped.
- Fix: measure with a real profile; run the preparation in a worker thread or child process (like the mirror's parse thread), and skip it when the inputs' sizes and mtimes did not change since the last preparation.

#### Minor (Nice to Have)

- **M1. Switching a VM agent back to host mode runs its thread on the mirror.** A VM row's `piPath` is its mirror; in host mode `service-launch.ts:168` passes it as `sessionFile`, so the host worker opens and appends to `$PAP_HOME/agents/.mirrors/<id>/<file>`. Back in VM mode, the VM's resend replaces the mirror, and the host-mode turns live only in the 7-day kept copy. R12's host-mode refusal went with T17. Fix: in host mode refuse a row with `mirrorFileOf(papHome, row) !== null` (`sandbox_unavailable`), or say in agents-vm.md not to switch a VM agent back to host.
- **M2. The VM-mode trash sweep is retroactive.** Host mode never purged `$PAP_HOME/agents/.trash`; `startTrashSweep` (`modules/agent-vm/trash.ts:84-117`, VM mode only) removes every `<id>-<stamp>` home and `.runs` entry older than 7 days at the first VM-mode boot, including homes deleted months earlier in host mode (and the homes the owner deletes per AVM-E53). Document it in "Existing agents: no migration", or sweep only entries stamped after VM mode was first used.
- **M3. "A launch waits for the relay to be ready" is not what the code does.** `agents-vm.md:51` says it waits; `compose-agents-vm-status.ts:67` refuses `sandbox_unavailable` at once. A launch in the seconds after boot (a scheduled task, the first message) fails. Wait on `relay.whenReady()` with a bound inside `guardedLaunch`, or fix the sentence.
- **M4. Two security residuals are missing from the known limits (`agents-vm.md:97-113`)** (Minor only because the ledger tracks both: seam note at `progress.md:166`, AVM-E39 I4). (a) The relay forwards request bodies and `anthropic-beta` verbatim (`relay/server.ts:248-290`, `relay/headers.ts:225-233`), so provider-side tools (Anthropic `mcp_servers` and web fetch, OpenAI Responses `web_search`/`mcp`) are an egress and spend path for code running in the worker; the ledger's seam note (line 166) plans it for the decisions log, but the topic note says a VM reaches "nothing else". (b) The relay's pause and budget gate rests on cost the VM worker reports; the relay's own counts are attribution only (log-only mismatch, AVM-E39 I4).
- **M5. `disk.populate` is root surface with no caller since AVM-E53.** `apps/vmd/src/ops.ts:103`, `ops-disk.ts:167-193`, the `VmdRequest` variant in `contracts/src/vmd.ts`: it copies `$PAP_HOME/vm/staging/<id>` and runs `mkfs.ext4 -d` as root. Remove it (smaller root API), or record it as a later sub-project's seam.
- **M6. Thin-handler rule.** `agents.vm.setClaudeToken` / `clearClaudeToken` do the step-up, the store write and the audit row in the handler (`modules/agent-vm/rpc.ts:21-34`); `models.setApiKey` does it in its service. Move it into one service call.
- **M7. A literal U+202E in source:** `apps/daemon/src/modules/sessions/vm-attachments.test.ts:175` (global constraint: numeric code points only, `String.fromCharCode` in tests).
- **M8. Undeclared error code.** `agents.purgeTrash` can throw `command_failed` (`modules/agents/trash-purge.ts:36`) but declares `step_up_required`, `not_found`, `sandbox_unavailable` (`agents-vm-methods.ts:95`).
- **M9. A plain restore silently drops every VM agent's package picks.** The plugin-id HMAC key is in `secrets/plugin-id.key` (`pi-host/src/helper/plugin-id.ts:39`), which a plain backup excludes; after a restore every id changes and `sourcesOf` drops them all with a log line only (`plugin-picks.ts:41-44`), so agents start without their packages, the bridge included. Post a notice when all picks drop, and mention it in `backup.md`.
- **M10. The archive ships `dist-agent` to every install** (`scripts/build-archive-stage.ts:127-129`): the archive went from ~94 MB to ~120 MB, downloaded by every `pap update`, host-mode users included, while only `--dev-from-tree` reads it (release installs get the bundle as its own artefact, AVM-E31). Consider leaving it out.
- **M11. Setup's `--home` defaults to `<user home>/.pap`** (`cli/vm/setup.ts:224`), not the unit's `PAP_HOME`; a mismatch makes every profile build `not_found` at pap-vmd with nothing in doctor saying why. Read the unit's `PAP_HOME` (doctor already parses the unit) or check it in `vm.vmd`.

### Recommendations

- Before the merge: fix C1 and I1, run the full clean-env `pnpm test:int` (it has not run since `a7111efc`) and push a draft PR so GitHub CI runs the unit and integration shards on HEAD.
- Before the owner relies on VM agents day to day: I2 and I4 (disk growth and daemon freezes both scale with the owner's real Pi profile, which the Kata bed does not exercise; one Kata run with a copy of the real profile would have shown both).
- Pending owner decision (AVM-E38/E35, not a finding): how a release install obtains a root-owned `vm-assets.json`. Today the compiled copy holds placeholders for pap-vmd and the bundle, so `sudo pap vm setup --user <name>` as documented refuses on any release install until `--assets` is given; install.md does not say where that file comes from.
- Process: AVM-E61's pre-merge gate (full `test:unit` only) let two deterministic integration failures and a CI-only unit failure through; add the full `test:int` and a CI run to the controller's merge step.

### Declined to judge

- Self-reported taint of VM workers gating platform ops at the box's exits: documented known limit, owned by sub-project 3.
- No migration of existing agents and R12's removal: owner decision AVM-E53 (M1 covers only the reverse switch).
- No CI Kata job, and the forward chain without an end-to-end test: owner decision AVM-E66, AVM-E68.
- The test scope of fix rounds: owner decision AVM-E61.
- OAuth providers through the relay (unverified, refused): T0b record, documented.
- The KVM, guest kernel and Cloud Hypervisor boundary itself, and Kata's `disable_guest_seccomp = true`: residual by design; T0a's suggestion 6 was not taken and is defence in depth inside the guest.
- R2's seven capabilities kept in the shell: the owner's page says the agent is root in its box.
- The relay-restart squatter window: documented residual of AVM-E49 M9b.
- MCP stdio servers and extension subprocesses outside bwrap and the file rule: RT-37 residual, sub-project 3.
- Search not indexing mirrors (RT-31) and the existence oracle by a race (AVM-E60): documented.
- Every VM agent may call any model of the owner's enabled list: spec §9 and R13 by design.
- The seccomp BPF itself: T11a's Opus review disassembled and pinned it against the syscall table; I did not re-derive it.
- Completeness of the profile secret scan (encoded values, short values, OAuth metadata): T14a and T15b deep reviews and the documented limits.
- pap-vmd resource exhaustion by a compromised daemon (a `vm.start` loop): the daemon's user owns that data and memory already; outside the spec.
- The parked test-hygiene minors, T9b UX items and T18 M1/M5 ("Not in S2"), and the sweep lines of the ledger: known and accepted; none found worse than parked except T13b M6, raised as C1.

### Assessment

**Ready to merge?** With fixes

**Reasoning:** The security boundary is well built and holds at every hop I traced (root API, network guard, gateway, token handling, file judge, mirror, relay), and host mode is untouched. But pap-vmd's constant version breaks every VM launch at the next release, the suite is red (two stale integration expectations, a non-hermetic parse thread that fails on GitHub CI), and image growth, event-loop stalls at VM starts and the undocumented `sudo pap vm setup` root residual need fixing or recording before the owner relies on it.

Counts: 1 Critical, 4 Important, 11 Minor.

## Re-verification of the final fix dispatch

## Final fix re-verify (AVM-E70), range 2ce84594..4ee38008

Reviewer: Opus, scoped and read-only. Worktree `.worktrees/feat-avm1`, HEAD `4ee38008`, tree clean before and after.

How I worked:
- Read the verdict, the brief, the report and `t-final/i4-measure.txt`, then the 14-commit diff by area: C1, I1, I2, I3 with M11, I4, M3, M5, M6, the docs, then the rest.
- Traced the code beyond the diff where the checks needed it: `image-policy.ts`, `kata-backend.ts`, pap-vmd `ops-image.ts` and `ops-vm.ts`, `vm-paths.ts`, `relay-link.ts`, `build-agent-bundle.ts`, `release-vm-assets.ts`, `unit-read.ts` and `ci.yml`.

Checks I ran myself, writing to the scratchpad only:
- **pap-vmd's built `version.js` against a broken package.json.** I copied it next to a missing, an unparsable and a version-less package.json:
  - each one fails at import and names the path (`ENOENT ... open '<dir>/package.json'`, `Invalid package config <path>`, `<path> has no version`);
  - none reports `undefined`.
- **The built profile thread.** I ran `apps/daemon/dist/modules/agent-vm/profile-runner.js` against a scratch profile. It answered `made` and then `unchanged`.
- **The development condition.** `import.meta.resolve("@pap/contracts")` from `apps/daemon`:
  - with `--conditions=development` it gives `packages/contracts/src/index.ts`;
  - without it, `dist/index.js`.
- **The focused unit files of the fix.** 16 files, 187 tests, all passed. Unlocked, as `implementer-common-main.md` allows for targeted runs.
- **Mechanical rules.** No changed file is over 400 lines (largest `image-inputs.ts`, 398). No `eslint-disable`. No bidi, zero-width, NBSP or BOM character in the 71 changed files.
- **Not re-run:** the full `test:int`, the kata tests and GitHub CI. The report's numbers stand unverified for those.

### Findings

| Item | Status | Evidence |
|---|---|---|
| C1 | ADDRESSED | `apps/vmd/src/version.ts:4-11`; `main.ts:11,47`; `release-please-config.json:11-14`; `scripts/release-check.ts` (the vmd line in `versions`); tests `apps/vmd/src/version.test.ts:25-45`, `release-check.test.ts` (9.9.4 case); the package.json ships, see below |
| I1 | ADDRESSED | `doctor.int.test.ts:94,99`; `host.vm.int.test.ts:205,207` against `policy/vm-paths.ts:79-89`; `mirror-parse.ts:26-38` |
| I2 | ADDRESSED, with a Minor race (N3) | `image-prune.ts:9-21`; `kata-images.ts:222-242,252,271,297,365`; `pick-map.ts` `held()` |
| I3 | ADDRESSED as the brief scoped it, with Minor gaps (N1, N2) | `cli/vm/trusted-code.ts:14-29`; `real-deps.ts:123-131`; `setup.ts:220`; docs `agents-vm.md:106`, `install.md:244`, ADR 0078 line 24 |
| I4 | ADDRESSED, with a Minor (N4) | `profile-runner.ts:20-37`; `profile-job.ts:33,45-67`; `profile-fingerprint.ts:13,21-58`; `kata-images.ts:161-204`; `t-final/i4-measure.txt` |
| M1 | ADDRESSED | `agents-vm.md:24` |
| M2 | ADDRESSED | `agents-vm.md:25` |
| M3 | ADDRESSED | `compose-agents-vm-status.ts:57,66-78,92`; `compose-agents-vm.ts:355-361`; `agents-vm.md:54` |
| M4 | ADDRESSED | `agents-vm.md:113-114` |
| M5 | ADDRESSED | contract variant, `populate`, `joinPopulate`, `stagingDir`, `mkfs -d` and the AVM-P19 kata case are gone; `rg` finds no caller; `vmd.test.ts:68-70` pins the refusal |
| M6 | ADDRESSED | `claude-token-service.ts` (step-up, store, audit row identical to before); `rpc.ts` is decode plus one call |
| M7 | ADDRESSED | `vm-attachments.test.ts:175` uses `String.fromCharCode(0x202e)` |
| M8 | ADDRESSED | `agents-vm-methods.ts:95` |
| M9 | ADDRESSED (doc only, as the brief allows) | `backup.md`, `agents-vm.md:116`; no notice, with the reason written down |
| M10 | NOT ADDRESSED (deferred) | Excluded by the brief; owner decision |
| M11 | ADDRESSED, with a Minor (N5) | `setup.ts:227-231`; `real-deps.ts:149-155`; `setup-home.test.ts` |
| S2 m1, m2, m3, m5, m6 | ADDRESSED | Only the diffs were read. One narrow residual in m1 is noted at the end. |

#### C1 in detail
- **A missing or unreadable package.json fails clearly.** `VMD_VERSION` is read when `version.ts` is imported. So a missing file, bad JSON or no `version` throws before `main.ts` listens (checked above).
  - pap-vmd then never opens its socket.
  - The daemon sees pap-vmd absent and refuses launches, naming `sudo pap vm setup`. It never sees "undefined".
- **The file ships, in the release and in `--dev-from-tree`.** Both build through `buildVmdFolder` (`scripts/release-vm-assets.ts:56-66`; `real-deps.ts:114` for dev).
  - Its `VMD_REQUIRED` lists `package.json` and `assertAgentBundle` refuses without it.
  - `finishAgentBundle` rewrites the file but keeps `version` and `type: module` (`build-agent-bundle.ts:84-95`).
- **The release-please config is valid.** `extra-files` with `{type: "json", path, jsonpath: "$.version"}` is the generic JSON updater, already used for `apps/daemon/package.json`. The path is relative to package `.`.
- **The versions are pinned together:**
  - `version.test.ts:43-45` checks vmd against the daemon;
  - `version.test.ts:25-36` checks that the module follows its own package.json (kills the hard-coded mutant);
  - `release-check` now compares all four version sources.

#### I1 in detail
- **The case c verdict matches the code.** `home/x` links to `sessions/new.jsonl`.
  - `kernelResolve` lands outside the folders, and that check (`vm-paths.ts:87`) comes before the leaf `link` verdict (`:89`).
  - So the answer is "outside this agent's folders".
- **The case e verdict matches too.** `ls dl` resolves to `layout.pi`, an ancestor of the read-only roots. It is not `within` any root, so the answer is again "outside".
- **The fix is hermetic.** `parseThreadExecArgv` adds `--conditions=development` for a `.ts` entry only, and contracts' `development` export points at `src`.
  - The new profile thread reuses the same helper (`profile-runner.ts:30`), so it is hermetic too.
  - The CI unit job never builds contracts (`ci.yml` unit job), so the thread tests depend on this.

#### I2 in detail
- **What is kept.** `keep` holds:
  - the current base;
  - the prepared profile;
  - the tags just built;
  - `latest` (each agent's newest wanted tag since boot);
  - the running thread VMs' tags;
  - every recorded image of agents not seen since boot.
- pap-vmd also skips any image a container uses, which covers running isolated task VMs.
- **Prune runs in two places,** both under `exclusive`, so never during a preparation or a build:
  - inside `buildLayers`, after a layer was built;
  - after the weekly base rebuild.
- **Errors are logged, never thrown into a launch.**
  - `prune` catches the client error and logs `agent_image_prune_failed`.
  - When the keep set is over 256 tags it logs `agent_image_prune_skipped` and prunes nothing.
  - `upgradeBaseIfDue` wraps all of it.
- **The race with a VM about to start.** In the common case the handed-out tag is safe while it waits for `nerdctl run`: it is in `latest`, or in `running` for `build-then-use`.
  - Two narrow interleavings can still drop it (N3).
  - The result would be a failed start ("image not found"), not unsafe behaviour.

#### I3 in detail
- **What is checked.** Four paths:
  - the realpath of `argv[1]` (links resolved);
  - its folder (`dist/`);
  - the realpath of `dist/cli/vm/vm-assets.json`, the file `assets.ts` imports;
  - the realpath of `process.execPath`.
- **How.** Each must be owned by uid 0 with no group or other write bit. `realpath` followed by `stat` is equivalent to `lstat` on the resolved path.
- **What is not checked:**
  - the ancestors above `dist/`;
  - `dist/cli/vm/`;
  - `node_modules`.
- **The check is a guardrail, not a boundary.** It runs inside code that is already loaded.
  - It cannot catch a tree that was swapped before the run.
  - Its value is refusing the honest run from a user-writable location. Ancestors matter for that (N1).
- **`--dev-from-tree` still works.** It skips the check (`setup.ts:220`), and the test passes a throwing `statCode` to prove the skip.
- **The refusal is clear.** It names every loose path and says "Run it from a release archive unpacked as root (--dev-from-tree is for testing only)".
- **An unreadable path is refused** with "cannot inspect <path>: refusing to run it as root".
  - A failing `realpath` inside `codePaths` throws a raw `ENOENT` instead, but it still fails closed.

#### I4 in detail
- **Thread errors and crashes cannot hang the launch.** A thread `error` or an `exit` without a message becomes a `failed` outcome.
  - `finish` is idempotent.
  - `outcomeOf` refuses any answer that is not an outcome.
  - A synchronous throw from `new Worker` rejects inside `prepare`, which logs `agent_profile_refused` and throws `config_invalid`.
  - So the launch fails closed.
- **The thread has no deadline.** This is a deliberate, written choice. The residual is N4.
- **Needles.** The secrets travel in `workerData` (structured clone, same process).
  - Nothing logs the job.
  - The outcome carries only a relative file name, a message or the made tree.
  - The salt is a sha256 over the sorted secrets, kept in memory only.
- **Does the skip ever bypass the scan? No, for what reaches an image.**
  - The unchanged path reuses the tree already in `out`, and that tree was scanned when it was copied (`image-inputs.ts:349` scans `out`; a refusal removes `out` at `:385`).
  - pap-vmd builds from that tree, not from the live profile.
  - A change to the known secrets, providers, home or base key changes the salt and forces a fresh preparation.
  - So a content change with the same size and mtime (`rsync -a`, `cp -p`, `tar -x`, an npm reinstall of a same-size file) leaves the VM on the older, scanned copy until another input changes. That is freshness, not exposure.
- **The 2 s settle window is sound.** `nowMs` is taken before the copy and the fingerprint after it, so any write during the preparation stays untrusted.
  - The margin covers the coarse kernel clock.
  - Only a filesystem whose clock is skewed by more than 2 s (NFS) defeats it, and then again only freshness is at stake.
- **Measured** (from the report): about 5 s cold on the event loop before, 0 ms loop lag now, about 0.3 s when nothing changed. That is plausible from the code.

#### M3, M5, M6 in detail
- **M3: the wait is bounded and cleans up.** The timer is created synchronously and cleared in `finally`, and the gate re-checks `ready()` after the race. A launch holds whatever the session reserved for at most 30 s. The relay waiters are flushed on ready and on stop, with a small leak (N6).
- **M5: nothing is left behind.** No caller, contract variant or kata case remains; `copyTreeSafely` stays for `image.build`.
  - No data migration is involved. An existing `/var/lib/pap-vm/staging` stays empty and harmless; `--purge` removes it.
- **M6: the handler is thin.** Step-up comes first, then the store, then the audit row `{ ownerId, actor: "user", kind: "auth", reason }`, the same as before. The handler decodes and makes one call; typed errors pass through.

### New issues

Counts: Critical 0, Important 0, Minor 7 (plus nits).

- **N1 (Minor, I3): the check does not walk ancestors.** A root-owned unpack inside a user-owned folder passes, e.g. `sudo tar -x` run in `~/Downloads`. pap's user can then rename or swap that folder before a later `sudo .../pap vm setup`.
  - `node_modules` and the `dist/` subfolders are covered only by the "unpacked as root" convention.
  - `agents-vm.md:106` overstates ("a compromise of pap's user cannot plant code"); `install.md:244` says "somewhere root-owned" but nothing enforces it.
  - Fix: require each checked path's ancestors, up to `/`, to be root-owned and not group- or other-writable (include `dist/cli/vm/`), and tighten the wording.
- **N2 (Minor, I3 scope): `sudo pap vm uninstall` is not checked.** It runs the same user-writable program as root, and the known limit names setup only. Add the same check or one doc line.
- **N3 (Minor, I2): two interleavings can prune a tag a launch is about to start.** The window is between `resolve` returning and pap-vmd's `nerdctl run` (disk prep, the global start queue).
  - (a) A concurrent resolve of the same agent with changed inputs replaces `latest[agent]`, and its build and prune finish first.
  - (b) An isolated launch gets `use = running.tag` (`image-policy.ts:89-97`), the thread VM stops (`running` deleted), and `buildBehind`'s prune runs before the isolated container exists.
  - Effect: the start fails with "image not found"; no safety impact.
  - Fix: a "starting" multiset of tags, added in `resolve` and released by the backend's start result, added to `keep`.
- **N4 (Minor, I4): the profile thread has no deadline.** A hung filesystem read in the thread holds `exclusive` (every later preparation, build and prune) and every VM launch that needs one, until restart, with no log line.
  - It is better than the old freeze of the whole daemon.
  - A generous deadline (minutes) with `thread.terminate()` and a `failed` outcome would bound it.
- **N5 (Minor, M11): root reads the user's unit file unsafely.** `readUserUnit` reads `~<user>/.config/systemd/user/pap.service` as root with `readFileSync` (`real-deps.ts:151`): it follows links and checks neither file type nor size.
  - pap's user can make setup hang (a FIFO) or exhaust memory (a link to `/dev/zero`). This is a DoS of an interactive root CLI, not an escalation: setup only writes `papHome` into `config.json`, and pap-vmd's owner check still applies.
  - Fix: use `openNoFollow`, a regular-file check and a size bound, as `--assets` does.
  - Also: a unit with `EnvironmentFile=`, or one not named `pap.service`, silently falls back to `~/.pap`, and setup does not print the home it chose.
- **N6 (Minor, M3): relay waiters can leak.** Each launch's `relay.whenReady()` adds a waiter (`relay-link.ts:254`) that is flushed only when the relay becomes ready or stops. While a foreign holder keeps the relay from ever becoming ready, each refused launch leaves one closure behind.
- **N7 (Minor, test gap): the built thread path is untested.** `profileThreadEntry`'s `.js` mapping has no unit test (the mirror's twin has one at `mirror-parse.test.ts:165-170`). The kata bed runs from sources, so no test runs the built thread. I ran the built one by hand and it works today.
- **Nits (not counted):**
  - `apps/vmd/src/locks.test.ts:8` still names `joinPopulate`.
  - `apps/vmd/src/ops-disk.ts:20` keeps an orphaned doc comment ("The most a home can be...") above `type AgentDisk`.
  - `agents-vm.md:115` has a grammar slip ("is shown ... and are not kept").
- **Observation (S2 m1, not counted): a narrow race remains on a damaged key.** Two helpers can judge the same damaged inode. One removes it and links key A; the other's identity check ran earlier, so it removes key A and links key B, while the first keeps key A. This needs a damaged key and two concurrent first runs.

### Merge verdict

**With fixes, and none of them blocks the merge.** C1 is closed for real: the version follows a file the release bumps, the file ships, a broken install fails loud, and a test pins vmd to the daemon. I1 is fixed and hermetic. I2, I3 and I4 do what the brief asked. M1 to M9 and M11 are done; M10 was deferred by the owner. No Critical or Important issue was introduced.

The seven Minors can go to the ledger, or into one small follow-up:
- N1 and N5 are cheap and improve the root path;
- N3 and N4 harden launches.

Before the merge, as the final verdict recommended and the report does not show: push a draft PR so GitHub CI runs the unit and integration shards on `4ee38008`.
