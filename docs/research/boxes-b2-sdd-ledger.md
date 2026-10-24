# SDD ledger — plan: docs/plans/2026-10-24-boxes-b2.md

Spec: docs/specs/2026-10-24-boxes-b2-design.md (decision 126; owner: "Les reco ont été toute appliqué go" = plan + execution approved). Programme: docs/specs/2026-10-23-boxes-design.md.
Worktrees: join /home/ubuntu/Workspace/soulkyu/pap-boxes-b2 (feat/boxes-b2); lanes from S1's head: pap-boxes-b2-a (feat/boxes-b2-a), pap-boxes-b2-b (feat/boxes-b2-b).
Models: Sonnet implementers and task reviews; one Opus final review (J3). Briefs: brief.sh <ID>. Another Claude session (health events, worktree pap-health-events) runs in parallel: shared heavy-gate lock only.

## Preflight scan

| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| S1 → all | ops, timeouts, pty frames, hello role, github views/methods, fake GitHub | names used consistently by A1–A4, B1–B4 |
| A1 ↔ A2 | pty frames, terminal hello | same lane, sequential |
| A3 ↔ B3/B4 | guest op semantics (clone into empty project, commit null when clean, push current branch, prCreate URL parse, identity returns publicKey) | both from S1 schemas; J1 journeys prove the pair |
| A4 ↔ B1–B4 | web consumes github-methods (S1) with mocks | contracts only; J1 wires |
| A2 ↔ lot B1 | BoxControl.start, boxCwdOf, runtime link | merged in main |
| B3 ↔ lot B1 | projects make(), onPhase, BoxOps.call | merged in main |
| J1 | PAP_TEST_GITHUB_ORIGIN config + guard | Ruling R1 |
| protocol | AGENT_VM_PROTOCOL 2→3 | Ruling R2 |

Ruling R1: lane tests inject the fake GitHub origin directly into the module/guest under test; J1 adds the `PAP_TEST_GITHUB_ORIGIN` config var with its guard (needs PAP_TEST_PROVIDER_SCRIPT) and the process backend's pass-through — keeps config.ts (353) edits in one place — cost if wrong: two tasks touch config.
Ruling R2: S1 bumps AGENT_VM_PROTOCOL to 3 once (new hello role + ops); lanes never bump it again — one protocol change per lot — cost if wrong: none.

## Progress
S1: dispatched (BASE fc2cdc22, join worktree, implementer a69d025e1cf70c715)
S1: implemented dd3afc5d (DONE_WITH_CONCERNS: GITHUB_BROWSER_ONLY set (no defineMethod marker); github.identity param displayName; GithubIssueView; GitRemoteUrl accepts http://127.0.0.1 and file:// (daemon/guest must refuse outside test mode); box-bound methods declare command_failed; stubs: gateway refuses terminal hello, guest ignores pty_open, compose-github answers github_unavailable; protocol 3)
Ruling R3: `settings:admin` becomes never-for-tokens (it now grants the GitHub App creation/deletion; nothing else used it) like sessions:admin in B1 — cost if wrong: a token cannot change settings (none could before).
S1: review: spec ✅, quality needs fixes (I: settings:admin token-grantable (R3); I: fake serve() unhandled rejections / non-idempotent fork); fix round 1 dispatched (FIX_BASE dd3afc5d) + Branch hardening + query in calls; lane B carry: build clone URLs only from RepoFullName + fixed origin, test origin only under PAP_TEST_GITHUB_ORIGIN+PAP_TEST_PROVIDER_SCRIPT; enforce GITHUB_BROWSER_ONLY for token callers
S1: fix round 1/5 (3 addressed, 0 open; commits dd3afc5d..d27c0029)
Task S1: minor (deferred): fake mint checks names not levels; Date.now in expires_at; list endpoints ignore pagination; tautological browser-only test
Task S1: complete (commits fc2cdc22..d27c0029, review clean)
A1: dispatched (BASE d27c0029, lane a, implementer adb906e516dd776c1)
B1: dispatched (BASE d27c0029, lane b, implementer a1a2c79a0bf351ebd)
B1: implemented a4ceef9d (DONE_WITH_CONCERNS: vault names GITHUB_USER_TOKEN/GITHUB_REFRESH_TOKEN + GITHUB_TOKEN_META json; own guarded client; owner-secrets extra dep wired in compose-agents-vm-secrets.ts; testing/bed.ts)
A1: implemented 2d9aaf6c (DONE_WITH_CONCERNS: pty_ack = cumulative bytes; refused pty_open reported as `exited {slot, code 1, tail}` on the guest link; node-pty 1.1.0 added to pi-host deps, lockfile hand-edited (frozen install accepts); image build not run)
Carry to A2: send cumulative acks; treat an `exited` for a pty slot before its terminal hello as a failed open (terminal_unavailable or the guest's reason).
Carry to A3: Debian /etc/profile resets PATH for root login shells → install the gh wrapper as /usr/local/bin/gh (Dockerfile symlink or copy) and the credential helper by absolute path, not via PATH tweaks.
Task B1: minor (deferred): a transient refresh error persists reconnect (user-tokens.ts:101); three vault writes not atomic; lost answer after rotation drops the pair; states cap evicts across users; secrets test doesn't scan thrown messages; install cache not cleared on mint failure; client `test` flag uncoupled (J1 couples it to PAP_TEST_GITHUB_ORIGIN + PAP_TEST_PROVIDER_SCRIPT)
Ruling R4: vault names are GITHUB_USER_TOKEN / GITHUB_REFRESH_TOKEN / GITHUB_TOKEN_META (isVaultName forces capitals; plan said github.user_token) — cost if wrong: names only.
Task B1: complete (commits d27c0029..a4ceef9d, review clean)
B2: dispatched (BASE a4ceef9d, lane b, implementer a40be3781a455fbd1)
Task A1: minor (deferred): only the shell's own process group is killed on close (setsid'd/background-group jobs survive, like nohup in a real terminal); pty_ack cumulative semantics undocumented in pty-frames.ts (A2 matches); 7 nits in task-A1-review.md
Carry to A3: bump the base image tag salt ("pap-base-1" → "pap-base-2") so the new Dockerfile (node-pty stage, gh) can never be served from a cached older base; the builder stage is built for real only in J3's root window.
Task A1: complete (commits d27c0029..2d9aaf6c, review clean)
A2: dispatched (BASE 2d9aaf6c, lane a, implementer a624b5dc4bd0c8656)
B2: implemented c77a33c5 (DONE_WITH_CONCERNS: APP_PUBLIC constant in manifest.ts; HandlerContext.origin from the ws upgrade; states carry a purpose + data, take(state, purpose); permissionMissing in memory; forget clears the caller's tokens only; /github/app/new takes its origin from Host; createGithubFeature → {service, rpc, mount} for J1)
B2: review: spec ✅, quality needs fixes (I: callback origin from Host header in /github/app/new); fix round 1 dispatched (FIX_BASE c77a33c5) + error-page CSP, concurrent create recheck, logged error codes, forget drops states, no code/state in request logs
A2: implemented 9cdad319 (DONE_WITH_CONCERNS: open failures classified by A1's exited tail text (not_found vs terminal_unavailable); a fresh terminal counts as output for one window (detached silent box frees after ~2x idle); TerminalView.projectId required; terminal.ts 355 lines; web enable is A4)
Task A2: minor (→ folded into A3): share the "not in the project" tail literal as one constant between guest and daemon; pre-check terminal capacity/closing before starting the box. Deferred: refused slots stay in `slots` for the launch; terminal hello covered by unit tests only (J1 journeys cover end to end)
Task A2: complete (commits 2d9aaf6c..9cdad319, review clean)
A3: dispatched (BASE 9cdad319, lane a, implementer a0230f96eaba6e683)
B2: fix round 1/5 (6 addressed, 0 open; commits c77a33c5..ce3bff84)
J1 carry (B2): pass config.allowedOrigins to createGithubFeature; mount createGithubFeature's `mount` and `rpc` in place of the compose-github stub.
Task B2: minor (deferred): permissionMissing in memory only; forget clears the caller's tokens only (M14 multi-user); a beginCreate on an existing App consumes the state
Task B2: complete (commits a4ceef9d..ce3bff84, review clean)
B3: dispatched (BASE ce3bff84, lane b, implementer a74329e18a1ffa7bc)
A3: implemented ecb2339e (DONE_WITH_CONCERNS: identity/signing/credential helper in home .gitconfig (not the repo config); user.name = displayName; base salt pap-base-2 + openssh-client + /usr/local/bin/gh wrapper; process-backend passes PAP_TEST_GITHUB_ORIGIN from the daemon env (J1 must gate it); knip ignores ssh-keygen; A2 carries done (PTY_FOLDER_REFUSAL in contracts, capacity pre-check))
Found: apps/daemon/src/modules/auth/tokens.test.ts forbidden-permissions list fails since S1's settings:admin change (both lanes) → fix in A3's round
B3: implemented f6661db5 (DONE_WITH_CONCERNS: project_github gains owner_id + linked; fork before the capacity check; "App cannot reach" = not_found, fork never appears = github_unavailable; delete hook via port.onRemoved; createGithubProjectsFeature → bind({control, ops}), start(), rpc for J1; view lists empty until B4)
Found (B3 report): agent-vm/box-ops.ts uses the 30 s BOX_OP_LIMITS for every op, not BOX_OP_TIMEOUTS → lane A fix (A3 round)
A3: review: spec ❌ (I: user.name = displayName, spec says login), quality approved after; 8 minors; fix round 1 dispatched (FIX_BASE ecb2339e): login; /run/pap-github bound ro into the project VM shell (sessions can push); box-ops per-op timeouts; network ops ignore repo-local url/http/credential config; REQUIRED_FILES bin/*; PAP_REAL_GH gated; tokens.test.ts settings:admin
Ruling R5: identity, signing config and credential helper live in the box's home/.gitconfig, not the repository config (spec §5 wording) — one project per box, daemon ops run with GIT_CONFIG_GLOBAL=/dev/null, and a re-clone keeps them — cost if wrong: a second repository cloned in the box by hand also signs as the owner.
B3: review: spec ✅, quality needs fixes (I: clone runs after a failed token step → row failed); fix round 1 dispatched (FIX_BASE f6661db5) + pre-checks before fork, release re-reads, timers cleared + 1 min retry, rate limit ≠ permissionMissing, cloneAgain conflict on non-empty
A3 round 1 gained item 8: guest git.clone into a temp sibling folder, project/ stays empty on failure
A3: fix round 1/5 (8 addressed, 0 open; commits ecb2339e..4c067e68)
Task A3: minor (deferred): daemon and guest op timeouts are equal (race, either way a timeout); staged clone assumes same filesystem (box disk); no include.path test; gh.prCreate collapses failures into failed
Task A3: complete (commits 9cdad319..4c067e68, review clean)
A4: dispatched (BASE 4c067e68, lane a, implementer a3f2227045065bfc3)
B3: fix round 1/5 (6 addressed, 0 open; commits f6661db5..c10cd511)
Task B3: minor (deferred): unlink/delete wait behind a running clone (up to 600 s); one re-armed timer after an unlink mid-token (exits harmlessly); no rollback of an empty project if store.put throws; a 422 "key already in use" upload retries every tick
J1 carry (B3): createGithubProjectsFeature → bind({control, ops}), start(), spread rpc; projects.hasRoom on ProjectsModule
Task B3: complete (commits ce3bff84..c10cd511, review clean)
B4: dispatched (BASE c10cd511, lane b, implementer a56ca8c0eb7d8232b)
B4: implemented 8b07c89c (DONE_WITH_CONCERNS: real GitHub answers the job-log endpoint with a 302 the client never follows → checkLog fails on real GitHub; GithubSessionsPort {create, prompt, sessionIdsIn, markTainted} required (J1 wires); unlinked project → bad_request (commitPush, prCreate, sendToSession), not_found (checkLog))
B4: review: spec ❌ (I: job-log 302 never followed + client buffers whole body, 4 MiB cap → checkLog/send-a-check fail on real GitHub), quality needs fixes; 8 minors; fix round 1 dispatched (FIX_BASE 8b07c89c): one controlled redirect on the log call only (https, no userinfo/IP literal, host suffix allowlist .actions.githubusercontent.com/.blob.core.windows.net, blockedStrict DNS guard, no Authorization to hop 2, signed URL never logged, streamed 64 KiB tail ring + absolute cap, 15 s across both hops) + lists cache keyed by project+repository
B4: fix 70c514da (DONE; fake-github.test 13/13 rerun by controller); re-review dispatched
B4: fix round 1/5 (2 addressed, 0 open; commits 8b07c89c..70c514da)
Task B4: minor (deferred): bare catch → github_unavailable; one failed check-runs call fails the PR list; per_page=50 before the PR filter on issues; no single-flight on a miss; issueText accepts a PR number; cross-owner session test covers a missing id only; no test for stale fallback on a checks failure nor prCreate with explicit base; blocked-address test injects lookup (blockedStrict itself not exercised)
J1 carry (B4): GithubSessionsPort adapter {create, prompt, sessionIdsIn (caller's own sessions only), markTainted}; replace githubPendingRpc spread in daemon.ts with the real rpc
Task B4: complete (commits c10cd511..70c514da, review clean)
Lane B: complete (head 70c514da)
Join: lane B merged a57d91a9 (no conflicts); lane A merges after A4
A4: implemented 88a9a459 (DONE_WITH_CONCERNS: startCreate navigates same tab to postUrl (daemon's own /github/app/new page — correct); GitHub "tab" is a disclosure section on the project home (no tab system); confirm dialog before step-up on Delete the App; extra EN/FR copy (created state, PR dialog fields, push status, key states, picker, log words); eslint boundary allowances home/vcs/projects→github, github→boxes; budgets green 243/250 KB)
Ruling R6: the spec's "GitHub tab on the project page" is a GitHub section of the project home (the project page has no tab system; a new ItemRef kind is out of scope) — cost if wrong: UI placement only, the section moves into a tab later.
Found (A4 report, controller-diagnosed): `pnpm build` fails at build-agent-bundle on main too (environmental, pre-existing): `pnpm store path` answers ~/.local/share/pnpm/store/v11 (pnpm 10.34.6) and `deploy --store-dir <that>` appends v10 → store/v11/v10 lacks pi-ai 1.1.0 (ERR_PNPM_NO_OFFLINE_TARBALL); `--store-dir ~/.local/share/pnpm/store` deploys fine (123 packages).
Ruling R7: J1 fixes scripts/build-agent-bundle.ts to pass the store root (strip a trailing /v<N> from `pnpm store path`) with a unit test — the J3 root window needs `pnpm build` — cost if wrong: one line in a build script.
A4: review: spec ✅, quality needs fixes (I: httpsUrl checks scheme only — any https host becomes the PR/compare/OPEN GITHUB link; I: navigate(postUrl |authorizeUrl) with no scheme/origin check); 11 minors; fix round 1 dispatched (FIX_BASE 88a9a459) + refused-URL hint shows an error, clone notice with no link
A4: fix c80cdda3 (DONE); re-review dispatched
J1 carry (A4): daemon client.ts imports GITHUB_WEB_ORIGIN from contracts (dedupe)
A4: fix round 1/5 (3 addressed, 0 open; commits 88a9a459..c80cdda3)
Task A4: minor (deferred): 11 from task-A4-review.md (settings status failure has no retry; github catalog's identical-in-FR keys not in the i18n guard; terminal on a stopped box untested in web); lanes/PrPanel.tsx + pr.vm.ts check https only (pre-existing, B4 of the programme removes host lanes)
Task A4: complete (commits 4c067e68..c80cdda3, review clean)
Lane A: complete (head c80cdda3)
Join: lane A merged e372ac6e (no conflicts)
J1: dispatched (BASE e372ac6e, join worktree, implementer ac8cc9fd3f8f813ae)
J1: implemented 15135598 (DONE_WITH_CONCERNS: journeys exposed no lane bug; worktree needed `pnpm install --offline --frozen-lockfile` to link node-pty (J3 too); AGENTS.md lacks PAP_TEST_GITHUB_ORIGIN (J2); test-only additions: smart-HTTP git backend in the fake GitHub, fake gh script, guestEnv seam for the fake gh path; tokens.liveValues() feeds owner-secrets)
J1: review: spec ✅, quality approved; 10 minors
Task J1: minor (deferred): gh / pap-git-credential test hooks key on the caller env with no production guard (no escalation: the shell reads the token file anyway); daemon.ts 385→394 (brief said net-negative); secrets journey doesn't grep served pages; no composed test of liveValues → collector; fake-github.ts at 400; 5 more in task-J1-review.md
Task J1: complete (commits e372ac6e..15135598, review clean)
J2: dispatched (BASE 15135598, join worktree, implementer a0465b6f6879172b2)
J2: implemented e3281fd1 (DONE: docs-truth/adr-index/parity 27/27 ×3; 4 docs-truth-allow entries since github is an RPC domain); controller added the roadmap line (J2 missed docs/plans/roadmap.md) — controller-checked: routes /github/app/{new,created,authorize,authorized}, MAX_STATES 64, log cap 32 MiB match the code
Task J2: complete (commits 15135598..HEAD, controller check)
J3: final review dispatched (Opus, fc2cdc22..8e72581c, reviewer a5b3a91e2725ee225); main moved to d853204b (health events docs) → rebase/merge main before the root window
J3: final review: needs fixes, 0 C, 5 I (I1 delivery uses ops.call → GitHub box never idles; I2 gh.prCreate runs the real gh as guest root → planted filter drivers run outside bwrap; I3 signing private key in home/ readable by every session → exfiltrable, account-wide "Verified" as the owner; I4 callback-mismatch advice cannot work, redirect_uri pinned to the creation origin; I5 permissions link uses /apps/<slug> not /settings/apps/<slug>), 17 minors
Ruling R8: the signing private key leaves home/: stored under the box dir outside every session bind, loaded by guest root into an ssh-agent whose socket sits in /run/pap-github (bound ro into the shell; connect works on ro binds); git signs through `gpg.ssh.program = /usr/local/bin/pap-ssh-sign` (sets SSH_AUTH_SOCK, execs ssh-keygen) with `user.signingkey` = the public key — security first (owner): the key can never leave the box; a session can still ask the agent to sign while the box runs and the project is linked (documented limit) — cost if wrong: an agent process per GitHub box.
Ruling R9: pull requests in the project's own repository are opened by the daemon through the API (POST /repos/{repo}/pulls, installation token {pull_requests: write} for that repository, head = git.push's branch, base = the given or default branch); the guest op gh.prCreate is removed — no gh runs as guest root on a repository a session can write — cost if wrong: none (fewer moving parts).
Final fix dispatch (FIX_BASE 8e72581c): I1–I5 + R8 + R9 + guest writes into home/ never follow links (O_NOFOLLOW / rename into place) + revoke the live box token on unlink/delete
J3: final fix dispatched (Sonnet, FIX_BASE 8e72581c, implementer ac0f09952908742c0)
J3: final fix 735ef83e (DONE_WITH_CONCERNS: process backend only — bwrap→agent socket over ro bind and Debian ssh-keygen -Y sign with agent unproven until the kata window; pap-ssh-sign by bundle path + /usr/local/bin link; removed fake gh + PAP_REAL_GH; App file gains authorizedOrigins ≤ 8; implementer ran `pkill ssh-agent` once on the host — reported to owner); final re-review dispatched (a1a2b4d92a0fb7ece)
Found (owner report 14:36, preview): "VM code older than pap" on project create = vm_bundle_stale. Root cause: dist-agent/node_modules/@pap/contracts/dist/* are HARDLINKS of packages/contracts/dist/* (same inode, link count 2) despite --package-import-method=copy (injected workspace package); the health-events session's `pnpm build` at 13:35 rewrote contracts in place → tree digest changed. Fixed live (owner asked "Tu peux fix ca pour moi"): preview stopped, sudo vm setup --user ubuntu --home ~/.pap --dev-from-tree from main, preview started, doctor green (vm.bundle ok). DB untouched, no backup taken (setup does not touch it).
Found (controller): main's GitHub CI red since ≤ 83b40f3c: class-coverage (B1 PhaseChip.tsx:6 tones read as classes), literal-coverage (SP5 KnowledgeRow.tsx:22 "knowledge/"), integration budget flake (202 vs 200 ms, session-open/idle-RAM journey).
Ruling R10: B2 fixes both coverage failures and the bundle hardlinks (deploy into a temp dir, then copy into dist-agent so no file shares an inode with the workspace) before merge — the merge pushes to main and the owner's preview depends on an independent bundle — cost if wrong: one small script change.
J3: final re-review: all 7 ADDRESSED, 0 new C/I (commits 8e72581c..735ef83e)
Final: minor (deferred): a session can ssh-add -D/-x over the agent socket → delivery fails every 60 s until reboot (own box only); an agent orphaned by a guest-process restart keeps the key after forgetKey; delivered-token map in memory → no revoke after a daemon restart (expires ≤ 1 h); 8 origins + key could in theory pass 16 KiB; 17 final-review minors in final-review.md (rejected push wording, token per list read, terminal runs home dotfiles, hidden tab keeps the box up, node-pty from npm without lockfile, spec deviations: no release notes, titles outside Fence, no base-branch field, no GitHub link in Delete dialog)
Fix batch R10: 9bb34614 (PhaseChip/CheckChip/ProjectGithubSettings *TONES → *_TONE, KnowledgeRow FOLDER const, bundle deploy into temp + copyUnlinked; 32 tests)
Found (owner report ~14:50, preview): a session stuck launching = guest crash at boot. My 14:39 setup installed main's dist-agent as it was: its contracts hardlinks carried the rewritten index.js (export * from ./health.js) but not the NEW files (health.js, health-methods.js) → ERR_MODULE_NOT_FOUND → no hello → vm.stop at 60 s. Fixed: rebuilt main's bundle with buildAgentBundle(storeDir = store root) + cpSync copy (no hardlinks; scratchpad rebuild-bundle.ts), verified contracts loads and dist/node_modules identical outside contracts, vm setup again, preview restarted, doctor vm.bundle ok. Disk: 5.4 GB free (/var/lib/pap-vm 29 GB: 8 GB disk per box, 11 images kept), vm.disk warns. agent_image_entries_damaged at boot (pick map file; rebuilt at the next image build).
Found (J3 gate): B2 `pnpm build` fails in assertAgentBundle: node_modules/node-pty/build/Makefile names the builder's home/repo/store (node-pty is a pi-host dep since A1; built in the image's builder stage, not needed from the bundle)
J3 root window (owner: cut OK once disk OK; 27 GB free after owner cleanup): preview stopped 15:1x; pap backup taken
J3: vm setup --home ~/.pap-kata --dev-from-tree (B2 tree) done; kata project running (log scratchpad/kata-b2.log)
J3: kata 29/29 (8 files) green on the B2 tree
Merged: squash 44fd3196 on main (2026-10-24)
