# M0 + M1 SDD ledger (archived 2026-10-11)

Controller ledger of the M0 + M1 subagent-driven run, copied verbatim from the git-ignored SDD workspace before its worktree was removed. Rulings: [m0-m1-rulings.md](m0-m1-rulings.md).

Spec: docs/specs/2026-10-10-C-architecture.md (+ A, D, DESIGN.md). Worktree: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1 (branch feat/m0-m1). Start base: 3c9c278.
Models (decision 35, user-approved): T1 S2 + T2 S1 → opus; T3–T8 (S3,S4,S7,S8,S5,S6) → sonnet; T9–T11 → haiku; T12–T16, T20, T23–T27 → sonnet; T17,T18,T19,T21,T22 → sonnet impl + opus reviewer. Other reviewers: sonnet. Any upgrade beyond this table (incl. fix-loop round 4–5 escalation to opus) needs user approval first (CLAUDE.md rule).
Env: node v24.14.1; pnpm via 'corepack pnpm' (no global install); bwrap 0.11.1; systemd --user running; gh present; docker absent.
Preflight: scan table in preflight.md (136 rows: 80 pairs, 27 per-task, 15 plan-mandated, 14 spec checks). 34 rulings in rulings.md; each dispatch carries "Rulings for Task N" from that file.
Ruling: preflight R1–R34 adopted as written in rulings.md — spec C (amended, decision 34) and DESIGN.md are binding over plan text — costs listed per ruling; the only non-trivial one is R24 (non-Secure cookie on plain-HTTP loopback only).
Task 1: dispatched (base 3c9c278, model opus)
Task 1: implementer agent ac54247445983717e (opus); report task-1-report.md
Task 1: implementer DONE_WITH_CONCERNS (40d426d), S2 GO; concerns carried as R35/R36. Review package: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-3c9c278..40d426d.diff: 1 commit(s), 125744 bytes
Task 1: ⚠️ checks resolved by controller: commit body has no trailer; no ~/.pi/agent writes (no agentic session dir, no top-level mtime change).
Task 1: minor (deferred): retry-disable via settings.json + SettingsManager.create is unmeasured (s2.md:36,51) — T20/T23 must verify it.
Task 1: minor (deferred): ad hoc evidence (extension-route control, retry timings, event payload fields) not reproducible from repo.
Task 1: minor (deferred): network guard never shown to trip; cross-route equality asserted in prose only; results.json 1186 lines w/ absolute paths (plan-mandated); session.dispose() outside finally.
Task 1: complete (commits 3c9c278..40d426d, review clean)
Task 2: dispatched (base 40d426d, model opus)
Task 2: implementer agent a42e937f0080114fc (opus); report task-2-report.md
Task 2: implementer DONE_WITH_CONCERNS (0da60f9), S1 GO (fork→ready ≈656 ms, RSS ≈155 MB); concerns carried as R37–R40. Review package: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-40d426d..0da60f9.diff: 1 commit(s), 88703 bytes
Ruling: R37 — pap session id is its own; Pi path/uuid set once the JSONL exists; draft reopen = fresh Pi session bound to same pap id — Pi writes the file only on first user message (S1) — low if wrong.
Task 2: review Approved; 1 Important (plan-mandated): spike driver lacks kill ladder/finally/timeout.
Task 2: parked — driver cleanup robustness — Ruling: accepted for the throwaway S1 driver (measurements valid, controller+reviewer found no orphans/no real agent-dir writes); carried into Task 4 as R41 because S4 forks this host — if wrong, a hung S4 run leaves orphan workers to kill by hand (low).
Task 2: minor (deferred): 4 of 5 runs uncommitted; headline timing measured from t0 after fork; afterRunRssMb mid-scenario; RSS≠PSS caveat missing in note; branched/panel recorded not asserted; inherited stdout; note filenames from another run; probe uses includes (→R42); done()-inside-factory edge; --ignore-workspace bypasses minimumReleaseAge (spike-only).
Task 2: ⚠️ commit trailer checked by controller: none.
Task 2: complete (commits 40d426d..0da60f9, 1 parked)
Task 3: dispatched (base 0da60f9, model sonnet)
Task 3: implementer agent a65f5c9d1c15f29de (sonnet); report task-3-report.md
Task 3: implementer DONE (0648f25), S3 GO (FTS5 ok, 10k rows 27 ms, query 1 ms); concerns carried as R43/R44. Review package: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-0da60f9..0648f25.diff: 1 commit(s), 5210 bytes
Task 3: ⚠️ backup() claim reproduced by reviewer (pages 2, row read back).
Task 3: minor (deferred): backup() check ad hoc (not in probe); 10k-row timings synthetic (order of magnitude only); WAL probe outside try.
Task 3: complete (commits 0da60f9..0648f25, review clean)
Task 4: dispatched (base 0648f25, model sonnet)
Task 4: implementer agent a818526828b360d71 (sonnet); report task-4-report.md
Task 4: implementer DONE (c3453e7), S4: RSS≈156/PSS≈103 MB; budget 236 MB; cap clamp(…,2,16); carried as R45. Review package: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-0648f25..c3453e7.diff: 1 commit(s), 27802 bytes
Task 4: review Approved with 1 Important (note omits that codemode/tool-search/256 MiB sandbox were not exercised) → fix round 1 sent to implementer (fix base c3453e7).
Task 4: minor (deferred): descendants() covers main-thread children only.
Task 4: fix round 1/5 (3 addressed, 0 open — codemode limits disclosed + measured, TS-stripping note, warm-up log; commits c3453e7..191e81e)
Task 4: minor (deferred): s4.md "Derived values" lacks cross-ref to codemode caveat; docs/codemode.md citation not resolvable in repo (package doc); TS-stripping figure ad hoc.
Task 4: complete (commits 0648f25..191e81e, review clean)
Task 5: dispatched (base 191e81e, model sonnet)
Task 5: implementer agent aac04a35a2af54c6a (sonnet); report task-5-report.md
Ruling: R47 — S8 (Task 6) deferred: no docker/podman on host; installing needs sudo (user decision); S8 does not gate M1 — cost: M9 waits on it.
Task 6: deferred (R47) — not dispatched
Task 5: implementer DONE (f109da7), S7 GO (trust.json = Pi's store, read/write in place); security finding carried as R48 (fail-closed trust in T20). Review package: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-191e81e..f109da7.diff: 1 commit(s), 79972 bytes
Task 5: ⚠️ SDK dist file:line citations unverified (node_modules rule respected); Ruling: resolved by R48b — Task 20 tests pin the behaviour (late extensions not loaded, store failure = untrusted, no decision = no run) — if wrong, Task 20's tests fail loudly (low).
Task 5: minor (deferred): late-reload probe can't distinguish resolver re-run; mtime-only untouched check; stale-lock self-heal unmeasured; HOME sensitivity unprobed; no settings.md citation; machine path in s7.md:28; chmod check assumes non-root.
Task 5: complete (commits 191e81e..f109da7, review clean)
Task 7: dispatched (base f109da7, model sonnet)
Task 7: implementer agent a99b8e41daa1ac7df (sonnet); report task-7-report.md
Ruling: R49 — S8 un-deferred: podman installed by user; run with podman, docker labelled unmeasured; runs after Task 7 — low.
Task 7: implementer DONE_WITH_CONCERNS (612a7ac), S5 FALLBACK → CodeMirror merge (R50); WebKit not run → R51 (Playwright in podman image). Review package: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-f109da7..612a7ac.diff: 1 commit(s), 133378 bytes
Task 7: ⚠️ Safari 16.4 behaviour unverified (WebKit not run) — accepted: reversal condition recorded in s5.md and R50; R51 enables WebKit runs in podman later.
Task 7: minor (deferred): Pierre diff tints not verified equal to tokens; "824 KB in 4 requests" double-counts worker; JS floor scan covers 14 APIs only; CodeMirror scanLimit=500 → large diffs may use crudeMatch (M3/M6 DiffView must verify chunk exactness or raise scanLimit); @types/node caret; build:pierre-worker missing script; floor-scan.ts not type-checked.
Task 7: complete (commits f109da7..612a7ac, review clean)
Task 6: dispatched (base 612a7ac, model sonnet, podman per R49)
Task 6: implementer agent ae30b1c4892b23f80 (sonnet); report task-6-report.md
Task 6: implementer DONE_WITH_CONCERNS (5be28b7), S8 FALLBACK: needs --security-opt systempaths=unconfined; fail-closed full-profile probe (R52; compose default = user decision at M9). Review package: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-612a7ac..5be28b7.diff: 1 commit(s), 14495 bytes
Task 6: review Needs fixes — 2 Important (systempaths=unconfined cost understated/thin evidence; extra cells + isolation check unrecorded) → fix round 1 sent (fix base 5be28b7).
Task 6: Ruling: reviewer's "base image left cached" minor waived — the dispatch explicitly allowed cached pulled base images — none.
Task 6: fix round 1/5 (2 addressed, 0 open — cost of systempaths=unconfined recorded via extra.sh/inside.sh; evidence committed; commits 5be28b7..5644f5a)
Task 6: minor (deferred): /proc/sys/* write claim sampled (ns_last_pid 0666 untested); bwrap version/deb12u1 citations not in raw output; "cannot change /proc result" is reasoning; two separate image builds; full profile minus --proc not run.
Task 6: complete (commits 612a7ac..5644f5a, review clean)
Task 8: dispatched (base 5644f5a, model sonnet)
Task 8: implementer agent aa05968c135d4e78c (sonnet); report task-8-report.md
Task 8: implementer DONE (4c98a9d), S6 GO (Apache-2.0, adopt structure with attribution; rework className/raw colours/Shimmer; Collapsible primitive needed) → R53. Review package: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-5644f5a..4c98a9d.diff: 1 commit(s), 120835 bytes
Task 8: ⚠️ spikes/ must stay out of the 400-line gate — already covered (plan convention: spikes excluded from ESLint/Prettier/knip/tsc; R4).
Task 8: minor (deferred): render-check misses template-literal classes (bg-bg, px-3, py-2 verified ok by reviewer); "0/49 lines" figure inconsistent; check.ts blind to arbitrary variants; spikes/s6/upstream/ lacks provenance + full licence text (M3: delete or annotate); fallback rationale overstates independence (Message is derived); token fixture predates R23; focus ring → R54; branch wrap logic untested; @types/node caret.
Task 8: complete (commits 5644f5a..4c98a9d, review clean)
M0 gate: S2 (docs/spikes/s2.md) Decision: GO; S1 (docs/spikes/s1.md) Decision: GO → M1 may start. S3 GO, S4 results, S5 FALLBACK (CodeMirror), S6 GO, S7 GO, S8 FALLBACK (systempaths=unconfined, user decision at M9).
Task 9: dispatched (base 4c98a9d, model haiku)
Task 9: implementer agent ac128a4597a881d4a (haiku); report task-9-report.md
Task 9: implementer DONE_WITH_CONCERNS (f91ba4d); report recorded by controller (haiku declined .md). Review package: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-4c98a9d..f91ba4d.diff: 1 commit(s), 41273 bytes
Task 9: review Needs fixes — 2 Important (corepack in scripts; zod caret, plan-mandated) → Ruling: both fixed per R55/R56 (portable bare pnpm + local shim; exact pin) — fix round 1 sent (fix base f91ba4d).
Task 9: minor (deferred): int-test child spawn lacks --disable-warning (no warning on 24.14.1); vitest resolve/ssr conditions untested until T12; Renovate @types/node cap → R57 (T11); build red until T20.
Task 9: fix round 1/5 (2 addressed, 0 open — bare pnpm scripts, zod 4.6.5 exact; commits f91ba4d..d26b184)
Task 9: complete (commits 4c98a9d..d26b184, review clean)
Task 10: dispatched (base d26b184, model haiku)
Task 10: implementer agent aad5ad087dc8812c8 (haiku); report task-10-report.md (or final message)
Task 10: implementer BLOCKED (typescript-eslint refuses TS 7; nothing committed). Ruling: R58 pin TypeScript 6.0.x exact repo-wide (boring tech, single toolchain) — cost: slower tsc than TS7 native (low). Also R59 (boundaries test in temp fixture project), R60 (unrs-resolver build decision). Re-dispatch = resume same implementer (round 0, unblock).
Task 10: implementer DONE_WITH_CONCERNS (ff09b13) after R58–R60 unblock; report recorded by controller. Review package: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-d26b184..ff09b13.diff: 1 commit(s), 120434 bytes
Task 10: ⚠️ reported test/lint/knip results not re-run by reviewer — accepted (reviewer's independent probe confirmed gates fire; report records commands + output).
Task 10: minor (deferred): max-lines waivable via reasoned disable (→ fixed in T11 by R61, plan-mandated); allowed-import assertions weak (toEqual([]) passes if unresolved); tests cwd-dependent (→ R61); pap rules limits (JSXMemberExpression restyle, arbitrary variants/opacity, #add false positive, CSS not linted).
Task 10: complete (commits d26b184..ff09b13, review clean)
Task 11: dispatched (base ff09b13, model haiku)
Task 11: implementer agent a659ed42095c79734 (haiku); report task-11-report.md (or final message)
Task 11: implementer DONE_WITH_CONCERNS (e76427c, 208d981); report recorded by controller. Review package: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-ff09b13..208d981.diff: 2 commit(s), 12360 bytes
Task 11: review Needs fixes — 1 Important (R61 bypass via inline `/* eslint max-lines: "off" */`, ruling-mandated gap) → Ruling R62 amends R61 (no-use allow-list + tests) — fix round 1 sent (fix base 208d981).
Task 11: minor (deferred → R63 in T27): major-tag action pins; nightly min-release-age=0 global bypass (plan-mandated; uncommitted run); vacuous nightly (no-change guard, no typecheck); docs-only skip vs required checks & root *.md format; cancel-in-progress on main; no timeout-minutes; duplicated Node version/.nvmrc "24"; Renovate internalChecksFilter/ignorePaths spikes; bump test happy-path only.
Task 11: fix round 1/5 (1 addressed, 0 open — no-use allow-list + tests; commits 208d981..c7d6d4d)
Task 11: out-of-scope residual → R64 (T26): guard rules themselves can be disabled; allow-list unpinned; no-use also rejects /* global */, /* eslint-env */ (tightening, lint clean).
Task 11: complete (commits ff09b13..c7d6d4d, review clean)
Task 12: dispatched (base c7d6d4d, model sonnet)
Task 12: implementer agent a02c7b7b6d8a9db43 (sonnet); report task-12-report.md
Task 12: implementer DONE (59d143c). Review package: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-c7d6d4d..59d143c.diff: 1 commit(s), 22983 bytes
Task 12: ⚠️ items resolved: frame cap enforcement → T16 (ws maxPayload); commandId requirement → R65 (T16); knip pre-existing; unknown types wrapped as pi_event per brief (OK).
Task 12: minor (deferred): PAP_TYPES duplicated (→R67); worker-origin strings unbounded (→R66 consumer truncation); DialogResponse union non-strict; server→client frames less bounded (epoch/sub/capabilities); dialog prefill vs 1 MiB frame (→R66); PiEvent duplicate schema; thin record tests (init, prompt, shutdown, policy_update, ui_closed…); errors arrays omit read_only; ResponseFrame requires result key.
Task 12: complete (commits c7d6d4d..59d143c, review clean)
Task 13: dispatched (base 59d143c, model sonnet)
Task 13: implementer agent ab88e17121f45b86f (sonnet); report task-13-report.md
Task 13: implementer DONE (8150349); fixed 3 brief bugs (logger depth leak, header override, config error echo). Review package: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-59d143c..8150349.diff: 1 commit(s), 23950 bytes
Task 13: review Needs fixes — 2 Important (plan-mandated): empty/relative/tilde PAP_HOME & PI_CODING_AGENT_DIR; empty --host binds all interfaces.
Task 13: Ruling: promote 3 minors to load-bearing (fix now, same files): clock delays > 2^31−1 ms (T17 30-day sessions would expire at once); redaction key gaps (privateKey/signing/hmac/bearer/jwt) + inputTokens false positive (FinOps logging); logger not total (BigInt/getters/cycles) — cost if wrong: small extra scope in fix round 1.
Task 13: minor (deferred): colliding caller fields dropped, error codes lost; --dev id from process cwd + PAP_HOME overrides dev home; PAP_PUBLIC_ORIGIN any scheme; fake clock NaN/negative; randomToken(0); test gaps (dev ids, overrides, createSystemClock, ids); Number() accepts 0x50/1e3, no PAP_MAX_WORKERS upper bound.
Task 13: fix round 1 sent (fix base 8150349).
Task 13: fix round 1/5 (5 addressed, 0 open — dirs, host, long timers, redaction keys, total logger; commits 8150349..cf5b0d2)
Task 13: minor (deferred, FINAL REVIEW should triage — security-relevant): redaction recall regression vs old substring regex (accessTokens/refreshTokens/apiTokens, accesstoken/clientsecret/secretkey, token2/api_key2 not redacted); optional onSinkError hook; redact() signature change; port 80/443 dropped from origin (untested); PAP_TEST_PROVIDER_SCRIPT="" inconsistent; IPv6 zone ids rejected; no total-node budget in walk; child() redact outside try.
Task 13: complete (commits 59d143c..cf5b0d2, review clean)
Task 14: dispatched (base cf5b0d2, model sonnet)
Task 14: implementer agent abebdc794a6c81eb5 (sonnet); report task-14-report.md
Task 14: implementer DONE (bf39584); file-mode concern carried as R68 (T23). Review package: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-cf5b0d2..bf39584.diff: 1 commit(s), 30279 bytes
Task 14: review Needs fixes — 2 Important (plan-mandated): no checksum/ordering guard on applied migrations; snapshot raw-copies a live WAL db (checkpoint busy result ignored, untested).
Task 14: Ruling: fix both now (no real DB exists yet); R71 snapshot via backup()/VACUUM INTO + temp+rename (also fixes partial-snapshot minor); fold trivial ordering minors into fix 1 (plain string compare instead of localeCompare; re-check schema_migrations inside BEGIN IMMEDIATE). Receipt notes → R69 (T16); single-instance guard → R70 (T23).
Task 14: minor (deferred): broken-migration R2 test vacuous (the "half" test is the real proof); snapshots never pruned; missing source dir raw ENOENT; Db.transaction nesting/thenable limits (plan-mandated); copy-sql entry check fragile under symlinks.
Task 14: fix round 1 sent (fix base bf39584).
Task 14: fix round 1/5 (2 addressed, 0 open — checksum+ordering guard, VACUUM INTO snapshot temp+rename 0600; commits bf39584..46e857e)
Task 14: minor (deferred): VACUUM INTO temp file briefly 0644 before chmod (closed if backups/ is 0700 — R68); orphaned *.tmp after hard crash not swept; race recheck presence-only; add .gitattributes '*.sql text eol=lf' (checksums byte-exact); backups dir not fsynced after rename; plan text still says snapshotDir (stale).
Task 14: complete (commits cf5b0d2..46e857e, review clean)
Task 15: dispatched (base 46e857e, model sonnet)
Task 15: implementer agent a871568c48b0b1aec (sonnet); report task-15-report.md
Task 15: implementer DONE (a05896a); hardened static.ts beyond brief (traversal cases 404 instead of SPA fallback). Review package: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-46e857e..a05896a.diff: 1 commit(s), 26405 bytes
Task 15: ⚠️ RED/GREEN, R4, R43 not re-verified by reviewer — accepted (report evidence + mutation check against the brief's static.ts).
Task 15: minor (deferred → R73–R78): HSTS includeSubDomains on cleartext; no CSP; no post-listen error listener; close() vs upgraded sockets; MIME table lacks .mjs/.wasm/.map/.webp/.jpg/.gif/.woff; Origin guard vs future token/webhook POSTs (later milestone); no body limit; onError flattens HTTPException; SPA fallback covers API prefixes; test gaps (OPTIONS exact status, Origin:null, sibling-prefix symlink, TLS branch).
Task 15: complete (commits 46e857e..a05896a, review clean)
Task 16: dispatched (base a05896a, model sonnet)
Task 16: implementer agent a2c6fcc699befc574 (sonnet); report task-16-report.md
Task 16: implementer DONE_WITH_CONCERNS (d450bb6). Ruling: R65b — implementer's reading accepted (mutations = idempotent:false need commandId; R65 wording was inverted vs the codebase convention) — spec §4.1 example to fix in docs — none. Also accepted: R7 as a 15 s window (dead peer cut 15–30 s after last frame); R69 params hash stored inside the receipt result JSON (no migration; Task 14 closed) — low.
Task 16: review package /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-a05896a..d450bb6.diff: 1 commit(s), 60703 bytes
Task 16: review Needs fixes — 3 Important (plan-mandated): receipt save failure after success reported as failure (double execution on retry; read-only DB case); failed subscription open after ok leaves a dead sub; unbounded hub memory.
Task 16: Ruling: fix all 3 now (T22 builds on the hub); fold same-file minors: stringify before ++seq (seq hole), per-connection subscription cap 64 → `capacity`. Accepted as-is: R7 window design; R69 {paramsHash,result} storage (undocumented shape noted).
Task 16: minor (deferred): N+1 serialisation & ring aliasing (store strings later); hub.close O(all subs); lost observability (ws_bad_json debug, binary frames, void onText rejection path, no in-flight cap); test gaps (throwing subscriber isolation, dispatcher+real receipt store round-trip, in-flight duplicate whose original fails); snapshot size contract for T22 (≤ ~75 rows, < 1 MiB).
Task 16: fix round 1 sent (fix base d450bb6).
Task 16: fix round 1/5 (5 addressed, 0 open — receipts exactly-once + read-only refusal, two-phase subscribe, idle ring eviction keeping seq, stringify-before-seq, 64-sub cap; commits d450bb6..3795143)
Task 16: minor (deferred): ReceiptStore.readOnly required in fakes; no int test for socket closing between prepare and response; committed flag set before commit loop; residual Channel objects (→R79); prepared queue unbounded (short-lived); idle timer not re-armed by publishes while idle; hub.close O(N); publish throws on non-serialisable events.
Task 16: complete (commits a05896a..3795143, review clean)
Task 17: dispatched (base 3795143, model sonnet impl, opus reviewer)
Task 17: implementer agent a4ff811296320e9d7 (sonnet); report task-17-report.md
Task 17: implementer DONE_WITH_CONCERNS (468bb70); deviations: throttle counted before scrypt, cookie re-issued on /auth/status. Review package: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-3795143..468bb70.diff: 1 commit(s), 73305 bytes — reviewer opus (decision 35)
Task 17: Opus review Needs fixes — I1 Secure dropped behind Host-rewriting TLS proxy (→R24b); I2 owner lockout cheap & invisible (plan-mandated → R80 document + log). Deviations D1–D4 accepted; concerns C1, C2, C4 accepted; C3 rejected (became I1).
Task 17: Ruling: fold security minors M2 (scrypt p=3, OWASP floor; params stored so non-breaking), M3 (reset cached dummy hash on rejection — enumeration oracle), M4 tests (dummy-hash spy, race loser `conflict`, module over existing owner, auth-level 403 without/foreign Origin, no Domain=), M5 (ADR wording). Deferred: M1 throttle map growth/cap/IPv6 /64 (roadmap via R80), M6 int-test cleanup, M7 revoke previous session on re-login + __Host- prefix.
Task 17: fix round 1 sent (fix base 468bb70); re-review opus.
Task 17: fix round 1/5 (6 addressed, 0 open — R24b Secure from https public origin, R80 failure logs + docs/agents/auth.md, scrypt p=3, dummy-hash reset, M4 tests, ADR wording; commits 468bb70..8aee8e7; Opus re-review)
Task 17: minor (folded into T18): ADR 0004 decision wording (public origin must be plain-http LOOPBACK, not just http:); docs/agents/auth.md lockout wording (password sign-in can be denied indefinitely; passkey = recovery path); task-18 brief needs secureByConfig + shared sessionCookie (R33).
Task 17: minor (deferred): auth_throttled could carry which key tripped + suppressed count; p=3 latency on 4-thread pool; R80 roadmap (device-cookie exemption, throttle cap, IPv6 /64); M6 int-test cleanup; M7 revoke previous session on re-login, __Host- prefix.
Task 17: complete (commits 3795143..8aee8e7, review clean)
Task 18: dispatched (base 8aee8e7, model sonnet impl, opus reviewer)
Task 18: implementer agent a8ba3c74e29d2c22f (sonnet); report task-18-report.md; Ruling: R81 UV required + single-use capped flows — passkey is a sole factor — PIN-less security keys excluded (low)
Task 18: implementer DONE_WITH_CONCERNS (a1a801d). Accepted: @simplewebauthn/server pinned 13.3.3 (brief + browser ^13; browser must be exact-pinned in the web task, R56); shared passkey throttle across enroll/login; two T17 tests edited. Open for reviewer: login/options flow-cap eviction by one client (passkey = recovery path, R80). Note: root `pnpm build` fails in packages/pi-host (no sources until T21) — verify T21 fixes it.
Task 18: review package /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-8aee8e7..a1a801d.diff: 1 commit(s), 95066 bytes — reviewer opus
Task 18: Opus review Needs fixes — I1 login/options flood evicts pending sign-ins (defeats R80 recovery) → R82 stateless HMAC login challenge; I2 stolen session silently enrolls permanent passkey → R83 password step-up + enrollment log + docs. Concerns 1,3,4,5 accepted.
Task 18: Ruling: fold M1 (check userHandle at login), M2 (validate transports to known strings), M4 (ceremony test origin http://localhost:3000 refused), M5 (one shared auth test helper: setup-token extraction + module/app builder + migrate boilerplate), M6 (auth.md: recovery path weaker behind shared addresses). Deferred: M3 counter-regression audit signal (audit table), M7 throttle map growth (R80 follow-up).
Task 18: fix round 1 sent (fix base a1a801d); re-review opus.
Task 18: fix round 1 DONE_WITH_CONCERNS (f538dc2): 'unauthenticated' used for R83's 'unauthorized' (accepted — existing code, indistinguishable from wrong login); testing helpers moved to modules/auth/testing (boundaries) with build exclude src/**/testing/**; service.confirmPassword shares login's check
Task 18: fix round 1/5 (7 addressed, 0 open — R82 stateless HMAC login challenge, R83 password step-up + enrollment log, userHandle, transports, localhost:3000 test, shared test bed, docs; commits a1a801d..f538dc2; Opus re-review)
Task 18: minor (deferred → R83b T26, R84 T19, R85 roadmap): lint guard on testing imports; login lookup before guard (nit); clock step-back replay window; passkey throttle counted after await; enrollment flow bound to user not session.
Task 18: complete (commits 8aee8e7..f538dc2, review clean)
Task 19: dispatched (base f538dc2, model sonnet impl, opus reviewer)
Task 19: implementer agent afa630a72ebde6b84 (sonnet); report task-19-report.md; must make root pnpm build green
Task 19: implementer DONE_WITH_CONCERNS (f4501c4 R84, 0a39c6b); pnpm build green; real Pi session probe OK. Flagged for Opus: clipped >4000-char approval payload; R14 gaps incl. .git/hooks and .pi/extensions inside cwd auto-allowed. Review package: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-f538dc2..0a39c6b.diff: 2 commit(s), 160418 bytes
Task 19: Opus review Needs fixes — I1 clipped approval payload (→R86), I2 invisible/bidi spoofing (→R87), I3 auto-allowed edits to .git/.pi → code exec (→R14b), I4 outside-cwd dialog hides real target (→R88). Concerns 1, 6 accepted; 2 accepted for M1 (M5).
Task 19: Ruling: fold M2 signal, M3 builtin sourceInfo check, M4 ADR wording, M5 audit field clip, M6 knip ignore (→R89). Deferred → R90 (T20/M5): M1, M7, M8, M9.
Task 19: fix round 1 sent (fix base 0a39c6b); re-review opus.
Task 19: fix round 1 DONE (195ee0f); PAP_HOME not in InitRecord → T20 (R90); 'contains home' covers parents of home (accepted, safe direction)
Task 19: fix round 1/5 (4 addressed, 1 open — R88 arrow shows literal spelling not Pi's write target; Opus re-review)
Task 19: Ruling: fix round 2 = R88b + folded minors R86b (cap on escaped text), R87b (default-ignorables), R14c (cwd segments, agentDir literal, ADR residuals incl. links into cwd), R89b (command-only view by trusted category); R90b T20 brief staleness noted.
Task 19: fix round 2 sent (fix base 195ee0f); re-review sonnet (small scoped diff).
Task 19: fix round 2 DONE (0c00988); 1 MiB raw pre-scan bound added; describeCall now (toolName, input, {exec, review}) → {reviewable, message} (R90b)
Task 19: fix round 2/5 (5 addressed, 0 open — R88b Pi-spelling target+decision, R86b escaped cap, R87b default-ignorables, R14c cwd segments + agentDir literal + ADR residuals, R89b trusted exec view; commits 195ee0f..0c00988)
Task 19: minor (deferred → R91): U+1680 class mismatch; lookalike blanks; vertical newline padding (UI scroll); reason-vs-target edge case.
Task 19: complete (commits f538dc2..0c00988, review clean)
Task 20: dispatched (base 0c00988, model sonnet impl, sonnet reviewer)
Task 20: implementer agent a393c7127cfd8259a (sonnet); report task-20-report.md; Ruling: R90 papHome REQUIRED in InitRecord (contract change in T20) — policy needs both protected roots — T21/T22 must pass it (low)
Task 20: implementer DONE_WITH_CONCERNS (253b570). Accepted: R66 reading (invalid init.policy → exit 70; invalid policy_update keeps previous rules + extension_error); extra init path checks; malformed init exits 70. Ruling: R92 CI probes must fail not skip (T26/T27); R93 worker contract for T21/T22.
Task 20: review package /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-0c00988..253b570.diff: 1 commit(s), 117352 bytes — reviewer sonnet
Task 20: review Needs fixes — I1 network guard lets TLS/fetch through (→R94); I2 late prompt rejection swallowed (→R95). Concerns 1–3 accepted.
Task 20: Ruling: fold M1 malformed shutdown, M2 queue cap, M4 ipc closed-channel, M5 clip extension_error, M6 second provider gate + AbsolutePath, M7 tests (→R95). Deferred: M3 crash/orphan dispose → T21 process-group kill (R96); M8 papHome narrowing → R97.
Task 20: fix round 1 sent (fix base 253b570).
User pre-approval (2026-10-10 23:5x UTC): Opus escalation for fix rounds 4–5 allowed if needed (this plan run only).
Task 20: fix round 1 DONE (5e663fe); host.lifetime.int.test.ts split (400-line cap); DNS not intercepted (accepted, R94 scope)
Task 20: fix round 1/5 (2 Important + folded addressed, 0 open — R94 guard blocks all TCP/TLS/fetch/http2, R95 late failure log, shutdown/queue/clip/provider gate/ipc/reopen; commits 253b570..5e663fe)
Task 20: minor (deferred → R98 T21): number-like bare-string connect bypass; multi-launch bed stderr; pin guard in DEV_EXEC_ARGV; graceMs cap. Out of scope: UDP/DNS unguarded, bash children not covered (test scripts must not use curl).
Task 20: complete (commits 0c00988..5e663fe, review clean)
Task 21: dispatched (base 5e663fe, model sonnet impl, opus reviewer)
Task 21: implementer agent a65a628c33e772040 (sonnet); report task-21-report.md; Ruling: R28 amended — fake worker at apps/daemon/src/kernel/testing/ (boundaries let module tests import kernel, R84 blocks prod) — none
Task 21: implementer DONE_WITH_CONCERNS (9611fc4, b51a0f7). Accepted: no IPC record-size cap at receive (T22 caps kept/forwarded, R66); R46 limits apply with systemd scopes (M2); daemon SIGKILL → worker watchdog only. Review package: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-5e663fe..b51a0f7.diff: 2 commit(s), 70519 bytes — reviewer opus
Task 21: Opus review Needs fixes — I1 30 s default timeout breaks extension-command prompts (→R99); I2 setsid'd bash trees + daemon signal deaths leak processes, comments overclaim (→R100); I3 IPC garbage/huge line crashes daemon (plan-mandated → R101 cap at source + durable framer later).
Task 21: Ruling: fold all minors (→R102): tail 8 KiB, NODE_OPTIONS strip, forced flags after extra, reaped flag, destroy pipes, EPERM log, unkillable test, graceMs 1500, fake parity, test hazards, host-bed close.
Task 21: fix round 1 sent (fix base b51a0f7); re-review opus.
Task 21: fix round 1 DONE (b78ad7e, 811a80a); concerns: orphan path no int test, worker SIGKILL/OOM residual (M2 cgroup), shutdown kills tree before abort; extra may still set NODE_OPTIONS
Task 21: fix round 1/5 (3 Important + folded addressed, 0 open — R99 per-command timeouts + timeout code, R100 /proc descendant cleanup + killAllWorkerGroups, R101 4 MiB source cap, R102 hardening; commits b51a0f7..811a80a; Opus re-review)
Task 21: minor (deferred → R103 T22, R104 T23, R105 T22, R106 M2): agent_end size, stop order note, test hazards, id slice, single /proc snapshot, SIGTERM needs event loop (ADR line), timeout on mutation semantics.
Task 21: complete (commits 5e663fe..811a80a, review clean)
Task 22: dispatched (base 811a80a, model sonnet impl, opus reviewer)
Task 22: implementer agent a7fd863397adeea2e (sonnet); report task-22-report.md
Task 22: implementer DONE_WITH_CONCERNS (e9e2868 R103, 036a6d7). pi-web checked clean after the stray-file incident (no untracked, no recent modifications). Ruling: R107 filter system-role messages; R108 lazy SDK import. Accepted: R37 ADR 0005; no method returns timeout yet (R105); deferred idle release (M2), needs-input push (M12). Open for reviewer: partial assistant message missing from snapshot; selects >100 options cancelled.
Task 22: review package /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-811a80a..036a6d7.diff: 2 commit(s), 178875 bytes — reviewer opus
Task 22: Opus review Needs fixes — I1 R107 not done; I2 R108 not done (sync provider → R108b); I3 one oversize row empties the snapshot (→R109); I4 sessions.abort idempotent:true (→R110). Concerns 3,4,6 accepted; 5: partial message/coalescing deferred to M2 (R112), select>100 cancel accepted.
Task 22: Ruling: fold M1 idle abort, M2 *_end measure, M3 upToBytes read, M8 notice rate-limit, docs (→R111). Deferred → R112: M4, M5, M6, M7, M9, steering queue cap, get_entries.
Task 22: fix round 1 sent (fix base 036a6d7); re-review opus.
Task 22: fix round 1 DONE (1a14a94); sessions module import 163→96 MB, 650→110 ms; first subscription pays ~89 MB/0.56 s once; abort needs commandId (T25/T26 web must send)
Task 22: fix round 1/5 (4 Important + folded addressed, 0 open; Opus re-review) — Ruling: fix round 2 for two cheap correctness minors + R111 automatic clear (→R111b); M2 backlog R113.
Task 22: fix round 2 sent (fix base 1a14a94); re-review sonnet.
Task 22: fix round 2 DONE (41c0655)
Task 22: fix round 2/5 (3 addressed, 0 open — idle-abort generation guard + abort still sent, auto-clear stale runs, role clip; commits 1a14a94..41c0655)
Task 22: minor (deferred → R112/R113 M2): closeStaleRun swallows callback errors silently; stale-idle abort doesn't wait/kill; cosmetic aborted flag race.
Task 22: complete (commits 811a80a..41c0655, review clean)
Task 23: dispatched (base 41c0655, model sonnet impl, sonnet reviewer)
Task 23: implementer agent a6ac3387a88fe579f (sonnet); report task-23-report.md
Task 23: implementer DONE_WITH_CONCERNS (e537b4e). Ruling: R114 workers restore the original umask (InitRecord.umask) — expected fix item. Accepted: knip.json unchanged (bin entry found); lock takeover non-atomic after crash (noted). Review package: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-41c0655..e537b4e.diff: 1 commit(s), 76318 bytes — reviewer sonnet
Task 23: review Needs fixes — I1 R114 not done (→R114b); I2 repeated server error forces SIGKILL (→R115); I3 lock refuses restart when pid repeats (→R116); I4 e2e kill(0) hazard. Concerns: knip accepted; non-atomic takeover accepted (Minor 1); docs note folded.
Task 23: Ruling: fold M1 link() message, M2 wal/shm + tighten modes, M3 zombie-safe check, M4 harness hygiene, M6 docs/agents/daemon.md, M7 setup_url regardless of level (→R117). Deferred → R118: daemon-layer R94 check (M2), T26 CSP/Vite checks.
Task 23: fix round 1 sent (fix base e537b4e).
Task 23: fix round 1 DONE (2194c1a); dist smoke under umask 022: worker file 0644, setup_url printed at PAP_LOG_LEVEL=error
Task 23: fix round 1/5 (4 Important + folded addressed, 0 open — R114 umask in workers, R115 onFatal once, R116 lock pid reuse + start time, kill guard, R117 hygiene/docs; commits e537b4e..2194c1a)
Task 23: minor (parked → R119, final fix pass): lock error hint, symlink chmod, waitFor timeout, docs limits. Note: session transcripts now follow the user umask (CLI parity).
Task 23: complete (commits 41c0655..2194c1a, review clean)
Task 24: dispatched (base 2194c1a, model sonnet impl, sonnet reviewer)
Task 24: implementer agent a54e02eae8979ec93 (sonnet); report task-24-report.md; ApprovalCard renders detail verbatim pre, scrollable, sticky header (R86/R87/R91)
Task 24: implementer DONE_WITH_CONCERNS (daa182e). Accepted: danger = error tone (DESIGN §9.1 authority over brief); mono-uppercase labels etc. deferred to M3; no DOM test lib (Playwright T27 covers disabled state). Review package: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-2194c1a..daa182e.diff: 1 commit(s), 38503 bytes — reviewer sonnet
Task 24: review Needs fixes — I1 ref read during render in ApprovalCard (react-hooks/refs, probe-confirmed). Concerns 1–4 accepted (danger=error confirmed).
Task 24: Ruling: fold M1 aria-describedby, M2 TextField alert/hint/disabled/IME, M5 @theme color reset, deferral comment (→R121); DESIGN-level contrast gaps → R120 (user decision, M3). Deferred: M7 key enforcement (T26/T27 wiring), M8 DOM tests (T27).
Task 24: fix round 1 sent (fix base daa182e).
Task 24: fix round 1 DONE (f463d0f); refs probe 1→0 problems; palette reset verified. Ruling: R122 enable compiler-era react-hooks rules in T26. Review package: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-daa182e..f463d0f.diff: 1 commit(s), 16410 bytes
Task 24: fix round 1/5 (1 Important + folded addressed, 0 open — lazy once guard, aria-describedby, TextField alert/hint/disabled/IME, palette reset; commits daa182e..f463d0f)
Task 24: minor (deferred): Safari IME keyCode 229 guard (M3); DOM test of guard/disabled (T27); long body read in full by AT.
Task 24: complete (commits 2194c1a..f463d0f, review clean)
Task 25: dispatched (base f463d0f, model sonnet impl, sonnet reviewer)
Task 25: implementer agent a8dcbabadc7be5840 (sonnet); report task-25-report.md
Task 25: implementer DONE_WITH_CONCERNS (840cf35); real-daemon smoke OK; fixed plan bug (snapshot lost when subscribe reply + snapshot same tick). Open for reviewer: failed subscribe not surfaced; second listener gets no snapshot. Review package: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-f463d0f..840cf35.diff: 1 commit(s), 57633 bytes — reviewer sonnet
Task 25: review Needs fixes — I1 failed subscribe invisible (→R123); I2 unknown error code hangs a call (→R123). Deviations accepted (early buffer, unclaimed release, dead timer, probe guard, pins).
Task 25: Ruling: fold M1–M6, M8, M11 (→R124); commandId per user retry = new (R124); deferred → R125: stream keying, hidden-tab cycle, HMR singleton.
Task 25: fix round 1 sent (fix base 840cf35).
Task 25: fix round 1 DONE (c5f6a8a); supervisor probe deadline 10 s; real-daemon smoke not re-run (T26/T27 e2e will exercise)
Task 25: fix round 1/5 (2 Important + R124 addressed, 1 open Minor — vacuous nudge-after-stop test). Ruling: round 2 with same-file minors (→R126).
Task 25: fix round 2 sent (fix base c5f6a8a).
Task 25: fix round 2 DONE (2303b80); stale release only on same connection (sub ids restart per connection)
Task 25: fix round 2/5 (6 addressed, 0 open — vacuous test fixed, onError doc, RpcErrorCode export, constants renamed, deadline cleanup, stale release on same connection; commits c5f6a8a..2303b80)
Task 25: minor (deferred): deadline tag timing in test bed; crossed-request capacity edge.
Task 25: complete (commits f463d0f..2303b80, review clean)
Task 26: dispatched (base 2303b80, model sonnet impl, sonnet reviewer)
Task 26: implementer agent aecfedfd60ce8afec (sonnet); report task-26-report.md
User (2026-10-11 ~07:00 UTC, question "Playwright is for e2e test? I think we can skip them for the moment?"): Ruling: Task 27-lite — keep budgets script, root tsconfig (R25), CI timeouts/SHA pins (R63); drop Playwright/podman/journey/e2e job; journey moves to M3 — user suggestion, controller default stated, user can override — lost: automated browser + WebKit proof (low/medium).
Task 26: implementer DONE_WITH_CONCERNS (bdaf427 R64/R122, 72c45c7). Bundle 140.5 kB gz / 180. No browser on host (no Chrome; Playwright shell lacks libatk; installing needs sudo) → controller browser smoke not possible; user's manual POC test is the browser check. R64 residual (block comment self-suppression) accepted for M1. Review package: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-2303b80..72c45c7.diff: 2 commit(s), 235913 bytes — reviewer sonnet
Task 26: review Needs fixes — I1 dead approval card after failed answer; I2 silent passkey register failure; I3 role:timestamp key drops parallel tool results; I4 provider error shown as empty reply (→R127); I5 R64 holes (→R64b); I6 Playwright leftovers (→R128). Concerns: no browser (accepted), compiler runs in prod (confirmed), jitless/happy-dom accepted.
Task 26: Ruling: fold minors (→R128); deferred M3: @pap/ui compile, locale switch, server text i18n.
Task 26: fix round 1 sent (fix base 72c45c7).
Task 26: fix round 1 DONE (b666742, d27907d, 2673150); bundle ~141.5 kB gz
Task 26: fix round 1/5 (6 addressed, 0 open — re-armed approval card, passkey verify 401, message identity, provider error, R64b, Playwright cleanup + minors; commits 72c45c7..2673150)
Task 26: minor (deferred → R129 M3): quadratic snapshot reduce; role:none dedup; DESIGN Playwright line. Inline-config bypass → R64c in T27-lite.
Task 26: complete (commits 2303b80..2673150, review clean)
Task 27: dispatched as 27-lite (base 2673150, model sonnet impl, sonnet reviewer; brief task-27-lite-brief.md)
Task 27: implementer agent a45529433cfcf8f86 (sonnet); report task-27-report.md
Task 27: implementer DONE_WITH_CONCERNS (f3f4b90); full M1 gate green (1200 unit, 179 int, budgets 136.6/180 KB). Ruling: R63b bump exits 1 only on no-match (implementer read R63 literally: already-latest → 1 → nightly red) — expected fix item. Review package: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-2673150..f3f4b90.diff: 1 commit(s), 32325 bytes — reviewer sonnet
Task 27: review Needs fixes — I1 R63b not done (expected); I2 budget test can't detect a wrong asset set (plan-mandated). Concerns accepted (install input, actions SHA pins, parser guard, yaml dep); Playwright ignore patterns left until M3.
Task 27: Ruling: fold minors — budgets throws on empty initialAssets / non-numeric budget, failure test asserts stdout, budgets job install:"false". Deferred: change-detector test brittleness.
Task 27: fix round 1 sent (fix base f3f4b90).
Task 27: fix round 1 DONE (6b98aec); gate green (1210 unit, 179 int, budgets 136.6/180)
Task 27: fix round 1/5 (2 Important + folded addressed, 0 open — R63b bump exit codes, exact budget test, no vacuous budget pass, budgets install:false; commits f3f4b90..6b98aec)
Task 27: minor (deferred): budgets job runs apt step unnecessarily; f3f4b90 body claim superseded (drop if squashed); prefetch links counted.
Task 27: complete (commits 2673150..6b98aec, review clean)
Final review: dispatched (base 3c9c278a = merge-base main, head 6b98aec, model opus)
Final review: With fixes — I1 open WebSockets outlive sign-out/expiry (smoke-confirmed); minors: R119 batch, omitted rows vanish in web, pre-ready events dropped, silent origin 403 on 0.0.0.0, TLS stack trace, read-only DB 500 on HTTP, logger redaction gaps, ADR 0001 umask, AGENTS.md POC line + eslint line, hub clock, nightly unit tests, no dist→dist smoke. Built-artifact smoke by reviewer: full POC path OK.
Final review: Ruling: one fix dispatch covering I1 + R119 + minors 2–12 (final-fix-brief.md) — fresh implementer sonnet; scoped re-review opus.
Final fix: dispatched (base 6b98aec, implementer agent a0d2ed9fa788b76ac sonnet; report final-fix-report.md)
Final fix: DONE_WITH_CONCERNS (14 commits b21dfad..cb01865); gate green (1290 unit, 189 int), pnpm smoke OK. Concerns: pre-ready events still not visible to cursor-less first subscriber (M2); workerExecArgv forwards --import preloads to workers (verify prod safety); TLS config holds PEM bytes. Review package: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m0-m1/.superpowers/sdd/2026-10-10-m0-m1-spikes-skeleton/review-6b98aec..cb01865.diff: 14 commit(s), 206880 bytes — scoped re-review opus
Final re-review: items 1–15 addressed; residual Important — commit 6966000 forwards unresolved --import preloads to workers (project-cwd resolution → project code before policy). Minors: keepalive slides session, read-only DB vs WS re-check, DER cert stack trace, whole Cookie header kept, smoke nits, M2 roadmap line.
Final residual adjudication: Ruling: R130 — load-bearing security residual fixed now with a small follow-up dispatch (resume final-fix implementer) + focused sonnet verification — deviates from "one fix dispatch" because leaving project-code-exec-before-policy unmerged is worse — cost one extra small round.
Final residual R130: DONE (c3af20a..d24d7df); gate green (1298 unit, 191 int), smoke OK
Final residual R130: verified (sonnet) — security point confirmed (26-flag probe); 4 trivial leftovers fixed by controller in f6a065e (--conditions= only, smoke http timeout, stale comment, daemon.md line) — RED→GREEN on config.test; gates green: lint, format, typecheck, knip, unit 1298, int 191 (4/5 runs green; 1 uncaptured failure right after build+smoke — possible flake), build, budgets 136.8/180, smoke ok.
Final review: CLEAN after residual fix. Branch feat/m0-m1 head f6a065e, 76 commits, fast-forward of main (3c9c278). Awaiting user decision on merge (local ff into main; no remote). SDD workspace kept (rulings.md to be archived into docs before deletion).
Post-M1 (user request 2026-10-11): --insecure-http opt-in for LAN testing (a394e50) — cookie without Secure on plain HTTP, insecure_http warning, refused with TLS, ADR 0004 exception; verified live on 192.168.1.182; gate green (1301 unit, 191 int, smoke ok). Also f6a065e (R130 leftovers).
