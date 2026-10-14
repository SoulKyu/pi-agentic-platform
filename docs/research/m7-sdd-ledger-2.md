# M7 SDD ledger, part 2 (archived 2026-10-14)

Continued from [m7-sdd-ledger.md](m7-sdd-ledger.md): Tasks 8–30, the rebase on M8, the two parallel lanes and their three joins, the minor sweeps, the flaky-test work, the final review, its single fix round and the final re-review.

Task 8: dispatched implementer (Sonnet), BASE 866cd5b; carries: harden kernel/helper/pool.int.test.ts flake (real 800 ms deadline); its own error codes per plan (helperErrorCode mapping)
Task 8: implementer
Task 8: implementer DONE_WITH_CONCERNS (02f405f) — unit 7507, int 454+1, smoke ok, bundle 196.4; 3 error codes added; pool.int flake fixed (flush before exit; 5/5 clean runs); !cmd guarantee from Pi checkAuth (pinned by test); refreshCatalog helper_failed when all fail; cwd covers folders inside a project. Review dispatched (Sonnet).
Task 8: review (Sonnet) Needs fixes — 3 I:
- I1: the `!cmd` pin covers only the overview's models.json apiKey. There is no refresh-path or real-runtime test, nothing on auth.json `!cmd` keys, headers or setDefault.
- I2: refreshCatalog fails when ANY provider fails and nothing changed, although its comment and test claim "every provider failed".
- I3: the flush fix was in the test-only op; the held-deadline clock matches magic durations.
- Ruling MC24 [8]:
  - I1: overview and defaults (incl. setDefault) never resolve a `!cmd` key or header. Tests for every field: models.json apiKey and headers, auth.json stored keys.
    - Refresh is an explicit `pi:admin` owner action. It may resolve the owner's OWN `!cmd` keys (global config, trusted projects), as Pi does when calling a provider, but NEVER keys from an untrusted project's config.
    - Add a real-runtime refresh marker test in both cases, with the network guard on. If the untrusted case runs the marker, skip providers whose key or header comes from untrusted project config before `refresh`.
    - Document the behaviour in the models section of docs.
  - I2: fail only when ALL asked providers failed. Otherwise answer with a partial flag naming the failed providers (no secret). Two-provider test.
  - I3: import the pool's drain constant (or make it an option). State in the fix commit that the defect was in the test op.
  - Why: `!cmd` is code execution. The owner's own config is trusted; a repo's is not. Cost: none for the owner.
Task 8: fix round 1/5 → resume implementer
Task 8: fix round 1 DONE (bef1c20) — REAL BUG fixed: overview ran an auth.json !cmd via Pi checkAuth; now reads auth.json itself; marker tests per field; refresh failedProviders; STDIO_DRAIN_MS imported; unit 7511, int 454+1. Scoped re-review (Opus — code execution).
Task 8: re-review 1 (Opus) — I2, I3 addressed; N1 (I1 still open): auth.json with a UTF-8 BOM → pap reader JSON.parse fails → falls back to checkAuth → command runs (real SDK, online and offline). Ruling MC25 [8]: the overview NEVER calls checkAuth (no fallback at all); 'configured' comes only from pap's own reading (strip a leading BOM like Pi; an unreadable/unparseable file → status 'unknown', never a Pi call); BOM + unreadable marker tests; mutation (re-add the fallback) fails. Fix round 2/5.
Task 8: fix round 2 DONE (adbdb61) — overview never calls checkAuth/listCredentials; auth.status known|unknown; BOM stripped; marker + spy tests; unit 7517, int 454+1.
- Ruling MC26 [8, 13]: env-variable sign-in is shown from a pap-side table of known env var NAMES per built-in provider (presence only, never the value, nothing executed), sourced from Pi SDK exported data if available, else a documented constant — CARRY to Task 13 (overview field + UI copy for `unknown` and env sign-in, en/fr).
Scoped re-review 2 dispatched (Opus).
Task 8: re-review 2 (Opus) — N1 addressed (no !cmd anywhere, real SDK). N2 (Important, correctness): readJsonObject (models-open.ts:93) rejects models.json with // comments / trailing commas that Pi accepts (model-config.js:265) → false 'unknown' and wrong configured:false. Ruling MC27 [8, 12a]: one parseJsonc mirroring Pi's model-config tolerance (comments + trailing commas, BOM), used by the overview now and by Task 12a's scanJsonc later; tests with Pi-valid JSONC fixtures. Fix round 3/5.
Task 8: fix round 3 DONE (5a225d4) — jsonc.ts mirrors Pi (BOM, // outside strings, trailing commas; block comments rejected like Pi); 12 tests vs Pi's own loader; unit 7529. Flake again: pool.int 'stopAll kills a running helper and its group' failed once in the full run (13/13 alone ×2) → CARRY to Task 11: make it deterministic. Scoped re-review 3 (Sonnet).
Task 8: re-review 3 (Sonnet) All addressed — regexes identical to Pi, linear on 1 MB hostile input. MC27 text corrected (Pi rejects block comments).
Task 8: complete (02f405f, bef1c20, adbdb61, 5a225d4) — 3 fix rounds; real bug found and fixed (overview ran auth.json !cmd)
Task 9: dispatched implementer (Sonnet), BASE 5a225d4
Task 9: implementer
Task 9: implementer DONE_WITH_CONCERNS (de8fdaa) — unit 7564, build-output int 24; initial bundle 196.5 unchanged, session chunk 38.5→40.7, model menu lazy 2.7 KB; link to /settings/models before it exists; no role=group (existing test); use-action describe param. Review dispatched (Sonnet).
Task 9: review (Sonnet) Approved after 1 I (M7R51: pills must use label-hud mono uppercase); /settings/models dead until Task 13 (check at merge); small fix round 1 (+ minors: truncation copy, cold current row, Composer test selector).
Task 9: small fix (744103e) — controller verified: label-hud in ModelBar.tsx:71/81; ModelBar + Composer tests 40/40.
Task 9: complete (de8fdaa, 744103e)
Task 10: dispatched implementer (Sonnet), BASE 744103e
Task 10: implementer
Task 10: implementer DONE_WITH_CONCERNS (4c9e267) — unit 7632, int 454+1; every row checked vs Pi resolveModelScopeWithDiagnostics; async plan + refused too-large (>256); resync carries providers[] (CARRY to Task 12a: compute from overview enabled flags); re-resolve before write; docs → Task 30. Review dispatched (Sonnet).
Task 10: review (Sonnet) Needs fixes — deviations accepted; 2 I: lost update on two overlapping setEnabled (read → plan → whole-field write, pool of 4); settings.json written by Pi's SettingsManager with the guard only before the write (plan-mandated, same as Task 8).
- Ruling MC28 [10]: the models service serialises every Pi settings write (one chain per agent dir in the daemon; a write waits for the previous one; bounded queue that refuses when full with `capacity`), with a two-overlapping-calls test; `guardFile` re-runs immediately before `commit`; the SettingsManager-write deviation is stated in docs/ADR (Task 30 picks it up if not now).
Task 10: fix round 1/5 → resume implementer
Task 10: fix round 1 DONE (2f25bb4) — one write queue (max 8 → capacity), guardSettingsWrite before each SettingsManager.set*; docs daemon.md; int two-overlapping test; unit 7639, int 455+1. CARRY to Task 13: disable a switch while its write is pending (burst > 8 → capacity); Task 30: ADR for the SettingsManager-write deviation. Scoped re-review (Sonnet).
Task 10: re-review 1 (Sonnet) All addressed.
- Ruling MC29 [15, 18, 22, 24, 25]: any later task that writes Pi settings goes through the models service's write queue — lift it into a shared Pi-settings queue (daemon) at the first such task; never a second unsynchronised writer.
Task 10: complete (4c9e267, 2f25bb4)
Task 11: dispatched implementer (Sonnet), BASE 2f25bb4; carries: step-up per c3 verified here; pi-file 'hard-link' → fixed message
Task 11: implementer
Task 11: implementer DONE_WITH_CONCERNS (b41137b) — unit 7740, int 460+1, smoke ok, bundle 197.4; stored !cmd never resolved; auth.json forced 0600; logout no step-up (M7R133); 60 s no-subscriber rule only for the first subscriber.
- Ruling MC30 [rebase on M8]: the ws dispatcher's idempotency receipt hashes request params incl. an API key / manual code (kernel/ws is M8's — agreement 12, M7 cannot edit it now). At M7's rebase on M8: add a per-method `sensitiveParams` flag in contracts so the dispatcher's receipt hashes a constant (or the commandId only) for those methods; until then documented in daemon.md. REBASE-BRIEF item.
Review dispatched (Opus).
Task 11: review (Opus) Needs fixes. Named risks held: no leaks, no !cmd, step-up, 0600, owner-scoped flows, owner-typed `!` keys refused.
- I1 (M7R60): a written credential is not audited when Pi's model sync fails (CredentialSynchronizationError, reproduced: auth.json holds the key but pap answers helper_failed), nor on a cancel that races success.
- I2 (plan-mandated M7R59): the 60 s rule stops at the first subscriber; a reload mid-flow leaves the provider slot busy for up to 10 min with no way to cancel.
- Ruling MC31 [11, 13, rebase]:
  - I1: apply the reviewer's fix. CredentialSynchronizationError counts as success (log the provider only), and any ok helper result is audited, even after a cancel. Tests from the probe; change login-flows.test.ts:276.
  - I2: add an owner-scoped `models.cancelLogin({ provider })` that cancels the caller's own live flow for that provider (pi:admin, idempotent:false, no step-up, as a removal). CARRY to Task 13: keep the flow id in sessionStorage so a reload re-subscribes or cancels. REBASE-BRIEF item: a hub "last subscriber left" hook (kernel/ws is M8's) to restore the 60 s rule after a disconnect.
Task 11: fix round 1/5 → resume implementer
Task 11: fix round 1 DONE (def5d12) — sync error = success, audit once on any ok result, models.cancelLogin(provider) owner-scoped; unit 7748, int 460+1; 1 equivalent mutant. Scoped re-review (Opus).
Task 11: re-review 1 dispatched (Opus), diff review-b41137b..def5d12.diff
Task 11: re-review 1 (Opus) All addressed — minors m1–m6 parked (task-11-rereview-1.md). CARRY to Task 12a: m3 (conclude before reportSignedIn), daemon.md:128 + auth.ts:16 checkAuth statements rewritten (not appended). Task 13: keep models.loginCancel{flowId} vs models.cancelLogin{provider} apart.
Task 11: complete (b41137b, def5d12)
Task 12a: dispatched implementer (Sonnet), BASE def5d12; carries: pi-file realpath root check, hard-link residual doc + fsync-after-rename ok, resync providers[] from overview, Task 11 m3 + checkAuth docs rewrite
Task 12a: implementer
REBASE-BRIEF item (from M8 Task 12): daemon stop order on M8 is sessions.shutdownAll() → wk.shutdown() → killAllWorkerGroups() → closers; M7's helpers.stopAll() runs in parallel with sessions.shutdownAll().
Task 12a: implementer DONE_WITH_CONCERNS (26cd728, 7c00fbb, 9e0e8a4) — unit 7849, int 93 files ok, bundle 197.5; comment-held credentials redacted (stricter than brief table); revision = sha256 incl. secrets (offline guess oracle for pi:read → reviewer judges, HMAC option); receipt hashes save params → add models.saveConfig to MC30 rebase list; audit reason models_config_saved added; mutation script corrupted 2 files, restored by hand. Review dispatched (Opus).
Task 12a: review (Opus) Needs fixes (spec ✅) — I1 moved placeholder restored → plaintext key to browser/pi:read tokens (probed); I2 sha256 revision = offline oracle (pi:read is a token permission); I3 masking fails open on a broken file; I4 comment redaction misses env-style/camelCase keys, docs claim false; I5 queue not tested for configSave. Ruling MC32 [12a, 14].
Task 12a: fix round 1/5 → resume implementer
Task 12a: fix round 1 DONE_WITH_CONCERNS (33e1af3) — MC32 applied; unit 7900, int 93 files, bundle 197.6; residuals visible to pi:read (cmd literal, unnamed secrets, comment value on another line). Scoped re-review (Opus).
REBASE-BRIEF item (from M8 MC29): M7's helper entry calls pi-host's inherited-PTY-fd closer as its first statement.
Task 12a: re-review 1 (Opus) I1–I5 + m1–m9 ADDRESSED; minors N1–N6; concern 4 → ruling MC33 (models.config.get → pi:admin) + N1–N4, N6 in round 2; N5 parked.
Task 12a: fix round 2/5 → resume implementer
Task 12a: fix round 2 DONE_WITH_CONCERNS (3fecb33) — pi:admin, N1–N4, N6; unit 7909, int 93 files; residuals: value before word, split word. Scoped re-review 2 (Sonnet, small diff).
Task 12a: re-review 2 (Sonnet) Approved — minor: redactLine keeps '// "apiKey": "!op read x" "sk-abc"' → CARRY Task 30 (residual in daemon.md or tighter regex).
Task 12a: complete (26cd728, 7c00fbb, 9e0e8a4, 33e1af3, 3fecb33)
Task 12b: dispatched implementer (Sonnet), BASE 3fecb33
Task 12b: implementer
Task 12b: implementer DONE_WITH_CONCERNS (5661893) — unit 7959, int 465+1, bundle 197.9; discover extra code field; no audit for discover; models.test resolves !cmd key without step-up; pricing cache one entry. Review dispatched (Opus).
Task 12b: review (Opus) Needs fixes — spec ✅; I1 redirect refusal untested (works today via strictFetch, Pi-dependent). Ruling MC34 [12b, 14] (I1, pricing price-map cache 1 h, m1–m3, m5–m9).
Task 12b: fix round 1/5 → resume implementer
Task 12b: fix round 1 DONE_WITH_CONCERNS (2520418) — MC34 applied; unit 7971, int 465+1; m2 by rename; 307 pinned for openai/anthropic only (Google/Bedrock → CARRY Task 30 residual). Scoped re-review (Sonnet).
Task 12b: re-review 1 (Sonnet) Approved — minor: no in-flight dedupe on pricing cache (bounded by pool).
Task 12b: complete (5661893, 2520418)
Task 13: dispatched implementer (Sonnet), BASE 2520418; carries: MC26 env sign-in + unknown copy, switch disabled while pending (Task 10), flow id sessionStorage (MC31), /settings/models route live; design hygiene (label-hud, tokens)
Task 13: implementer
Task 13: implementer DONE_WITH_CONCERNS (896e62b, 8f363aa) — unit 8038, int 466+1, bundle 197.8 (chunk 12.4 lazy); env table copied from Pi private table; StepUpRunner injected from route; warnings not shown; one sign-in at a time in UI. Review dispatched (Sonnet).
Task 13: review (Sonnet) Approved — minors → CARRY Task 14: auto-select restored flow provider, links keyed by index, reactive doneText + clear auth link/device code after done.
Task 13: complete (896e62b, 8f363aa)
Task 14: dispatched implementer (Sonnet), BASE 8f363aa; carries MC32/33/34 UI + Task 13 minors
Task 14: implementer
Task 14: implementer DONE_WITH_CONCERNS (13a19b4) — unit 8087, bundle 197.8 (chunk 20.6 lazy); textarea closes without unsaved-edit ask; TextField gains mono/rows props (REBASE-BRIEF: union with M8's TextField passthrough props); weak doneText mutant. Review dispatched (Sonnet).
REBASE-BRIEF item (from M7 Task 14): @pap/ui TextField gains mono + rows props — union with M8's inputRef/onKeyDown/onPaste/onDrop/onDragOver/combobox props.
Task 14: review (Sonnet) Approved — minors; Ruling MC35 small fix round (controller verifies).
Task 14: fix round 1/5 → resume implementer
Task 14: fix round 1 DONE (4e90556) — controller verified (pricing bound to looked-up id, discard confirm, read-only during save); unit 8097.
Task 14: complete (13a19b4, 4e90556)
Task 15: dispatched implementer (Sonnet), BASE 4e90556; carries: MC20 migration stamp, MC29 shared queue (if Pi settings written), Task 4 M6 (preset must restrict codemode/deferred MCP)
Task 15: implementer
Task 15: implementer DONE_WITH_CONCERNS (b0c2eb5) — unit 8147, int 478+1, smoke ok; read-only enforced in worker policy by tool name (PolicyRules.presetTools); MC29 lift deferred (no Pi settings write); forks inherit preset; unknown preset → chat. CARRY Task 16: cold session shows stored preset. Review dispatched (Opus).
Task 15: review (Opus) Needs fixes — I1 (plan-mandated) read-only preset lets extension tools run unasked in full-access (probed, incl. extension 'read' override). Ruling MC36 (option b: non-read never unasked under read-only preset; ADR fix; m1–m7, m9; m8 parked).
Task 15: fix round 1/5 → resume implementer
Task 15: fix round 1 DONE (fb791d4) — MC36 in stage-approval.ts (Deny/Allow once only), m1–m7, m9 (no fix needed, tested); unit 8155, int 481+1, smoke ok. Scoped re-review (Opus, security).
Task 15: re-review 1 (Opus) Needs fixes — I1 partly: heldByPreset only on matrix 'allow'; supervised/auto-accept-edits still grantable, existing session/exact grants skip the ask (probed). ADR Context line unchanged.
Task 15: fix round 2/5 → resume implementer (hold every non-block verdict with [deny, once], grantable false; existing grants never skip; both modes tested; ADR :7)
Task 15: fix round 2 DONE (d0cf677) — preset ask only one, grantable false, grants ignored; 3 modes tested; unit 8164, int 481+1. Scoped re-review 2 (Opus).
Task 15: re-review 2 by controller (10 KB diff): stage-approval holds every non-block verdict under read-only preset as [deny, once] grantable:false; evaluate-once consults session/always/pattern grants only when grantable (evaluate-once.ts:134) → grants cannot skip; no-UI → block. Approved.
Task 15: complete (b0c2eb5, fb791d4, d0cf677)
Task 16: dispatched implementer (Sonnet), BASE d0cf677; carries: cold-session stored preset, MC36 copy; composer lines limited to ModelBar
Task 16: implementer
REBASE-BRIEF item (from M8 Task 21): ComposerMenu has optional fieldRef + dropPath; M7's useComposerCommands takes mentions.fieldRef and joins composerFieldProps([mentions, commands]) (MC1).
REBASE-BRIEF item (from M8 MC37): the helper is useComposerFieldProps([mentions, commands], attachments), not composerFieldProps.
Task 16: implementer DONE_WITH_CONCERNS (76c0f30) — unit 8188, bundle 198.5 (picker lazy); cold-session preset not exposed by daemon → Ruling MC37 pre-review fix (resume implementer); strings in session-tools catalog.
Task 16: pre-review fix DONE (4ca31c5) — toolPreset in snapshot/SessionSummary/ShellSession; unit 8199, int 482+1. Review dispatched (Sonnet) on d0cf677..4ca31c5.
Task 16: review (Sonnet) Approved — minors parked (chosen vs newer stored preset, cold timeout no re-read, marks-store import cycle, duplicated copy, focus, unused shell field).
Task 16: complete (76c0f30, 4ca31c5)
Task 17: dispatched implementer (Sonnet), BASE 4ca31c5; reuse 12a masker, MC32/MC33 rules apply to mcp.json
Task 17: implementer
Task 17: implementer DONE_WITH_CONCERNS (15ee756) — unit 8273, int 485+1, bundle 198.9; fixed prescribed regex/mask gaps (SERVER_NAME '.', constructor, $ecret args, URL vars); overview kept pi:read → Ruling MC38 pi:admin, pre-review fix.
Task 17: pre-review fix DONE (254c369) — mcp.overview pi:admin; unit 8275, int 485+1. Review dispatched (Opus) on 4ca31c5..254c369.
Task 17: review (Opus) Needs fixes — I1 masking misses multi-word args, URL in flag values, fragments (probed); I2 override matched on displayed (masked) name → wrong server overridden. Ruling MC39.
Task 17: fix round 1/5 → resume implementer
Task 17: fix round 1 DONE (7ec57c1) — I1 multi-word/URL-in-flag/fragments, I2 raw-name matching; unit 8286, int 485+1. Parked vocab gap → Ruling MC40 (shared MC32 predicate); fix round 2 (small) before the scoped re-review.
Task 17: fix round 2 DONE (4b1ee55) — shared credential-words.ts; but MCP lost pwd/session/signature → Ruling MC41 union; fix round 3 (tiny).
Task 17: fix round 3 DONE (90e9a26) — union list; unit 8318. Scoped re-review (Opus) on 254c369..90e9a26 (rounds 1–3).
Task 17: re-review 1 (Opus) Needs fixes — I1 partly: quoted segments in sh -c lines and --header=Name: value unmasked; fragment rebuild cosmetic. Ruling MC42 → fix round 4/5 with a FRESH Opus implementer (pre-approved).
Task 17: fix round 4 implementer (fresh Opus), BASE 90e9a26
Task 17: fix round 4 DONE (3cd0d33, fresh Opus) — shell-split quoted segments, headers in flag values, fragments in place, depth cap 8; unit 8338; jdbc: userinfo gap named in ADR. Scoped re-review 2 (Opus).
Task 17: re-review 2 (Opus) Approved — CARRY Task 18: M1 (mask.ts:146 URL word with a space), M2 unterminated-quote test row, M3 ADR 0025:23 jdbc whole string shown.
Task 17: complete (15ee756, 254c369, 7ec57c1, 4b1ee55, 90e9a26, 3cd0d33)
REBASE: M8 merged on main (df12aed + 481ae48). Rebase now at the Task 17/18 boundary per .superpowers/m7-rebase-brief.md (amends M7R131: still one rebase). BASE before rebase 3cd0d33.
REBASE: squashed 59 commits into 2276db1 (tree identical to 3cd0d33; history kept in branch backup/m7-pre-rebase-2026-10-14). Rebase dispatched (Sonnet implementer) per m7-rebase-brief.md.
REBASE: implementer (Sonnet) — Phase A rebase + mechanics, Phase B security items 1–4 + MC31 hook.
REBASE: done — 9510489 squash rebased (27 conflicted files), 9188159 reconcile, 477351f/465df95/59f067f/2713205/ad16056 Phase B items 1–4 + MC31 hook. Gates green on ad16056 (unit 9657, int 645+1 skip, smoke, bundle 205 KB). Report rebase-report.md.
REBASE: scoped review (Opus) dispatched, package rebase-review-package.md → rebase-review.md
REBASE: review (Opus) Ready after fixes — C1 own attachments ask (Pi sid vs pap sid), I1 nested repo filter via numstat diff, I2 empty filter name; M1–M8. Ruling MC43. Fix round 1 → resume implementer.
REBASE: fix round 1 done ad16056..7b7740b (122c7b1 C1, f0c36e0 I1, 95391d2 I2, 846e901 M1, ea6cecc M2, 2e8ff2d M4+M5, 601fa1b M6, 7b7740b docs). Gates green (unit 9674, int 649+1 skip). Concern: git_too_old shows as generic failed in UI (contract enum).
REBASE: Ruling — git_too_old shown as generic 'failed' in the Review pane is accepted (floor documented in files.md; dedicated message would touch contracts+web+i18n; owner host has git 2.53). REBASE: re-review 1 (Sonnet) dispatched → rebase-rereview-1.md
REBASE: re-review 1 (Sonnet) PASS — all of C1, I1, I2, M1–M8 addressed. Controller fix 936b708: git --version probe uses gitEnv's absolute PATH (re-review minor); kernel/git unit 242 pass, typecheck clean.
REBASE: complete (9510489..936b708). Next: Task 18 (carries M1–M3 from Task 17 re-review 2; MC29 Pi settings write queue lift if 18 writes Pi settings).
Task 18: BASE 936b708. Implementer (Sonnet) dispatched — carries: protected_path (MC2/rebase item 9), MC29 shared Pi-settings queue lift, Task 17 M1–M3, sensitiveParams for secret-bearing new methods.
Task 18: implementer DONE_WITH_CONCERNS (7f4d303 carries M1–M3, adfa600 feature) — unit 9749, int 653+1, bundle 205.5; queue lifted to kernel/pi-write-queue.ts; mcp.add sensitiveParams; concerns: CodemodeSettings type (Task 20), no audit lines for MCP writes, array-index names reorder, partial global/project group switch. Review (Opus).
Task 18: review (Opus) dispatched → task-18-review.md
Task 18: review (Opus) spec ❌ (plan-mandated CodemodeView) / Needs fixes — I1 no read path for codemode settings; M1–M9. Ruling MC44. Fix round 1 → resume implementer.
Task 18: fix round 1 DONE (ccbdeda) — unit 9759, int 653+1, smoke ok, bundle 205.5; new row code write_failed; overview settings field (missing file → defaults, unreadable → null). Scoped re-review (Sonnet).
Task 18: re-review 1 (Sonnet) PASS — all MC44 items addressed, M8 carried to Task 30 (index-like names, duplicate keys, LF re-indent, remove timeout no undo, pi CLI race, partial group writes). Owner final-report option: audit line for mcp.add/undo.
Task 18: complete (7f4d303, adfa600, ccbdeda)
Task 19: BASE ccbdeda. Implementer (Sonnet) dispatched — notes: tested server env reported/pinned, local fixtures only, forbidden on untrusted, SDK sign-in notice pinned.
Task 19: implementer DONE_WITH_CONCERNS (b383192) — unit 9792, int 661+1, smoke ok, bundle 205.6; tested server env = worker MCP env (PAP_*/NODE_OPTIONS stripped, daemon vars visible for ${VAR}); closeSession mutant survives; silent crash → connected/no tools; '_' names bad_request; results keyed by cwd. CARRY Task 20: M7R96 sign-in panel copy. Review (Opus).
Task 19: review (Opus) dispatched → task-19-review.md
Task 19: review (Opus) spec ✅ / Needs fixes — I1 tested server outlives helper (own pgid), I2 handler rejection → connected; M1–M8. Ruling MC45. Fix round 1 → resume implementer.
Task 19: fix round 1 DONE_WITH_CONCERNS (aff966e) — unit 9801, int 663+1, smoke ok; no RED this round (mutants after); 3 overlapping cleanup layers, disconnect sweep untested alone; M2 generation counter global (over-conservative, accepted). Scoped re-review (Sonnet).
Task 19: re-review 1 (Sonnet) dispatched. Owner asked about parallel lanes; proposal pending (2 lanes: A 20→21→27→29 here; B 22→23→24→25→26→28 in feat-m7-b; flock on test:int).
Task 19: re-review 1 (Sonnet) APPROVED — all MC45 items addressed; M4 + env accepted (doc Task 30: receipt holds masked message/tool names; results keyed by cwd).
Task 19: complete (b383192, aff966e)
Task 20: BASE aff966e. Implementer (Sonnet) dispatched — carries: settings field for codemode pane, write_failed rows, protected_path + Save anyway, McpTestView.state, M7R96 sign-in copy, cwd-keyed results.
LANES: owner go for 2 lanes (2026-10-14). Lane A = feat-m7 (20 → 21 → 27 → 29). Lane B = worktree .worktrees/feat-m7-b, branch feat/m7-lane-b from aff966e (22 → 23 → 24 → 25 → 26 → 28). Single ledger here; lane B lines prefixed [B]. Override lane-b.md; heavy-gate flock added to global-constraints.md. Joins: rebase lane B onto feat-m7 at chain ends.
[B] Task 22: BASE aff966e (feat/m7-lane-b). Implementer (Sonnet) dispatched. Lane A Task 20 implementer told about the flock.
Task 20: implementer DONE_WITH_CONCERNS (4889f29) — unit 9837, smoke ok (flock), bundle 205.7, MCP chunk 12 KB; McpTestView is {at, ok, state, tools:number|null}; no signal for sandbox/-builtin:codemode blocking code mode; undo inline row (60 s) not Toast; exposure Select untested; step-up hook shared (routes/settings/use-settings-step-up.ts). Review (Sonnet).
Task 20: review (Sonnet) dispatched → task-20-review.md. (Disk cleanup done for owner: 79% → 57%; feat-m8 worktree removed, branch kept.)
Task 20: review (Sonnet) spec ❌ / Needs fixes — I1 no -builtin:codemode block signal (sandbox half → M11), I2 state survives cwd change; M1–M8. Ruling MC46. Fix round 1 → resume implementer.
STOP: owner accidentally stopped both implementers (Task 20 fix round 1, [B] Task 22); uncommitted partial work left in both worktrees, no leftover processes. Relaunched as fresh Sonnet agents finishing the partial work: Task 20 fix round 1 →; [B] Task 22 →.
[B] Task 22: implementer DONE_WITH_CONCERNS (3d1e2f3) — unit 9850, int 667+1, smoke ok, bundle 206; deviations in ADR 0027: trust.status pi:admin (MC38), breadth refusal {ok:false, refusal} not forbidden; no RED/mutants → mutation checks requested before review.
[B] Task 22: mutants all killed (breadth home rule, holds-other-projects, restartFolder). Review (Opus) package review-B-aff966e..3d1e2f3.diff
[B] Task 22: review (Opus) dispatched → task-22-review.md
Task 20: fix round 1 DONE (56d495b) — unit 9847, int ok (flock), smoke ok; tests split to McpSection.review.test.tsx (462-line file); readCodemodeState; built-in-off check reads global settings.json only (project override not covered, noted). CARRY Task 30: sandbox half → M11. Scoped re-review (Sonnet).
Task 20: re-review 1 (Sonnet) dispatched → task-20-rereview-1.md
Task 20: re-review 1 (Sonnet) APPROVED — all MC46 items addressed; sandbox half carried (Task 30 note); minor: Undo-focus test relies on happy-dom focusing disabled buttons.
Task 20: complete (4889f29, 56d495b)
Task 21: BASE 56d495b. Implementer (Sonnet) dispatched.
[B] Task 22: review (Opus) spec ❌ / Needs fixes — I1 decision during worker start fails prompt (worker_failed), I2 trust.status looks complete while hiding linked extensions/MCP problems; 10 minors. Ruling MC47 (incl. clear needs step-up, HOME fallback). Fix round 1 → resume implementer.
Task 21: implementer DONE (edc9412) — unit 9893, smoke ok, initial 205.7 unchanged, MCP chunk 12.9→18.7 KB; second catalog settings-mcp-add.ts; claude mcp add only with --; importer https only; pasted secret in React state until close. Review (Sonnet).
Task 21: review (Sonnet) dispatched → task-21-review.md
Task 21: review (Sonnet) spec ✅ / Needs fixes — I1 partial failure + step-up cancel untested; M1–M8. Ruling MC48. Fix round 1 → resume implementer.
[B] Task 22: fix round 1 DONE (14758df) — unit 9861, int 667+1, smoke ok; RED + mutants for I1/I2/clear/cap/home; TrustResources.unlisted (required, ≤16) → CARRY Task 23 show 'could not list everything'; >2000 projects → capacity (fail closed). Scoped re-review (Sonnet).
[B] Task 22: re-review 1 (Sonnet) dispatched → task-22-rereview-1.md
Task 21: fix round 1 DONE (52087e9) — unit 9907, 20 mutants killed, smoke ok, MCP chunk 19.3 KB; extra: URL preview https://•••@host, empty args omitted. Scoped re-review (Sonnet).
[B] Task 22: re-review 1 (Sonnet) ACCEPTED (all MC47 items); minors: non-prompt reopen keeps worker until idle release (accepted), second decision overwrites needsRun (controller fix), unlisted reader → Task 23.
[B] Task 22: controller fix 47ba544 — second decision keeps needsRun and skips release (unit test fails on old code; release int 2/2, trust int 3/3 under flock; lint/format/tsc ok).
[B] Task 22: complete (3d1e2f3, 14758df, 47ba544). CARRY Task 23: render TrustResources.unlisted ('pap could not list everything'); refusal read from result (MC47).
Task 21: re-review 1 (Sonnet) APPROVED — all MC48 addressed; unrequested URL preview mask + empty args safe.
Task 21: complete (edc9412, 52087e9)
JOIN 1: lane B rebased onto feat-m7 (52087e9) cleanly → 5a4a633, d130a05, 36f2e9c; feat-m7 fast-forwarded to 36f2e9c (both lanes at 36f2e9c). Full gate running in detached worktree .worktrees/join-check (log scratchpad/join-gate.log).
Task 27: BASE 36f2e9c. Implementer (Sonnet) — M8 plumbing: skip TextField, useComposerCommands(fieldRef: mentions.fieldRef), useComposerFieldProps([mentions, commands], attachments).
[B] Task 23: BASE 36f2e9c. Implementer (Sonnet) — carries unlisted/truncated rendering, refusal from result, capacity, step-up for trust+clear.
JOIN 1: first gate run failed at root typecheck — env artefact (root tsc resolves @pap/contracts via dist/index.d.ts; fresh join-check worktree had no build). Pre-existing quirk: on a fresh clone pnpm typecheck needs pnpm build first (note for final report). Rerun with build first.
JOIN 1: gate GREEN on 36f2e9c (build, lint, format, typecheck, knip, unit:      Tests  9968 passed (9968), int 667+1, budgets 206 KB, smoke ok). join-check worktree removed.
[B] Task 23: implementer DONE_WITH_CONCERNS (ad242ca) — unit 10004, smoke ok, initial 206.1, session chunk 47.9, dialog lazy ~3 KB; 9 mutants; eslint.config.js +2 lines (feature→trust allowed); dynamic cross-layer imports (McpSection→TrustDialog, TrustBanner→routes/shell entry); skills notice → CARRY Task 26; no clear UI; escapeHidden → lib/. Review (Sonnet).
[B] Task 23: review (Sonnet) dispatched → task-23-review.md (asked to rule on lint loosening + dynamic cross-layer imports).
[B] Task 23: review (Sonnet) spec ✅ / Needs fixes — I1 TrustBanner → routes/shell upward dynamic import; lint loosening accepted narrowed to sessions+mcp. Ruling MC49. Fix round 1 → resume implementer. CARRY Task 26: skills notice opens TrustDialog via context.
Task 27: implementer DONE_WITH_CONCERNS (61c259b) — unit 10018, int 668+1 (1st run: M8 terminal.reconnect flake, rerun green), smoke ok, initial 206.1, session chunk 48.6, CommandMenu 0.7 KB; useComposerCommands takes sessionId; menu below field (brief: above); createElement + eslint-disable-next-line react-hooks/refs; implementer used git stash once (stack now empty, no harm). Review (Sonnet).
Task 27: review (Sonnet) dispatched → task-27-review.md
Task 27: review (Sonnet) ✅ / Approved — 0 C/0 I, 8 minors. Controller fix d6d50f7: unique row keys (index), pickSkill single space (+ test); sessions web unit 564 pass via --project unit, lint/format/tsc ok. Ruling MC50 (chip below field accepted; minors parked).
Task 27: complete (61c259b, d6d50f7)
Task 29: BASE d6d50f7. Implementer (Sonnet) dispatched (no lib/step-up-context, lane B owns it).
[B] Task 23: fix round 1 DONE_WITH_CONCERNS (60317f4) — unit 10012, smoke ok, initial 206.1→206.4 (eager StepUpHost, lazy engine), 7 mutants; second prompt owner beside Settings; AppShell.test flake once under load. Scoped re-review (Sonnet).
[B] Task 23: re-review 1 (Sonnet) dispatched → task-23-rereview-1.md
[B] Task 23: re-review 1 (Sonnet) APPROVED — all MC49 items; carries Task 26 (skills notice), Task 30 (docs, lint deviation in ADR 0027/web.md).
[B] Task 23: complete (ad242ca, 60317f4)
LANES: lane A after Task 29 takes Task 28; lane B continues 24 → 25 → 26.
[B] Task 24: BASE 60317f4. Implementer (Sonnet) — protected_path for missing confirmProtected; forbidden untrusted; frontmatter writes serialised per file (not settings queue); SKILLS_CLI pin verified (≥3 days, repo check, else NEEDS_CONTEXT); no real npx/fetch in tests; npx env stripped + pinned.
SPEED (owner go 2026-10-14): A = fix rounds for Critical/Important only, minors parked → controller trivial fixes + one minor sweep before the final review; B = gate tiers (targeted while developing, full once at the end, lighter fix-round gate, full gate at joins/final); written in global-constraints.md. C = stabilise flaky tests (terminal.reconnect, pool.int stopAll, AppShell 'renders a settings section') in a third worktree.
Task 29: implementer DONE_WITH_CONCERNS (86e61a0) — unit 10044 (1st run 2 flakes: a daemon test + sections.test Language; rerun green), smoke ok, initial 206.1→205.8 (whole stepper lazy), stepper 4.9 KB; own use-first-run-step-up (no shell pre-sign-in); PiStep takes panel prop from routes/setup/SetupModels.tsx; Skip/Finish label static. Review (Sonnet).
Task 29: review (Sonnet) dispatched → task-29-review.md
C: worktree .worktrees/feat-m7-c, branch feat/m7-flaky from 86e61a0 (installed + built). Flaky-fix agent (Sonnet) → flaky-report.md (terminal.reconnect, pool.int stopAll, AppShell settings section, sections Language, daemon 'judged' test). Join by rebase when done.
Task 29: review (Sonnet) spec ❌ / Needs fixes — C1 websocket stopped during setup → step 3 RPCs offline in real browsers (fake runtime hid it); I1 no inline retry on FirstRun chunk failure; 5 minors parked. Ruling MC51. Fix round 1 → resume implementer.
C: agent left 20 orphaned busy loops (load ~35) → killed by controller 08:12; agent told: ≤3 loops, timeout 90, no orphans.
Task 29: fix round 1 DONE_WITH_CONCERNS (bafd307) — socket starts on account created (real createRpcClient test fails on old code), inline Retry on chunk failure; web tests green; full test:unit not green under load ~37 (pi-host unchecked.rough + enabled-models.ops timeouts) → controller reruns unit when quiet, then scoped re-review.
Task 29: controller reran the 2 pi-host timeouts + web routes (36 files, 269 tests) green after load dropped. Scoped re-review (Sonnet).
Task 29: re-review 1 (Sonnet) dispatched → task-29-rereview-1.md
Task 29: re-review 1 (Sonnet) PASS — C1, I1 closed; 5 minors parked (minor sweep).
Task 29: complete (86e61a0, bafd307)
Task 28: BASE bafd307. Implementer (Sonnet) dispatched (token grid generic from methods catalogue incl. M8 + lane B skills; reuse 1c readOnlyCommands rule).
[B] Task 24: implementer DONE_WITH_CONCERNS (d41840b) — unit ok (load timeouts rerun green), int 667+1, smoke ok, initial 206.8; SKILLS_CLI skills@1.7.2 (2026-10-09, repo vercel-labs/skills verified); npx env stripped + pinned; concerns: search deadline via injected SearchTimers in helper, env key list duplicated, killed npx children until pool kill, scope-filter guard untested, mutation script corrupted files once (repaired). Review (Opus).
[B] Task 24: review (Opus) dispatched → task-24-review.md
C: done (feat/m7-flaky: 0c7d582 pool.int zombie-aware poll, 1366140 terminal.reconnect attach MAX_SAFE_INTEGER, 59e9df7 shell-bed preloads settings chunk). Test-only, 13 lines → controller-verified diff (sdd-lightening); agent gate green (unit 10044, int 668+1). 'judged' daemon test unidentified (skipped). Only terminal.reconnect reproduced before fix. Land on feat-m7 by cherry-pick after Task 28's review package is cut.
[B] Task 24: review (Opus) spec ❌ / Needs fixes — I1 skills.list/setInvocation trigger Pi package resolution → npm install / git clone (scripts) unasked; 16 minors parked. Ruling MC52 (all helper read ops offline, incl. trust.status). Fix round 1 → resume implementer.
[B] Task 24: fix round 1 DONE_WITH_CONCERNS (3561d2b) — offline() sets PI_OFFLINE=1 around skills reload, trustStatus, mcp-test createAgentSessionServices; fake npm/git tests (npm root -g allowed); trust wrapper mutant survives (no package resolution in trustStatus today); unit 10082/10083 (enabled-models.ops load flake → add to flaky list). Scoped re-review (Sonnet).
[B] Task 24: re-review 1 (Sonnet) dispatched → task-24-rereview-1.md
Task 28: implementer DONE_WITH_CONCERNS (3b6cdc7) — unit 10064, int 668+1, smoke ok, initial 206.1; native radios; READ_ONLY_COMMAND_NAMES hand-listed + pi-host drift test; fixed settings form dropping readOnlyCommands on Save; session-reducer.test.ts at 400. Review (Sonnet) dispatched, agent see next line.
C landed on feat-m7: cherry-picked 3f9ac1b, 4c3b422, e3a7027 (from feat/m7-flaky) after cutting Task 28's package; AppShell + sections tests 30/30. Add enabled-models.ops (pi-host) to flaky watch list.
Task 28: review. feat-m7-c worktree removed (branch feat/m7-flaky kept until merge).
[B] Task 24: re-review 1 (Sonnet) APPROVED — I1 closed; 16 minors parked (minor sweep).
[B] Task 24: complete (d41840b, 3561d2b)
[B] Task 25: BASE 3561d2b. Implementer (Sonnet) — list offline (MC52), install/update online + step-up global, npm/git children env stripped (reuse Task 24 list, shared + drift test), writes via kernel/pi-write-queue (MC29), protected_path/forbidden, hanging fake npm cleanup test.
Task 28: review (Sonnet) ✅ / Approved — 0 C/0 I, 5 minors parked; confirmed pre-existing bug: settings Save reset stored readOnlyCommands false → true (fixed + tested) — owner report.
Task 28: complete (3b6cdc7)
MINOR SWEEP A (lane A): brief minor-sweep-a-brief.md (T27 items 1–4, T28 items 5–6; T29 minors accepted). BASE e3a7027.
MINOR SWEEP A: implementer (Sonnet) → minor-sweep-a-report.md
MINOR SWEEP A: DONE (ff4781a, 2a864c0) — 6 items, each mutation-checked; controller verified diff (small, UI/test) and reran touched tests. No re-review agent (minor-only, small).
Task 30: split per MC53 → 30a now in lane A (carries in task-30-carries.md), 30b after Join 2. BASE 30a 2a864c0.
Task 30a: implementer (Sonnet) → task-30a-report.md
Task 30a: implementer DONE_WITH_CONCERNS (e3a634a) — parity D07–D09 green (unit 30 files/616, int 8 files/50 under flock); models.md, mcp.md, ADR 0024, ADR 0029 (SettingsManager-write deviation), m7-rulings.md; redactLine tightened (test-first); 8 carry/code disagreements written as code; MC49/MC52/trust docs → 30b. Review (Sonnet).
Task 30a: review (Sonnet) dispatched → task-30a-review.md
[B] Task 25: implementer DONE_WITH_CONCERNS (4aa87c2) — unit 10157, int 125 files, smoke ok, initial 207.1; update = checkForAvailableUpdates + update(source); env keys shared in contracts/env-keys.ts (+ drift tests); cleanup int test (hanging fake npm, setsid grandchild); concerns: install holds pi-write-queue up to 5 min, global re-enable w/o step-up, npm grandchild during sync npm root -g, git ref reconcile not reported. Review (Opus).
[B] Task 25: review (Opus) dispatched → task-25-review.md
Task 30a: review (Sonnet) ❌/Needs fixes — I1 models.md claimed models.pricing the only pi:read (models.overview is too); 7 minors parked. Controller fix 11e4096 (doc line, prettier ok).
Task 30a: complete (e3a634a, 11e4096)
[B] Task 25: review (Opus) spec ❌ / Needs fixes — I1 plugin-source regexes let git: sources resolve as local paths outside home (reproduced) and refs start with '-'; concern 2 accepted (doc 30b), concern 3 kept (owner option); 14 minors parked. Ruling MC54. Fix round 1 → resume implementer.
[B] Task 25: fix round 1 DONE (590c49c) — MC54 shapes (dotted host, 2+ clean segments, ref not '-', https no dot segment), op-level test settings.json byte-identical, 5 mutants. Controller verified diff + added 40b0784: host never starts/ends with '-' or '.' (ssh option injection guard), 4 refusal rows, mutant kills 4; plugin tests 58/58, lint/tsc ok. No re-review agent (small, controller-verified).
[B] Task 25: complete (4aa87c2, 590c49c, 40b0784)
JOIN 2 (after Task 25): lane B rebased onto feat-m7 11e4096 (1 conflict: apps/web/src/i18n/index.ts key union, resolved keeping both), feat-m7 fast-forwarded to 0809638. Full gate in join-check (build first).
MINOR SWEEP B (lane A): brief minor-sweep-b-brief.md (15 items, backend only), ruling MC55. BASE 0809638.
[B] Task 26: BASE 0809638. Implementer (Sonnet) — carries: SKILLS_CLI → contracts (only change in skill-source.ts), skills notice → TrustDialog via context (+ eslint allow skills→trust), shared step-up context, ProtectedAsk.
MINOR SWEEP B: implementer (Sonnet) (lane A, backend only; regex-only edit in skill-source.ts).
JOIN 2: gate on 0809638 — build/lint/format/typecheck/knip ok, unit 10274 pass, int 670+1 skip with 1 fail: daemon.int idle-worker RSS 191 vs budget <191; reruns 3/3 pass. Measured idle RSS: main (M8) 177/177/184 MB, feat-m7 183/183/190 MB → M7 adds ~6 MB; headroom gone (budget 191 from decision 50). budgets 207.2 KB, smoke ok. Owner asked: raise idleWorkerRssMb (recommend 210 = ~191×1.10). join-check + main-check worktrees removed.
Owner: idleWorkerRssMb → 210 (MC56, Task 30b).
MINOR SWEEP B: DONE (0b898ca, 0537793) — 15 items, unit 10294, int skills/trust/pool/plugins 20 tests, smoke ok; security mutants killed (home guard double, FIFO mutant hangs); pi:admin count 34. Scoped review (Sonnet).
[B] Task 26: implementer DONE_WITH_CONCERNS (2ade4d5) — unit 10322, smoke ok, initial 207.2, Skills chunk 10.9 KB; SKILLS_CLI → contracts; eslint allow skills→trust; scope default approximated (switcher project / last session tab). Review (Sonnet).
MINOR SWEEP B: review (Sonnet) → minor-sweep-b-review.md
[B] Task 26: review (Sonnet) → task-26-review.md
MINOR SWEEP B: review (Sonnet) Approved after 1 Important — N1 FIFO test can hang suite (sync read); N3/N4/N5 small; N2 (web copy, lane B), N6 parked. Fix round → resume (N1, N3, N4, N5 if redactor exists).
[B] Task 26: review (Sonnet) ✅ / Approved with 1 I — URL.canParse (Safari < 17, floor 16.4) crashes Skills section; same in MCP import/AddServer; 10 minors parked. Controller fix 251a242: lib/parse-url.ts (try/new URL) replaces all 5 uses; Safari test fails with canParse version (mutant), mcp+skills web tests 134 pass, lint/tsc ok.
[B] Task 26: complete (2ade4d5, 251a242)
MINOR SWEEP B: fix round DONE (f4bce7c) — N1 FIFO test in SIGKILL-bounded child (mutant fails in 10 s), N3, N4 (SKILLS_CLI + SKILLS_CLI_BEFORE pinned together), N5 install tail through maskCommandLine; unit 10295. Controller-accepted (test-heavy, small).
MINOR SWEEP B: complete (0b898ca, 0537793, f4bce7c)
JOIN 3 (after Task 26 + sweep B): lane B rebased onto f4bce7c (1 conflict: skill-source.ts → lane A GITHUB regex + contracts SKILLS_CLI import), feat-m7 fast-forwarded to fac91f0. Gate in join-check.
Task 30b: BASE fac91f0. Implementer (Sonnet) (skills/plugins docs, lane-B docs from 30a, 30a minors, D10 parity, budgets incl. idleWorkerRssMb 210, decisions log MC56, full final gate). Lane B worktree now idle (can be removed after merge).
JOIN 3: gate on fac91f0 — build/lint/format/typecheck/knip ok, unit 10346, int 669+1 skip with 2 fails: daemon.int RSS 192 (fixed by 30b budget 210) and models/service.int network-guard canary (sweep B logs every op's stderr tail) → ruling MC57, sent to 30b implementer. budgets 207.3 KB, smoke ok.
Task 30b: implementer DONE_WITH_CONCERNS (7287f85 MC57, 169e064 docs) — FULL GATE GREEN: unit 10347, int 671+1 skip, build, budgets 207.3/229 KB, smoke; idleWorkerRssMb 210; decision 78; D10 parity green (P10-1..7, P09-9); skills.md, m7-rulings-after-join.md; new flaky plugins.int PATH assertion (2 fails then 3 passes).
FINAL: Task 30b review folded into the Opus final review (MC58). Dispatching Opus final whole-branch review main(481ae48)..169e064 (54 commits, 641 files, +58.6k).
FINAL: Opus final review dispatched → m7-final-review.md
FINAL: review (Opus) With fixes — 0 C, 1 I (budget 229 vs decision 75 flat 300), 8 minors. Ruling MC59: one fix dispatch (I1, M1–M8 per ruling), then a scoped re-review.
FINAL: fix round implementer (Sonnet) → m7-final-fix-report.md
FINAL: fix round DONE (af1bfe3, 24c942a, 3fd1289, ea9de2a, c76b6e6, 3ff6253, 0a07788) — FULL GATE GREEN on 0a07788: unit 10354, int 671+1, build, budgets 207.3/300, smoke; plugins.int 5/5; mutants M1/M2/M8 killed; pool tailOps option (default skills.install). Scoped re-review (Sonnet).
FINAL: re-review (Sonnet) → m7-final-rereview.md
FINAL: re-review (Sonnet) READY — I1, M1–M8 addressed; 0 open. M7 ready to merge; asking owner.
