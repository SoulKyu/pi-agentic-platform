# Final whole-branch review: boxes lot B2 (fc2cdc22..8e72581c)

Reviewer: Opus (J3 seat). Read-only; no subagents; no tests run (none needed for the findings below; one offline `gh` probe in the scratchpad, see I2).
Method: spec, plan (Global Constraints, Review Focus), ledger (R1 to R7, deferred minors), task reviews, then the code by seam (guest ops and wrappers, gateway and pty, terminal module, GitHub module, composition, web, image). Known deferred minors are not repeated unless a cross-task seam changes their weight.

## Strengths

- **Box tokens are narrow and checked.** `tokens.ts:70-99` refuses `administration` and an empty ask, mints for one repository name, and refuses an answer that widens a permission or names another repository. Only `BOX_PERMISSIONS` reach a box (`deliver.ts:103`). A fork's pull request never calls the upstream's API (`actions.ts:90-101`).
- **The callback flow is well bound.** States are single use, ten minutes, bound to a user and a purpose (`states.ts`). The create origin comes from the WebSocket `Origin` checked against `allowedOrigins`, never `Host`. Pages carry their own hashed CSP on error answers too. Request logs drop the query. Every value is escaped (`pages.ts`).
- **Guest network ops are hardened.**
  - The credential helper is reset, then scoped, and the helper script answers `get` for github.com only.
  - The repository's own config is scanned for `credential.*`, `url.*`, `http.*`, `remote.*.proxy|pushurl` (`git-remote.ts:14-29`).
  - `GIT_ALLOW_PROTOCOL` is https only, the push uses an explicit refspec, and the staged clone leaves `project/` intact on failure.
- **The job-log redirect is careful.** One hop, https, suffix allowlist, no IP literal, no Authorization on hop 2, a streamed tail ring, absolute caps (`client-log.ts`).
- **The remote pty is a clean seam.**
  - It sits behind the existing terminal module, so the ring, attach, replay and binary frames are reused.
  - Terminal hellos need the launch token and a daemon-asked random slot (`guest-ptys.ts`, `gateway.ts:212-226`).
  - Flow control is cumulative and windowed on both ends.
  - A lost link ends the shell (`pty.ts:209-214`).
- **Test seams are gated.** `PAP_TEST_GITHUB_ORIGIN` needs the scripted provider and a loopback http origin. The client's `test` flag and the guest origin derive from config only. `guestEnv` is DI only. No production import of the fakes.
- **The secrets journey has teeth.** It has a positive control (the App file must be found) and scans logs, audit, answers, events and disk.
- **Repo rules hold.** Every changed file is ≤ 400 lines. Module imports go through `index.ts`. Handlers decode and call one method. Permissions match the plan's table.

## Issues

### Critical (Must Fix)

None.

### Important (Should Fix)

**I1. Token renewal keeps a GitHub box awake forever when `PAP_WORKER_IDLE_MINUTES` ≥ 45 (FinOps).**
- Where: `apps/daemon/src/modules/github/deliver.ts:104` (`github.token`), also `:116` (`github.identity`), `:130` (`fs.list`), `:137` (`git.clone`).
- What: delivery uses `BoxOps.call`, which calls `runtime.touch` (`box-ops.ts:68`) and re-arms the idle wait (`lifecycle.ts` `armIfEmpty`). The renewal fires every 45 min (`RENEW_MS`). With an idle time of 45 min or more, each renewal pushes the stop back, so the box never idles out.
- A guest-side failure after the mint also re-touches the box every 60 s (`RETRY_MS`) whatever the idle time.
- Why it matters: a 2 GiB box stays up for days. B1 created `BoxOps.poll` for exactly this case: background work that is not activity (agents-vm.md: "`BoxOps.call` resets the idle wait; `BoxOps.poll` does not").
- Fix: use `ops.poll` for every delivery step (the first delivery at start, renewals, retries). Add a test with idle 60 min and two renewals that ends with the box stopped.

**I2. `gh.prCreate` runs the repository's filter drivers as guest root, outside bwrap.**
- Where: `packages/pi-host/src/guest/ops/github.ts:109-131` (`runGh` env), reached by `ghPrCreate` (`:161`).
- What: the real `gh` runs git in the project. Its uncommitted-change warning in `pr create` runs `git status --porcelain`; the string "uncommitted change" is in the gh binary. `runGh` neutralises only `core.fsmonitor` and `core.hooksPath`. It does not empty filter drivers as `runGit` does (`FILTER_SCAN_ARGS` → `driversToDisable` → `disablingEnv`), and it sets no `GIT_CONFIG_NOSYSTEM`.
- Attack: a session can write `project/.git/config` (`[filter "x"] clean = …`) plus `.gitattributes`, then touch a tracked file. When the owner presses OPEN A PULL REQUEST, the guest process runs that command as root outside the session's bwrap. From there it can see `.pi`, the worker, `/dev/vsock` and the relay. This is exactly what B1's neutralised git exists to prevent: agents-vm.md says "git runs in the guest with the neutralised command line (no fsmonitor, hooks, filters or external diff)". B2's own doc says the network ops refuse hostile config. `assertCleanRemoteConfig` does not look at `filter.*`.
- Fix (minimal): give gh's git the same disabled drivers as `runGit` (scan, then merge `disablingEnv` into the `GIT_CONFIG_*` pairs) and `GIT_CONFIG_NOSYSTEM=1`.
- Fix (cleaner): open the pull request from the daemon with a `{pull_requests: write}` installation token for the row's repository (`POST /repos/{repo}/pulls`, head = the branch the push reported). gh leaves the daemon-initiated path, and the PR URL is no longer guest-reported.
- Unverified end to end: needs a GitHub API. An offline `gh 2.103 pr create` with a dead proxy fails at its first GraphQL call, before any status. The marker stayed empty, which is consistent with the check coming after base-repo resolution.

**I3. The signing private key is readable by every session and its reach is the owner's whole GitHub signing identity.**
- Where: `packages/pi-host/src/guest/ops/github-env.ts:24` (`home/.ssh/pap_signing`), and `packages/pi-host/src/vm-shell/argv.ts:40`, which binds `home/` read-write into every project-box shell.
- What: a session (a prompt-injected model included) can read the key and push it out through github.com, which is on the list by default. The key then signs commits that GitHub shows as "Verified" for the owner, on any repository, until the project is unlinked or deleted.
- Why it matters: ADR 0084:19, agents-vm.md:208 and spec §5 say "the private key never leaves the box". The documented risk model is the token ("one repository for one hour"), and this key breaks it: it is persistent and account-wide.
- Fix (owner's decision):
  - (a) keep the private key out of the shell's view: a guest-only folder outside the bound set, an `ssh-agent` socket in the read-only `/run/pap-github` folder, and `user.signingkey = key::<public key>`. A session can then still sign but cannot copy the key.
  - (b) or record it as a known limit with its real reach in ADR 0084, agents-vm.md and spec §5, and drop "never leaves the box".

**I4. The callback-mismatch remedy cannot work, and its notice never clears.**
- Where: `apps/daemon/src/modules/github/service.ts:90-99` (`authorizeUrlOf`), `:132` (`originMatches`), `:219-229` (`completeAuthorize`).
- What: both `redirect_uri` values are always the stored `app.callbackOrigin`. GitHub requires `redirect_uri` to match a registered callback URL.
  - If the owner follows the notice and replaces the callback URL on GitHub, Reconnect is refused by GitHub.
  - If they add the new URL instead, the flow still returns to the old address, which may not be reachable.
  - `originMatches` compares to the stored origin forever, so the notice never goes away.
- Fix:
  - carry the caller's origin (checked against `allowedOrigins`) in the `authorize` state, as `create` does;
  - use it for both `redirect_uri` values;
  - record each origin a successful authorization proved, so `originMatches` can become true.

**I5. The "review its permissions" link probably 404s (unverified: no public host contacted).**
- Where: `service.ts:210` builds `${html_url}/permissions`, i.e. `https://github.com/apps/<slug>/permissions`. `GithubSettings.tsx:58,87` (OPEN GITHUB) opens the public page `html_url`.
- What: `/apps/<slug>` is the public App page. The App's settings, where "SSH signing keys: Read and write" is set, live at `https://github.com/settings/apps/<slug>/permissions`. Spec §3 asks for a direct link to them, and the permission is the prerequisite for "Verified", B2's exit criterion.
- Fix: build `${webOrigin}/settings/apps/${slug}/permissions`, and for the "accept on the installation" step link `${webOrigin}/settings/installations`. Confirm on the owner's real run.

### Minor (Nice to Have), 17

1. **Push and PR failures read "The session process failed."** `box-ops.ts:26` maps the guest's `failed` to `worker_failed`. The GitHub methods declare `command_failed`, which has box words. A rejected push (non-fast-forward, protected branch) is the common case. Map `failed` to `command_failed` for the GitHub ops.
2. **Lists mint a fresh installation token per GitHub read.** `lists.ts:115,197`: pulls, one per PR's check runs, issues, releases, branches and log, so N+3 mints per refresh. Each mint lands in `live`, which makes J1's known `live.clear()` at 1024 (`tokens.ts:97`) drop the box tokens from value redaction sooner. Cache one read token per repository until shortly before expiry, and keep `live` for box tokens.
3. **Guest writes in `home/` follow links a session can plant.**
   - `git config --file home/.gitconfig` resolves a symlinked target when it takes the lock.
   - `writeFileSync(<key>.pub)` follows a link.
   - `ssh-keygen -f` follows a dangling `pap_signing` link.
   - Effect: guest root creates or overwrites files outside the shell's view (e.g. under `.pi`), with fixed content (`github.ts:34-51, 84-97`).
   - Fix: refuse a link at `.gitconfig`, `.ssh`, `pap_signing` and `pap_signing.pub`, as B1 refuses links under `project/`.
4. **The box terminal runs files that sessions can write.** It is guest root outside bwrap with `HOME = home/`, which sessions write: `.bashrc`, `.profile`, `.gitconfig` aliases and fsmonitor, `.config/gh`. Planted code runs outside bwrap at the owner's next terminal. This is by design (programme §56) but undocumented: add it to Known limits, or start the shell with a root-owned profile.
5. **The box token outlives an unlink.** Unlink, Disconnect and Delete the App leave the current token in `/run/pap-github/token`, valid up to an hour. There is no `DELETE /installation/token` and no file removal in `git.unlink` or `forgetKey` (`projects.ts:199-212`).
6. **An interrupted clone leaves debris.**
   - A box stop mid-clone leaves `/boxes/<id>/.clone-<hex>`: the `finally` never runs and nothing sweeps it.
   - A stop during the rename loop leaves a partial `project/`, which the next start marks `done` ("clone skipped") (`git-remote.ts:73-90`, `deliver.ts:131-134`).
7. **Stale streams keep a box up.** `terminal.ts:282` `activity().streams` counts stale (long-paused, background-tab) streams, so a terminal left in a hidden tab keeps its box up with no limit. Count only non-stale streams in `registry.ts:194`.
8. **Browser-only depends on each service remembering.** Each service method must call `assertBrowserCaller`, and no table-driven test drives every `GITHUB_BROWSER_ONLY` method through the composed RPC with a token caller. This extends S1's "tautological test" minor: a future method that forgets the call is open to tokens.
9. **Release notes and assets (spec §7).** Spec §7 lists release notes (fenced) and assets as links. `ReleaseView` has no notes, and `GithubTab` shows asset names as text. Plan line 197 dropped notes without a ruling.
10. **GitHub text outside the Fence.** The plan's design constraint says GitHub titles, labels and authors in the section go "inside the Fence with UNTRUSTED · github <kind>". They are plain text but not fenced (`GithubTab.tsx`, `PullRow.tsx`). Only the log is fenced.
11. **No base branch in the PR dialog.** Spec §6 and the plan mention a base branch "defaulting to the repository's default". The dialog has no base field, and the non-fork path does not push first, so a PR from `main`, or from an unpushed branch, fails with M1's words.
12. **Delete the App gives no link.** `install.md` says "you delete the App itself on GitHub from the link shown". `DeleteAppDialog` shows none.
13. **A failed key removal is not shown.** Spec §5 asks for it in Settings › GitHub. `GithubStatusView` has no such field, and after a project delete nothing on screen shows the stranded key.
14. **The image fetches node-pty from npm without a lockfile.** The base build fetches `node-pty@1.1.0` from npm in every `--no-cache` build, with no lockfile or integrity; its `node-addon-api` caret range is unpinned (`apps/vmd/src/dockerfile.ts:41`). The bundle already carries node-pty from the pnpm store: rebuild that copy in the stage instead.
15. **The spec's Kata clone and push item is not covered.** Spec §10 asks for clone and push in Kata; plan line 312 makes it impossible against the fake. No real-VM run exercises any of:
    - `gh`;
    - ssh-keygen signing;
    - the absolute-path credential helper;
    - git CONNECT through the proxy;
    - `/run/pap-github` in a session shell.

    The owner's SoulKyu/cpg check is the first one. Give the owner a written checklist for it.
16. **M14 carry.** Clone and link check only that the App reaches the repository (`appReaches` with the App JWT, `projects.ts:150,177`), never the caller's own GitHub access. This is harmless with v1's single owner. Multi-user must bind it to the caller's user token.
17. **Log noise after Delete the App.** Linked rows stay, so every running linked box logs `github_delivery_failed` every 60 s (`deliver.ts:155-158`) until it stops. Back off on `github_unavailable`.

## Recommendations

- Fix I1 and I2 before the root window: each is small and local.
- I4 and I5 are small too and save the owner's first real run.
- I3 needs the owner's ruling, (a) or (b); record it as R8.
- For the owner's real check on SoulKyu/cpg, verify each of these:
  - the permissions link;
  - signing key upload, then "Verified" on a commit;
  - push through the proxy;
  - `gh pr create` from a session shell;
  - the job-log redirect hosts;
  - install-time OAuth carrying `state`.

## Declined to judge

- **Guest root outside bwrap versus inside it.** The programme's own stance is that the terminal is not in bwrap (§56). I flagged only the daemon-initiated path (I2) and the undocumented dotfile consequence (M4).
- **The token readable by every box process.** This is spec-accepted (§5, ADR 0084).
- **Pushes with `contents: write` can run the repository's existing Actions workflows, with their secrets.** This is inherent to "a session can push", which the spec documents.
- **Multi-user GitHub.** M14; noted as carry M16 only.
- **DESIGN.md visual details** (tokens, 44 px targets, timing). A4's review covered them; not re-reviewed.
- **Lanes (B3) and the host `gh` (B4).** Out of the lot.
- **How faithful the fake GitHub is to real GitHub** beyond the URLs in I4 and I5.
- **pty throughput under heavy output** (base64 overhead, ack cadence).

## Could not verify

- **Real GitHub behaviour:** the permissions URL (I5); `state` carried through install-time OAuth; `redirect_uri` with several callback URLs (I4); job-log redirect hosts.
- **gh's `git status` in `pr create`** (I2). The evidence is the binary's strings, gh source recollection, and the offline probe, which stops at the first API call.
- **J3 root window:**
  - the buildkit stage's npm and node-gyp network;
  - Debian trixie `gh` and `openssh-client`;
  - node-pty loading in Kata;
  - the terminal over the real gateway;
  - signing and push in a real VM.
- **No vitest run.** The task gates and J1's journeys are taken as reported.

## Assessment

**Ready to merge?** No: with fixes.

**Reasoning:** The architecture is sound and the secret and state handling are careful. Four cross-task seams are wrong in ways the task reviews could not see, and I5 is a likely broken link:
- the renewal defeats the idle stop;
- gh reopens the filter path B1 closed;
- the signing key's real reach contradicts the docs;
- the origin-mismatch remedy cannot work.

All but I3 are local fixes; I3 needs an owner ruling.
