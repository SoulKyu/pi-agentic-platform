# M6 SDD ledger (archived 2026-10-16)

# SDD ledger — plan: /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m6/docs/plans/2026-10-15-m6-install.md

Roadmap M6 (decision 87, KISS: two methods); owner decisions .superpowers/owner-decisions-2026-10-15-m11m6.md (i1–i6 all recos); controller rulings .superpowers/m11-m6-controller-rulings.md (W5-R1, W5-R2); agreements .superpowers/m11-m6-cross-plan-agreements.md (C1–C5, 1–13).
Owner GO for execution 2026-10-15 ("Go, 3 lanes"). Plan at 810b6be (rebased on main 35ecc54). One lane (M6 runs its two chains in sequence): .worktrees/feat-m6 (feat/m6-install).
Models (owner-approved): 7 Sonnet implementers; Opus reviewers on T1 (unit rendering, spawn argv) and T5 (archive checksum, untrusted extraction); Sonnet reviewers on T2, T3, T4, T6, T7; Opus final review. Opus implementer at fix rounds 4–5 pre-approved (c2). No Haiku.
Merge first (c1), after the owner's OK.

## Pre-flight scan (2026-10-15)
- The plan's "Pre-execution conflict scan" and "Chains" (A: T1→T2→T3; B: T4→T5; join T6 smoke, T7 docs) re-checked by the Sonnet red-team and plan fixer (12 findings applied). Run sequentially T1..T7 in one lane: no intra-plan parallel conflict.
- Scripted per-task check (Files block vs committed paths): 7/7 ✅. Invisible-character scan: 0.
- Ruling: W5-R2 — T2 step 5's real-host check (journal field, NoNewPrivileges with a worker scope) touches the real user manager: the implementer must NOT run it; the controller runs it after T2's review, before T3 — cost if wrong: a wrong journal field name until the controller's check.

## Execution
T1: dispatched (Sonnet, BASE 810b6be)
Ruling: heavy gates in two slots; M6 uses heavy-gate.lock with M11 lane A, vitest --maxWorkers=7/5
T1: implementer DONE 53263ba (79 tests, 10 mutations; ran systemd-analyze verify --user on a rendered unit — static) — review dispatched (Opus)
T1: review (Opus) — security contract holds; Important: UMask=0077 contradicts R114/R114b (plan-mandated) → Ruling W5-R8 drop it. Fix round 1 sent with minors 1–8 (forgeable --since fallback → _SYSTEMD_USER_UNIT, ours() fail-closed, journalctl -q, knip revert, trailing slash, stopTimeoutSec, timed-out wording, test fixes). FIX_BASE 53263ba
T1: verified on this host (systemd 259): user-unit journal lines carry _SYSTEMD_INVOCATION_ID (= InvocationID), no USER_INVOCATION_ID (answers M6R7 here); `systemd-analyze verify --user` makes no socket/connect (needs XDG_RUNTIME_DIR, reads real unit dirs)
T2 carry: check KillMode=mixed (worker scopes off when linger refused → workers in pap.service cgroup) during step 5 (controller-run)
T1: fix round 1/5 (9 addressed incl. W5-R8 UMask drop, 0 open; commits 53263ba..8ea6738). Controller verified on this host: `journalctl --user -u X -q _SYSTEMD_USER_UNIT=Y` is an AND (mismatch → empty).
T1: minor (deferred): maxBuffer overflow also reported as "timed out" (execFile sets killed); mode-000 test fails under root; plan text still says UMask=0077 at lines 63/257/396 (superseded by W5-R8)
Task 1: complete (commits 810b6be..8ea6738, review clean)
T2: dispatched (Sonnet, BASE 8ea6738) — step 5 (real user manager) is controller-only per W5-R2
T2: implementer DONE_WITH_CONCERNS 873ba43 (ref'd setInterval holds the loop during io.clock.sleep; int case 7 ~21 s real clock; step 5 skipped, commands in report) — review dispatched (Sonnet)
T2: review (Sonnet) — core flow correct; spec gap: journal hint missing on systemctl failures; Important 1: uninstall swallows every CliError then says "removed"; Important 2: url 24 h fallback can show a stale token / owner claim; Important 3: case 5 does not prove safePath. Fix round 1 sent (+ minors 2–5). FIX_BASE 873ba43
T2: minor (deferred): case 7 ~21 s real clock ×2 (bounded); enable/restart failures leave written files (acceptable); missing loginctl aborts instead of warning
T2 step 5: owner OK requested 2026-10-15 ~19:15 UTC (temporary pap.service on 7791, ~/.pap-m6-try, then uninstall)
T2: fix round 1/5 (spec gap + 3 Important + minors addressed, 0 open; commits 873ba43..0cad3b7)
T2: minor (deferred): url on a stopped unit can show the last run's URL (stale InvocationID/ActiveEnterTimestamp); url journal reads not hinted; restart/stop timeout value untested
Task 2: complete (commits 8ea6738..0cad3b7, review clean) — Step 5 (real host) PENDING owner OK; must run before the M6 merge (NoNewPrivileges + worker scope, linger, listening at default level)
T3: dispatched (Sonnet, BASE 0cad3b7)
T3: implementer DONE edfabd1 (15 tests + 1 root-skip, 3 mutations; shellcheck not installed) — review dispatched (Sonnet)
T3: review (Sonnet) — Approved overall; Important: `cd -- "$repo"` untested (mutation survives). Fix round 1 sent (+ M1 early unsafe-path refusal, M2 node -p guard, M4 test gaps, M6 stat -L). FIX_BASE edfabd1
T3: minor (deferred → T7 docs): unknown/typo'd flags refused only after the build (needs a T2 dry-run); PATH with empty/./relative entries not refused (plan: never edits PATH) — mention in install.md; hard-coded /usr/bin test paths (non-merged-usr hosts)
T3: fix round 1/5 (Important + M1/M2/M4/M6 addressed, 0 open; commits edfabd1..146e29d)
T3: minor (deferred): optional LC_ALL=C before the path `case` (bash ≥5 globasciiranges makes it moot)
Task 3: complete (commits 0cad3b7..146e29d, review clean)
T4: dispatched (Sonnet, BASE 146e29d)
T4: implementer DONE_WITH_CONCERNS 7383cea (89 MB archive in 12 s; offline store needed; root package.json staged; .bin shims name the stage path) — review dispatched (Sonnet)
T4: review (Sonnet) — security sound; Important 1: .bin shims leak the builder's home path + break determinism (plan-mandated) → W5-R10 remove shims + stage-path scan; Important 2: missing store gives raw pnpm error. Fix round 1 sent (+ modes, symlink refusal, reject test). FIX_BASE 7383cea
T4: minor (deferred): -dirty suffix not enforced inside buildArchive; gitignored stale dist passes the dirty guard
T4: fix round 1/5 (W5-R10 shims + stage/home scan + node-gyp prune, store sentence, minors; 0 open; commits 7383cea..1930439). Real archive: 0 home/stage paths, 93.5 MB, 23 s.
T4: minor (deferred): the leak scan skips symlinks (absolute link targets naming stage/home would pass; pnpm writes relative links); scan matches literal paths only (no realpath form)
Task 4: complete (commits 146e29d..1930439, review clean)
T5: dispatched (Sonnet, BASE 1930439) — Opus review (archive checksum, untrusted extraction)
T5: implementer DONE_WITH_CONCERNS d2dac15 (tar -tvzf + awk listing refuses non-file members, absolute/escaping symlinks and hardlinks; GNU verbose format parsing; test file at exactly 400 lines) — review dispatched (Opus)
T5: review (Opus) — TOCTOU design, pinned hash, restore/prune order, ~/.pap isolation correct; I1: listing parser desync (owner names with spaces, " -> " names) + no real-dir check + prune follows a symlinked release → a pinned crafted archive can delete files outside (reproduced). Fix round 1 sent (+ split the 400-line test file, M1–M8). FIX_BASE d2dac15
T5: fix round 1 DONE 25a6d87 (I1 + M1–M8; test file split) — scoped re-review dispatched (Opus, security)
FLAKE-W5-1: apps/daemon/src/modules/terminal/service.test.ts "refuses a request id past the cap…" failed once in M6 T5's full unit gate (passes alone; diff unrelated) — root-fix before the M6 final gate (rule C); likely load-sensitive with 4 lanes / 2 gate slots
T5: fix round 1/5 (M2–M8 + split addressed; I1 residual open: post-extraction find fails open on errors; M1 residual getconf stderr; commits d2dac15..25a6d87)
T5: fix round 2 sent — I1 residual (chmod + fatal find), find-link test row, getconf, + pre-existing holes reproduced by the re-reviewer: TAR_OPTIONS honoured (-P writes outside the stage), prune failure rolls back a successful install, cleanup trap under errexit; neutral extraction sentence. FIX_BASE 25a6d87
T5: minor (deferred): the link check runs against the stage location, not the final one (only pap-<id> / x/pap-<id> names reachable, dangling inside the 0700 folder); an existing releases/<id> symlink to a complete folder is trusted (needs prior write access to the 0700 folder)
T5: fix round 2/5 (I1 residual + TAR_OPTIONS + prune warn + cleanup + getconf + neutral sentence addressed, 0 open; commits 25a6d87..41f46fd; Opus re-review probed uutils 0.10 + GNU chmod, tar 1.35, gzip 1.14)
T5: minor (deferred): no shim row for a failing `find` on the link list (keep `|| die`: real defence vs EMFILE/EIO); no row for getconf exiting non-zero (`|| host_glibc=""` path); pre-existing: a failed extraction leaving a 0000 folder blocks later installs at the stage `rm -rf` (fix: chmod -R u+rwX before both stage rm); getconf output with no space ("musl") passes the version check (cut -s or numeric check); installed files lose read-only modes (harmless); stray /tmp/pap-archive-test-bjcCG9 from implementer mutation runs
Task 5: complete (commits 1930439..41f46fd, review clean)
T6: dispatched (Sonnet, BASE 41f46fd)
T6: implementer agent a7f4c7fc2ef1d742c
Note: W5-R10's "the T6 smoke proves it" is wrong — T6 smokes the repo dist, not the archive (M6R30). The archive's real proof joins the controller real-host check (owner OK pending): build:archive → install.sh into a temp HOME → `pap service url` / boot, then uninstall.
T6: implementer DONE aa696ef (smoke ok, serve-rename mutation fails at boot; smoke-lib.ts startDaemon gained optional launch param) — review dispatched (Sonnet)
T6: review (Sonnet) — Approved, spec ✅, 0 Critical/Important
T6: minor (deferred): no SIGINT/SIGTERM handler in smoke-install.ts (Ctrl-C leaves the detached daemon + temp root); setpriv refusal in a container exits early with no hint; fake journalctl prints port 1 (comment)
Task 6: complete (commits 41f46fd..aa696ef, review clean)
FLAKE-W5-1: root-fix dispatched (Sonnet, BASE aa696ef, agent af5c4b4d78d9781b4) — then T7
FLAKE-W5-1: fixed 379f611 (test-only, 15 lines; controller-verified) — root cause: 9 concurrent creates race for the one running slot on real realpath/stat (libuv threadpool order undefined); the test assumed index 0 wins. Forced-reorder proof (100 ms delay on the first realpath) failed the old assertions, passed the new; 50 runs green
T7: dispatched (Sonnet, BASE 379f611)
T7: implementer agent aee211447183c88f7 — real-host lines left 'pending' in ADR 0056 + install.md; controller replaces them after T2 step 5
T7: implementer DONE 43e65aa (full gate green: unit 14201, int 183 files, smoke, smoke:install, budgets 225.4 KB; 'pending' lines in install.md, ADR 0056 ×2, W5-R2 ruling) — review dispatched (Sonnet)
Controller: removed stray /tmp/pap-archive-test-bjcCG9 (a T5 mutation-run stage with a 0100 folder; chmod -R u+rwX then rm). Sweep brief written: sweep-brief.md (14 items, A–D) — dispatch after T7 review
T7: review (Sonnet) — directives, threat model, T5 defences, journal match accurate; Important: I1 setup URL shown as ?token= (code: #token= fragment); I2 hand-run `pap serve` fallback fails with the unit running (instance lock, port) + impossible "owner on a trusted machine"; I3 unsafe-HOME advice "use method 1" also refused (bin-dir safePath). Fix round 1 sent (resume). FIX_BASE 43e65aa
T7: fix round 1/5 (I1 #token= fragment, I2 stop/serve/start procedure + pap user add alternative, I3 unsafe-HOME advice + tpl sentence; 0 open; commits 43e65aa..fbbed51; doc-only + one tpl string, controller-verified; archive-install tests 51 pass)
Task 7: complete (commits 379f611..fbbed51, review clean) — 'Real-host check: pending' lines remain for the controller run
Sweep: dispatched (Sonnet, BASE fbbed51) — sweep-brief.md items 1–22
Sweep: DONE 93b3546, 049350f, dd110a2, 7e30e1e, 6233151 (items 1–9, 11–22; item 10 skipped: subprocess on real clock needs restructuring; item 13 test is a source guard + manual SIGINT exit 130; item 18 podman example removed rather than invented). Gate: unit 14214, int 183 files, smoke:install green
Final review: dispatched (Opus, range 810b6be..6233151); FLAKE-W5-2 fix runs in parallel (test-only, outside the range)
FLAKE-W5-2: root-fix dispatched (Sonnet, BASE 6233151, agent ad0f7f3efc8042279). Final review agent a714d4d9d63b693d1
FLAKE-W5-2: fixed 00077f4 (test infra, 48 lines; controller-verified) — root cause: freePort() closed a listen(0) ephemeral port; the kernel hands it to the next listen(0)/connect of any process (concurrent int runs) → EADDRINUSE; 'Invalid URL' = new URL('undefined') follow-on, now a clear error. freePort picks 20000-29999 (below this host's ephemeral range) with a bind check, never twice per process. Stress RED 5/8/7 collisions → 0. scripts/smoke-lib.ts freePort unchanged (one smoke per gate)
Final review (Opus): With fixes — I1 start limit (5/120 s counts manual starts) blocks the documented retry and the rollback restart → reset-failed before restart; I2 volatile journal → false failure + method 2 dismantles a running install → Ruling W5-R18; M5 KillMode → Ruling W5-R19. Minors M1–M7. Final fix dispatch: I1, I2 (W5-R18), M1 (owner claim needs 2 consecutive reads; --since only after several empty reads; URL port must match), M2 (never-listening first install: disable the unit + print what remains and the undo), M3 (same-id reinstall keeps the rollback target), M5 (W5-R19), M6 docs (+ method 1 any arch: relax doc/plan, archive x64), M7, M4 doc line only (reinstall with the same flags; warn if PAP_HOME set without --home) — M4 carry-over warning → M6b
Real-host check notes (final review): archive install must use the real HOME with --home ~/.pap-m6-try --bin-dir ~/.pap-m6-try/bin (the user manager reads only its own ~/.config/systemd/user), then remove ~/.local/share/pap; method 1 from the feat-m6 worktree (not the preview checkout); add a taken-port rerun within 2 min (I1), `systemctl --user show pap -p NoNewPrivileges,KillMode`, and confirm no pap.service stays enabled afterwards
Final fix: dispatched (Sonnet, BASE 00077f4, agent acd01baf7ba3224f2; I1, I2/W5-R18, M1–M3, M5/W5-R19, M6, M7, M4 doc+warning) — then one scoped re-review (Opus)
Final fix: DONE e9dbb74 (all items; unit 14236, int 184 files, smoke:install, budgets; 17+8+4 RED, 14 mutations; exit 3 = unverified). Ruling W5-R22: the archive installer also exits 3 (it exited 0) — follow-up sent to the same implementer before the re-review
Final fix follow-up: 6e4a07c (W5-R22 exit 3 propagated; switched reset before exit so the trap does not roll back; 62 template tests). Scoped re-review dispatched (Opus) on 00077f4..6e4a07c
Final re-review (Opus): all items addressed, Ready to merge: yes (unit 150 + int 35 + source-guards run). New: Minor M2 retry gap (a second failed first-install re-enables the unit: decide on "was enabled before"); nits: ADR 0056:36/38 + 0057:25 stale (readiness, exit 3, same-id prune); W5-R19 wording (fixed by the controller in the rulings file); tpl:168-171 switched=0 after printf (set -e write failure rolls back); undo message: unquoted rm paths, "at login" vs boot with linger, unit disabled but not stopped; port filter false owner claim with a loopback PAP_PUBLIC_ORIGIN on another port (→ M6b)
Residual fix: dispatched (Sonnet, BASE 6e4a07c) — M2 retry (is-enabled before enable), switched=0 first, undo message (quote, boot wording, stop the unit), ADR 0056/0057 lines + ADR 0056 KillMode line per corrected W5-R19; nit 5 → M6b
Residual fix: DONE 4ca63bb (first install = not enabled before this run via is-enabled --quiet; stop + disable + quoted undo; switched=0 before printf; ADR 0056/0057 updated; 6 mutations; unit 14237, service int 37) — controller-verified (diff read: isEnabled exit-code based, read before enable)
M6 READY TO MERGE on feat/m6-install @ 4ca63bb, pending only the real-host check (owner 2026-10-16: "pas maintenant") and the owner's merge OK. Real-host plan: real-host-check.md
FLAKE-W5-3: fixed 7108ced (lane B; test-only, 19 lines, controller-verified) — root cause: TasksBoard 'today' is the local day from Date.now(); the fixture sat at 2026-10-15 11:58Z, no longer today after midnight; journal.vm.test.ts had the same UTC-noon pattern (fails in GMT±12). Fake Date at local noon, fixtures relative. Cherry-picked: lane A 15e0801, feat/m6-install 2d3fe59 (2 files 18 tests pass there)
M6: owner 'go pour merge, pas besoin de test réel' (2026-10-16 ~12:30 Paris). Docs: real-host lines → 'not run before the merge (owner); M6b' (416fbc8 after rebase on main bf6297a). Merge gate running (slot 1). Ruling W5-R47 (M6 = decision 88 on main; M11 renumbers to 89/90 at its rebase)
