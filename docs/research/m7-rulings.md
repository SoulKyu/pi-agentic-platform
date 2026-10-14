# M7 implementation rulings

Decisions taken while planning and executing [the M7 plan](../plans/2026-10-13-m7-models-tools.md) (models, tools and MCP, 2026-10-13 to 2026-10-14): the task rulings M7R1-M7R130 and M7R147-M7R153 live in the plan beside the task each binds; this file holds the owner decisions (M7R131-M7R146, the owner's answers of 2026-10-13) and the controller rulings made during execution (MC1-MC53). MC54-MC57, made after the lane join, are in [m7-rulings-after-join.md](m7-rulings-after-join.md) (this file would pass the 400-line cap).

Where an execution ruling below differs from the code, the code is the reference and `docs/agents/*.md` says what it does. Known differences, found when the notes were written (30a):
- MC11 lists the `UNTR` index extension as allowed; the code asks on it (`packages/pi-host/src/policy/git-index.ts:35`).
- MC4 (b) names four git-lfs entries; `LFS_ENTRIES` holds `clean`, `smudge` and `process`, and `filter.lfs.required` is never a program key.
- M7R147-M7R149 (the plan's first reading of the git check) are superseded by MC4, MC7-MC11 and MC13: the repository read is the one git would discover, not every folder up to `/`, and a boolean `core.fsmonitor` and the standard git-lfs entries do not ask.
- MC2 is superseded at the rebase on M8: a project write without `confirmProtected` is `protected_path` (`apps/daemon/src/modules/mcp/service.ts:92`).
- MC28 says every settings write goes through `SettingsManager.set*`; the code mode keys have no setter and use `writePiFile` through the same queue (ADR 0029).
- The notes for the trust dialog, skills and plugins (Tasks 23 to 26) and the web side of MC49 to MC52 were written by 30b: `docs/agents/web.md`, `skills.md`, ADR 0027.
- MC52 says helper read ops run offline: on the joined branch `skills.list`, `skills.setInvocation`, `plugins.list`, `trust.status` and `mcp.test` do (`helper/ops/offline.ts`). `models.overview` loads no package and only reports the variable.
- MC55 made `plugins.list` and `skills.list` `pi:admin`, where the plan said `pi:read`.
- The plan's pricing-fetch note: the 307 pins are on model Test and discover; the pricing fetch uses `redirect: "error"` (`models-pricing.ts:100`).

## Owner decisions (2026-10-13)

The owner answered the M7 + M8 question page (the owner's decision page of 2026-10-13). Every answer is the recommendation, and two answers carry a note the controller ruled on. Each answer is a ruling here, cited by the tasks it binds. Decision 76 in `docs/research/decisions-log.md` records them for both milestones. The plan-fix rulings that implement them are M7R147–M7R153.

- M7R131 (c1) [merge notes, 30] Merge order: M8 first, then M7 rebases once (agreement 1). The exception: M7 passes its Opus final review more than one working day before M8. Why: M8 opens the M8 → M9 → M11 path and adds no migration. Cost if wrong: the mirror rebase steps of the merge notes.
- M7R132 (c2) [27] No tiptap in this wave. `@path` stays text (M8), and `$skill` is sent as Pi's own `/skill:name`, with a chip beside the plain field. Revisit at M11. Cost if wrong: chips are a row, not inline tokens.
- M7R133 (c3) [8, 11, 12a, 12b, 17–22, 24–26] Changes that run code later:
  - **Pi's own config** under `<agentDir>` (`auth`, `models`, `mcp`, `trust` and `settings` JSON) is read and written only by M7's helper, and edited only in Settings, with keys masked.
  - **The password step-up** applies to the changes on the Q3 (a) list: sign-in, an API key, a `models.json` save, discover, a global MCP add or undo, an MCP Test, a global skill or plugin install or update, trusting a project. Switches, defaults and removals never ask.
  - **A project's protected files** (its `.pi/` folder, a project skill file) take the "Save anyway?" confirmation instead. The method requires `confirmProtected: true` for a project target; a request without it is refused `bad_request`. The UI asks first, with M8's protected-save copy.
  - **Tokens never confirm.** `pi:admin` is never a token permission, so every such method answers a token `forbidden` (agreements 5 and 6; pinned by Task 6a's token test).
  
  Cost if wrong: one click per project save; one password entry per 5 minutes in the listed flows.
- M7R134 (m1) [1c] Read-only commands run unasked in supervised and auto-accept-edits; read-only mode keeps blocking the shell (M7R11).
- M7R135 (m2) [1c] In a tainted session, read-only commands still run: no listed command reaches the network. Egress keeps asking Deny / Allow once (M7R12).
- M7R136 (m3) [1a, 1b, 1c] `git status`, `diff`, `log` and every other git read command of the table run unasked only when the repository's own config runs nothing. pap reads `.git/config`, `config.worktree` and their `include` / `includeIf` targets. The command asks on any of these:
  - `core.fsmonitor`, `diff.external`, `diff.*.command`, `*.textconv`, `filter.*.{clean,smudge,process}`, `core.pager`, `core.editor`, `core.sshCommand`, `gpg.program` or `credential.helper`;
  - an unreadable file;
  - an include that cannot be resolved.
  
  Full code and an Opus review in Task 1a (details in M7R147–M7R150). This replaces M7-RT-04's "accept the residual". Cost if wrong: the friction named in M7R148 and M7R149.
- M7R137 (m4) Provider usage quotas go to M10 (FinOps); P07-12 stays deferred.
- M7R138 (m5) [12b, 14] models.dev pricing stays, as an **opt-in** (owner note):
  - A Settings › Models switch, "Look up prices on models.dev", off by default. It is stored as the owner's `models` account setting (`modelsDevPricing: false`).
  - Off: no lookup control is rendered, and `models.pricing` answers `forbidden` without any request.
  - On: a lookup on click only, and the copy names models.dev.
  
  Cost if wrong: none.
- M7R139 (m6) [4, 19, 20] MCP OAuth sign-in runs through Pi's `/mcp` in a session. Settings shows the file state and the last Test (M7R96).
- M7R140 (m7) [24, 25, 26] skills.sh installs stay, through a pinned `npx skills@<version>`, with the exact command shown. The owner's note asked "skills must be bound to users / project?", and the ruling is:
  - Every install chooses a scope. "This project" means the project's Pi packages and skills: it needs a trusted project and the protected-file confirmation of M7R133. "All my projects" means the owner's Pi folder (global), with the password step-up of M7R133.
  - The scope picker defaults to the project of the session the owner came from, when it has one; otherwise "All my projects".
  - The same scope rule applies to plugins (Task 25).
  - pap v1 has one owner (decision 10), so skills live in the owner's Pi folder or in a project. Per-user skills come with teams after v1 (spec A §7): deferred.
- M7R141 (m8) [27] One `$skill` per message (M7R119).
- M7R142 (m9) [8, 13] Settings › Models lists built-in and `models.json` providers. A provider an extension registers shows in the session's model menu and signs in with the `pi` CLI (M7R46).
- M7R143 (m10) P08-3 (Chat only's exact system prompt) and P08-5 (the PowerShell switch) are dropped.
- M7R144 (m11) [4] codemode runs with `models: false` (M7R29).
- M7R145 (m12) [29] The first-run Pi step asks for the password again before a sign-in (M7R127). The auth module is unchanged.
- M7R146 (m13) [12a, 17, 30] The `models.json` and `mcp.json` editors follow a dotfiles symlink anywhere inside `$HOME` (M7-RT-06). This is a stated decision, written in `docs/agents/models.md` and `mcp.md`. Cost if wrong: none: only a same-user process can plant the link, and that process can already write the target.


## Controller rulings (pre-dispatch, 2026-10-13)
- MC1 [27, merge] The composer mount budget counts `<ModelBar/>`, the `useComposerCommands` call and the menu. The textarea ref and the three `TextField` field props are the shared plumbing of agreement 7: whichever branch merges first lands them, and at M7's rebase on M8 M7 drops its copy and uses M8's. — why: agreement 7 already allocates the primitive change — cost if wrong: one rebase hunk.
- MC2 [project-scope saves, rebase] A project-scope Pi save without the confirmation flag answers `bad_request` during M7's execution, so M7 does not depend on M8's codes. At the rebase on M8, switch to M8's `protected_path`; this is a rebase-brief item. The web always confirms before sending, so only API misuse ever sees the code. — cost if wrong: one error-code change at the rebase.
- MC3 [12b] A token with `settings:operate` may flip the models.dev switch. It only shows a lookup control in the browser, and no code or request runs from the switch itself. — cost if wrong: a token can enable a UI button.
- MC4 [1a] Usability relaxations of the owner's git rule:
  - (a) `core.fsmonitor` set to a boolean (`true`/`false`/`yes`/`no`/`on`/`off`/`1`/`0`) is allowed, because it uses git's own daemon; any other value asks.
  - (b) The exact standard git-lfs entries are allowed: `filter.lfs.clean = git-lfs clean -- %f`, `filter.lfs.smudge = git-lfs smudge -- %f`, `filter.lfs.process = git-lfs filter-process`, `filter.lfs.required = true`. Any other filter value asks. PATH entries inside the session folder are already refused by 1b.
  - (c) Read only the configs of the repository git would discover: the nearest `.git` dir or gitfile, then its `gitdir:` / `commondir`, `config` and `config.worktree`, and their includes. Never read every ancestor: an outer repository does not make inner ones ask. Unresolvable discovery asks.
  - (d) Submodules may keep asking (a residual, written in `policy.md`).
  - Why: the owner weighs usability as much as security (decision 71, memory), and these values run nothing planted. Cost if wrong: one more prompt class, which fails safe.
- MC5 [25] Plugins follow the same project / global scope rule as skills. — why: same Pi packages mechanism — cost if wrong: none.
- MC6 [12a] The `scanJsonc` masking is not spelled out in the plan: the Task 12a implementer writes it test-first against the plan's masking table, with real mutation checks, and an Opus reviewer. — why: the planfix could not run it — cost if wrong: a fix round.
- MC7 [1a] (C1): the guard accepts only a strict SUBSET of what git accepts, so that any doubt asks.
  - Per level, git's order applies: `dir/.git`, then `dir` itself as a bare repo.
  - A `.git` (dir or gitfile → gitdir) is accepted only when all of these hold:
    - HEAD is a regular file (lstat) of at most 255 bytes, matching exactly `^ref: refs/[^\0\s]+\n?$` or `^[0-9a-f]{40}\n?$`; a symlink HEAD whose target starts with `refs/` and exists is also accepted;
    - `objects/` and `refs/` are directories passing access(X_OK);
    - a gitfile holds exactly `gitdir: <path>\n?`, and its target and its `commondir` pass the same check.
  - A `.git` entry, or a bare-looking folder (any of HEAD, objects, refs present), that is not fully accepted gives `GIT_UNREADABLE` and the command asks. The walk continues upward only when no `.git` entry and none of HEAD/objects/refs exist at that level.
  - Tests: one per reviewer probe, in both directions, plus the reviewer's 9 cases.
  - Why: a stricter-than-git acceptance can only add questions, never skip a repository git uses. Cost if wrong: extra asks on unusual repos.
- MC8 [1a] (I1): ask when the repository-local config sets `core.hooksPath`, or when a `post-index-change` file exists in `<gitdir>/hooks/` or `<commondir>/hooks/`. Other hooks, like `pre-commit`, do not run on status/diff/log and do not make it ask. A global `core.hooksPath` is the owner's own config and stays trusted. Why: a precise list avoids asking in every repo using pre-commit. Cost if wrong: one hook class missed, needing a new probe.
- MC9 [1a] (I2): parse the index read-only and ask on any 160000 gitlink entry, which is consistent with MC4(d) "submodules ask".
  - Supported index versions are 2, 3 and 4, including v4 prefix compression.
  - Cap 64 MiB or 1 000 000 entries, otherwise ask. A split index (`link` extension, `sharedindex.*`), an unknown version, a bad signature or a truncation asks. A missing index is fine.
  - Full code, with tests built from real `git update-index --cacheinfo 160000,…` fixtures for v2, v3 and v4.
  - Why: same threat model as a planted config. Cost if wrong: a parser bug, which fails closed.
- MC10 [1a]:
  - N1: walk entries exactly as git does.
    - v2/v3: the name length comes from flags & 0x0FFF; when it is 0x0FFF, scan to the NUL. The entry ends padded to 8 bytes from its start, with the extended-flags word when flag 0x4000 is set (v3+). Ask when the NUL is not where the length says.
    - v4: strip length varint, then a NUL-terminated suffix. Ask when strip > previous name length, or when the varint is over-long or overflows.
  - N2: ask when any read config sets `extensions.objectFormat` to anything but `sha1`, or a `.git/objects` layout says sha256. Never rely on the index checksum: accept an all-zero trailer (skipHash, N4), and ask only on structural errors.
  - N3: decode every path read from gitdir, commondir, include.path and the index with a fatal UTF-8 decoder. Invalid bytes ask.
  - Apply N5–N7.
  - Why: MC7 means stricter-than-git, never different-from-git. Cost if wrong: more asks in exotic repositories.
- MC11 [1a]: stop chasing divergences one at a time.
  - (a) Index extensions are an allowlist of the ones that never change which entries git loads: `TREE`, `REUC`, `UNTR`, `FSMN`. Any other signature asks: `EOIE`, `IEOT`, `link`, `sdir`, unknown ones. The extension headers are walked exactly as git does (4-byte signature, 4-byte big-endian size, bounds-checked, ending exactly at the trailer).
  - (b) A deterministic differential test against real git. A seeded PRNG builds and mutates at least 300 v2, v3 and v4 indexes, from valid fixtures plus byte and field mutations, with and without gitlinks. For each, when the guard answers "clean", `git ls-files -s` on the same `.git` must succeed and list no 160000 entry. Bounded runtime, fixed seed, temp dirs.
  - (c) The Opus implementer audits git's read-cache.c paths (do_read_index, the EOIE/IEOT loaders, create_from_disk) once more and lists every remaining divergence in the report, each either closed or proven unable to hide an entry.
  - Why: three rounds each found a new parser divergence. An allowlist plus a differential oracle bound the problem. Cost if wrong: asks in repos with index.threads set, which is rare.
- MC13 [1a guard, applied in Task 1b's fix round] (from M8 Task 4's real-git probes): the guard's command keys also ask on:
  - `extensions.partialClone`, any `remote.*.promisor`, `remote.*.uploadpack`, `remote.*.receivepack`: a partial clone's lazy fetch runs a transport program on diff/cat-file;
  - `protocol.*.allow`, `core.gitProxy`, `core.alternateRefsCommand`, `uploadpack.packObjectsHook`;
  - `log.showSignature` (gpg.program already asks).
  - A bare-repository layout of ordinary files in a no-.git folder is already covered: MC7 asks unless it is a valid repo, and a valid one has its config read.
  - Why: the agent-run git has none of the daemon runner's -c flags or env pins. Cost if wrong: asks in partial clones, which are rare.
- MC14 [1b]:
  - date's `-f` / `--file` ask, whether glued or separate.
  - Add an invariant test: every rule whose operands are null declares no option that reads a file, or the engine judges its separate-word value.
  - Fix the cluster parse so that a value-taking letter ends the cluster. `date -Iseconds` and `sort -T/opt/tmp` stay covered, with tests.
  - Add the PATH-cap crossing test.
  - Apply MC13's guard keys.
  - Each change gets a real mutation check.
  - Why: a separate-word option value read nowhere is a leak class, not a one-off. Cost if wrong: n/a.
- MC15 [1b]:
  - (a) `valued` only for tools verified to parse options with getopt (GNU date, sort, file). tree is removed, so a tree cluster containing any refused letter asks again.
  - (b) An invariant test lists the allowed getopt tools explicitly.
  - (c) file's `-f` / `--files-from` and `-m` / `--magic-file` ask in every form.
  - (d) The table header rule "options that read a list of files are refused" gets an invariant test over all rules: every option known to take a file list or a program/magic file must be listed refused.
  - Hostile rows for all four tree forms and both file forms, with real mutation checks.
  - Why: the cluster grammar is per tool, not global. Cost if wrong: n/a.
- MC16 [1c] RIPGREP_CONFIG_PATH in the session env facts (or assignments) makes rg uncovered, like ShellFacts.gitEnv — why: an rg config can carry --pre — cost if wrong: rg asks when the owner set that variable.
- MC17 [1c] (STRICTER than owner m2; report it to the owner):
  - (1) In a TAINTED session, git segments are never covered and ask. Other covered commands keep m2.
  - (2) In any session, a git segment is covered only when the guard finds an EXISTING valid repository with a clean config at evaluation time. "No repository found" asks.
  - (3) The remaining untainted-session race (a concurrent plain-file write to an existing bare-layout repo's config) is documented in policy.md next to the parallel-execution note.
  - Why: a reproduced unasked program run through a check-then-use race; taint is M5's marker for injected content. Cost: `git status` asks after the session read external content, until Clear.
- MC18 [1c]: pi-host pins `safe.bareRepository=explicit` for every git the agent runs. At worker boot, before any tool runs, it APPENDS it to the process env through `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`, keeping any existing entries and their count.
  - It is done in pi-host, not in the daemon's `supervisor/env.ts`, which M8 owns (agreement 14).
  - git 2.53 honours it from the environment (reviewer checked). A planted bare layout is then never discovered, and a real `.git/` write is protected and asks.
  - Fix the overstated comment (`command-cover-git.ts:70-71`), policy.md and the commit wording.
  - Tests: the reviewer's inside-a-repo variant at engine level, plus a real-worker int test with the bed inside a repository (writes plus `git -C empty status` in one message → the plant never runs), with a positive control. Real mutation check: drop the env pin and the int test fails.
  - Why: a general neutraliser beats chasing discovery races. Cost: the agent's git ignores bare repositories unless given `--git-dir`, which is rare.
- MC19 [3] (amends M7R27(c) for the taint decision only; the Q13 notice is unchanged):
  - (a) a new migration adds `sessions.pap_wrote_at`, written at worker exit and on fork/clone. The test becomes `!isLive && at > max(workerEndedAt, papWroteAt)`, with no startedAt term. Agreement 2 is amended: M7 adds a third migration; M8 has none, so nothing is re-stamped.
  - (b) taint first in `touched`. When tool results were found, `touched` runs before the position is saved, and a throw keeps the position so the next pass retries within 60 s. A bounded set (cap, refuse-when-full means taint-now) remembers failed sessions. Replace the test pinning the fail-open behaviour.
  - (c) before starting a pap worker on a session, scan that session file's unread bytes first and taint as needed.
  - Tests RED first and real mutation checks for (a), (b) and (c).
  - Why: each case lets outside tool results reach the agent untainted. Cost if wrong: a migration and one scan per worker start.
- MC20 [15] Task 15's migration is stamped 202610131030_tool_preset (after Task 3's 202610131020) — cost if wrong: a dev DB refusing a migration.
- MC21 [3]: the pre-start check uses the reviewer's mtime gate:
  - skip when the file mtime ≤ max(updated_at, pap_wrote_at);
  - else, when the row has no stamp, taint;
  - else read from pap_wrote_size as today.
  - Tests:
    - (1) an unstamped row with an outside append before start → tainted;
    - (2) an unstamped row unchanged since pap last saw it → NOT tainted (no friction for pre-M7 sessions);
    - (3) Clear while closed, then reopen with no new append → stays cleared, no second audit row;
    - (4) Clear, then an outside append, then reopen → tainted.
  - Real mutation checks. Update the test that pins "unstamped → skip".
  - Why: closes the gap without tainting every pre-M7 session. Cost if wrong: mtime granularity, so equal mtimes skip; say so in docs.
- MC22 [4]: apply the reviewer's fixes.
  - I1: every codemode result is treated as external (fenced) while the session is tainted. The leftover case is written in policy.md: a stored value outlives a Clear and returns unfenced after it. Int test and mutation check.
  - I2: pap's notice becomes the "paste the redirect" instruction, never repeating the URL. The mapping moves into builtins.ts with a unit test of both branches. Correct policy.md and amend M7R31.
  - I3: int test in both directions (untrusted → the server never starts; trusted → it starts), with the mutation check that `projectTrusted: true` in open-session.ts makes it fail.
  - Apply the minors local to Task 4.
- M7R31 amended (MC22, 2026-10-13): Pi itself shows the MCP sign-in URL in rpc mode; pap's notifier only adds the paste-the-redirect instruction (and a 'not a web address' warning for other schemes), never repeating the URL.
- MC23 [6b]:
  - I1: resolve the roots once in `locate` and check against that list. Read and write tests with roots [agent, home] that swap `agent`.
  - I2: on ENOENT, lstat the missing folder; a symlink throws `PiFileRefused("link-dangling")`. One read test and one write test.
  - I3: a hard-linked file is READ normally. A WRITE to a file with nlink > 1 is refused with a distinct reason `hard-link`, because temp+rename would silently split the link and the other name would keep the old content. This adds a reason value to the interface; later tasks map it to a fixed message.
  - Apply the minors local to 6b.
- MC24 [8]:
  - I1: overview and defaults (incl. setDefault) never resolve a `!cmd` key or header. Tests for every field: models.json apiKey and headers, auth.json stored keys.
    - Refresh is an explicit `pi:admin` owner action. It may resolve the owner's OWN `!cmd` keys (global config, trusted projects), as Pi does when calling a provider, but NEVER keys from an untrusted project's config.
    - Add a real-runtime refresh marker test in both cases, with the network guard on. If the untrusted case runs the marker, skip providers whose key or header comes from untrusted project config before `refresh`.
    - Document the behaviour in the models section of docs.
  - I2: fail only when ALL asked providers failed. Otherwise answer with a partial flag naming the failed providers (no secret). Two-provider test.
  - I3: import the pool's drain constant (or make it an option). State in the fix commit that the defect was in the test op.
  - Why: `!cmd` is code execution. The owner's own config is trusted; a repo's is not. Cost: none for the owner.
- MC25 [8] The models overview never calls Pi's checkAuth (no fallback): configured-state comes only from pap's own bounded reading (leading BOM stripped like Pi); unreadable/unparseable → 'unknown' — why: a BOM made the fallback run an auth.json command.
- MC26 [8, 13] Env-variable sign-in is shown from a pap-side table of known env var names per built-in provider (presence only, never executed or echoed) — carried to Task 13.
- MC27 [8, 12a] models.json is parsed with one parseJsonc mirroring Pi's model-config tolerance exactly (// line comments outside strings, trailing commas, BOM; block comments rejected like Pi); Task 12a's scanJsonc reuses it.
- MC28 [10]: the models service serialises every Pi settings write (one chain per agent dir in the daemon; a write waits for the previous one; bounded queue that refuses when full with `capacity`), with a two-overlapping-calls test; `guardFile` re-runs immediately before `commit`; the SettingsManager-write deviation is stated in docs/ADR (Task 30 picks it up if not now).
- MC29 [15, 18, 22, 24, 25] Every Pi settings writer shares the models service's write queue (lift it to a shared daemon helper at the first task that needs it).
- MC30 [rebase] Methods carrying secrets get a contracts flag so the ws dispatcher's idempotency receipt never hashes their params — implemented at M7's rebase on M8 (kernel/ws is M8's).
- MC31 [11, 13, rebase]:
  - I1: apply the reviewer's fix. CredentialSynchronizationError counts as success (log the provider only), and any ok helper result is audited, even after a cancel. Tests from the probe; change login-flows.test.ts:276.
  - I2: add an owner-scoped `models.cancelLogin({ provider })` that cancels the caller's own live flow for that provider (pi:admin, idempotent:false, no step-up, as a removal). CARRY to Task 13: keep the flow id in sessionStorage so a reload re-subscribes or cancels. REBASE-BRIEF item: a hub "last subscriber left" hook (kernel/ws is M8's) to restore the 60 s rule after a disconnect.
- MC32 [12a, 14]:
  - I1: a placeholder is restored only at the exact JSON key path where it was masked. A moved, duplicated or unknown placeholder refuses the save with a `config_invalid` issue `masked_value_moved` (line and column, never a value). Test from the probe; mutant.
  - I2: revision = HMAC-SHA256(a per-boot random 32-byte key, file bytes). After a restart the answer is `conflict` and the editor reloads. Test: the revision is not sha256(file) and is stable within one boot.
  - I3: fail closed. When `parseJsonc` fails, `models.config.get` answers `{ text: null, revision, issues }`; issues carry line, column and message only, never a value. Task 14's editor shows the issues and offers to replace the whole content; a replacement contains no placeholders. Docs: fix a broken file in a terminal or with a full replacement.
  - I4: credential words match as a case-insensitive substring of the normalised identifier (letters only, lowercased): key, token, secret, password, passwd, auth, bearer, credential, cookie. The same rule applies to real keys (`secretValue`) and to comments; in a comment, redact from the first match to the end of the line. Over-masking is accepted (fail-safe). Correct `daemon.md` and ADR 0026.
  - I5: a write-queue test for `configSave` that fails when `serialised` is removed.
  - Minors:
    - m1: a race-guard test.
    - m2: a helper-side log when the folder sync fails on `auth.json`.
    - m3: the validation copy goes to a 0700 folder under PAP_HOME (path passed by the daemon), leftovers swept at daemon boot, a failed removal logged.
    - m4: cap at `MODELS_CONFIG_TEXT_MAX` inside the unmask loop.
    - m5: `restoreAllMocks`.
    - m6: mask once.
    - m7: a `!cmd` marker test for `piRejects` and resync.
    - m8: document the residual window for outside writers.
    - m9: mask URL userinfo in `baseUrl`, trim key names before matching; a `!cmd` that embeds a literal is a named residual (it is shown so the owner sees what runs).
  — why: I1 shows a secret in plain text to `pi:read` tokens; I2 and I3 leak to tokens; I4 makes the docs claim false. — cost if wrong: about 1 h of rework.
- MC33 [12a, 13, 14] Concern 4 of the re-review: `models.config.get` requires `pi:admin` instead of `pi:read`, so it is browser sessions only and never a token. This amends the plan. Masking is best-effort, so the masked text, which still shows probed residuals such as `?key=` in a URL and `!echo sk-…`, never goes to a token. Owner sessions hold every permission, so the UI is unaffected; Tasks 13 and 14 keep their gating as is.
  - Fix round 2 also covers:
    - N1: redact from the credential word itself, inside the identifier, as MC32 says.
    - N2: take the parse position only from V8's trailing "at position N" form, never from anywhere in the message, and never quote file text in `issues`.
    - N3: compute save issue positions on the client's masked text.
    - N4: run the claimed "new command typed" case, or drop the claim.
    - N6: fix the stale comments.
  - Parked: N5 (the stderr line is dropped when the run succeeds; diagnostic only).
  — why: a token reaching an imperfectly masked file is a leak with no use case. — cost if wrong: a token client that needs this method gets `forbidden`, a one-line revert.
- MC34 [12b, 14]:
  - I1: a cross-origin 307 test for `models.test` and for discover, using the existing fixture, plus a mutant with `fetch: strictFetch` removed.
  - m4/m10 (FinOps, a token can loop `models.pricing`): M7R67 is read as one cache of the EXTRACTED price map, not one cached answer. The map holds model ids and numeric price fields only, is capped at 1 MiB serialised (over the cap, nothing is cached), and lives 1 h. `models.pricing` answers from it, so models.dev is downloaded at most once an hour whatever the caller does.
  - Minors applied:
    - m1: classify from the HTTP status only (anchored), never from a number in free text.
    - m2: assert the guard line positively.
    - m3: a byte budget with `truncated` (the M2R54 pattern).
    - m5: a comment plus a log code on the keyless fallback.
    - m6: docs.
    - m7: add the audit reason `provider_discovered {provider}`.
    - m8: exact bounds.
    - m9: in docs, built-in Anthropic/Google discover is a known no-op (plan-mandated); Task 14 may hide the button for them.
  — why: I1 is an untested security property that depends on Pi; m4 is unbounded egress from a token. — cost if wrong: about 30 min.
- MC35 [14] A small fix round on the Task 14 review minors; the controller verifies it.
  - Applied:
    - An unsaved-edits confirm when closing the editor or switching provider.
    - The pricing entry is bound to the model id that was looked up, and cleared when the id field changes.
    - The selected provider stays put after a restored flow closes.
    - A discover fallback message of its own.
    - Edits typed during an in-flight save are kept (no overwrite by the re-read) or the field is read-only while saving.
    - A test that several placeholders keep their order after a discover insert.
  - Parked: "Use prices" for built-in providers (UX).
  — why: wrong cost data and lost edits are user-visible. — cost if wrong: about 15 min.
- MC36 [15, 16, 30]:
  - I1, option (b). Under the read-only preset, a tool whose category is not `read` never runs unasked, in every approval mode, `full-access` included. That covers `unknown` extension tools, an extension registered under a built-in name (it is classified by source, so it is `unknown`), and MCP writes, which keep their current rule. The read-only approval mode keeps blocking `unknown`. Ask rather than block, per the owner's balance between security and use.
  - ADR 0028's Context and Consequences say this exactly, plus m7 (the MCP `readOnlyHint` is trusted from the owner-configured server).
  - Tests: an extension `read` override and an extension write tool both ASK under `full-access` with the read-only preset; Pi's built-in `read` runs.
  - Minors applied:
    - m1: apply `setActiveToolsByName` first, store the preset after; on a throw nothing changes.
    - m2: `timeout` declared on `sessions.setTools`.
    - m3: honest bundle line in the next commit.
    - m4: rename or drop the `tool_search` test.
    - m5: an exact count.
    - m6: a reload int assertion.
    - m9: a test for a trusted project's `.pi/extensions` and packages under `chat`; if they load, fix it.
  - Parked: m8 (the owner's own last request loses, no escalation).
  — why: the preset's promise must hold in full access too. — cost if wrong: one ask per extension tool call under the read-only preset.
- MC37 [16] A cold session's stored preset is exposed by the daemon, so the UI never shows "—" for a session whose preset is known. The stored preset, from the column of Task 15's migration, goes into the session summary that the session list and the shell already read, and into the snapshot when no worker is running. This is additive in contracts. The chip shows it. Tests: daemon (summary carries the preset; unknown → `chat` per Task 15) and web (a cold session shows its stored preset). Done as a pre-review fix by the Task 16 implementer.
  — why: an always-wrong or empty preset label on every cold session misleads the owner about what a session can do. — cost if wrong: one field.
- MC38 [17, 18, 19, 20] MCP views that carry masked command, args, URL, env or headers require `pi:admin`, so they are served to browser sessions only, never to a token. This applies MC33 to MCP: masking is heuristic. Tests: a `pi:read` token gets `forbidden`, and an owner session reads. A name-and-status-only listing stays `pi:read` only if a later task explicitly needs one (none does today). Pre-review fix by the Task 17 implementer.
  — why: same reasoning as MC33, and Pi's config is the owner's, so other users and tokens have no need for it. — cost if wrong: a one-line revert.
- MC39 [17]:
  - I1: apply the reviewer's short fix.
    - `maskCommandLine` runs on any arg that contains whitespace.
    - `maskUrl` runs on any flag or pair value that parses as a URL (`--dsn=`, `DATABASE_URL=`).
    - Fragments are masked like query strings (`#access_token=…`).
    - One test per form; the residual list in ADR 0025 is corrected so it claims nothing beyond the code.
  - I2: override and replace entries are matched on the RAW server name, never on the displayed one. A name that passes `SERVER_NAME` is never masked. Test with two long names that share digits.
  - Minors: apply the cheap ones listed in the review; park the rest with a note in the report.
  — why: a token in a multi-word arg was shown to the owner's browser in clear, and a wrong server was marked overridden. — cost if wrong: about 30 min.
- MC40 [17, 18–20] The MCP masker uses the SAME credential-word predicate as MC32: one shared function, never a second list. The words (key, token, secret, password, passwd, auth, bearer, credential, cookie) match as case-insensitive substrings of the normalised identifier, so `--key`, `X-Key:` and `ANTHROPIC_KEY=` are masked. Over-masking is accepted. — why: two vocabularies drift, and the MCP one was narrower. — cost if wrong: over-masked labels.
- MC41 [12a, 17] amends MC32 and MC40: the shared credential-word list is the union, never the narrower set. It adds `pwd`, `passphrase`, `session` and `signature` to the nine words; the exact query names `code` and `sig` stay as they are. Over-masking is accepted. — why: round 2 dropped `pwd`, `session` and `signature` from MCP masking (DB_PWD= would show). — cost if wrong: over-masked labels.
- MC42 [17] Round 4, fresh Opus implementer (pre-approved escalation for wave 1).
  - Code fix: inside a command line (`sh -c` and the like), a quoted segment is unquoted and masked word by word with the same rules as top-level args. That covers `--header 'X-Api-Key: sk-…'` and a quoted URL with `u:p@`.
  - `--header=X-Api-Key: abc`: a flag value holding `Name: value` is treated as a header, and its value is masked when the name matches the credential predicate.
  - Fragments are masked in place, without re-encoding: `#/cb?code=abc` keeps its shape, and `code` is masked.
  - Tests: one row per form, with mutants. ADR 0025:14 and :23 claim exactly what the code covers.
  — why: these are the last probed clear-text shapes; masking stays best-effort behind `pi:admin` (MC38). — cost if wrong: about 30 min.
- MC43 [rebase review] Fix round 1 for the rebase review (rebase-review.md):
  - Fix:
    - C1: send pap's session id in the worker's init record. The attachment check uses that id, never Pi's. The int test asserts pap's id: an own attachment reads unasked; another session's attachment asks.
    - I1: add `--ignore-submodules=dirty` to the numstat diff.
    - I2: an empty filter-driver name is matched and emptied.
    - M1: check the git version once. Below 2.31, `status` and `diff` refuse with a typed error when the repository defines non-lfs drivers. Document the floor in files.md.
    - M2: `gitEnv` drops relative PATH entries.
    - M4 + M5: `sensitiveParams` replays hash the non-secret selector fields. These are `provider`; `flowId` + `promptId`; `baseRevision`; and for `sessions.respondDialog`, which is now flagged, the session and dialog ids.
    - M6: `LFS_ENTRIES` moves to `@pap/contracts`.
    - M8: daemon.md line ref.
  - Accepted residuals, documented in files.md:
    - M3: check-then-run between the scan and git. The writer already runs code as the user.
    - M7: the scan doubles the git processes per tick (`ponytail:` comment: scan once per tick if poll cost shows).
  — why: C1 breaks M8 attachments. I1/I2 run repository programs unasked (MC13 intent). Debian 11 ships git 2.30, so M1 is reachable. M4–M6 are a few lines each. — cost if wrong: about 1 h.
- MC44 [18, 20, 30] Task 18 review fixes:
  - I1, fixed in Task 18 rather than Task 20: the MCP overview operation reads the global `settings.json`. It adds `settings: CodemodeSettings | null` to the overview, with a test on a real `+codemode` or `only` config.
  - M1: each file's save failure marks only that file's rows `ok: false` with a row code. Rows already written stay `ok: true`.
  - M2: `restoreServer` uses `namespace()`.
  - M3: each undo record deletes itself at expiry, through a `Clock` timer that is unref'd where possible.
  - M4: the new size bounds apply only in `addServer`. The read path keeps the old schema.
  - M5: `addServer` bounds `JSON.stringify(entry)` by `ENTRY_TEXT_MAX`, answering `bad_request`.
  - M6: `WRITE_ERRORS` gains `bad_request`.
  - M7: when Automatic empties a plain list or a modifier-only list, the `defaultTools` key is removed. Pi's defaults apply; the key is never written as `[]`.
  - M9: add a cap-crossing row for each bound.
  - M8 carries to Task 30, documented in mcp.md or ADR 0025:
    - index-like names move first;
    - duplicate keys collapse;
    - re-indent with LF;
    - a `timeout` on remove leaves no undo record;
    - the `pi` CLI race;
    - partial group writes.
  - Concern (a), no audit line for `mcp.add` / `undo`, is not a spec requirement. It goes in the owner's final report as an option.
  — why: I1 makes the Task 20 pane lie about a real config. M7 turns "Automatic" into "no tools". The others are a few lines each. — cost if wrong: about 1 h.
- MC45 [19, 20, 30] Task 19 review fixes:
  - I1: the helper reuses the worker's `installSignalCleanup()` and `killDetachedDescendants()`, and `within` returns at once when the signal is already aborted. Tests:
    - a stdio server that ignores SIGTERM is gone after the helper's SIGTERM;
    - `stopAll()` during a Test leaves no server.
  - I2: a rejected `/mcp` handler becomes a fixed notice, giving `failed`, never `connected`. Add a test.
  - M1: fix the comment.
  - M2: a Test result is kept only if the entry was not removed during the Test (generation or existence check, whichever is simpler).
  - M3: kept results store `{ at, state, count, truncated }`, and `McpTestView` gains an additive `state` (Task 20 shows "needs sign-in" from the last Test).
  - M5, M6, M8: add the cap-crossing rows and exact assertions, and the symlinked cwd to untrusted real path test.
  - M7: the pid test's deadline goes to 3 s.
  - M4 is accepted: the `mcp.test` receipt holds a masked message and tool names, masked like every MCP view (MC38), behind `pi:admin`, and purged with receipts. Document it in Task 30.
  - The server's environment is accepted: spec C §2.5 gives the daemon env minus `PAP_*` and platform secrets, and `${VAR}` must resolve as in a session.
  — why: I1 leaks processes past a daemon stop; I2 lies about a failure. — cost if wrong: about 45 min.
- MC46 [20, 30, M11] Task 20 review fixes:
  - I1, built now for the `-builtin:codemode` half:
    - the overview gains an additive field saying that Pi's settings disable the `codemode` built-in, read by the helper from the same `settings.json` read;
    - the pane disables Always on with a visible reason, and a test covers it.
  - The sandbox half is deferred to M11, which brings the sandbox; record it in Task 30's docs.
  - I2: `key={cwd}` on the section, so a folder change resets the selection, the ask, the undo offer and the Test results, with a test.
  - M1: focus management. After Remove, focus goes to Undo. After Undo, focus goes to the restored row, or to the list. When the ask opens, it receives focus.
  - M2: tests for the exposure change, and for a global Undo going through the step-up.
  - M4, M5, M7: test hygiene, exact assertions, and the `key`.
  - M6: Save is disabled while a write is in flight.
  - M8: the typo, and a `forbidden` overview answer that is not about project trust is not shown as "not trusted".
  - Accepted:
    - (c) the inline 60 s Undo row instead of `Toast`, which is fixed at 5 s and cannot be extended;
    - M3: a second Remove replaces the first Undo offer; the server token simply expires. A `ponytail:` comment names the ceiling.
  — why: the brief binds the code mode block. I2 can write to the wrong project's same-named server. — cost if wrong: about 45 min.
- MC47 [22, 23] Task 22 review:
  - Accepted deviations, recorded in ADR 0027:
    - (a) MC38 extends to `trust.status`, which needs `pi:admin`;
    - (b) a breadth refusal is `{ ok: false, refusal }` in the result. Task 23 reads it from `result`, never from `error`.
  - The separate trust write queue is the controller's instruction, not an MC29 deviation: `trust.json` is not Pi's `settings.json`.
  - Fix:
    - I1: a worker that starts while a decision lands is released only after its first run, so the prompt that started it succeeds. Test it on the sessions bed.
    - I2: `trust.status` never looks complete when it is not:
      - the MCP file's problem flag is carried through;
      - a resource folder that links outside the session folder is listed as such, with a flag, never dropped;
      - `truncated` (or an `incomplete` flag) is set whenever anything is cut or skipped;
      - test: 201 servers, plus a linked `.pi/extensions`.
    - Clearing a decision always needs a live step-up: clearing an explicit `false` under a trusted parent widens trust.
    - With HOME unset, the home rule falls back to `os.userInfo().homedir`.
    - Tests: the caps crossed, the 2000-project cap, and a symlink to home refused.
    - ADR 0027: the refusal copy arrives with Task 23.
  - Accepted, documented in ADR 0027:
    - the window between the helper's check and Pi's write, and bind mounts;
    - a decision stops workers holding background processes or dialogs after their run (M7R105);
    - `compose-pi.ts` edits existing lines, so lane A's Task 24 rebase keeps both sides.
  — why: I1 fails a user prompt; I2 hides code that trusting will load; unguarded clearing widens trust. — cost if wrong: about 1 h.
- MC48 [21] Task 21 review fixes:
  - I1: tests pin a partial failure (only the failed servers stay listed, the panel stays open, and the notice says how many were added, M8) and a cancelled step-up stopping the loop, each mutation-checked.
  - M1: the `claude mcp add` reader skips flag values when looking for the name (`-t http`), and reads `-e`/`--env K=V` into env. Other flags are listed in a visible "ignored: …" note. Add tests.
  - M2: a bare line takes `https://` only (M7R101). Pasted JSON keeps any URL the daemon accepts. The label says "http(s)".
  - M3: the raw paste text is cleared once Read succeeds.
  - M4: the scope toggles are disabled while the ask is open.
  - M5: one source for the name rules (`SERVER_NAME`, `RESERVED`), and `uniqueName` applies the `-`/`_` namespace within one paste.
  - M6: preview masking also covers URL userinfo (`//user:pw@`) in args and urls, and the value after `-H`/`--header`. Test them, and a row crossing the 32-pair and 500-char clips.
  - M7: `role="status"` on "Nothing to import" and on the cut note; an accessible name for the candidate list; focus on open and back on close.
  - Accepted: the Windows backslash in `words()` (pap runs on Linux; `ponytail:` comment).
  — why: small, user-facing, and M6/M3 shorten a pasted secret's exposure. — cost if wrong: about 40 min.
- MC49 [23, 26, 30] Task 23 review:
  - **Lint rule.** The eslint boundaries loosening is accepted, narrowed to the features that need it: `sessions` (the one-line banner mount) and `mcp` (`McpSection` → `TrustDialog`). Only these may import the `trust` domain. Record the deviation in ADR 0027 and in web.md (Task 30).
  - **I1, layering.** No feature imports `routes/`. A shell-provided step-up context in `lib/` (`lib/step-up-context.tsx`) supplies the `StepUpRunner`, and the shell provides it and renders the single prompt. `TrustBanner` lazy-imports its own `./TrustDialog.tsx` and reads the runner from that context. This deletes `routes/shell/trust-dialog-entry.tsx`, the routes mock in the banner tests, and trust's own `step-up.ts`. The `mcp` and `models` copies stay: `ponytail:` comment, migrate them to the context when one of them is next touched.
  - **Minors to fix:**
    - M2: one consistent restart copy.
    - M3: Esc, Cancel and the backdrop are inert while a decision is in flight.
    - M5: a timeout on `trust.set` says the outcome is unknown and re-reads the status.
    - M6: tests for Esc closing the dialog, focus returning to the opener, and the stacked prompt; mutation checks for `cwd === ""` and `key={sessionId}`.
    - M7: the comment typo.
  - **Carried:**
    - the skills notice goes to Task 26, opening the same `TrustDialog` through the context;
    - the docs (web.md, ADR 0027 refusal copy) go to Task 30.
  - **Accepted:** M8 (Settings decisions refresh the banner after the restart), and no UI to clear a decision (the brief lists Trust, Keep untrusted and Cancel only).
  — why: feature → routes is an upward dependency the linter cannot see. A context is the existing clean pattern. — cost if wrong: about 45 min.
- MC50 [27] The command menu's chip renders below the field, beside M8's mention listbox (M7R121: the same layout). This is an accepted deviation from the brief's "above": `menu` is one node, and a split would take a second `Composer.tsx` line. The `createElement` + `eslint-disable-next-line react-hooks/refs` in `use-composer-commands.ts` is accepted, because the brief requires `menu: ReactNode` and the rule flags JSX props the same way. Parked minors for the final review:
  - `onKeyDown` relies on the join for `open`;
  - no test crosses the 600 000-byte cap;
  - `truncated` is never shown;
  - the command list is fetched once per session;
  - ARIA points to a missing id before the lazy chunk renders.
  — cost if wrong: one line.
- MC51 [29] Task 29 review, rule A, so fixes for Critical and Important only:
  - C1: once the account exists, the user is signed in, and the websocket must run for steps 2 and 3. Either the root phase leaves `setup`, with the stepper kept mounted, or the socket starts when the stepper passes step 1; choose the simpler. A test must fail on the current code: it uses the real `rpc` offline rule, or asserts that the socket is started before step 3 calls `models.overview`. The fake runtime alone is not enough.
  - I1: when the lazy `FirstRun` chunk fails to load, an inline retry control appears, not only the toast.
  - Minors are parked for the minor sweep.
  — why: C1 breaks step 3 in every real browser. — cost if wrong: about 30 min.
- MC52 [24, 22, 25, 17] Task 24 review I1. A Pi resource load in a helper read op must never install anything.
  - Every helper op that builds Pi's resource loader, or resolves packages, runs offline, so no `npm install` or `git clone` happens: `skills.list`, `skills.setInvocation`, Task 22's `trust.status`, and any MCP or models read op that loads resources.
  - Use Pi's own offline switch (`PI_OFFLINE`, or the loader option), set for these ops only.
  - A missing package is listed as unavailable, or in `unlisted` for trust. The whole list never fails because of it.
  - Only an explicit, owner-initiated install or update op (Task 25, under step-up) may reach the network.
  - Tests:
    - a missing `npm:` package with a fake `npm` on PATH: `npm install` never runs, and the list still answers;
    - the same for `trust.status`.
  - Speed rule A: the 16 Minors are parked for the minor sweep.
  — why: listing skills ran package install scripts without the owner asking. That is code execution from a read. — cost if wrong: about 40 min.
- MC53 [30] Task 30 is split to use the idle lane A:
  - **30a**, now in lane A: the docs, ADRs and rulings archive for everything built so far, and the D07–D09 parity rows.
  - **30b**, after the lane join (Tasks 24–26 in): skills and plugins docs, the D10 parity rows, `budgets.json`, and the full final gate.

  The carries are listed in `task-30-carries.md`. — why: lane A is idle until the join, and docs do not depend on lane B. — cost if wrong: one extra docs commit.
