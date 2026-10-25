# SDD ledger — plan: docs/plans/2026-10-24-m14-multi-user.md

Spec: docs/specs/2026-10-24-m14-multi-user-design.md (decisions 126, 128). Owner: "Okay Go avec red team opus en plus ?" (2026-10-24 ~16:50) = plan + execution approved, plus an Opus red team (run on the plan before S1, the repo's milestone pattern: .superpowers/redteam-m14.md).
Worktrees: join /home/ubuntu/Workspace/soulkyu/pap-m14 (feat/m14); lanes from S1's head: pap-m14-a (feat/m14-a, daemon), pap-m14-b (feat/m14-b, web).
Models: Sonnet implementers and task reviews; Opus red team (plan) + one Opus final review (J3). Briefs: brief.sh <ID>. Templates: implementer-contract.md, reviewer-template.md, re-review-template.md, final-reviewer-template.md. Recon: recon-auth.md, recon-paths.md.
Post-merge root step (`sudo pap vm setup`, the relay changes): ask the owner at J3.

## Progress
Red team: dispatched (Opus, plan at eec7a44b)
Red team: done (.superpowers/redteam-m14.md): 2 C (RT-01 member reaches the owner's repos through the shared App JWT; RT-02 member budget ignores interactive spend), 10 I, 15 M; verdict ready after fixes. OQ1–OQ6 sent in form https://claude.ai/artifact/4B4Z9V9AN7YMr6A4q7qNnD (db doc answers/m14-redteam).
Planfix: dispatched (Sonnet). Controller rulings: apply every RT fix; drop Caller.role (RT-09, isMember/roleOf only); ops events → system:read, Health visible to members (RT-26); lanes:* in memberDenied; dispatcher ClientPath walk for members (RT-07), deps.isMember required; OQ defaults = recommendations until answered; A4→A4a/b/c, A5→A5a/b, new A6.
Planfix: done (plan 862 lines, committed 0ca4ea08; report .superpowers/planfix-report-m14.md); OQ1–OQ6 still unanswered → defaults (recommendations) applied, S1 unaffected
Ruling R1: S1 starts before the OQ answers — no OQ changes S1's shapes (OQ1 A4c, OQ2 A5b, OQ3 A6, OQ4 review models, OQ5 J2, OQ6 B2 copy) — cost if wrong: none for S1.
S1: dispatched (BASE 0ca4ea08, join worktree /home/ubuntu/Workspace/soulkyu/pap-m14, implementer a4d0c18209f56ff66)
Owner answers (17:08): OQ1–OQ6 = every recommendation (decision 129); plan updated; Opus task reviews for A1+A3 and A6 approved
S1: implemented 5f860508 (DONE_WITH_CONCERNS: daemon typecheck red — no handlers for users.*, sessions.availableModels, agents.packages; ClientPath not branded (brand broke daemon result schemas) — the dispatcher gate rests on collectClientPaths; raw path fields allow-listed in result/guest schemas; 4 error codes added to the web catalog; step-ups for users.invite / setDisabled(false) enforced in the service, not the contract; methods.ts 398; github/http.ts routes moved to system:admin / settings:operate)
Ruling R2: S1 adds compose-m14-pending.ts (typed "not wired" answers) so both lanes' root typecheck is green; lane A replaces it per method, J1 deletes it — same pattern as B2's githubPendingRpc — cost if wrong: none.
S1: follow-up 88d60f15 (compose-m14-pending.ts, unknown_method answers; root typecheck green; daemon.ts 397)
S1: review dispatched (Sonnet, 0ca4ea08..88d60f15)
S1: review: spec ❌ (I1 budget_cap copy lacks {cap}), quality needs fixes (I2 raw-path test greps files, exempts whole files — weak net for new methods); 8 minors; fix round 1 dispatched (FIX_BASE 88d60f15)
Ruling R3: the generic error sentence for budget_cap has no number (EN "Your daily budget is capped by the owner of this pap." / FR "Votre budget quotidien est plafonné par le propriétaire de ce pap."); the plan's {cap} sentence is lane B's, shown beside the budget field — generic error surfaces pass no params — cost if wrong: copy only.
S1: fix round 1/5 (I2 addressed by a params-schema walk + per-key allow-list + negative test; I1 per R3 already; controller-checked the allow-list; commits 88d60f15..c65fd229)
Carry to A3: vcs.fileDiff path/oldPath are repo-relative under a gated root — confirm `..` and symlinks cannot leave the root (existing confinement), test it for a member.
Task S1: minor (deferred): collector is a module global (sync parses only); a union can record a path twice (fail-closed); cwd fields in mcp/models/trust/skills now absolute; ClientPath not branded; users.invite declares limit_reached; no forbidden/not_found tests for setDisabled/delete in contracts; methods.ts 399
Task S1: complete (commits 0ca4ea08..c65fd229, review clean after round 1)
Lanes: pap-m14-a (feat/m14-a), pap-m14-b (feat/m14-b) from c65fd229
A1: dispatched (BASE c65fd229, lane a, implementer a699ab6f0c45fa25d)
B1: dispatched (BASE c65fd229, lane b, implementer a7eb5984fe365ce9c)
B1: implemented cbd16091 (DONE_WITH_CONCERNS: member can't see the cap on load (no contract field); token dialog offers system:read to members (held), filters pi:* and system:admin; only the Home host-terminal action hidden (surface/pane terminals are box terminals); unknown role → member view; member picker uses sessions.availableModels {}, owner keeps models.available; New project already Empty/GitHub only (test pins it); budgets green 243.6/250)
Ruling R4: A4c adds `dailyBudgetCapUsd: number | null` (null = no cap / owner) to the automation settings view in contracts; B's cap line reads it on load; J1 checks the pair — RT-06c wants the effective value visible — cost if wrong: one optional field.
A1: implemented 1e4b99c6 (DONE_WITH_CONCERNS: setDisabled(true) also deletes the member's sessions and tokens (enable restores sign-in only); `user add --role member` refused with no user; disabled check in startSession (password, passkey verify, setup) after a correct credential; token cap via role-aware ownerPermissions(userId); AuthUserRow not exported until A5a; related run 3179 pass after 3 position/usage test updates)
Ruling R5: disable revokes credentials for good; Enable restores sign-in only (spec "Enable reverses it" = account usable again) — security first — cost if wrong: a re-enabled member signs in again and re-creates tokens.
A1: review deferred to the Opus A1+A3 review (OQ4)
B1: review: spec ❌ (I1 persist/item-path not role-filtered; I2 other terminal entries), quality needs fixes; 5 minors; fix round 1 dispatched (FIX_BASE cbd16091) + chip primitive, RoleContext default member, refused reset
Ruling R6: a member keeps a terminal entry only with a box context (session/project root that is a box project); generic or host-folder entries are hidden — the daemon gate refuses host anyway, UX should not offer it — cost if wrong: a member opens a box terminal from the project home instead.
B1: fix f5f87870 (restrict(role) on shell mount, deep links rewritten, terminal entries gated by box context, Chip beside the account icon, defaults member); re-review dispatched
A2: dispatched (BASE 1e4b99c6, lane a, implementer aaf6d7089e2199af2)
B1: fix round 1/5 (I1, I2, minors addressed; commits cbd16091..f5f87870)
Task B1: minor (deferred): lane terminal "new here" not role-gated (lanes:* denied to members, never reached); URL normaliser redirects an owner's /settings to /settings/appearance; member terminal test covers helpers only; Chip beside the account icon (Menu takes strings); PROPRIÉTAIRE width in the narrow rail unchecked visually
Task B1: complete (commits c65fd229..f5f87870, review clean after round 1)
B2: dispatched (BASE f5f87870, lane b, implementer ae45e9bf73c26256a)
A2: implemented e487c0f6 (DONE_WITH_CONCERNS: no RED evidence (implementation before first run); failures answer {error:{code}} like every auth route (web reads error.code); InviteView/Invites exports for A5a; A5a passes the caller's origin; createAuthTestHarness does not mount invite routes; tests share IP bucket "unknown")
Ruling R7: invite routes answer `{ error: { code } }` like every auth route — the web reads error.code; the plan's literal `{error:"invite_invalid"}` was shorthand — cost if wrong: none.
A2: review dispatched (Sonnet, 1e4b99c6..e487c0f6); A2's own related run still queued on the heavy-gate lock
B2: implemented abe123f4 (DONE_WITH_CONCERNS: initial bundle 244.2/250; whenText/formatUsd duplicated (feature boundaries); extra EN/FR copy (intro, loading, failed, retry, cancel, done, owner no-cap line, budget invalid/saved, empties); disable without step-up (contract: only invite, enable, delete); provider switches all labelled Shared)
B2: review: spec ✅, quality needs fixes (I: provider switches all named Shared); 7 minors; fix round 1 dispatched (FIX_BASE abe123f4)
A2: review: spec ✅, quality approved; 9 minors
Carry to A5a (from A2 review): user_invited / member_created audit details {inviteId, memberId}; revokeInvite writes an audit row; export InviteView from auth/index.ts; caller origin to invites.create
Task A2: minor (deferred): accept can commit the member then fail in startSession (invitation consumed, no session); used/expired rows never purged; behind a reverse proxy one shared throttle bucket; no expired-on-accept / token-not-in-logs / origin-guard tests
Task A2: complete (commits 1e4b99c6..e487c0f6, review clean)
A3: dispatched (BASE e487c0f6, lane a, implementer a97d9c14cdd8cbbbb); review = Opus A1+A3 together (OQ4)
A2: controller ran invites.test.ts + invite-http.int.test.ts: 2 files, 10 tests passed
B2: fix round 1/5 (I addressed: "{provider}: Shared" label + unique-name test; minors 2-4 taken; commits abe123f4..801bfd41, controller check)
Task B2: minor (deferred): whenText now 5 copies in features/ (move to lib/format later); review minors 1, 5-7
Task B2: complete (commits f5f87870..801bfd41, review clean after round 1)
B3: dispatched (BASE 801bfd41, lane b, implementer a0f8596b6e02a5544)
B3: implemented f264c799 (DONE_WITH_CONCERNS: no RED evidence; signed-in copy 'Signed in as {name}. Accepting signs {name} out.' CONTINUE/GO BACK; loading line; /invite without token → invite_invalid; no socket in the invite flow; token kept in a module variable (StrictMode double init); bundle 244.7/250)
B3: review: spec ✅, quality needs fixes (I: transient inviteInfo failure shows the final invite_invalid view with no retry); 5 minors; fix round 1 dispatched (FIX_BASE f264c799) + heldToken cleared, password cleared after the passkey step, hashchange re-read
B3: fix 9a567412 (retry for 429/offline honouring Retry-After, forgetInviteToken on accept/invalid/back/passkey done/leave, password cleared on accept, hashchange re-read; bundle 244.8/250)
B3: fix round 1/5 (I, token, password, hashchange addressed; commits f264c799..9a567412)
Task B3: minor (deferred): gate state keeps the spent token as a prop until refresh (memory only); 429 wait timer edge on check identity change; no RED evidence on the first commit
Task B3: complete (commits 801bfd41..9a567412, review clean after round 1)
Lane B: complete (head 9a567412)
A3: implemented bb620c57 (DONE_WITH_CONCERNS: tests written after code, mutation-checked (12 fail with the gate broken); lanes.create/runScript refuse any member outright; /upload, /agent-files, GitHub routes pass NO_CLIENT_PATHS; project-link keeps non-throwing boxCwdOf (ensure refuses); compose-auth.ts split (daemon.ts 399); gate wired in daemon.ts; vcs.fileDiff RepoPath rejects .. and the host never touches the guest path)
Found: daemon.migrations + compose-m11 order tests red since A2 (invitations migration not listed; tail-based slices). Controller fix 2ac29ef6 + 1b?: lists name it, the m11 test anchors on names (no more tail arithmetic). Note: my first commit went in with the m11 test still red (exit masked by a pipe) — fixed in the next commit.
A1+A3: Opus review dispatched (a57e840139354a08e)
A6: dispatched (BASE a6ae205c, lane a, implementer a3d304efc79ae5658) in parallel with the read-only A1+A3 review; review = Opus (OQ4)
A6: implemented 918e6a5e (DONE_WITH_CONCERNS: create/link check fresh (no cache), deliver() caches 10 min; outage keeps the last decision unbounded; lost access also revokes the last box token; fake-github-access.ts split (fake-github.ts 394); cache not evicted per owner (A5b))
A6: Opus review dispatched (a4804fa9ab46121c5)
A1+A3: Opus review: A1 spec ✅ quality needs fixes (I1: isMember = role==="member", so an unknown/deleted id passes every gate as owner); A3 spec ✅ quality approved; 11 minors; RT-07/09/21/25 closed; 27 files 187 tests green. Fix round 1 dispatched to the A1 implementer (head 918e6a5e): fail closed (gate = "is owner"), setDisabled in one transaction, disabled-check tests independent of revokeAll, check subagents/profiles.ts pi.trust.status and policy projectScopeOf for host fs with a box folder
A6: Opus review: spec ❌, quality needs fixes. C-1 (pre-existing B2 flaw made exploitable by M14): the GitHub authorize callback binds a token by `state` alone → a member sends their authorize link to the owner, the owner's GitHub token lands on the member's account → access check passes for owner repos (reopens RT-01). I-1: prCreate pull_requests:write mint and read mints (lists, checkLog, sendToSession) skip the check. I-2: stale "allowed" kept forever on rate limit/outage (member-triggerable); 401 mapped to github_unavailable. 9 minors.
Ruling R8: the authorize callback no longer binds: it exchanges the code and parks the result under the state (5 min, single use), then serves a page that navigates (same-site, so the SameSite=Strict cookie is sent) to a finish route (`POST /github/app/authorized/finish` from the app, or a GET page that posts) where caller.userId must equal the state's starting user; mismatch → discard + audit, never bind. One mint chokepoint `mintFor(ownerId, repo, perms)` runs the cached access check before every App mint. Stale window ≤ 60 min, then refuse; 401 on the user token = lost access — security first — cost if wrong: one extra click/redirect at GitHub connect.
A6 fix round 1: queued until the A1/A3 fix round (same worktree) commits
A1+A3: fix a64ed854 (isMember = roleOf !== "owner" (unknown ids gated); disableAndRevoke one transaction; raw disabled tests; profiles runsInVm true for gated owners (no host trust.status); project-link + triggers return null before projectScopeOf for gated owners). Note for A4c/A5: "is a member row" = roleOf === "member", not isMember.
A1+A3: fix round 1/5 (I1, R5, tests, profiles/projectScopeOf addressed; commits 918e6a5e..a64ed854)
Task A1: minor (deferred): deleteUser revokeAll + delete not in one transaction (fail-closed anyway); auth/service.ts 347; findByHash reads role via roleOf
Task A3: minor (deferred): no triggers test for the gated-owner scopeOf skip; runsInVm name stretched; 11 review minors in task-A1A3-review.md
Task A1: complete (commits c65fd229..1e4b99c6 + a64ed854, Opus review clean after round 1)
Task A3: complete (commits e487c0f6..a6ae205c + a64ed854, Opus review clean after round 1)
A6: fix 7d256a7f (callback parks the pair 5 min single use; GET /github/app/authorized/finish?state= same-site (meta refresh + Continue link) binds only when session user = starting user, else github_link_refused audit; core.mintFor runs the access check before every mint (module scan test); stale ≤ 60 min; 401 = lost access; minors M1 M2 M3 M5 M8 done; M4 M6 M9 open; github-bed finishes with the owner's cookie)
A6: Opus re-review dispatched (a89a7c813da0a77fe)
A4a: dispatched (BASE 7d256a7f, lane a, implementer a66ad5672768f0dcf)
A6: Opus re-review round 1: I-1, I-2, M1 M2 M3 M5 M8 ADDRESSED; C-1 NOT ADDRESSED — race: the member (starting user) polls /finish?state=S with their own cookie; once the owner clicks, the owner's token parked under S binds to the member. R8 as written has this flaw.
Ruling R9 (amends R8): the callback parks the pair under a fresh 128-bit ticket handed only to the callback's browser (redirect to /github/app/authorized/finish?ticket=…); finish needs the ticket AND session user = starting user; a finish with no session cookie does not consume (Continue link retries until the 5-min expiry); a different authenticated user consumes and refuses (audit github_link_refused); state alone never finishes — security first — cost if wrong: none (one more random id).
A6 fix round 2: queued until A4a (same worktree) commits
A4a: implemented d1e6a08f (DONE_WITH_CONCERNS: no RED evidence; status words "set"|"missing" (existing enum); box_policy keeps `claude` next to `claudeToken` (bridge w/o token → no_claude_token, not model); daemon.ts at exactly 400 (migrateLegacy line); compose-agents-vm-late.test.ts 400; agents.packages built (user-scope plugins.list via helper, no folder); 2 stale expectations fixed after the related run)
A6: fix round 2 dispatched (R9 one-time ticket) on d1e6a08f
A4a: review: spec ✅ (status set|missing, claude kept), quality approved; 7 minors
Carry to A4b (from A4a review): M2 send claudeToken only when the box/agent declares the bridge (`claude ? token : null`); M3 agents.packages `source` max 1024 vs helper 2048 → align (2048) or truncate; M4 ClaudeTokens.get must not turn a vault failure into "missing" (distinct state, one warning)
Task A4a: minor (deferred): claude=false for a tokenless member → refusal reason `model` not `no_claude_token`; no boot test for migrateLegacy; no RED evidence; agents.packages shares the helper pool
Task A4a: complete (commits 7d256a7f..d1e6a08f, review clean)
A6: fix round 2 f31fba71 (ticket parking, state alone → 400, no-session keeps the ticket, mismatch consumes+audit, MEMBER_COOKIE bed, fork test acme/vault, link path no lookup before check); Opus re-review 2 dispatched
A4b: dispatched (BASE f31fba71, lane a, implementer aaf2c9bc140c1eac9) with A4a carries M2 M3 M4
A6: Opus re-review round 2: C-1 ADDRESSED (ticket 128-bit, single use, 5 min, never logged, no-referrer, CSP default-src 'none', cap 32 parked), fork + link-path test fixes ADDRESSED, no new C/I (commits 918e6a5e..f31fba71 over 2 rounds)
Carry to J1 (from A6 re-review 2): per-user caps for stored states (64) and parked tickets (32) — a member can evict the owner's pending sign-in (DoS only, no mis-binding)
Task A6: minor (deferred): M4 double log every 60 s while access is lost; M6 docs (J2); M9 box tokens delivered before a daemon restart never revoked (expire ≤ 1 h); member-poll test lacks the github_link_refused assertion; expiry not exercised on the no-session path; projects.github not_found when the owner's own token needs reconnect
Task A6: complete (commits a6ae205c..918e6a5e + 7d256a7f + f31fba71, Opus review clean after round 2)
A4b: implemented 803cc55c (DONE_WITH_CONCERNS: no RED; M4 partial (read() set|missing|unreadable, wire enum still set|missing); no audit row for setProviderShared (audit reasons enum in contracts → A5a); auth kind from models.overview (checkAuth would run !command keys); 60 s overview TTL + reset on models.onChanged; daemon-setup-url.ts split (daemon.ts 397); testing/late-bed.ts; users/index.ts exists (A5a merges exports); 6 stubs left)
Carry to A5a: audit reasons (contracts) for user admin actions incl. setProviderShared, setBudget, setDisabled, delete, revokeInvite, user_invited/member_created details
A4b: review dispatched (af12f2d19cda18911); A4c: dispatched (BASE 803cc55c, lane a, implementer a77456a9d9ee3b533)
A4b: review: spec ❌, quality needs fixes (I-1: first-sight sharing row written lazily on member evaluation → an OAuth→API-key change before any member call shares silently (RT-16)); 7 minors; fix round 1 queued after A4c (same worktree): write default rows for every provider whenever the overview is built + a test with no member call in between
A4c: implemented 3fafe08b (DONE_WITH_CONCERNS: RED first ✓; disabled→paused left to A5a (needs disabled(userId) in settingsMembersOf + effective); member timezone = owner's for every gate incl. quiet hours (editor shows the saved zone); live runs count while running; claude-bridge excluded; overshoot ≤ one run; memberSpentToday on the MemberLine built inline in daemon.ts bindLate (A5a hoists); daemon.ts 399; compose-boxes-budget.int.test.ts; ADR 0085 must state OQ5)
Carry to A5a: disabled(userId) → settings.automation().paused + effective; hoist MemberLine for UserView.spentTodayUsd
A4b: fix round 1 dispatched (on 3fafe08b); A4c: review dispatched (a89f65c0ddd6aff94)
A4c: review: spec ✅, quality needs fixes (I1: bridge exclusion keyed on provider for live runs but on VM billing for finished runs → a subscription-only member may count; I2: member quiet hours moved to the owner's zone while the editor shows the member's); 8 minors
Ruling R10: only the member's budget DAY uses the owner's zone, at one seam: RunsPort.spentToday (and the member line) computes the day in the owner's zone for a member; SettingsService.automation(id).timezone stays the member's own (quiet hours, triggers, editor) — RT-06b wanted the budget day fixed, not the member's clock — cost if wrong: none.
A4c fix round 1: queued after the A4b fix round (same worktree): I1 provider filter in spentApiSince with one shared constant + finished-bridge-run test; I2 per R10
A4b: fix df14c025 (onSeen seeds default rows at overview build; gate.reset at bind + models.onChanged; sharedFor requires api_key for members; M-2 M-4; login-flow asserts 'no credential'); accepted gap: a sign-in with no onChanged and no read until the 60 s TTL
A4b: re-review dispatched (a436f4f0825b8dcbc); A4c: fix round 1 dispatched (on df14c025)
A4b: re-review: I-1 ADDRESSED, M-1 ADDRESSED, empty auth.json harmless, login-flow change fair; NEW I-A: provider-gate reset() 'void kinds.get()' + build() → onSeen → sharing write can throw (SQLITE_BUSY, disk full) → unhandled rejection → daemon exit. Controller tiny fix queued after A4c: try/catch around onSeen with logger.warn + .catch in reset(), with a test.
A4b: controller fix 993fe880 (try/catch around onSeen with provider_sharing_seed_failed; reset() catches; test RED without the fix, green with it); fix round 1/5 done (I-1, M-1, I-A addressed)
Task A4b: minor (deferred): out-of-band sign-in (no onChanged, no read within 60 s TTL) can miss first sight; empty auth.json created at boot read (harmless); claude-bridge literal duplicated (users/provider-sharing.ts, agent-vm/image-inputs.ts → CLAUDE_BRIDGE_PROVIDER); M4 wire enum unreadable state deferred; no audit row for setProviderShared (A5a)
Task A4b: complete (commits f31fba71..803cc55c + df14c025 + 993fe880)
A4c: fix 31c363ab (CLAUDE_BRIDGE_PROVIDER constant in contracts, provider filter on finished runs too; R10 seam RunsService.bindBudgetZone; member timezone stays own); re-review dispatched
A4c: re-review dispatched (a5c0abebd4a0411eb); A5a: dispatched (BASE 993fe880, lane a, implementer aadccc15d2f2b70fd)
A4c: fix round 1/5 (I1, I2/R10, doc addressed; commits df14c025..31c363ab)
Task A4c: minor (deferred): runs/agent-spend.ts per-agent limits use the caller's zone; live spend unbounded by the day; overshoot bounded by the 60 s tick; blocked:"budget" also blocks the member's own bridge use; usage summary reads the caller's zone; ADR 0085 must state OQ5 + forgeable provider label
Task A4c: complete (commits 803cc55c..3fafe08b + 31c363ab, review clean after round 1)
A5a: implemented 0bb652f2 (DONE_WITH_CONCERNS: no RED; failed VM stop during disable answers internal after revoke (idempotent retry); launch gate inert before bindLate; composeUsers tested by parts; invite cap 50 pending (limit_reached); also did github.forget all users, push boot loop, owner-secrets caps scale; daemon.ts 400)
A5a: review dispatched (a07fe9f58ad98f9ac); A5b: dispatched (BASE 0bb652f2, lane a, implementer a8e6a182baa456ddf)
A5a: review: spec ✅, quality approved; 6 minors; 12 named files 74 tests green
Carry to J1 (from A5a review): launch gate fails CLOSED before bindLate (sandbox_unavailable), not open (compose-agents-vm.ts disabledBox ~335); re-check the disabled gate right before spawn in guardedLaunch.spawn (compose-agents-vm-status.ts) to close the disable-during-await window; J1 matrix covers users:* denial for members through the dispatcher
Task A5a: minor (deferred): 4 more in task-A5a-review.md; invite cap 50 is a controller-accepted addition
Task A5a: complete (commits 993fe880..0bb652f2, review clean)
A5b: implemented 25639bdd (DONE_WITH_CONCERNS: full-schema scan test in src/daemon.users-delete.test.ts (needs MIGRATION_SOURCES); GitHub key DELETE refused → delete goes on, logs user_delete_github_keys_left; AgentId accepts 4-hex and 8-hex, slugs cut to 39; agent_trash rows deleted, disks left to vmd's 7-day sweep; compose-m14-pending removed; daemon.ts 399, agents/service.ts 396, sessions/service.ts 397)
Found: security/automation-crash.int.test.ts 2 failures (workers() returns a pid) also on 0bb652f2 → J1 must bisect lane A or confirm a flake/env leftover process
Found (controller bisect): automation-crash.int "starts no worker" red since df14c025 (A4b fix's boot overview read spawns a Pi helper); f31fba71, 803cc55c, 3fafe08b green.
Ruling R11: no provider overview read at boot; default sharing rows are written at every overview build and on models.onChanged (a pap logout seeds "not shared" before a key is set) — a boot read starts a helper and breaks the crash-restart guarantee — cost if wrong: an out-of-band OAuth→key switch with no read in between shares by default (accepted gap, owner can unshare).
R11 commit: see log (compose-agents-vm-late.ts: bind no longer calls providers.reset()); crash test + users + late tests 8 files 66 green
A5b: review: spec ✅, quality needs fixes (I: delete.ts trashAll before automation.removeAll → busy agent task → session_busy → account stuck disabled, undeletable); 5 minors; fix round 1 dispatched next
A5b: fix round 1/5 (Important addressed: automation.removeAll before agents.trashAll, busy-agent + retry tests; minors: forced disable audit, key ids in the warning; commits ee78157c..1f6171cf, controller check); crash test 5/5 on the head (the agent's "still failing" was from a stale baseline)
Task A5b: minor (deferred): attachment folders of sessions removed earlier wait for the retention sweep; 7-day vmd/agent trash keeps member data; full-schema scan fakes most modules
Task A5b: complete (commits 0bb652f2..25639bdd + 1f6171cf)
Lane A: complete (head 1f6171cf)
J1: dispatched (merge lane A 1f6171cf then B 9a567412 into feat/m14 at c65fd229, implementer a2fc6d9a1f12984fa)
J1: implemented — merges (no conflicts) + fbf1f60b (launch gate fails closed before bindLate, re-check before spawn, GitHub states/tickets capped 8/user + global) + ebb4be37 (6 journey files m14.matrix/routes/members/disable/claude/github; inspect.routes(); daemon.ts 400). 9 files 40 tests green; budgets green. Concerns: security/agent-budget.int flake at the UTC day boundary (pre-existing, clock advance crosses midnight); METHOD_CLASS derived from typed lists (compile-time exhaustive); disable journey drives fire, queued tasks, launch gate (reminders/resume via the same paused check, unit-tested)
Found: security/agent-budget.int.test.ts flakes when the advanced clock crosses the zone midnight (pre-existing) → fix in J3's fix wave (pin the test clock away from midnight)
J1: review dispatched (a61173ba83597619a); J2: dispatched (a91a32f92374f4380) in parallel (docs only)
J1: review: spec ❌ (journeys thinner than the brief), quality needs fixes: I1 scanner test can't tell role='owner' from oldest row; I2 bridge test checks the policy flag only (no member sessions.models/availableModels listing the bridge); I3 disable journey lacks a queued task, reminder, usage-limit resume; I4 delete journey seeds no vault/push/inbox/token/search/attachment rows (vacuous) + step-up accepts ok; I5 canary: no live owner frames while the member is subscribed; 8 minors. Fix round 1 queued after J2 commits (same worktree). Also check: boot-time box restore before bindLate now refused sandbox_unavailable?
J2: implemented 4aeb63ce (ADR 0085 + index; auth, agents-vm, finops, web, automation notes; stale B2 text fixed (private App, state-only callback, claude-token file); AGENTS.md M14 section; decision 130 "merge sha: pending" + decision 129 row copied (branch predates 32ebd21b — keep one copy at the main merge); roadmap; docs/README.md). Doc tests 3× green. To verify at J3: web.md owner-row claims.
Task J2: complete (commit 4aeb63ce, controller check at J3)
J1: fix round 1 dispatched (on 4aeb63ce)
J1: fix round 1 390d7be6 (I1 owner youngest + mutation red; I2 member availableModels lists claude-bridge; I3 queued reminder + quota resume + worker kill, owner control; I4 real rows of every kind seeded, step-up strict; I5 live owner frames vs member subscriptions; boot restore: nothing launches before bindLate + test; minors; agent-budget flake fixed (no start within 1 h of UTC midnight)). Concerns for the final review: POST /upload accepts any sessionId (member stages a file under the owner's session id folder; owner can't claim; member budget), project box tokenless → relay reason `model` not no_claude_token.
Ruling R12: J1's scoped re-review folds into the Opus final review (the last diff of the branch; same coverage, one less dispatch) — cost if wrong: none.
J3: Opus final review dispatched (whole branch merge-base..390d7be6)
J3: final review (Opus): needs fixes, 0 C, 1 I (I1: the image secret scan uses every user's vault values ≥ 8 chars; a member's ordinary value (NODE_ENV=production) matching the shared profile fails every launch install-wide; a damaged member vault fails closed too), 8 minors; POST /upload with a foreign sessionId is NOT a finding (pending/<random>, claim needs uploader + own session).
Ruling R13: the shared-profile secret scan uses install values only (Pi auth.json, App secrets, live GitHub and box tokens, the OWNER's vault); every user's values stay in the relay log redactor; an unreadable member vault is skipped with a warning — members cannot write ~/.pi/agent, so their values can only false-positive; deviates from spec §7 ("every user's vault"), recorded in ADR 0085 — cost if wrong: a member secret pasted into the owner's profile by the owner would not be caught (the owner's own vault still is).
J3 fix dispatch: I1 per R13 + minors (disabled(unknown) = true; github_link_refused also in the session user's audit; ADR 0085: owner reads members' data on disk + R13; update.md: rollback below M14 loses the owner's Claude token (file migrated to the vault))
J3: final fix dispatched (a230b52d32a7f4dd0, on 390d7be6)
J3: final fix 5e71aaaf (R13 scan sources; disabled(unknown)=true; link_refused in both audits; sessions.commands/subagents.profiles probed; ADR 0085 + update.md notes); vault-store.ts 400
J3: main merged into feat/m14 (de47724b, decisions-log conflict: one 129 row + 130)
J3: final re-review: all 5 ADDRESSED, no new C/I (db always passed in production, daemon.ts:120-122)
J3: gate on de47724b: lint red (lane B: lib/RoleChip.tsx imports i18n, lib/box-path.ts imports stores — boundaries) → moved to routes/shell/RoleChip.tsx and stores/box-path.ts; lint, format, typecheck, knip, budgets green; web shell+terminal 69 files 400 green
J3: squash 7ea23ea0 on main (tree = feat/m14 4b341dc8); build + smoke green; DB backup /home/ubuntu/.pap/backups/manual-pre-m14-20261025T011135Z.db; awaiting owner OK for sudo pap vm setup
J3: owner OK for sudo pap vm setup (2026-10-25)
J3: preview stopped; sudo pap vm setup --dev-from-tree done (owner OK); preview started (migrations user_roles, invitations, provider_sharing applied; claude_token_migrated); doctor all ok (vm.bundle ok); pushed main 32ebd21b..7ea23ea0
Found (pre-existing, not M14): agent_image_entries_damaged at every boot since 2026-10-24 14:48 (pick-map.ts load: the image entries file fails its shape check) → later lot
Task J3: complete (merge 7ea23ea0)
