# M13 final whole-branch review (Opus)

- Range: `e264c2b9..2fbca174` (feat/m13-join), 80 non-merge commits, 199 files, +12 441 / -426.
- Inputs: plan (Global Constraints, Review Focus, Interfaces, M13R1–R57), spec A §2, spec D, owner answers, ledger (M13-C1..C9, CJ1–CJ3, CB6), `docs/research/m13-rulings.md`, `docs/research/m13-exit-criteria.md`.
- Read-only on the join checkout; its tree is clean at the end of the review.
- Mutations ran only in a scratch worktree (`/tmp/claude-1000/m13-final-review`, detached at 2fbca174, removed and pruned afterwards).
- No subagent, no e2e, no GitHub, no pi-web, no `~/.pap` / `~/.pi/agent`, no systemd.

## Passes

0. Plan, rulings, owner answers, ledger and exit evidence, read in full. Commit list and stat.
1. Security:
   - B4: `address-strict.ts`, `address.ts`, egress judge/allow/proxy, push transport, vectors, parity test. Ranges re-derived against the IANA IPv4 and IPv6 special-purpose registries.
   - The ten spec C §8.1 tests and their index.
   - F1 `kernel/home.ts`.
   - C9: `CodemodeBody`, `codemode.vm`, `nested-calls`, `row-view`.
   - B6: builder, closure, shrinkwrap check.
   - Licence shipping.
2. Outside-write detection: `scan-port.ts`, `live-idle.ts`, `live-session.ts` event flow, `service-adopt.ts` (stamp and pre-start check), the unit and int tests, `sessions.md` coexistence section, ADR 0074. I reproduced one gap with a unit test in the scratch worktree.
3. Crash isolation: exit-criteria §1 against the test files and their titles.
4. Release machinery:
   - `release-check.ts`, `release-flip.ts`, `release.yml`, `pi-compat.yml`, `ci.yml`, the setup action, `pi-compat*.ts`, licence rule.
   - **Flip rehearsal**: ran `scripts/release-flip.ts` in the scratch worktree, then `release:check` and the pinned unit tests.
5. e2e harness: `run.ts`, `daemon.ts`, `fixtures.ts`, config, `seed.ts`, stubs, loopback guard, the 15 journeys (grep for retries, selectors, hosts, ports).
6. Docs truth:
   - 28 claims sampled across ADRs 0071–0077, AGENTS.md, README "Testing and releasing", `e2e.md`, `release.md`, `daemon.md`, `sessions.md`, `finops.md`, exit criteria.
   - 15 parity proofs spot-checked against test titles and assertions.
7. Seams:
   - The four conflict resolutions (release-check checks list, scan-port, daemon.md, ci.yml).
   - Duplicated helpers.
   - Dead code.
   - Cross-task assumptions.

Targeted unit run on the join head: address-strict, proxy.strict, net-guard parity, home, outside-writes.live, live-idle, security-index, docs-truth, parity-doc, release-flip, release-check.v1. Result: 12 files, 221 tests, green.

## Strengths

### Strict address predicate (B4)

- `blockedStrict` now covers every IANA special-purpose block marked "not globally reachable". IPv4: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, the three TEST-NETs, 192.88.99/24, 192.168/16, 198.18/15, 224/3.
- It covers the same blocks in IPv6: ::/128, ::1, mapped, SIIT, 64:ff9b::/96 and /48, 100::/64, Teredo, 2001:2::/48, ORCHID, 2001:db8::/32, 6to4 carrying a refused IPv4, 3fff::/20, 5f00::/16, fc00::/7, fe80::/10, fec0::/10, ff00::/8.
- It lets through the blocks marked globally reachable (2001:1::1–3, 2001:3::/32, 2001:4:112::/48, 2001:20::/28, 2001:30::/28, AS112).
- Only RFC 9780's 100:0:0:1::/64 remains open; it is already parked (m3).
- Push and egress both use it.
- The egress judge refuses literal IPs in every spelling before any lookup (`normalizeHost`).
- The judge connects to the address it checked (no second lookup), and one blocked answer refuses the whole name.
- The three-predicate parity test pins every difference by value.

### Home permissions (F1)

- The readback after `chmod` is correct for both stat flavours.
- It fails closed, and the message carries the remedy.

### Codemode card (C9)

- Every untrusted string (script, call names, args, errors, output) is React text inside `<pre>`, `<span>` or `<p>`. There is no `dangerouslySetInnerHTML`.
- `nestedCallsOf` reads the row defensively, with caps, and an unknown status fails closed.

### npm shrinkwrap (B6)

- Generated offline, with integrity strings copied from the lockfile, never recomputed.
- `release:check` deep-compares it with a regenerated copy.
- Diverging peer variants fail closed.
- CB6 used the tuple criterion, not a byte diff.

### Live outside-write notice (B2)

- The quiet time is touch-based. Every `pi_event`, `entry_appended` included, touches before the scanner (about 1 s latency) can report the write.
- Commands touch at start and end, and every pending state (run, steer, compaction, a command in flight, `releasing`) is "busy".
- So pap's own writes do not raise the notice. The grace logic matches spec D §3.

### Crash isolation (B3)

- The new tests are honest. The second session is held mid-run and its stream is then gapless and complete after `exit(7)`, `abort()` and SIGKILL.
- The limit is written down.

### Release machinery

- `release-check` pins both pre- and post-flip shapes, the `if:` strings, `cache: "false"` on the write-token jobs and the run-injection rule.
- In the scratch rehearsal, `pnpm release:check` prints `ok` on the flipped tree.
- `pi-compat` fetches first, works in a scratch worktree, and leaves the transitive age to pnpm's own `minimumReleaseAge`.

### e2e harness

- The daemon environment is an allowlist, with temporary HOME, `PAP_HOME` and agent dir.
- Leftover processes are reaped by `HOME=` in `/proc/*/environ`.
- Ports come from the OS. The container gets `--rm` plus a `finally` remove.
- The runner lists the tests before it runs them, so an empty or misrouted suite cannot pass.
- `retries: 0`, and journeys end on durable state.

### Enforced docs

- `docs-truth`, `parity-doc`, `security-index` and `adr-index` are real tests.
- No allowlist entry has a `sweep` owner. `AGENTS.md` is 74 lines.

## Issues

### Critical

None.

### Important

#### I1. Outside tool results written while a pap worker is live are never judged for taint (ADR 0074's premise is false)

**Where**
- `apps/daemon/src/modules/sessions/scan-port.ts:172-182`:
  - `touched` discards `noteOutside`'s result.
  - `outsideForTaint` requires `!deps.isLive(sessionId)`.
- `apps/daemon/src/modules/sessions/service-adopt.ts:33-41`: `stampPapWrite` stamps `pap_wrote_at` and the file's size at worker end, so outside bytes are included.
- `service-adopt.ts:81-99`: `beforeStart` treats `mtime <= max(updated_at, pap_wrote_at)` as unchanged and reads nothing.
- Decided in `docs/adr/0074-live-session-outside-write-detection.md:14` and `docs/agents/sessions.md:81`.
- Pinned by `outside-writes.live.test.ts:84` "(f)".

**What happens**
- A second app (pi-web, the Pi CLI) resumes a session that pap holds. Its agent reads a web page, and a `toolResult` lands in the file.
- pap raises the live notice and, by design, no taint.
- When pap's worker ends (idle release after 30 min, a crash, a restart), the exit stamp absorbs those bytes.
- The next prompt starts a worker that loads the untrusted tool result into its context, and the session is not tainted.

**Reproduced** in the scratch worktree with a `service-bed` unit test:
1. Live worker, clock +60 s, a `toolResult` line appended.
2. `scanPort.touched(id, at, false, true)`: `outsideWriteAt` equals `at` (the notice fires), and `onOutsideToolResults` is not called.
3. The worker crashes, and the next `prompt` spawns worker 2. `onOutsideToolResults` is still never called.

**Why it matters**
- Taint is the prompt-injection control: "taint then exfiltration" is one of the ten spec C §8.1 security tests.
- q12 makes pap and pi-web on one Pi folder the permanent v1 setup, and B2 was built for exactly this case.
- "Never resume one session in both apps" is prose.
- ADR 0074 justifies "no taint" by the released-session rule (M7R27), which cannot see these bytes.
- `sessions.md` lists "writes made while a pap worker held the session" as not covered (since M7). The new angle: M13 now detects these writes, the scanner already passes `toolResults`, and the taint is still dropped.

**Fix**
- In `touched`: `const noted = noteOutside(...)`, then taint when `toolResults && (outsideForTaint || (noted && deps.isLive(sessionId)))`.
- I applied this in the scratch worktree: only test (f) flips, and the other 1 536 session unit tests stay green.
- If an immediate taint of the live session is not wanted, keep the exit stamp from absorbing outside bytes instead: stamp the size from before the notice, or put the session in `owed`.
- Then update ADR 0074, `sessions.md:81` and test (f).

#### I2. The v1 flip turns the unit suite red: 11 tests in 5 files pin the pre-flip files

**Where**
- `scripts/release-flip.ts` (`applyFlip`) rewrites one assertion of `update-check.test.ts` and nothing else.
- After the flip these fail:
  - `scripts/ci-config.compat.test.ts:58` ("is dispatch-only until the repository is public")
  - `scripts/release-check.test.ts:109`
  - `scripts/release-check.v1.test.ts:126, 165, 220, 228`
  - `scripts/release-flip.test.ts:46, 64, 72, 78`: they read the live files, so after the flip they hit "already flipped".
  - `apps/daemon/src/update-check.test.ts:68` ("unset while the default is off")
- The runbook, `docs/agents/release.md:34` (step 4.1), says "Then `pnpm release:check` and `pnpm test:unit`".

**Evidence**
- Scratch worktree at 2fbca174: `node scripts/release-flip.ts`, then `release-check: ok`.
- Then `vitest run --project unit` on the 8 workflow/release/update-check test files: **11 failed, 118 passed**.

**Why it matters**
- The flip PR's CI fails at `unit`, so `integration`, `build`, `budgets` and `e2e` never run.
- The runbook requires a green `e2e` on that PR, so the owner meets an unexplained red at the one release step that cannot be rehearsed on GitHub.
- Review Focus 8 was checked for `release:check` only. `release-flip.test.ts`'s "yields a tree on which release:check returns no problem" does not run the other pinned tests.

**Fix**
- Make the pinned assertions shape-aware (pre or post, as `release-check` is), or have them read frozen fixture copies of the pre-flip files instead of the live ones.
- Extend `applyFlip` for `update-check.test.ts`'s "default is off" row.
- Add a rehearsal test that flips a scratch copy and runs the same assertions.
- List any remaining hand edit in `PROSE_CHECKLIST` and in `release.md` step 4.2.

#### I3. The release archive and the container image ship no licence text, and no package ships the Apache-2.0 notice

**Where**
- `scripts/build-archive-stage.ts:108-116` (`stageTree`) copies the manifests, the lockfile and `dist` only. Both `build-archive.ts` and `stage-app.ts` (so the Containerfile) use it.
- `scripts/build-archive.ts:108` copies Node's `LICENSE` only.
- `scripts/build-npm.ts:323` copies `LICENSE` but not `THIRD_PARTY_NOTICES.md` or `LICENSES/Apache-2.0.txt`.
- `packages/ui/src/ai/Message.tsx` and `Reasoning.tsx` (Apache-2.0, Vercel) are compiled into `apps/web/dist`. A grep of the built `apps/web/dist/assets/*.js` finds no Apache or Vercel notice: the header comments are stripped.

**Why it matters**
- The archive is the primary v1 channel (the GitHub release asset, `get-pap.sh`), and the image is the container channel.
- AGPL-3.0 expects the licence to travel with each copy conveyed.
- Apache-2.0 §4(a) requires a copy of the Apache licence with a redistributed derivative.
- `release:check` validates the repository, not the artefacts. ADR 0077 and exit criteria §3 speak about npm only.
- The owner's reasonable expectation for "v1 under AGPL" is that every artefact says so.

**Fix**
- Add `LICENSE`, `THIRD_PARTY_NOTICES.md` and `LICENSES/` to `stageTree`'s copy list (one place covers the archive and the image) and to the npm staging.
- Pin them in `build-archive.test.ts`, `build-npm-package.test.ts` and the image check.
- Add one line in `install.md`.

#### I4. The pi-compat nightly that the flip restores runs `test:int` without the sandbox, so it fails every night on GitHub

**Where**
- `.github/workflows/pi-compat.yml:18-21`: the setup step passes only `install: "false"`, not `sandbox: "true"`. Then `pnpm test:int` runs.
- `scripts/ci-config.test.ts:151-160` pins `sandbox: "true"` for `integration` only. The linger test right below it (`:165`) covers both `integration` and `pi-compat`.
- `apps/daemon/src/security/testing/agent-bed.ts:24` and nine more int files throw under a truthy `CI` without a usable bwrap. Ubuntu 24.04 runners restrict unprivileged user namespaces, which is the reason for M13-C9.

**Why it matters**
- After the flip the nightly is red whatever Pi does, so the one signal B5 built (a newer aged Pi breaks pap) is drowned.
- It is a cross-task seam: B5 wrote the job, and A5 under M13-C9 provisioned only `integration` and `e2e`.

**Fix**
- Use `with: { install: "false", sandbox: "true" }` in `pi-compat.yml`.
- Add the pi-compat job to the sandbox assertion of `ci-config.test.ts`.
- Dispatch it once on GitHub before the flip.

### Minor

#### M1. Journeys use CSS and `data-*` selectors, against M13R4 and ADR 0071

- **Where**: 35 `locator("…")` calls in 9 of the 15 journeys (`j10-models.e2e.ts` 10, `j15-settings.e2e.ts` 9, `j11` `.xterm-rows > div`, `j08` `li:has([data-subagents-toggle]) ul a`, …).
- **Wrong claims**: `docs/research/m13-rulings.md:29`, `docs/adr/0071-…md:15` and plan checklist item 3 all say "no CSS or test-id selectors".
- **Effect**: brittleness only; the durable-state assertions keep the journeys honest.
- **Fix**: record an exception ruling (app-owned `data-*` hooks where no accessible name exists) and correct ADR 0071 and `e2e.md`, or convert the selectors.

#### M2. Two retries may still mask real dropped clicks, and the e2e guide gives stale advice

- `scripts/e2e/j14-automation.e2e.ts:143-150` retries the Inbox rail click "while its label changes". But `InboxButton` and `IconButton` keep one node across the label change, and since C8 the Tooltip never re-creates it, so the stated cause does not match the code.
- `scripts/e2e/j10-models.e2e.ts:85-89` retries a WebKit switch click "while the mode write is answered".
- `docs/agents/e2e.md:59` (step 5) still tells authors that a Tooltip-wrapped icon button drops its first click and to use `actUntilVisible`. This contradicts `seed.ts:200-205` ("C8 fixed that one; first clicks are plain").
- **Fix**: find the cause of both drops, or record why the product is right; correct step 5.

#### M3. Docs-only changes skip CI, so the docs tests never run on them, and the README overstates when CI runs

- `.github/workflows/ci.yml:3-7` has `paths-ignore: docs/**, **/*.md` on both `pull_request` and `push`.
- So `docs-truth`, `parity-doc`, `adr-index` and `security-index` never run on a docs-only PR. A breaking doc lands on `main` and fails the next code push.
- `README.md:123` says "CI runs on every push to `main`", which is false (`release.md` step 3 has it right).
- **Fix**: drop `**/*.md` from `paths-ignore` (or add a light docs job), and reword the README.

#### M4. `AGENTS.md:9` gives `pnpm test:budget` the wrong scope

- It says "(timed run: search, scanner, RSS, payload)".
- `test:budget` runs only `search.budget.int.test.ts` and `scanner.exit.int.test.ts`. RSS and payload are measured by `pnpm test:int` (`sessions.budgets.int.test.ts`); `finops.md` has it right.

#### M5. "One derived file" is two files

- `AGENTS.md:56`, `docs/adr/0077-the-licence.md:13` and `docs/agents/release.md:11` say one ai-elements file stays Apache-2.0.
- `THIRD_PARTY_NOTICES.md` lists two: `packages/ui/src/ai/Message.tsx` and `Reasoning.tsx`.

#### M6. Parity row P03-8 claims a behaviour pap does not have

- **Where**: `docs/agents/parity.md:81` says "Trailers Pi-Lane and Pi-Session on lane commits" and is marked green.
- **What pap does**: it writes only `Pap-Lane: <laneId>` (M9 ruling, `m9-rulings.md:500`), and there is no session trailer. The proof (`commit.test.ts:127`) asserts `Pap-Lane` only.
- **Fix**: reword the row as pap's behaviour with the M9 reference, and mark the Pi-Session part `dropped` or `after v1` with its decision.

#### M7. Exit evidence overstates and cites an earlier head

- `docs/research/m13-exit-criteria.md:16` and `docs/agents/policy.md:139` say the hard-exit tests run "while a second session streams". The second session is parked on an approval card at the death; the document's own Limit line says so.
- `sessions.crash.hard.int.test.ts:93`'s comment ("the dead session's worker can be replaced") is not asserted.
- `m13-exit-criteria.md:51-53` ("The whole gate") cites `6ba3ff83`, not the final head. The CJ1 numbers on 2fbca174 (unit 20 711, int 241 files / 1 382 tests, e2e 36 passed / 2 skipped in 3.8 min) are in the ledger only.

#### M8. The flip's owner items and prose checklist have drifted

- `scripts/release-flip.ts:21` and `release.md:42` place `FEED_REPO` in `apps/daemon/src/update-check.ts`; it is in `apps/daemon/src/cli/update/feed.ts:7`.
- `PROSE_CHECKLIST` (`release-flip.ts:28` and `:31`) describes wording that J1a and P2b already rewrote: `AGENTS.md` no longer says "private until v1", and `install.md` has no "private until v1".
- The `AGENTS.md` bullet does need a post-flip edit, for its new wording.
- `docs/agents/daemon.md:135` and `ci-config.compat.test.ts:58` say "until the repository is public"; it is public, and the condition is now the v1 flip.

#### M9. `e2e.md` cites the wrong ruling and an old run count

- `docs/agents/e2e.md:10` says "not yet passed on GitHub (M13R5)". M13R5 is the passkey ruling; M13R33 or M13-C9 is meant.
- `e2e.md:96` says the whole suite "passed once". It passed at least three times since (J1b twice, CJ1).

#### M10. After the flip, nothing keeps test daemons off GitHub

- Test daemons get no `PAP_UPDATE_CHECK=0` (`scripts/e2e/daemon.ts:111`, the smoke environment).
- Once the version is 1.0.0 and the default is `true`, any test daemon that lives more than 10 minutes fetches the GitHub feed. Today only daemon lifetimes keep "Nothing contacts GitHub from tests" true.
- The same flip makes `AGENTS.md:36` "… or from this host" false for the preview's daily check, and that line is not in `PROSE_CHECKLIST`.

#### M11. Duplicated helpers

- `apps/daemon/src/kernel/net/address-strict.ts:12-14` re-implements `prefix` and `dotted` from `address.ts:17-21`; export them once.
- `apps/web/src/stores/row-view.ts:58` `CODEMODE` duplicates `codemode.vm.ts:5` `CODEMODE_TOOL`.

#### M12. ADR 0072 misnames the test file and claims an untested guarantee

- `docs/adr/0072-…md:19` says "`pi-compat-bump.test.ts` pins the choice". The pick tests are in `pi-compat-bump.pick.test.ts`.
- "Clock skew must not be picked" is not tested or enforced: `pickNewest` trusts `Date.now()`.

#### M13. npm timing is worded two ways

- `docs/agents/install.md:196` says `npm publish` is "after v1".
- `release.md` step 7 makes it the last v1 step (q15: after the verified GitHub release).

## Declined to judge

- **The GitHub CI run of draft PR #1**: the first real run of `e2e`, the sandbox provisioning and the contracts build before typecheck. I was not allowed to touch GitHub; M13-C9 leaves this to that run.
- **e2e flake rate and the cause of the j10 and j14 dropped clicks**: needs a browser, and running e2e was not allowed. Judged only from the code (M2).
- **The fonts branch's use of `blockedStrict`**: it is a later branch, outside this range.
- **RFC 9780 `100:0:0:1::/64`, network-specific NAT64 prefixes, the unrouted remainder of 2001::/23**: parked under B4 (m3, M7) with no new angle.
- **npm behaviour beyond CB6** (global install, script execution): needs the network. CB6 was accepted, and the `hasInstallScript` allowlist matches the pnpm build policy. Not re-run.
- **Scope and OOM tests on a GitHub runner**: they need a user manager on the runner. Not run here.
- **Owner-deferred and accepted items**: the 8 after-v1 parity rows, the Loki guide, the cutover, the 15 s lane poll, "Operation aborted" on SIGTERM, the about 4 s model switch, and the per-task parked minors. Not re-raised.
- **The legal reading of AGPL §13 for the hosted web UI**: only a recommendation below, no finding.
- **Coverage of the sampling**: the other 182 parity rows and the roughly 1 500 sweep claims beyond the 28 claims and 15 proofs sampled.

## Recommendations

1. Land I1–I4 before the v1 flip. Each is small: under 30 lines plus tests. For I2, the lasting guard is a rehearsal test that applies `flipTree` to a scratch copy and runs every shape pin.
2. Add `PAP_UPDATE_CHECK=0` to the e2e and smoke daemon environments (M10).
3. Consider making J03 fail closed on `https`: today `PAP_TEST_GIT_PROTOCOLS=file` still allows `https`, so only the `insteadOf` rewrite keeps the push off github.com.
4. Run the docs tests on docs-only changes (M3). The milestone's premise is "the enforcement is in tests".
5. AGPL §13: a "Source" link (the repository at the running tag) in Settings or About would make the network-use obligation easy for anyone who modifies pap.
6. Write a short ruling for e2e `data-*` hooks (M1), so the next journey author has one rule.
7. Refresh `m13-exit-criteria.md` with the CJ1 numbers of the final head (M7) when the controller writes the acceptance rows.

## Assessment

**Ready to merge: With fixes.**

- There is no Critical issue. The security core of the branch is sound:
  - B4's strict predicate, re-derived range by range, and the literal-IP refusal.
  - F1's readback.
  - C9's plain-text rendering.
  - B6's lockfile-pinned shrinkwrap.
  - B2's false-positive guards.
- Crash-isolation claims match their tests, apart from one overstated phrase (M7).
- The four Important issues are each small and local:
  - **I1** is a real taint gap in exactly the coexistence scenario that q12 made permanent. The fix is one condition, verified to flip only its own pin.
  - **I2** and **I4** turn CI red at the moment the owner flips for v1: the flip PR's unit job, then the nightly every night.
  - **I3** ships the first public release artefacts without their licences.
- None needs a redesign. Fixing them on the branch (or as one blocking task before `scripts/release-flip.ts` runs) makes the v1 exit claims true as written.
- The Minor items are docs truth and cosmetic and can ride along or follow.
