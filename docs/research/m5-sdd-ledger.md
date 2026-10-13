# M5 SDD ledger (archived 2026-10-13)

Controller ledger of the M5 subagent-driven run (including Task 8c, the owner's overnight levers B and D, the rebase on M4 and the final fix round), copied verbatim from the git-ignored SDD workspace. Rulings: [m5-rulings.md](m5-rulings.md); final review: [m5-final-review.md](m5-final-review.md).

# SDD ledger — plan: docs/plans/2026-10-12-m5-policy-access.md
Worktree /home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m5 (feat/m5-policy). Plan @ 286a618 (red-team M5 applied: 2 C / 21 I / 17 m; owner decisions 2026-10-12 X1, X3, Q1–Q15, MQ1–MQ8, E1; 17 cross-plan agreements). Spec: docs/specs/2026-10-10-C-architecture.md (§5, §8.1) — binding.
Models (owner X3): Sonnet implementers ×33; Opus reviewers 3a, 4, 5a, 5b, 6, 8a, 8b, 9, 10, 12b-2, 13a, 13b, 14, 16, 17, 25a, 25b; Sonnet reviewers others; Opus final. E1: Opus implementer allowed at fix rounds 4–5 (log each use).
Pre-flight scan: the plan's "Pre-execution conflict scan" (22 rows, l.216–243) is the pair table, re-checked by the Opus red-team (§2 plan-internal findings, §3 overlap) and fixed in 286a618; per-task self-consistency (tests vs code, files created vs touched) was the red-team's item 4 and the fixer's self-check. Controller adds no row. Rulings: 134 in rulings.md (M5R1–M5R134).
Ruling: pre-flight relies on the red-team's plan-internal pass instead of a fresh controller read of 5 500 lines — cost, the plan is fresh from an Opus fix with a self-check — if wrong, a conflict surfaces in a task review and costs one fix round.
Parallel: M4 runs in .worktrees/feat-m4 (one implementer per worktree). Merge order M4 first (X1).
M5 Task 1: dispatched implementer (sonnet, agent ac74ac7b011db5732), BASE 286a618
Ruling: plan l.988 (Task 3a test) holds a literal U+202E and l.1889 (Task 5a hostile step) a literal U+200D (fixer's \uXXXX escapes were turned into characters) — the 3a and 5a dispatches tell the implementer to write them as `\u202E` / `\u200D` escapes in source, never literal — cost if wrong: an invisible bidi char in source (trojan-source class) or a test that silently tests ASCII.
M5 Task 1: implementer DONE_WITH_CONCERNS (14b7e34) — PolicyRules.parse wraps in grants.ts + 4 pi-host files; v2 rules with defaults on the wire; session-reducer.test.ts 395/400; bundle 194.7 → 195.3
M5 Task 1: review (Sonnet) approved — spec ✅, 0 C / 0 I
Task 1: minor (deferred): mutation checks missing for the DenyPattern INVISIBLE refine, the Snapshot.policy default and the guard copy in dialogs.ts
Task 1: CARRY to Task 9 (and 12b-1): policyFor now sends defaulted v2 rules incl. taint {tainted:false, epoch:0} on init/policy_update — the push must carry the real taint + epoch, or the worker must ignore a lower epoch (M5R6)
Task 1: CARRY to Task 4: DenyPattern (binding code) accepts Unicode space separators and lone surrogates — a pattern with a lookalike blank never matches; normalise or refuse when Task 4 implements matching
Task 1: follow-up (resumed implementer): literal U+202E in policy.test.ts:63 → escape
Task 1: complete (commits 286a618..d7d8e42, review clean; follow-up d7d8e42 escape verified by controller scan)
M5 Task 2: dispatched implementer (sonnet, agent a5c67d631874c8354), BASE d7d8e42
M5 Task 2: implementer DONE_WITH_CONCERNS (6a9d91f) — policyBed takes a make callback (boundaries lint); fake-policy path; revoke-then-prompt timeline wraps send/request; existing exit-before-update test now awaits exit (sync push stops a dead worker: fail closed); sessions.md grants paragraph updated
M5 Task 2: review (Sonnet) Needs fixes — 1 I: stale contradictory comment grants.ts:348-350
Task 2: minor (folded into round 1): pin "worker crashed, exit not settled, revoke → send=false → stop, logged, nothing thrown"
Task 2: minor (deferred): carry-#30 timeline test passes on old flush too (regression guard, as the brief says); upgradeRaw piles once("error") listeners per loop pass (test helper)
Task 2: fix round 1 dispatched (resumed sonnet implementer), FIX_BASE 6a9d91f
M5 Task 2: fix round 1 implementer DONE (07c44ea) — stale comment deleted, unsettled-exit test added; re-review dispatched (sonnet)
Task 2: fix round 1/5 (2 addressed, 0 open; commits 6a9d91f..07c44ea)
Task 2: complete (commits d7d8e42..07c44ea, review clean after 1 fix round)
M5 Task 3a: dispatched implementer (sonnet), BASE 07c44ea; dispatch carries the U+202E-as-escape ruling (brief l.198)
M5 Task 3a: implementer DONE_WITH_CONCERNS (32336dc) — ApprovalAsk gains optional tainted/guard (approvals.ts not in brief); showHidden exported for audit-args; answersFor restated (3b deletes extension.ts copy); auditArgs >2 MiB = unreadable → block; extra restore cases (block/deny); bundle 195.3 → 195.4
M5 Task 3a: review (Opus) Needs fixes — 0 C / 2 I (both partly plan-mandated): unknown stage verdicts / answers pass; readable calls audited "[unreadable input]"
Task 3a: Ruling: whitelist every stage outcome and answer, anything else blocks — spec C §5.1 fail-closed beats the brief's `=== "block"` snippet — cost if wrong: none (a stage returning an unknown verdict is a bug either way)
Task 3a: Ruling: kind/args computed before the attempt loop; marker only when auditArgs throws — M5R13 + C §5.1 ("call, redacted arguments, decision and reason") beat the brief's fail() snippet — cost if wrong: none
Task 3a: Ruling: inputs over 2 MiB stay blocked (fail closed; M2 auto-allowed them) but with a clear "too large to judge" reason — a model write tool call above 2 MiB is near impossible (output token limits) — cost if wrong: a legit huge write is refused with a clear reason, the agent uses bash instead
Task 3a: minors folded into round 1: 2 MiB crossing test, code-point counting, stale grant-key comment, reason clip test, restore-not-on-recheck-block test, prototype-key names, stderr restore in afterEach, exact reason at pipeline.ask.test.ts:101
Task 3a: CARRY to 3b: delete every duplicate left in extension.ts (answersFor, decideCall, TITLES, DENIED_REASON, FAIL_CLOSED_REASON, TOO_LONG_REASON) and carry M2's two "why" comments of answersFor into stage-approval.ts; check rules()/rulesVersion() update atomically
Task 3a: CARRY to 8b: restore runs before commit/audit, which can throw → make restore the last fallible step or undo it on the catch path
Task 3a: CARRY to 8a: the redactor sees canonical JSON (escaped strings) — match a secret containing " \ or control chars in its escaped form too
Task 3a: CARRY to 4, 5a, 21: stage/trip reasons, tool and ids reach audit entries only clipped — stages keep input text out of reasons; the audit viewer escapes these fields
Task 3a: fix round 1 dispatched (resumed sonnet implementer), FIX_BASE 32336dc
M5 Task 3a: fix round 1 implementer DONE (da49ebd) — whitelists, real args on failure, "input too large" reason; pipeline.ts 397/400
Task 3a: CARRY to 3b, 4, 5a, 5b, 6, 7, 8a, 8b, 9: pipeline.ts is at 397/400 lines — new logic goes in stage files (stage-*.ts, decide.ts…), never in pipeline.ts
Task 3a: fix round 1/5 (2 I + 7 minors addressed, 0 open; commits 32336dc..da49ebd; Opus re-review)
Task 3a: minor (deferred): oversized-input reason incoherent across tool kinds (3 MiB write → "evaluation error" via canonical RangeError; 500k \u0001 write → "too large"); stale comment audit-args.ts:6; settle's 2nd reason clip (pipeline.ts:223) untested; plan answers list not whitelisted (internal); guard trip without rule still asked; block without modelReason
Task 3a: CARRY to 7 and 8b: in settle, commit runs before deps.audit(entry) — a sink throw blocks a call already committed as allow (distorts the run guard count) — reorder or undo when Task 7/8b touch settle
Task 3a: complete (commits 07c44ea..da49ebd, review clean after 1 fix round)
M5 Task 3b: dispatched implementer (sonnet), BASE da49ebd; carries from 3a in dispatch (duplicates, atomic rules/version, pipeline.ts 397)
M5 Task 3b: implementer DONE_WITH_CONCERNS (6ae8f35) — AuditRecord.entry z.unknown().optional(); supervisor no longer validates entry (rogue-bed junk swapped); DispatchDeps.rules() removed; rules/rulesVersion atomic by construction (no host test); 2 int tests rewritten for M5R11/null rules; smoke + budgets green
M5 Task 3b: review (Sonnet) approved — 0 C / 0 I; trailers checked (0)
Task 3b: CARRY to 10: live-session.ts passes the worker's unvalidated audit entry to session_events (only the 4 MiB IPC cap bounds it) — Task 10 validates with the contract (or caps size) before storing; restore a rogue-bed junk-audit case so the dropped count covers it
Task 3b: minor (deferred): provisional-always int test title overclaims "valid or malformed"; stale mode in session entry after a null update (harmless); expected fail-closed stderr noise in unit runs; int session-entry case not run RED
Task 3b: complete (commits da49ebd..6ae8f35, review clean)
M5 Task 4: dispatched implementer (sonnet), BASE 6ae8f35; carries (DenyPattern blanks, reasons free of input, pipeline.ts full) in dispatch
Owner (2026-10-12, workflow lightening): (1) a fix round whose diff is test-only or comment-only and < ~50 lines is re-verified by the controller (runs the named covering test, checks the reported mutation) instead of a re-review agent — logic fixes keep a scoped re-review; (2) implementers run test:int only when the task touches the runtime; effort levels unchanged (owner declined).
M5 Task 4: implementer DONE_WITH_CONCERNS (e5b61c8) — pipeline.ts 398/400; powershell treatment only for Pi's built-in (prescribed-code defect fixed); pipeline tests updated for a real stage 01 (2 MiB no-UI case stubs stage 01); 2 brief mutation instructions unworkable (forms / exec||unknown) → added wrapper-stripped pattern test; owner patterns fold Zs→space, lone surrogates→U+FFFD in both pattern and command (conservative); 3-level cap counts $(…) inside bash -c
Task 4: CARRY to 26 (docs policy.md): owner patterns fold Unicode blanks and lone surrogates — a pattern may block a command bash would not run (conservative)
M5 Task 4: review (Opus) Needs fixes — 0 C / 2 I: "never throws" hostile tests cannot fail (fail-closed block passes them); missing documented-pass tests for M5R18 residuals (aliases, functions, here-docs to a shell, scripts written then run)
Task 4: Ruling: add the four documented-pass tests (M5R18/RT-35 wins over the brief's Step 4 list) — cost if wrong: four small tests
Task 4: reviewer had not run the adversarial bypass probe — resumed it for the probe before opening the fix round (one round for all findings)
Task 4: reviewer could not run the probe (a safety check stopped its scratch script) — Ruling: the bypass probe becomes a committed, parser-only table-driven test (denylist.variants.test.ts) written by the implementer in fix round 1, and the Opus re-review reads that table + the reader code — cost if wrong: a variant missing from the table stays unprobed; the final review re-checks the denylist surface
Task 4: minor (folded into round 1): pattern clip uses clipUnits
Task 4: minor (deferred): bounded-work hostile cases accept block-or-pass (outcome not pinned per case)
Task 4: fix round 1 dispatched (resumed sonnet implementer), FIX_BASE e5b61c8
M5 Task 4: fix round 1 implementer DONE (34a52ce) — verdict-pinned hostile tests, 4 residual tests, 215-row variants table; the table found a reader defect (redirections glued to a word passed: echo x>/dev/sda, 1>/dev/sda, >| …) — shell-words now emits redirection operators as words; clipUnits
Task 4: fix round 1/5 (I1, I2, clip addressed; I3 partly — Opus re-review found reader gaps G1 comments, G2 compound keywords, G3 redirections before the command / missing operators, G4 quote desync ($'…', here-doc bodies), plus N1 owner-pattern operator spacing, N2 verdictOf blind to throws; commits e5b61c8..34a52ce)
Task 4: Ruling: fix G1–G4, N1, N2 in round 2; cheap minors G5, G7, G8, ${IFS}, chmod /* folded in; wrapper option forms (G6) and other wrappers/shells get table rows (documented pass if not fixed) — the denylist stays best-effort (M5R18) but ordinary shapes (comments, if/for, leading redirections) must not bypass it — cost if wrong: one more round
Task 4: CARRY to 26 (policy.md): here-doc bodies are read as commands (false positive pinned "caught anyway"); redirections written as their own word; the documented-pass list from task-4-report.md
Task 4: fix round 2 dispatched (resumed sonnet implementer), FIX_BASE 34a52ce
M5 Task 4: fix round 2 implementer DONE (1e6b418) — G1–G5, G7, G8, N1, N2 + extra wrappers/shells fixed; 14 mutation checks; shell-words split into shell-argv.ts (144) + shell-words.ts (232); remaining documented passes: env -S, taskset mask, tee /dev/sda, cp img /dev/sda, find -exec rm, chmod --re=…
M5 Task 4: fix round 2 re-review dispatched (resumed Opus re-reviewer)
Task 4: fix round 2/5 (G1–G4, G5, G7, G8, IFS, chmod /*, N1, N2 addressed; 2 new Important regressions B1 ${IFS}# comment, B2 glued option value eats the command word; commits 34a52ce..1e6b418)
Task 4: Ruling: here-doc bodies are lexed as commands only when the receiver is a shell or ssh — otherwise an agent writing a file with cat <<EOF hits "too complex" or blocks on data (real-use false positive) — cost if wrong: a here-doc piped to a non-shell interpreter (python <<EOF) is not inspected (documented)
Task 4: fix round 3 dispatched (resumed sonnet implementer; last resume round), FIX_BASE 1e6b418
M5 Task 4: fix round 3 implementer DONE (bce245b) — B1 (# literal after IFS blank), B2 (getopt clusters), here-doc bodies lexed only for shells/ssh, function f {…}, ${HOME:?}; also fixed 0<<EOF, <<'END OF', ssh --
M5 Task 4: fix round 3 re-review dispatched (resumed Opus re-reviewer)
Task 4: fix round 3/5 (B1, B2, function, HOME forms, 0<<EOF, <<'END OF', ssh -- addressed; new Important regressions from body skipping: B3 false here-doc ((0<<0)) / ${x/<<} hides later lines, B4 shell reached via pipe / sudo -s / su / chroot has its body skipped; adversarial residuals: IFS + line continuation + #, \" in a double-quoted delimiter; receiver detection quadratic in shape; commits 1e6b418..bce245b)
Task 4: Ruling (revises the round-2 here-doc ruling): skip a here-doc body only for an allowlist of data receivers (cat, tee) whose segment does not end in a single |; any other receiver, a body that never meets its delimiter, and anything inside ((…)) / ${…} are lexed — fail toward inspection; the cat-to-file false positive stays fixed — cost if wrong: python <<EOF etc. are inspected (possible false positive), acceptable
Task 4: round 4 → fresh implementer on Opus (skill rounds 4–5; owner E1 approved) — first E1 use in M5
M5 Task 4: fix round 4 (Opus implementer, E1 use #1) DONE_WITH_CONCERNS (17a7795) — allowlist ruling applied; no here-doc queued inside ((…)) $((…)) ${…} $[…]; also closed: unquoted data-body $(…), delimiter split by line continuation, # inside ${…}/((…)), process substitution, { cat <<EOF; } | bash, \||bash, $'…' delimiter end; 25 mutation checks
Task 4: Ruling: accept the usability cost of the allowlist ruling — a non-cat/tee here-doc body (python3 - <<'EOF', psql, kubectl apply -f -) is read as commands; > ~1000 lines is "too complex" and text may match owner patterns — fail toward inspection; the agent can write the file then run it — cost if wrong: occasional false blocks on long inline scripts (report it to the owner)
M5 Task 4: fix round 4 re-review dispatched (resumed Opus re-reviewer)
Task 4: fix round 4/5 (B3, B4, B1 residual, \" delimiter, linear receiver detection addressed; extra classes have rows + named mutations; commits bce245b..17a7795; Opus re-review — gap hunt not completed)
Task 4: Ruling: close the task after round 4 instead of a 5th round — all open findings addressed, no breakage found, the reader is best-effort by design (M5R18) with documented passes; the remaining risk is unknown gaps — cost if wrong: an ordinary shape bypasses stage 01 until found; mitigated by Task 25a's security suite and an explicit denylist gap hunt in the Opus final review
Task 4: CARRY to final review: adversarial gap hunt on the stage-01 reader (shell-words.ts, shell-heredoc.ts, shell-argv.ts, denylist.ts) — the round-4 re-review did not complete it
Task 4: CARRY to 26 (policy.md): documented passes from task-4-report.md (incl. group/loop piped to a shell on a later line, function/program named cat/tee, here-doc reaching a shell via $(…), env -S, taskset mask, tee/cp to a device, find -exec rm, chmod --re=, watch 'cmd', flock -c, runuser -u x --); here-doc bodies for non-cat/tee receivers are inspected (long inline scripts may be "too complex"); owner-pattern Unicode blank folding; redirections are words of their own
Task 4: complete (commits 6ae8f35..17a7795, Opus-reviewed, 4 fix rounds, E1 used once)
M5 Task 5a: dispatched implementer (sonnet), BASE 17a7795; U+200D brief l.172 → escape ruling in dispatch; table-driven verdict lesson from Task 4
M5 Task 5a: implementer DONE_WITH_CONCERNS (5d948e1) — pipeline.ts 399/400 (import + slot); extra: non-built-in tool with command walks whole input, 100 000-node cap; cycle / 2 MiB refused upstream (stage verdict pinned directly); redundant apex guard kept; 'curl https://example.com evil.test' documented pass (controller doubts it: curl fetches bare hosts too)
M5 Task 5a: review (Opus) Needs fixes — 0 C / 4 I (plan-mandated matching rules): I1 WHATWG forms without "://" not extracted; I2 $VAR hosts under *.; I3 touching URLs judged as one; I4 git global options with a separate value hide push/fetch
Task 5a: Ruling: fix I1–I4 (Review Focus 9 beats M5R22/M5R23/M5R118 snippets); curl https://example.com evil.test stays a documented pass (M5R118) but redirection-target URLs do not count and curl reroute flags / /dev/tcp|udp make the segment uncheckable (block while a list is set); keys scanned; non-string command walks the input — cost if wrong: a few extra blocks while an allowlist is set (off by default)
Task 5a: CARRY to 8a/8b: audit reasons carry a judged host (lowercased) — a secret in a subdomain reaches the reason; redaction of reasons should match case-insensitively or reasons should be redacted like args
Task 5a: CARRY to 5b/6: pipeline.ts at 399/400 — split before any edit
Task 5a: CARRY to 20/26: owner-facing egress residual text (any allowed URL in a segment unlocks bare hosts; host-only fields; git submodule/remote update/archive --remote/lfs)
Task 5a: fix round 1 dispatched (resumed sonnet implementer), FIX_BASE 5d948e1
M5 Task 5a: fix round 1 implementer DONE (4b287de) — I1–I4 + m1–m3, m5–m7; 58 rows; nested URLs judged too (redirect URLs need both hosts listed); curl -oxfile false positive; smoke + test:int green
M5 Task 5a: fix round 1 re-review dispatched (resumed Opus reviewer)
Task 5a: fix round 1/5 (I2, I3, m2, m3, m5/m7, m6 addressed; remainders I1 (leading C0, space in no-// URL), m1 (proxy value containing a URL, --proxy1.0), I4 (--attr-source, --shallow-file); commits 5d948e1..4b287de)
Task 5a: Ruling: inner URLs of a whole-string URL are judged too (stricter than M5R22 "judged whole": redirect / archive / reader-proxy URLs need both hosts listed) — cost if wrong: extra blocks while an allowlist is set (off by default)
Task 5a: Ruling: git -c / --config-env alias.* makes the segment uncheckable while a list is set — cost if wrong: none
Task 5a: CARRY to 20/26: egress residuals — env / config-file proxies (HTTPS_PROXY, export, ~/.curlrc, curl -K, wget -e, .wgetrc), saved git aliases, expansion-built /dev/tcp paths, free-text "see https:evil.test", curl https://example.com evil.test; false positives: curl -oxfile, underscore hosts under *., /dev/tcp-looking args
Task 5a: fix round 2 dispatched (resumed sonnet implementer), FIX_BASE 4b287de
M5 Task 5a: fix round 2 implementer DONE (081e05e) — C0/space no-// URLs, whole-URL curl reroutes, --proxy1.0/--dns-servers, --attr-source/--shallow-file, git alias.*; 29 rows; smoke + test:int green
M5 Task 5a: fix round 2 re-review dispatched (resumed Opus reviewer)
Task 5a: fix round 2/5 (I1, m1, I4, alias rule closed; new load-bearing regression: text after a leading no-// piece not scanned; minor: reroute value cut at a space; commits 4b287de..081e05e)
Task 5a: Ruling: curl long-option prefixes of reroute flags count as the flag; git -c *proxy= makes the segment uncheckable — cheap, fail closed — cost if wrong: rare false blocks while an allowlist is set
Task 5a: fix round 3 dispatched (resumed sonnet implementer; last resume round), FIX_BASE 081e05e
M5 Task 5a: fix round 3 implementer DONE (44900e0) — regression fixed (scan continues after a no-// piece), whole-URL reroute values, option prefixes, git proxy settings; 21 rows; smoke + test:int green
M5 Task 5a: fix round 3 re-review dispatched (resumed Opus reviewer)
Task 5a: fix round 3/5 (regression, whole-URL reroute value, prefix rule, git proxy rule closed; Opus: approved for ordinary shapes; commits 081e05e..44900e0)
Task 5a: Ruling: close after round 3 — the two remaining adversarial git spellings (clone's own -c http.proxy=…; -c url.<base>.insteadOf=<allowed prefix>) become documented residuals rather than a round-4 Opus re-dispatch for two regex lines — cost if wrong: an adversarial git spelling reaches an unlisted host while an allowlist is set (off by default); cheap fix noted for the final review
Task 5a: CARRY to 20/26 (egress residuals, add): git clone -c|--config <setting> after the subcommand; -c url.*.insteadOf / pushInsteadOf; http.noProxy false block
Task 5a: CARRY to final review: optional cheap rules — clone's -c/--config values through isUnreadableSetting; url\. in that regex
Task 5a: complete (commits 17a7795..44900e0, Opus-reviewed, 3 fix rounds)
M5 Task 5b: dispatched implementer (sonnet), BASE 44900e0; MQ1/MQ2 + pipeline.ts 399 + egress.ts size in dispatch
M5 Task 5b: implementer DONE_WITH_CONCERNS (50c34b5) — builtin:mcp/codemode/tool-search source paths only with {name, factory, builtin:true, replaceable:true} registration (bare factory → <inline:N> → unknown/external, fail safe); probe in-process (brief's host-bed version unworkable); tool_search not URL-bearing, read_mcp_resource URL-bearing; egress.ts 306
M5 Task 5b: review dispatched (Opus)
M5 Task 5b: review (Opus) Needs fixes — 0 C / 1 I (plan-mandated M5R24): an MCP server's own openWorldHint:false clears external (unverified claim; HTTP MCP servers send every argument off-machine) → re-opens RT-01 through the other hint. builtin:mcp confirmed unspoofable; codemode nested calls and tool_search confirmed judged.
Task 5b: Ruling: every builtin:mcp tool is external regardless of openWorldHint (openWorldHint:false keeps its meaning only for non-MCP extension tools, MQ2) — tightening in the spirit of owner MQ1; reported to the owner in the final report — cost if wrong: local closed-world stdio MCP tools get fenced and taint the session (fails safe)
Task 5b: Ruling: read_mcp_resource stays URL-bearing — with an allowHosts list set, custom-scheme MCP resources (fixture://, postgres://) are blocked (fail safe; documented)
Task 5b: minor (folded into round 1): closeSession in probe afterEach; spoof test asserts category; stage-02 pin; list_mcp_resources / list_mcp_resource_templates classified; wiring requirement in tool-kind.ts doc
Task 5b: CARRY to the wiring task / 26: register MCP/codemode/tool-search as {name, factory, builtin:true, replaceable:true}; codemode models.classify/generateImages send script data to providers outside judged calls — wire createCodemodeExtension({ models: false }) or document
Task 5b: fix round 1 dispatched (resumed sonnet implementer), FIX_BASE 50c34b5
M5 Task 5b: fix round 1 implementer DONE (23a61dd) — MCP always external, closeSession, pinned stage entries, list_mcp_* classified, wiring doc
Task 5b: fix round 1/5 (5 addressed, 0 open; commits 50c34b5..23a61dd)
Task 5b: minor (deferred): probe afterEach not try/finally (closeSession throw skips cleanup)
Task 5b: complete (commits 44900e0..23a61dd, Opus-reviewed, 1 fix round)
M5 Task 6: dispatched implementer (sonnet), BASE 23a61dd
M5 Task 6: implementer DONE_WITH_CONCERNS (747094c) — R91: Pi does not rewrite U+1680 → asPiResolves uses Pi's exact class; probe path ../<blank>out.txt; non-interactive profile still blocks (M1, kept); decide.test.ts and an answersFor test deleted, pipeline.ask assertion changed (tainted bash → Deny/Once); docs not updated (outside brief)
Task 6: CARRY to 26 (docs): docs/agents/daemon.md / policy.md + Settings wording for the matrix v2
M5 Task 6: review dispatched (Opus)
M5 Task 6: review (Opus) Needs fixes — 1 C: protected reads bypassed by symlink-then-".." spellings (/proc/self/root/.., /proc/self/cwd/..) — string ".." removal before symlink resolution (also the write check, pre-existing); 1 I (plan M5R30): lefthook / mise / pre-commit config names missing. Matrix, taint rule, grant gating confirmed over 864 combinations.
Task 6: Ruling: kernel-order path resolution for both read and write targets (prefer over fail-closed ask) with hostile tests — cost if wrong: none
Task 6: Ruling: extend M5R30's protected names with lefthook / mise / pre-commit config variants — tightening — cost if wrong: an edit to those files asks in auto-accept-edits
Task 6: minor (folded into round 1): MQ6 re-check knows protected reads (via a stage-approval helper, pipeline.ts net ≤ 0); Object.hasOwn in decide; escapes in tests; break the stage-approval ↔ pipeline import cycle
Task 6: minor (deferred): Pi read fallback spellings (NFD, curly quote, narrow NBSP) not mirrored — matters only if papHome/agentDir contain such characters
Task 6: fix round 1 dispatched (resumed sonnet implementer), FIX_BASE 747094c
M5 Task 6: fix round 1 implementer DONE_WITH_CONCERNS (6ac30e0) — probe: Pi collapses .. lexically (read/write not exploitable; grep/find/ls not probed); kernel-path.ts judges both readings; card names the more dangerous reading; hook-manager names; readOnlyRefusal WeakMap; pipeline.ts 399 → 393
M5 Task 6: fix round 1 re-review dispatched (resumed Opus reviewer)
Task 6: fix round 1/5 (C1 withdrawn as stated — Pi collapses .. lexically for read/write — both-readings check sound; I1, M1, M2, M3, M5 resolved; new I: card names the kernel's file not Pi's (R88b regression); commits 747094c..6ac30e0)
Task 6: CARRY to 26 (ADR 0002 residuals): .githooks/ (core.hooksPath), .claude/settings*.json hooks, lefthook.jsonc, mise/config.local.toml / mise/config.<env>.toml; Pi grep/find/ls path resolution not probed (both readings judged)
Task 6: fix round 2 dispatched (resumed sonnet implementer), FIX_BASE 6ac30e0
M5 Task 6: fix round 2 implementer DONE (930f03e) — card names Pi's file first + kernel reading second line when flagged; >4096-byte spellings ask; prototype-key mode tests with overrides; first-line reason can be the combined one (kernel-only problem)
M5 Task 6: fix round 2 re-review dispatched (resumed Opus reviewer)
Task 6: fix round 2/5 (N1, N2, N3 resolved — Opus: Approved; commits 6ac30e0..930f03e)
Task 6: Ruling: fix W1 now (round 3) rather than defer — per-line reasons on the approval card (a label contradicting its path teaches the owner to ignore protected-path labels) — cost if wrong: one small round
Task 6: fix round 3 dispatched (resumed sonnet implementer), FIX_BASE 930f03e
M5 Task 6: fix round 3 implementer DONE (14ae403) — per-line card reasons; extra both-readings-protected test after a surviving mutation
M5 Task 6: fix round 3 re-review dispatched (sonnet). Controller: killed 3 orphaned vitest fork workers from deleted M2 scratch dirs (PPID 1, idle since 2026-10-11 23:18, ~450 MB RSS)
Task 6: fix round 3/5 (W1 addressed; commits 930f03e..14ae403)
Task 6: minor (deferred): piReason accumulates over both spellings (narrow edge: line 1 label from another spelling's file); label strings typed as plain string
Task 6: complete (commits 23a61dd..14ae403, Opus-reviewed, 3 fix rounds)
M5 Task 7: dispatched implementer (sonnet), BASE 14ae403; carries from 3a (commit-before-audit, trip without rule) in dispatch
M5 Task 7: implementer DONE (1b6adbf) — pipeline.ts 395/400, extension.test.ts 399; brief test defect fixed (toolCalls 10); release after count; GUARD_MODEL_REASON for deny and no-UI; real guard in pipeline-bed (extension.grants uses roomy limits); carries done (audit before commit, trip without rule throws, counters saturate at 100 000, reset at agent_start)
Task 7: CARRY to 26 (docs): run guard in docs/agents policy page
M5 Task 7: review dispatched (sonnet)
M5 Task 7: review (Sonnet) Needs fixes — 1 I: "blocked calls count" (M5R33) has no test that can fail
Task 7: minor (folded into round 1): exact assertions; spy restore in finally; identity / priority comment; check Pi tool_call hook sequencing for parallel calls
Task 7: CARRY to 26 (docs): guard limits, Allow-once restarts the tripped streak, identity = exact canonical input
Task 7: fix round 1 dispatched (resumed sonnet implementer), FIX_BASE 1b6adbf
Task 7: fix round 1/5 (test-only + comment, 28 lines; controller-verified: diff stat, comment-only change in run-guard.ts, guard test files 11/11 green; implementer ran the skip-commit mutation; commits 1b6adbf..f1e4c2d)
Task 7: residual (documented): Pi runs tool calls of one assistant message in parallel; tool_call hook sequencing not documented → a burst in one message may pass a limit by a few calls
Task 7: complete (commits 14ae403..f1e4c2d, review clean after 1 fix round)
M5 Task 8a: dispatched implementer (sonnet), BASE f1e4c2d; carries (escaped JSON form, case in audit reasons) in dispatch
M5 Task 8a: implementer DONE_WITH_CONCERNS (88344e6) — tool_execution_update partials still raw (Task 8b); withheld result returns details: {} (Pi keeps original details on undefined); brief int test rewritten on the real bed (4 redactions: content + structuredContent); escaped-JSON form matched; audit reasons redacted case-insensitively (args exact); step-count cost tests; PolicyConfig.secrets optional until 9; classify unused until 07
M5 Task 8a: review dispatched (Opus)
M5 Task 8a: review (Opus) Needs fixes — 0 C / 2 I: audit-args redaction + reasons wrapper untested (mutations survive); credential-name rule narrower than the daemon logger's (plan M5R35). Redactor, strength floor, auth.json refresh, withheld path (details: {}) confirmed.
Task 8a: Ruling: widen the credential-name rule to the daemon logger's SECRET_WORDS semantics + PGPASSWORD / MYSQL_PWD / SSHPASS — tightening; the strength floor limits false positives — cost if wrong: more [SECRET:…] markers on unusual env names
Task 8a: minor (folded into round 1): non-regular auth.json bounded; single-repeated-char values weak; Pi $VAR / ${VAR} references not secrets; ino/ctime in refresh signature; stderr spies; failing-result int case; cleanups
Task 8a: minor (deferred): overlapping different secrets leave the second's tail (prescribed); reasons clipped before redaction (egress host.slice(0,200) — a secret cut at the clip leaks its head; final review); old auth.json values dropped on rebuild (still-valid tokens)
Task 8a: CARRY to 9: PolicyConfig.secrets required (absent → no redaction, fails open)
Task 8a: CARRY to 26 (docs): object keys not redacted; values split across text parts / content vs structuredContent not matched
Task 8a: fix round 1 dispatched (resumed sonnet implementer), FIX_BASE 88344e6
M5 Task 8a: fix round 1 implementer DONE (1b93d92) — wiring tests (args, reasons case, failing result), widened credential names (24-row table), non-regular auth.json refused + bounded read, repeated-char weak, Pi references skipped, ino/ctime; NOTE: a mutation batch left 4 source files mutated — restored by hand, full gate green after (re-review must confirm no residue)
M5 Task 8a: fix round 1 re-review dispatched (resumed Opus reviewer, incl. residue check)
Task 8a: fix round 1/5 (I1, I2, M1, M2, m4, m5, m6, m10 resolved; m3 partly; Opus: Approved, no mutation residue; commits 88344e6..1b93d92)
Task 8a: fix round 2 dispatched for N1 (rename-based refresh test), N2 (readBounded bound exercised), N3 (reference rule on key only + unescaped $$/$! literals), N4 (O_NONBLOCK + fstat isFile) — FIX_BASE 1b93d92
M5 Task 8a: fix round 2 implementer DONE (3d2d907) — rename-based refresh test, readBounded tested at the bound, reference rule + unescape on key only, O_NONBLOCK + fstat isFile; tests split into secrets.source.test.ts
M5 Task 8a: fix round 2 re-review dispatched (sonnet)
Task 8a: fix round 2/5 (N1–N4 addressed; commits 1b93d92..3d2d907)
Task 8a: complete (commits f1e4c2d..3d2d907, Opus-reviewed, 2 fix rounds)
M5 Task 8b: dispatched implementer (sonnet), BASE 3d2d907; carries (restore last fallible step, pipeline.ts 395) in dispatch
M5 Task 8b: implementer DONE_WITH_CONCERNS (a88cfa1) — pipeline.ts 392; restore followed by audit + commit with unrestore on throw (Stages.unrestore, withRestored); hostile budget test adapted (a×4095+b); int tests on the real bed API; 'restore before decision' mutation caught only via a crash
M5 Task 8b: review dispatched (Opus)
M5 Task 8b: Opus review — Needs fixes: I1 clip before redaction (secret prefix leaves via extension_error / response.error), I2 deep keeps keys + toJSON closures, I3 (plan-mandated) Pi cuts before redaction; spec: secrets still optional; 11 minors
Task 8b: Ruling: M5R120 amended — final tool results get edge masking too (head-mask when Pi marks output cut; `... [truncated]` line end = tail) — why: probes leaked 10/25 chars of a token from a bash final result and grep's 500-char clip — cost if wrong: a few legit chars masked at a cut edge
Task 8b: Ruling: PolicyConfig.secrets required now, NO_SOURCE removed from production — brief says required from 8b; supersedes the 8a carry to T9 — cost if wrong: none
Task 8b: Ruling: worker stdout/stderr pass through the exact redactor once the secret source exists — the daemon logs the worker's output tail and pap's own error lines carry provider text — cost if wrong: a secret split across two writes still leaks (documented residual, T26)
Task 8b: Ruling: restore writes back env-sourced secrets only, never auth.json-sourced (provider credentials) — STRICTER THAN MQ4, report to owner — the "a command reads the environment anyway" cost line does not hold for auth.json values — cost if wrong: an agent cannot materialise a provider key into a file; the owner pastes it
Task 8b: fix round 1 dispatched (resumed implementer): I1, I2, I3, required secrets, stdout/stderr wrap, env-only restore, escaped edges, overlap rule, audit-args isolation test + mutation, missing tests, exact assertions, errorClass decoupling — FIX_BASE a88cfa1
M5 Task 8b: fix round 1 implementer DONE (4cbc916) — 12 items; RED in throwaway worktree (21 failing), 7 real mutation checks; new concerns: a secret split across two message_update deltas leaks the second part's head; any string ending in ≥4 chars of a secret's start shows a marker (display)
Owner (2026-10-12 ≈17:30): B — reader limits (too complex / too long) ask instead of block in interactive sessions with a UI; D — daily-use corpus test (~50 ordinary dev commands pass without a question in the default mode); A and C declined (review stance unchanged)
Ruling: B and D become Task 8c (after 8b, before 9; Sonnet implementer, Opus review since it changes a block into an ask) — D moved from Task 26 to 8c so false positives surface before the remaining tasks build on the stages — cost if wrong: none (same work, earlier)
M5 Task 8b: fix round 1 re-review dispatched (resumed Opus reviewer; + classify delta-split and string-end marker)
Task 8c: brief written by the controller (task-8c-brief.md: B unchecked → ask deny/once in interactive+UI+not read-only, D 52-entry daily-use corpus with knownFriction pinning); dispatch after 8b closes
Task 8b: fix round 1/5 re-review (Opus): I1, I2, spec, m1–m10 addressed; I3 partly (details.truncation.content keeps the cut fragment); new Important N1 (tail hook rewrites ids/keys → approval refused, forks misplaced), N2 (false head mask on truncated read, restore writes a secret into a file); N3/N4 minor
Task 8b: Ruling: tail-mask only clipped strings and never identifier fields (id, *Id, key, sessionFile, type) — the hook on every string end corrupts ids at ~3 % of long sessions with a hex secret — cost if wrong: a clipped identifier (none known) keeps a prefix
Task 8b: Ruling: head-mask only when truncation.lastLinePartial; `... [truncated]` line tails only for built-in grep; a spent edge budget fails the record like a redaction throw — cost if wrong: a Pi cut shape we did not probe keeps a fragment (residual list)
Task 8b: CARRY to 26 (residuals): message_update delta split; Pi persists assistant text and tool-call args raw; free-text string-end false markers; fs.writeSync(fd) / fatal printer bypass stdio wrapper; Pi's /tmp/pi-bash-*.log holds full unredacted output
Task 8b: fix round 2 dispatched (resumed implementer): N1, N2, I3 rest, N3, N4, m11 — FIX_BASE 4cbc916
M5 Task 8b: fix round 2 implementer DONE (6d31a85) — tail mask gated on clip lengths (2000/512/256/4096/200000) + identifier skip; head mask only lastLinePartial; grep-only line tail; truncation.content masked; spent budget fails the record; stdio encodings; 15 RED, real mutations
M5 Task 8b: fix round 2 re-review dispatched (resumed Opus reviewer)
Task 8b: fix round 2/5 re-review (Opus): N1, N2, I3, N3, N4, m11 addressed; remaining Important: egress reason cuts the host at 200 and the trail clips at 256 before redaction → secret prefix in the audit table (probe 6–15/24)
Task 8b: Ruling: every stage reason is redacted (case-folded) before the trail clips it; egress drops its host slice — closes the reason-clip class at its source instead of extending the length list — cost if wrong: none
Task 8b: CARRY to 26 (residuals): ui-lines 512 cut + SGR/surrogate strip, session title 80+…, compaction summary 65 536, worker stderr logLineOf lines exact-only
Task 8b: fix round 3 dispatched (resumed implementer): reason redaction before clip, grep built-in check — FIX_BASE 6d31a85
M5 Task 8b: fix round 3 implementer DONE (a5f9194) — redactReason dep (case-folded) before trail 256 / entry 1024 clips, egress host slice dropped, grep notice classified via isBuiltin; pipeline.ts 393
M5 Task 8b: fix round 3 re-review dispatched (resumed Opus reviewer)
Task 8b: fix round 3/5 re-review (Opus): Approved — 0 leaked chars at every offset (mixed-case + hex) in audit entry, audit record and model reason; no other reason path clips before redaction
Task 8b: Ruling: the two remaining minors (isBuiltin fails toward masking: true on unknown/throw, host.ts:52-54; createTrail redact parameter required) are carried into Task 8c's dispatch instead of a 4th round (which would need a fresh Opus implementer for two lines) — cost if wrong: none, 8c touches the same files
Task 8b: complete (commits 3d2d907..a5f9194, Opus-reviewed, 3 fix rounds)
M5 Task 8c: dispatched implementer (sonnet), BASE a5f9194; carries from 8b (isBuiltin fails toward masking, createTrail redact required) in dispatch; Opus review
M5 Task 8c: implementer DONE_WITH_CONCERNS (56adb34, 22bec76) — corpus 52/52 pass with no fix and no knownFriction (allowHosts null); B: 11/24 RED, real mutations; 4 denylist.hostile block tests moved to hasUI:false, egress.hostile too-many-words now blocks at 02; pipeline.ts 394 (checkStage → unchecked.ts); fork-bomb check still blocks on reader failure
M5 Task 8c: review dispatched (Opus)
M5 Task 8c: Opus review — Needs fixes: C1 the card never shows UNCHECKED_REASON (padded rm -rf ~ = ordinary "Run a command?", tail behind "show more"); I1 padding turns any built-in hit into a deny/once question (probes A–E); m1 owner pattern skipped via budget; m2 MQ6 re-check accepts unchecked for any call; m3/m4/m6 tests; m5 egress reader-limit block names the wrong cause; m7 M5R17/M5R18 text stale
Task 8c: Ruling: when the stage-01 reader fails, the built-in catastrophic checks still run over a cheap bounded split of the raw text (quotes/backslashes stripped; lines, ; && || |, whitespace) — a hit blocks — why: owner lever B is about legit complex commands; padding a catastrophic command must not turn a block into a question; this only adds blocks to commands that would otherwise ask — cost if wrong: a legit complex command containing a catastrophic shape in data (e.g. inside a here-doc string) blocks instead of asking
Task 8c: Ruling: the unchecked question shows UNCHECKED_REASON as the card title (or first message line next to a guard title) — the owner's "you see the command, you decide" needs an informed card — cost if wrong: none
Task 8c: CARRY to 26 (docs/residuals): M5R17/M5R18 + M5R92 "What it cannot catch" + policy.md describe the deny/once question for unreadable commands; owner patterns skippable by budget exhaustion in an earlier segment (m1)
Task 8c: fix round 1 dispatched (resumed implementer): C1, raw-text built-in scan + probes A–E, m2, m5, m3/m4/m6 — FIX_BASE 22bec76
M5 Task 8c: fix round 1 implementer DONE (a99cacb) — card title UNCHECKED_REASON (guard: first line), roughBuiltinHit over raw split (≤ 4 Mi chars), 5 probes + quoted rm/mkfs/dd block, here-docs unchanged; MQ6 re-check scoped; egress cause named; knownFriction pins verdict
Task 8c: fix round 1/5 re-review (Opus): C1, m2–m6 addressed; open N1 (rough scan misses /bin/rm, ${HOME}, line continuation, glued redirect, $IFS — 8 padded forms ask while the short form blocks), N2 (rough scan unbounded: up to 2.4 s per call near the 2 MiB cap; size cap returns null)
Task 8c: Ruling: rough-scan budget exhaustion and the size cap block (too-complex reason) — a pathological input is not daily use — cost if wrong: none
Task 8c: CARRY to 26 (residuals): with an egress host list on, unreadable bash commands block at stage 02 (lever B inert there); unreadable commands that only mention a catastrophic shape in data block
Task 8c: fix round 2 dispatched (resumed implementer): N1 five reader rules in the rough scan + 8 pinned probes, N2 step budget, m-b size line, m-c rename — FIX_BASE a99cacb
M5 Task 8c: fix round 2 implementer DONE (5bf06d7) — rough scan: basename, \+newline, ${…} whole, redirects split, $IFS blanks; 4 M-step budget blocks (pinned counts), size cap blocks; guard card first line = reason + size; markAskable; pipeline.ts 400/400
Task 8c: CARRY to 9 (and every later task touching the pipeline): pipeline.ts is at 400/400 — split it (e.g. settle / evaluateOnce into their own files) before any edit
Task 8c: fix round 2/5 re-review (Opus): N1, N2, m-b, m-c addressed (worst case ~1 s at 2 MiB, all bounded); open N3: `>|` and `>&` to a disk ask when padded (reader blocks) — one-line rewrite
Task 8c: CARRY to 26 (residuals): `rm -f a.txt $(ls -R /)` blocks when the reader gives up (substitution args fall in the rm window)
Task 8c: fix round 3 dispatched (resumed implementer): redirection operator rewrite + 3 pinned forms — controller re-verifies (one-line logic + tests + mutation, reviewer's suggestion) — FIX_BASE 5bf06d7
Task 8c: fix round 3/5 (f897d88) verified by controller — redirect rewrite; mutation (keep the operator glued) fails exactly the 3 new tests, restored; policy unit 1683 green; residual isForkBomb outside the step budget (~0.6 s at 2 MiB) → final review note
Task 8c: complete (commits a5f9194..f897d88, Opus-reviewed, 3 fix rounds)
M5 Task 9: dispatched implementer (sonnet), BASE f897d88; carries (split pipeline.ts first, taint epoch on push, fence vs redaction order) in dispatch; Opus review
M5 Task 9: implementer DONE_WITH_CONCERNS (27e4b62 refactor split, 019abbe) — daemon push still sends defaulted taint until 12b-2 (worker ignores lower/equal epoch, tested); forked worker does not load Pi's MCP extension → MCP int case in-process; captured prompt = leading system messages; extension.test.ts at 400; bundle 195.4
Task 9: CARRY to 12b-2: policyFor must read the taint store (real taint + epoch on init and policy_update)
M5 Task 9: review dispatched (Opus)
M5 Task 9: Opus review Approved — refactor byte-identical; fence after redaction, random id per result, epoch rule sticky; I1 (plan-mandated, cross-task): the production worker loads no MCP / codemode / tool_search (SDK sessions do not load Pi's built-ins; host.ts passes no extraExtensions) — 5b's int test was in-process too
Task 9: Ruling: MCP / codemode / tool_search wiring into the worker belongs to M7 (roadmap: D08 presets incl. codemode + tool-search, D09 MCP client) — M5's MCP stages stay tested in-process; no new M5 task — cost if wrong: M5's MCP policy is unexercised in production until M7 (no MCP tools exist there to exercise)
Task 9: CARRY to M7 planning: register MCP/codemode/tool_search as {name, factory, builtin:true, replaceable:true} with exact names; activate MCP tools (setActiveToolsByName); codemode models:false (5b carry); forked-worker test of MCP fencing + taint; a real codemode nested call fencing its root
Task 9: CARRY to 25a: the "MCP read-only tool asks" exit criterion cannot run against a real daemon worker (no MCP until M7) — run it in-process (openSession + extraExtensions) and say so in the test
Task 9: CARRY to 12b-2: a worker restart drops the taint today (daemon pushes NO_TAINT, drops the taint record) — 12b-2's store closes it; optional: start tainted when the loaded transcript holds `<untrusted ` markers
Task 9: CARRY to 12b-2 / 24 (M5R122): TaintRecord has no epoch — carry the epoch and drop stale records; allow Clear only on an idle session
Task 9: CARRY to owner report: tool_search is not external yet returns MCP-server-written descriptions; image parts and structuredContent are not fenced (taint is the only barrier)
Task 9: follow-up (resumed implementer): M1 isExternal inside try, M2 reason wording, M6 two mutations, M7 isError/throwing external tool tests — controller verifies
Task 9: follow-up 49933ff verified by controller (isExternal fully inside try → external; audit reason from taint.current(); isError + throwing external tool tests; mutations reported caught; policy unit 1714 green)
minor (deferred): when classify throws for a nested result, its parent root is not recorded (the parent's result is not fenced) — codemode is not wired until M7
Task 9: complete (commits f897d88..49933ff, Opus-reviewed, approved + follow-up)
M5 Task 10: dispatched implementer (sonnet), BASE 49933ff; carry from 3b (validate worker audit entry, rogue-bed junk case) + agreements 2/3/7 in dispatch; Opus review
M5 Task 10: implementer DONE_WITH_CONCERNS (03fa471) — bundle 195.4 → 195.6; scrub test: prescribed regexes match the hostile alphabet runs → exact counts asserted; junk audit {} stored as invalid (dropped count stays 10); session entry mode not stored (detail full); service.ts 382
M5 Task 10: review dispatched (Opus)
M5 Task 10: Opus review — Needs fixes: I1 worker stage-05 reason + daemon suffix > 256 breaks every audit.list page (also stages [1], empty sessionId); I2 (plan-mandated M5R124) JWT regex super-linear (20.9 s on 4 MiB, ~10.6 ms per call entry); I3 (plan-mandated M5R44) REPLACE bypasses the append-only triggers; 10 minors (stages > CHECK, NUL truncation, out-of-range at, mode dropped, valid rows uncapped…)
Task 10: Ruling: M5R124 amended — JWT expression uses (?<![A-Za-z0-9_-]) instead of \b (linear; a JWT right after `-` is not matched) — cost if wrong: that JWT shape stays unscrubbed in the audit
Task 10: Ruling: M5R44 amended — BEFORE INSERT triggers refuse an existing id on audit and audit_prunes (REPLACE); recursive_triggers stays off — cost if wrong: none
Task 10: Ruling: audit.list decodes row by row and degrades a refused row instead of failing the page; the daemon's own suffix never pushes a reason past 256 — cost if wrong: none
Task 10: Ruling: worker rows capped at 600 per session per minute, excess dropped with one marker row per minute counting them — why: an unpruneable 12-month table must not take an unbounded flood — cost if wrong: a legit burst > 10 rows/s loses rows (the marker records how many)
Task 10: Ruling: the session entry stores the worker-reported mode (validated enum) in detail; Task 21 shows detail — cost if wrong: fewer tool names fit
Task 10: CARRY to 11: monthCutoff exported from audit/index.ts (done in round 1); CARRY to 21: show the session row's detail (mode + tool names)
Task 10: fix round 1 dispatched (resumed implementer) — FIX_BASE 03fa471
Owner (2026-10-12 ≈19:45): overnight full autonomy on M5; when M5's tasks are done, merge M4 then M5 (rebase, gates, final review), push, rebuild, restart pap-preview
M5 Task 10: fix round 1 implementer DONE (bb86c8f) — list decodes per row + degrade, linear JWT, no-replace triggers, stages fitted, NUL→U+FFFD, at range CHECK, mode in detail, 600 rows/min budget + marker, docs; 14 RED; mutations on I1–I3, M1, M4, M6
M5 Task 10: fix round 1 re-review dispatched (resumed Opus reviewer)
Task 10: fix round 1/5 re-review (Opus): Approved — all probes pass (REPLACE refused, 256-char reason lists, degraded rows parse, eyJ- 4 MiB 14 ms, at range, 8×256 stages stored, NUL → U+FFFD)
Task 10: Ruling: no per-session volume cap on audit rows (600 rows/min × ≤ 18 K chars stays) — a compromised worker can already write arbitrary files under the same account (its session file, the project), so an audit volume cap does not prevent disk exhaustion; documented in Task 26 — cost if wrong: a hostile session grows the audit table ~10 MB/min until the owner stops it
Task 10: CARRY to 11 (touches the audit module): write the drop marker at the first drop of each window (where the gap starts), keep the count in the log; fix docs/agents/daemon.md:57 and the AuditPort.fromWorker doc (returns the entry whether or not stored); int-bed.ts:119 sessionEvents doc
Task 10: complete (commits 49933ff..bb86c8f, Opus-reviewed, 1 fix round)
M5 Task 11: dispatched implementer (sonnet), BASE bb86c8f; carries from 10 (marker at first drop, docs) + agreement 3 int case; Sonnet review
M5 Task 11: implementer DONE_WITH_CONCERNS (dab98ae) — usage lists serve + audit prune (Task 18 adds the rest); open-home imports MIGRATION_SOURCES from daemon.ts; drop marker at first drop without count (count in log)
M5 Task 11: review dispatched (sonnet)
M5 Task 11: review (Sonnet) approved — 0 C / 0 I; lock, prune protocol, openHomeForCli, args, drop marker meet the brief
Task 11: CARRY to 18: extend USAGE and COMMANDS together (user add, passkey reset); CARRY to 26 (docs): daemon.md CLI paragraph (cli/, openHomeForCli, exit codes 0/1/64, daemon stopped + systemctl hint, a killed prune leaves a stale lock replaced next run)
minor (deferred): duplicate import in audit-prune.ts; audit_rows_dropped logs dropped:1 twice for a single drop
Task 11: complete (commits bb86c8f..dab98ae, review clean)
M5 Task 12a: dispatched implementer (sonnet), BASE dab98ae; Sonnet review
M5 Task 12a: implementer DONE_WITH_CONCERNS (75b9dbc) — bundle 195.7; RESTRICTIVE_SETTINGS not re-exported (knip) → 12b-1; sessions/store.test.ts migration test adjusted (stamp order); old policy methods inline, new four in policy-methods.ts; bare git stash incident (applied + dropped; stash list empty, both worktrees clean — controller checked)
M5 Task 12a: review dispatched (sonnet)
M5 Task 12a: review (Sonnet) approved — 0 C / 0 I; owner-scoped SQL, CAS settings, 64 KiB cap, audit lines, no existence oracle
Task 12a: CARRY to 12b-2: markTainted takes the observed epoch (WHERE tainted_at IS NULL AND taint_epoch <= observed), TaintRecord carries the worker's epoch; inherit must not lower the epoch (DO NOTHING or max()); tests: unbound sessionOwner → not_found, throwing audit port leaves the mutation done
Task 12a: CARRY to 12b-1: re-export RESTRICTIVE_SETTINGS from policy/index.ts when used; CARRY to auth tasks (13a/13b/14): a test that a token can never be granted policy:admin (owner Q7 b)
Task 12a: complete (commits dab98ae..75b9dbc, review clean)
M5 Task 12b-1: dispatched implementer (sonnet), BASE 75b9dbc; carries (real taint+epoch in compose, RESTRICTIVE_SETTINGS export, named hunks for the M4 rebase) in dispatch; Sonnet review
M5 Task 12b-1: implementer DONE (16c08d8) — compose real mode/settings/taint, pushes on changes, policy view; service.ts 380, live-session.ts 387; 12b-2 owes markTainted from the taint record, inherit, audited taint fact, PolicyLink.tainted/inherit, onAdopted
M5 Task 12b-1: review dispatched (sonnet)
M5 Task 12b-1: review (Sonnet) approved — 0 C / 0 I; compose fail-closed, sync pushes held across spawn→ready, push before publish, refused update always stops
Task 12b-1: CARRY to 12b-2: policy_update_refused limiter keyed by session (names every session); a test for a mode/taint push while a worker is starting; docs sessions.md/daemon.md for the policy link (or 26)
Task 12b-1: complete (commits 75b9dbc..16c08d8, review clean)
Task 12b-2: Ruling: TaintRecord carries the worker's epoch; markTainted raises only when taint_epoch <= observed (a pre-Clear report is stale) — closes the Clear/late-report race without an "idle only" Clear — cost if wrong: none (additive contract field)
Task 12b-2: Ruling: M5R60 path (2) (audit result external:true) raises without an epoch check — fail-safe fallback; a late one after a Clear re-taints (documented nuisance, Task 26) — cost if wrong: an owner clears twice
Task 12b-2: Ruling: onAdopted → markTainted (agreement 8) is wired at the M5 rebase on M4, not in 12b-2 (M4 code absent on this branch)
M5 Task 12b-2: dispatched implementer (sonnet), BASE 16c08d8; carries from 9/12a/12b-1 in dispatch; Opus review
M5 Task 12b-2: implementer DONE_WITH_CONCERNS (18be56e) — epoch on TaintRecord, markTainted epoch guard, path 2 without epoch, inherit (mode + taint, epoch untouched), fork adopt removes the row on failure, restart keeps taint; sessions-level tests not RED (mutations instead); limiter cap not crossed in a test
M5 Task 12b-2: review dispatched (Opus)
M5 Task 12b-2: Opus review — Needs fixes: I1 M5R112 budgets gate skipped for a contracts change (no bundle line); security core holds (no fail-open found, no cross-session taint); minors (path-2 role in docs, inherit COALESCE, fork cleanup order, silent drop, test gaps, audit throw fails the RPC)
Task 12b-2: CARRY to M5 rebase on M4: wire onAdopted → policy.markTainted in daemon.ts + int test (adopted session snapshot shows policy.tainted) — until then adopted sessions are untainted (fail-open by design, ruling c)
Task 12b-2: CARRY to 26 (residuals): daemon crash between a worker's taint send and its dispatch; a clone taken while the live leaf is null; a clone after a failed markTainted before the next agent_end; insert + inherit not one transaction (crash between); path 2 is load-bearing (never add an epoch check)
Task 12b-2: fix round 1 dispatched (resumed implementer) — FIX_BASE 18be56e
Task 12b-2: fix round 1 (a8b7757) verified by controller — Important was a gate (budgets run: 195.7 → 195.7 KB, bundle line present); minors are small (COALESCE in inherit, audit catch in the policy service, fork cleanup order, logs, tests) with RED/mutations reported; diff read
Task 12b-2: complete (commits 16c08d8..a8b7757, Opus-reviewed, 1 fix round)
M5 Task 13a: dispatched implementer (sonnet), BASE a8b7757; Q7(b) token test carry; Opus review
M5 Task 13a: implementer DONE_WITH_CONCERNS (5831e33) — step-up on the browser session's key; added a 10 000-key hard cap with oldest-failure eviction to throttle.ts (not in the brief); Q7(b) test → 13b; auth.md stale → 26
M5 Task 13a: review dispatched (Opus, incl. throttle eviction bypass probe)
M5 Task 13a: Opus review — Needs fixes: C1 the implementer's extra throttle hard cap evicts live lockouts (10 000 free /auth/setup failures from distinct IPv6 addresses reset user:owner and session: lockouts, reproduced); minors m1–m8; step-up itself correct and fail-closed
Task 13a: Ruling: the password throttle refuses when full (drops only expired head entries, never evicts a live lockout); session: keys get their own throttle (only a valid cookie mints them); the passkey throttle keeps evict (nothing to guess, keeps recovery open); /auth/setup after an owner exists answers 401 without counting — cost if wrong: a spray from 10 000 addresses refuses password sign-in from unknown addresses for ≤ 1 h (passkey sign-in and the owner's own session stay open)
Task 13a: Ruling: requireStepUp refuses unless kind === "session" (amends the binding code; fail closed for future caller kinds) — cost if wrong: none
Task 13a: CARRY to 15: revoking a session must drop its step-up mark (stepUps is private to createAuthService — revoke through the service); CARRY to 17/26: docs/agents/auth.md rewrite (confirm route, key partitions, whenFull policy)
Task 13a: fix round 1 dispatched (resumed implementer) — FIX_BASE 5831e33
M5 Task 13a: fix round 1 implementer DONE_WITH_CONCERNS (9dc5452) — whenFull refuse/evict, session: throttle, setup 401 without counting, spray test; not RED-first (mutations instead); the index.ts refuse wiring is untested at HTTP level
Task 13a: fix round 1/5 re-review (Opus): Approved — spray probe holds both lockouts (429/60), refuse path bounded, owner session/step-up/enrollment/passkey stay open; minors n1 (register/verify shares the session key with step-up, against R80), n2 (throttle modes unpinned), n3 (no log on full-table refusal)
Task 13a: CARRY to 17: device keys must go in a table attackers cannot fill (not the password table) — else a full-table refusal locks known devices out
Task 13a: follow-up (resumed implementer): n1, n2 createAuthThrottles + mode test + mutation, n3 auth_throttle_full — controller verifies
Task 13a: follow-up ccbb6e3 verified by controller (register/verify back on the passkey throttle + test; createAuthThrottles mode test fails under either mode swap; auth_throttle_full rate-limited log; auth tests green)
Task 13a: complete (commits a8b7757..ccbb6e3, Opus-reviewed, 1 fix round + follow-up)
M5 Task 13b: dispatched implementer (sonnet), BASE ccbb6e3; Q7(b) defence-in-depth test carried; Opus review
M5 Task 13b: implementer DONE (5458ff2) — bundle 195.7 → 196.1; Q7(b) four layers; auth index re-exports token service/store for the test bed; 11 real mutations
M5 Task 13b: review dispatched (Opus)
M5 Task 13b: Opus review — Needs fixes: I1 auth.tokens.list answers read_only on a read-only db (dropExpired DELETE first; R130 says reads answer, side writes skipped); secret never leaks (probe: not in rows, audit, logs, db/WAL bytes; replay → conflict), Q7(b) holds at every layer incl. SQL tamper; minors (dead sameHash, damaged row unlogged, bidi names, test bed)
Task 13b: CARRY to 15: in-flight secret-receipt sharing is keyed by [userId, commandId], not by credential — revisit once devices have their own identity
Task 13b: fix round 1 dispatched (resumed implementer) — FIX_BASE 5458ff2
Task 13b: fix round 1 (1649958) verified by controller — read-only list catches + filters expired; sameHash removed; token_row_damaged warn (rowId); INVISIBLE refine on names; bed cleanups; mutations reported; auth + contracts tests green; index re-export kept (accepted by reviewer, sessions precedent)
Task 13b: complete (commits ccbb6e3..1649958, Opus-reviewed, 1 fix round)
M5 Task 14: dispatched implementer (sonnet), BASE 1649958; Opus review
M5 Task 14: implementer DONE_WITH_CONCERNS (d129f3c) — Origin checked before the cookie+bearer conflict (foreign Origin 403 even with both); int test not RED (mutations); cookie + malformed bearer = cookie-only; idle token expiry noticed within 15 s
M5 Task 14: review dispatched (Opus)
M5 Task 14: review (Opus) approved — 0 C / 0 I; ~120-combination probe: no cookie accepted with missing/foreign/null Origin, revoked/expired token closes 4401 within one tick, no token in logs, invalid vs revoked byte-identical
Task 14: Ruling: a present Origin is checked before the cookie+bearer conflict (M5R70 "whatever the credential" beats the brief's snippet order); cookie + malformed bearer stays cookie-only (a Basic-auth proxy replays Authorization on the handshake) — cost if wrong: none
Task 14: CARRY to 15 (auth module): refuse an upgrade with more than one Authorization header (headersDistinct, 400); unit test pinning authenticateCredential(bearer, { slide: false }); remove the dead AuthModule.authenticateBearer (and authenticateSession if test-only)
Task 14: CARRY to 26 (docs): upgrade order (Origin present → conflict → no-Origin rule → 426 → auth) in m5-rulings + ADR 0021; auth.md "Both: 400" → 403 with a foreign Origin; malformed bearer without Origin answers 403 origin_refused (CLI typo)
Task 14: complete (commits 1649958..d129f3c, Opus-reviewed, clean)
M5 Task 15: dispatched implementer (sonnet), BASE d129f3c; carries from 13a/13b/14 in dispatch; Sonnet review (X3)
M5 Task 15: implementer DONE (8d2def5) — bundle 196.1 → 196.3; in-flight secret sharing now refuses a duplicate from another credential (conflict); device mutations require a browser-session caller; auth index re-exports factories for testing/
M5 Task 15: review dispatched (sonnet)
M5 Task 15: review (Sonnet) approved — 0 C / 0 I; all carried items verified; session-only guard on device mutations is a real hole closed
Task 15: CARRY to 16 (auth module): narrow the testing seam — one createAuthTestHarness (or auth/test-seam.ts) instead of seven factory re-exports in index.ts; revokeOthers / revoke ignore expired rows (AND expires_at > now)
Task 15: CARRY to 26 (docs/residuals): auth.md devices + credentialId + passkey_ref; a persisted receipt of revokeOthers replays across credentials of the same owner (needs a commandId collision); public_id NOT NULL in a later migration
Task 15: complete (commits d129f3c..8d2def5, review clean)
M5 Task 16: dispatched implementer (sonnet), BASE 8d2def5; carries from 15 (narrow test seam, expired rows); Opus review
M5 Task 16: implementer DONE_WITH_CONCERNS (d232172) — passkey list/remove + sign-out of its browsers, nonce slack, early failure count, flows bound to session; createPasskeyManager takes the service; passkey_enrolled audit added; 12 mutations
M5 Task 16: review dispatched (Opus)
M5 Task 16: review (Opus) approved — 0 C / 0 I; e2e probe (26 checks, real verifier): one synchronous removal, step-up before any oracle, flows bound to session, in-flight sign-in loses to removal
Task 16: CARRY to 17 (auth module): used-nonce map hard cap (10 k, refuse when full of live entries) + cap test; HTTP cookie-swap test on register/verify (session B's cookie → 401); register/verify `conflict` → succeed (not a guess) or log it; passkeys list newest first (or a 100-passkey enrollment cap); auth.md:34 flows store the session id hash; test-seam.ts:34 comment reworded
Task 16: CARRY to 25a/25b: a WS test that removing a passkey closes its sessions' sockets with 4401
Task 16: complete (commits 8d2def5..d232172, Opus-reviewed, clean)
M5 Task 17: dispatched implementer (sonnet), BASE d232172; carries from 13a/14/15/16 (device keys in an unfillable table, nonce cap, cookie-swap test, conflict succeed, list newest first, auth.md rewrite); Opus review
M5 Task 17: implementer DONE_WITH_CONCERNS (5f2a680) — known-device cookie, own unfillable table, bundle 196.4; carries done (nonce cap, cookie-swap test, conflict succeed, newest first, auth.md); concern: the 10 k nonce cap can be filled (many addresses) → passkey sign-in refused ~10 min; AuthServiceDeps.devices optional (ephemeral key in the seam)
M5 Task 17: review dispatched (Opus)
M5 Task 17: Opus review — Needs fixes: I1 the carried 10 k used-nonce cap can be filled by garbage answers (nonce taken before the credential lookup) → every passkey sign-in refused ~10 min, attacker never throttled (passkey table evicts); known-device goal reproduced over HTTP (known browser: sign-in 200, step-up 204, enrollment 200 under the full spray); minors (devices optional, cookie tossing, chmod by path, auth.md overclaims)
Task 17: Ruling: look up the credential + user handle before logins.take (only a registered credential id records a nonce); keep R85 (taken before the slow verify, used up by the first answer) — cost if wrong: an attacker holding a registered credential id (only in excludeCredentials / the authenticator) can still fill the map
Task 17: Ruling: AuthServiceDeps.devices required; every pap_device value tried (cookie tossing); a key file readable by others is replaced, not tightened — cost if wrong: a restart with a replaced key forgets all known devices once (logged)
Task 17: fix round 1 dispatched (resumed implementer) — FIX_BASE 5f2a680
M5 Task 17: fix round 1 implementer DONE (e0d7955) — credential lookup before logins.take, auth_login_challenges_full, devices required + restart test, every pap_device tried (≤ 16), key file readable by others replaced (fchmod), docs/comment/test fixes
Task 17: fix round 1/5 re-review (Opus): Approved — garbage fill of 10 001 addresses no longer refuses the owner's passkey sign-in (200 unknown device, 200 known); answers identical across unknown/known/bad-signature (timing gap pre-existing, ids never shown); cookie loop bounded (≤ 16, ~45 µs worst); restart test spans two module instances
Task 17: CARRY to 18 (auth module): PasskeyDeps.logger required; known-device keyOf without this-recursion; auth.md:46 cross-reference to :68 (remaining risk: a registered credential id can fill the nonce map)
Task 17: complete (commits d232172..e0d7955, Opus-reviewed, 1 fix round)
M5 Task 18: dispatched implementer (sonnet), BASE e0d7955; carries from 11/17; Sonnet review (X3)
M5 Task 18: implementer DONE (dd387b9) — user add + passkey reset; resetCredentials async; new store oldestUserId() (M4's ownerId() absent on this branch); --password-stdin on a TTY reads a cooked line (echoed)
Task 18: CARRY to M5 rebase on M4: replace oldestUserId() with M4's AuthModule.ownerId() (agreement 6: one definition of the instance owner)
M5 Task 18: review dispatched (sonnet)
M5 Task 18: review (Sonnet) approved — 0 C / 0 I; password never on argv/logs, reset atomic and crash-safe, lock before prompt; follow-up: audit append inside the reset transaction, username validated before prompts, auth.md echo note — controller verifies
minor (deferred): raw-mode Esc swallows the next letter (Again prompt catches it); no injected rmSync-failure test; no direct oldestUserId / multi-user reset test
Task 18: follow-up c67c4e9 verified by controller (audit append inside the reset transaction + rollback test; username before prompts; doc sentence; CLI int tests re-run)
Task 18: complete (commits e0d7955..c67c4e9, review approved + follow-up)
M5 Task 19: dispatched implementer (sonnet), BASE c67c4e9; Sonnet review
M5 Task 19: implementer DONE_WITH_CONCERNS (aebf915) — catalog split, approvals section, lazy catalogs; bundle unchanged 196.4; settings-access.ts empty placeholder; eager commands.palette.settings.approvals key added; no separate RED (compile-time), 2 mutations
M5 Task 19: review dispatched (sonnet)
M5 Task 19: review (Sonnet) approved — 0 C / 0 I; split verified key-by-key (en/fr 184 → 185, only settings.section.approvals added); palette key required by typed key construction
Task 19: CARRY to M5 rebase: commands.ts en/fr list conflicts trivially with M4 (keep both sides + approvals line)
Task 19: complete (commits c67c4e9..aebf915, review clean)
M5 Task 20: dispatched implementer (sonnet), BASE aebf915; carries (egress limits copy, full-access copy, lever B copy) in dispatch; Sonnet review
M5 Task 20: implementer DONE_WITH_CONCERNS (78bac3d) — bundle unchanged 196.4 (Settings chunk 42 KB); panel tests not RED (mutations); Segmented mode picker; 7 built-in ids hard-coded in web (no cross-check with pi-host); no browser check
M5 Task 20: review dispatched (sonnet)
M5 Task 20: review (Sonnet) approved — 0 C / 0 I; CAS save + conflict + timeout re-read, glob validation, owner copy (a)(b)(c) en/fr, rules by project
Task 20: Ruling: built-in deny ids and the 64 KiB settings cap move to @pap/contracts, with a pi-host test tying BUILTIN_CHECKS to the shared list — stops drift in a security-facing screen — cost if wrong: none
Task 20: Ruling: the Segmented mode picker stays (chosen mode's hint incl. full-access limits shows before Save) — owner can ask for all four descriptions on the preview — cost if wrong: ~10 lines
Task 20: follow-up (resumed implementer): BUILTIN_DENY_IDS + MAX_SETTINGS_BYTES in contracts + pi-host test, revoke error lifted — controller verifies
Task 20: follow-up 1294c14 verified by controller (BUILTIN_DENY_IDS + MAX_SETTINGS_BYTES in contracts; ids test fails when an id is renamed — controller mutation, restored; revoke error lifted + test; bundle 196.5)
Task 20: complete (commits aebf915..1294c14, review approved + follow-up)
M5 Task 21: dispatched implementer (sonnet), BASE 1294c14; carries from 3a (untrusted text) and 10 (session detail, rate-limit markers); Sonnet review
M5 Task 21: implementer DONE (6cb0d66) — audit viewer, bundle unchanged 196.5; isGap matches the daemon's literal reason string; filter on Enter; 4 mutations (stale-page test strengthened)
M5 Task 21: review dispatched (sonnet)
M5 Task 21: review (Sonnet) Needs fixes — I1 session filter not validated client-side (> 128 code points → generic error, Try again resends); minors: share AUDIT_RATE_LIMIT_REASON via contracts, focusable args <pre>, raw actor enum, stage key uniqueness
Task 21: fix round 1 dispatched (resumed implementer) — FIX_BASE 6cb0d66
Task 21: fix round 1 (908627d, 9486103) verified by controller — AUDIT_RATE_LIMIT_REASON + AUDIT_SESSION_ID_MAX in contracts, filter > 128 refused inline (no request) + test, focusable args region; bundle 196.5; length counted in UTF-16 units (session ids are ASCII UUIDs — irrelevant)
Task 21: complete (commits 1294c14..9486103, review + 1 fix round)
M5 Task 22: dispatched implementer (sonnet), BASE 9486103; Sonnet review
M5 Task 22: implementer DONE_WITH_CONCERNS (1fef22d) — devices, passkeys, step-up prompt; bundle 196.6; #tokens link (Task 23 adds the id); stale 'confirm your password' error after a cancelled prompt; happy-dom only
M5 Task 22: review dispatched (sonnet)
M5 Task 22: review (Sonnet) Needs fixes — I1 fr says "Passkey" where M3 says "clé d'accès" (+ two unjustified IDENTICAL_IN_FR entries); I2 focus lands on body after the step-up dialog (trigger unmounted); minors: cancel leaves a misleading alert, missing mutation checks, #tokens hand-off
Task 22: CARRY to 23: the Tokens section has id="tokens" (Account links to #tokens)
Task 22: fix round 1 dispatched (resumed implementer) — FIX_BASE 1fef22d
Task 22: fix round 1 (a6b27b3) verified by controller — fr "clé d'accès", focus to the Passkeys heading (activeElement tests), cancel not an error, connection_lost + alive-guard mutation tests; unit 5575 green
Task 22: complete (commits 9486103..a6b27b3, review + 1 fix round)
M5 Task 23: dispatched implementer (sonnet), BASE a6b27b3; #tokens id carried; Sonnet review
M5 Task 23: implementer DONE (9e15630) — tokens create/show once/list/revoke; bundle 196.7; timeout on create shows the generic may-have-gone-through error, list reload tells
M5 Task 23: review dispatched (sonnet)
M5 Task 23: review (Sonnet) approved — 0 C / 0 I; value flow traced (input + Copy only; console/storage/URL/DOM-after-Done tested); Q7(b) grid exact; follow-up: timeout copy "revoke it if it appears", focus after Done, step-up prompt outside the create form — controller verifies
minor (deferred): list `now` frozen at answer time (Expired chip waits for the next reload)
Task 23: follow-up daf875c verified by controller (timeout copy en/fr + tests; focus to Name; prompt outside the form — structure test, behaviour already guarded by useMutation; budgets re-measured by controller)
Task 23: complete (commits a6b27b3..daf875c, review approved + follow-up)
M5 Task 24: dispatched implementer (sonnet), BASE daf875c; agreements 12/14/15 + one-line SessionScreen hunk in dispatch; Clear allowed any time (epoch guard, 12b-2 ruling) supersedes the Task 9 'idle only' suggestion; Sonnet review
M5 Task 24: implementer DONE_WITH_CONCERNS (ac3a73e) — policy bar, taint chip, tainted cards, fenced output; bundle 196.7 → 197.1 (+0.4 not bisected); SessionScreen one JSX line + one import; data-inline-edit only while a question is open
M5 Task 24: review dispatched (sonnet, with bundle analysis)
M5 Task 24: review (Sonnet) Needs fixes — bundle: no module became eager (+0.4 KB = Radix modules reshuffled between initial chunks); I1 (plan-mandated) untruncated external output (< 8000 chars) is stripped to plain text, never fenced/labelled; minors (stale clear question, hostile fence tests, pass-through helper, docs)
Task 24: Ruling: fence the whole preview when it is complete (whole === null) — the common case must carry the untrusted label — cost if wrong: none
Task 24: CARRY to M5 final / M7: SessionPolicyView could carry defaultMode so "Use my default" names the mode (contract change, deferred)
Task 24: fix round 1 dispatched (resumed implementer) — FIX_BASE ac3a73e
Task 24: fix round 1 (a4f3b17) verified by controller — complete preview split into a labelled Fence (+ test), Clear question reset with the taint, hostile fence tests, helper removed, web.md note; web unit green; bundle 197.1
Task 24: complete (commits daf875c..a4f3b17, review + 1 fix round)
Task 25a: Ruling: MCP exit criteria run in-process (openSession + extraExtensions), never against a real daemon worker — the production worker has no MCP until M7 (Task 9 ruling); M5R103's "MCP fixture not connecting fails under CI=1" applies to the in-process fixture — cost if wrong: none
M5 Task 25a: dispatched implementer (sonnet), BASE a4f3b17; carries (MCP in-process, passkey-removal 4401, path 2 not suppressed after Clear, no adopted sessions) in dispatch; Opus review
M5 Task 25a: implementer DONE_WITH_CONCERNS (ef7ad1a) — fail-closed + taint e2e (12 tests, 6 runs stable, 6 mutations); passkey-removal 4401 → 25b; MCP case in-process; no RED (behaviour pre-existing)
M5 Task 25a: review dispatched (Opus)
M5 Task 25a: review (Opus) approved — 0 C / 0 I; every 25a criterion proven through the real stack; two mutations fail by 30 s timeout (bounded, no hidden pass)
Task 25a: CARRY to 25b (same suite): fail fast on "dialog or idle" instead of waitIdle timeouts; rename the daemon full-access case (it does not prove RT-01; the MCP in-process case does); restrictive fallback also asserts policy.mode supervised + stage 02 reason; a WS-level Clear case (taint → clearTaint → policy event untainted → always rule applies, no card); passkey-removal 4401 case (from 16); workerEnv must not override HOME/PI_* isolation keys; a test for the agentFiles `..` refusal; markOf doc (one subscription per client)
Task 25a: complete (commits a4f3b17..ef7ad1a, Opus-reviewed, clean)
M5 Task 25b: dispatched implementer (sonnet), BASE ef7ad1a; carries from 16 and 25a in dispatch; Opus review
M5 Task 25b: implementer DONE_WITH_CONCERNS (fe5660a) — Origin/traversal/every-stage-audited/passkey 4401/Clear over WS + 25a fixes; int 385 green; passkey row seeded by SQL; Origin tests share one daemon (order-dependent)
M5 Task 25b: review dispatched (Opus)
M5 Task 25b: Opus review — Needs fixes: I1 (plan-mandated) forged-Origin list misses /auth/passkey/{register,login}/verify; I2 (plan-mandated) the M5R124 scrub assertion is vacuous (token does not match the pattern, never in args); minors (Origin test independence, software-authenticator over HTTP, export positive control, symlink/kernel-order e2e, Clear mark + taint_cleared row, exact sets, rawGet deadline)
Task 25b: fix round 1 dispatched (resumed implementer) — FIX_BASE fe5660a
Task 25b: fix round 1 (56e19ea) verified by controller — test-only (7 files), security suite re-run clean-env CI=1 (29 green); passkey routes in the Origin list, real scrub assertion (mutation fails it), real software-authenticator ceremony over HTTP, symlink/kernel-order e2e, Clear mark + audit row
Task 25b: complete (commits ef7ad1a..56e19ea, Opus-reviewed, 1 fix round)
M5 Task 26: dispatched implementer (sonnet), BASE 56e19ea; carries extracted to task-26-carries.md (42 lines); m5-rulings.md from every Ruling: line; Sonnet review
M5 Task 26: implementer DONE (b3cd87d, 1ad56db) — docs + ADRs 0020–0022 + ADR 0002 + m5-rulings; literal bidi/zero-width in 10 test files escaped; all gates green (unit 5653, int 387, smoke); bundle 197.1, budgets unchanged
M5 Task 26: review dispatched (sonnet)
M5 Task 26: review (Sonnet) approved — 0 C / 0 I; policy.md traced to code (stages, matrix, lever B, taint epoch, guard, audit numbers); m5-rulings complete (M5R1–R134, all 54 Ruling: lines); ADRs 0020–0022 + 0002 accurate; escapes keep code points; follow-up: auth.json rule split, M7 wiring carry, MCP resource tools — doc-only, controller verifies
Task 26: follow-up d7e2374 verified by controller (doc-only: auth.json vs env secret rules, M7 wiring carry, MCP resource tools)
Task 26: complete (commits 56e19ea..d7e2374, review approved + follow-up)
M5: all 33+1 tasks complete (incl. 8c). Next: M4 merge (X1), M5 rebase on main per agreements, gates, Opus final review on the rebased branch, merge (owner overnight approval)
M5 REBASE: dispatched (sonnet implementer) onto main cc594a2 (M4 merged ee8f41f, owner overnight approval); brief rebase-brief.md (agreements 3–16 incl. amended 5, onAdopted → markTainted, ownerId unification, budgets); safety ref feat/m5-policy-prerebase; then Opus final review on the rebased branch
M5 REBASE: DONE — head adb0a4d, 79 commits above main (78 rebased + fix: adapt M5 to M4); gates green (unit 6227, int 401+1 skip, smoke, test:budget pass, budgets 195.3/200); onAdopted → markTainted inside the adoption transaction (fail closed) + daemon.adopted.int.test.ts; oldestUserId → M4 firstUserId (tie-break created_at, id); safety ref feat/m5-policy-prerebase
M5 final review dispatched (Opus, rebased branch cc594a2..adb0a4d, full gate, rebase integrity + carries: stage-01 gap hunt, optional egress rules, isForkBomb budget)
M5 final review (Opus, rebased): not ready — 0 C / 3 I / 10 m; gate green (unit 6227, int 401+1 skip, budgets 195.3, smoke); rebase kept both sides' intent; I1 audit misses signed_in / owner_created (HTTP) / rule_revoked (M5R45); I2 sessions adopted by M4 on the preview before M5 stay untainted (deploy-order effect); I3 `rm -rf /home/ubuntu` (literal home path) passes the preset
Ruling: I2 — the M5 policy migration taints every session existing at upgrade (pap-created ones too; they cannot be told apart and nothing before M5 was fenced) — report to owner; cost: one Clear per old session continued
Ruling: final fix dispatch covers I1–I3 + M1 (git clone -c), M2 (size bound before isForkBomb), M3 (rough scan when unsure, builtin/sg wrappers, /dev/root), M4 (token answers deny/once only + actorId), M6, M7, M9; deferred: M5 (unused token cells), M8 (owner question: taint sessions continued outside pap), M10 (file-size headroom → M6 plan)
M5 final fix dispatched (fresh Sonnet implementer), BASE adb0a4d
M5 final fix: DONE (9be772a..e03c3ca, 9 commits) — I1 audit events, I2 taint-all migration, I3 home literal path, M1/M2/M3/M4/M6/M7/M9; gates green (unit 6323, int 401+1 skip, smoke), bundle 195.3; approved audit rows now actor user/token + actorId (optional toolCallId on the approval request)
M5 final re-review (Opus): READY TO MERGE at e03c3ca — I1–I3, M1–M4, M6, M7, M9 addressed; probes confirm (home path, git clone -c, ${x//'"'/}, builtin, sg -c, /dev/root block; corpus + lever B unchanged); M4 token refusal enforced daemon-side; I2 migration correct; gate green (unit 6323, int 401+1 skip, budgets 195.3, smoke)
Ruling: take the last nits N1 (ADR 0022 / daemon.md actor meaning), N2 (clipped toolCallId on the approval request), N3 (two residuals) before merging — one line + docs — controller verifies
M5 last nits 60ee6e0 verified by controller (clipped toolCallId + 300-char test; ADR 0022 / daemon.md answered-row meaning; two residuals in policy.md)
M5: READY — head 60ee6e0, contains main cc594a2; merging --no-ff (owner overnight approval)
