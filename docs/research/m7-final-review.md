# M7 final review (archived 2026-10-14)

The Opus whole-branch review of M7 (main 481ae48..169e064), copied verbatim. Its single fix round (ruling MC59, commits af1bfe3..0a07788) was re-reviewed: Ready, I1 and M1–M8 addressed. M7 merged as 53f63c4.

# M7 final whole-branch review (main 481ae48 .. 169e064)

Reviewer: Opus, final review (MC58: Task 30b's task review is folded in here). Read-only. The working tree, index and branches were not touched. No package-wide suite was rerun: the gate on 169e064 is the controller's (unit 10347, int 671 + 1 skipped, build, budgets 207.3 KB, smoke).

## How the review was done (passes)

The diff is 54 commits, 641 files and +58.6k lines, so it was read in passes:

1. **Ledger and rulings.** I read the plan's coverage and merge notes, `rulings.md` (M7R131–M7R153, MC1–MC58), `progress.md` and `global-constraints.md`, to find the seams and the parked items.
2. **Helper infrastructure.** `helper/{main,run,ops}.ts`, `kernel/helper/{pool,helper-io}.ts`, `compose-pi.ts`, `daemon.ts` (stop order), `supervisor/env.ts`, `contracts/env-keys.ts`, `install-env.ts` and `offline.ts`. Pi SDK call sites were checked against `node_modules/@earendil-works` (`PI_OFFLINE` is read at call time; `getEnv`; `runCommand` stdio; `ProjectTrustStore` canonicalisation; `SettingsManager` scoped saves).
3. **Security contracts, end to end.**
   - Every M7 method's permission, `idempotent` and `sensitiveParams` (a table built from the contracts).
   - Step-up placement in the models, MCP, trust and skills services.
   - The `confirmProtected` gates in the daemon and again in the helper.
   - The trust breadth rule and `restartFolder`.
   - Plugin and skill sources.
   - The install environment.
   - The read-only preset in stage 02 and stage 03.
   - The filter guard and the 2.31 floor.
   - Attachments in `read-target.ts`, and `papSessionId` reaching every launch path.
   - The receipt selector hash.
   - The `pi-token` test.
4. **Seams.**
   - The shared write queue: every writer of `settings.json`, `mcp.json` and `models.json`.
   - The trust queue.
   - The skills queue.
   - The composer mount and the field-props join.
   - The i18n key union and `skill-source.ts` after the joins.
   - The step-up context beside the per-feature copies.
   - The contracts unions: errors, streams, domains.
5. **Docs against code.**
   - `docs/agents/{models,mcp,skills,policy,daemon,web,sessions,files,auth}.md`.
   - ADRs 0023–0029.
   - The parity tables.
   - `AGENTS.md`, `budgets.json`, and the 30b commit.
6. **Tests and production readiness.**
   - Representative security tests.
   - The `plugins.int.test.ts` flake.
   - Both new migrations, and the migrator's newer-database path.
   - The 400-line rule.

## Strengths

- **Defence in depth that holds across tasks.**
  - Every code-running or credential path is checked twice: the daemon gates it, and the helper repeats the check. This covers `confirmProtected`/`protected_path`, project trust, and the user scope ignoring `cwd`.
  - Every helper result is parsed with a strict contract schema before it leaves the module, so a stray field cannot carry a secret out.
- **Tokens and Pi configuration.** `pi:admin` stays outside `TOKEN_PERMISSIONS`, and `security/pi-token.test.ts` walks the whole catalogue: it fails when a new `pi:admin` method has no sample, and pins at least 34 methods. Tokens still answer only `deny` or `once` (`sessions/service.ts:27,283`), so the new prefix and tool "always" rules are browser-only.
- **Step-up placement matches M7R133 exactly.**
  - With step-up: login, setApiKey, config save, discover, global `mcp.add` and `mcp.undo`, every `mcp.test`, global skill and plugin install or update, trust `true`/`null`.
  - Without step-up: switches, defaults, removals and logout.
  - Each placement has a service test that asserts `step_up_required` and that no helper started.
- **The shared write queue (MC28/MC29) has no in-daemon bypass.** `compose-pi.ts:61` creates one queue and hands it to models, MCP (code mode included) and plugins. Trust keeps its own queue (`trust.json`), and so do the skill files. Every `settings.json` write goes through `guardSettingsWrite` right before Pi's `SettingsManager` writes. Pi persists only the scopes that changed (`settings-manager.js:474-505`), so a user-scope write never rewrites a project file.
- **MC52 is real.**
  - Pi reads `PI_OFFLINE` on every package-manager call (`package-manager.js:38`), so `offline()` around the loader reloads is effective.
  - The `skills.list`, `skills.setInvocation`, `plugins.list`, `trust.status` and `mcp.test` resource loads are all wrapped.
  - `withInstallEnv` and `offline` nest and restore correctly.
- **The child environment comes from one place.** `isDaemonOnlyEnvKey` and `PLATFORM_ENV_KEYS` in contracts serve the supervisor, the helper and the helper's own `npx`, `npm` and `git` children. Install children also get absolute-only `PATH`, `HOME` and the telemetry switches. Pi's `getEnv()` returns the live `process.env`, so the swap does take effect.
- **The filter guard (MC13/MC43) is careful.**
  - Only `GIT_CONFIG_*` names may enter git's environment.
  - The scan is the exact allowlisted `config` call.
  - Below 2.31 the guard refuses to run instead of letting git silently ignore the overrides.
  - `--ignore-submodules=dirty` is on both `status` and `diff`.
- **The read-only preset (MC36) is enforced by the worker itself.**
  - The preset's tools are blocked by name at stage 02.
  - The preset's ask is `[deny, once]`, `grantable: false`, in every mode.
  - The worker ORs in its own preset, so a late rules push cannot loosen it.
- **Process hygiene.**
  - The helper closes the inherited PTY descriptors first (`helper/main.ts:2`).
  - The helper kills its group when the IPC channel closes, and sweeps detached descendants on SIGTERM and SIGHUP (MC45).
  - The pool tracks groups and never queues.
  - The stop order is `Promise.all([pi.stopAll(), sessions.shutdownAll()])`, then the workspace, then `killAllWorkerGroups()` (`daemon.ts:319`), as agreement 9 asks.
- **The ledger is honest.** Residuals are named in the docs rather than hidden: the `!cmd` paths, the masking heuristics, the same-user races, the 330 s queue hold, and N10.

## Issues

### Critical

None found.

### Important

**I1. `budgets.json` lowers the initial-bundle ceiling to 229 KB, against owner decision 75 Q8 (a flat 300 KB until M13).**

- Where: `budgets.json:2`. The docs at `docs/agents/web.md:90` and `:146` still say "flat 300 KB (decision 75)".
- What is wrong:
  - 30b applied the plan's M7R130, `min(ceil(measured × 1.10), 300)`, at `docs/plans/2026-10-13-m7-models-tools.md:3171`.
  - Decision 75 (`docs/research/decisions-log.md:81`) and main's commit 228dcdc set the ceiling flat at 300 KB until M13. The owner's reason: "the 200 KB ceiling cost a bundle hunt in every milestone."
  - A plan ruling cannot override a binding owner decision, and this one was never put to the owner (MC56 covered only `idleWorkerRssMb`). The branch now also contradicts its own `web.md`.
- Why it matters:
  - It brings back the per-milestone ratchet the owner removed.
  - With 21.7 KB of headroom, the M9, M10 and M11 lanes are likely to trip `pnpm budgets` and `build-output.int.test.ts` and start a bundle hunt.
  - The docs no longer describe the gate.
- Fix: restore `"initialBundleGzipKb": 300`. If 229 is wanted, ask the owner and record a decision. Either way, make M7R130, `web.md` and `budgets.json` agree, and correct the 30b report line.

### Minor

**M1. The helper pool still logs the raw output tail of every op on timeout, exit or malformed record.**

- Where: `apps/daemon/src/kernel/helper/pool.ts:172-183`, against the comment at `:24` and the claims at `docs/agents/daemon.md:129` and `docs/adr/0023-pi-config-helper.md:15`.
- What is wrong:
  - MC57 limited the tail to `skills.install`, but only on the `helper_op_failed` branch (`:241-246`).
  - `fail()` still attaches `tail.text()` for every op.
  - Pi runs `npm` and `git` with `stdio: "inherit"` (`package-manager.js:2145`), so `plugins.install` and `plugins.update` write unmasked npm and git output into the helper's pipes.
- Scenario: a plugin install hangs past the 330 s deadline. `fail("timeout")` then logs up to 2 KB of raw npm output, including any registry URL or diagnostic it printed. That is exactly the unmasked-stderr risk MC57 meant to remove. ADR 0023 and `daemon.md` now disagree, and both overstate the code.
- Fix: in `fail()`, use the same `LOGS_TAIL_OPS` gate, or pass the tail through `maskCommandLine` line by line. Add a pool test for the timeout path. Align ADR 0023:15 and `daemon.md:129`.

**M2. `skills.search` is `pi:read`, so a token can make pap send outbound requests without limit.**

- Where: `packages/contracts/src/skills-methods.ts:222-224`.
- What is wrong:
  - A token can send arbitrary query text to skills.sh, with no click, no cache and no opt-in.
  - Each call spawns a helper, so a loop can also hold the four pool slots and answer the owner's Settings with `capacity`.
  - `models.pricing` got an opt-in and a 1 h cache for exactly this (MC34).
  - `skills.md:37` ("only on the search click") and the zero-telemetry rule (C §9.4) claim more than the code does.
- Fix: make it `pi:admin` (only `SkillSearch.tsx` calls it). Otherwise, document it as a residual beside the pricing one.

**M3. Doc drift in the 30a and 30b notes.**

- `auth.md:88` and `daemon.md:125` say `pi-token.test.ts` requires "at least 25" `pi:admin` methods. The test pins 34.
- `daemon.md:125` names `models.md` and `mcp.md` as the only exceptions to `pi:admin`. `skills.search` in `skills.md` is a third.
- `daemon.md:124`:
  - The `compose-pi.ts:86` and `:95` references point to the wrong lines: the rpc spread is at `:95` and the skills module at `:87`.
  - "the four modules that use them [the pool and the one write queue]" is wrong too: trust has its own queue, and the sentence lists three modules.
- Fix: correct the numbers, the references and the wording.

**M4. The `plugins.int.test.ts` flake is a race in the test, not in the product. The ledger says "cause not established".**

- Where: `apps/daemon/src/kernel/helper/plugins.int.test.ts:73`, `:123-132`.
- What is wrong:
  - The fake npm runs `env > npm.env`. The shell creates the file before `env` writes, and `expect.poll(existsSync)` can win that race and read an empty file.
  - On an empty read, lines 129–130 pass vacuously. Line 132 is the first assertion that fails, because `"".split(":")` is `[""]`, which matches the observed failure.
  - `withInstallEnv` holds the environment for the whole `pm.install` call, so the product has no window here.
- Fix: write to `npm.env.tmp`, then `mv` it into place in the fake. Or poll until the file contains `PATH=`. Update the D10 parity note at `models.md`.

**M5. Two frozen test files were edited.**

- `apps/web/src/stores/session-reducer.test.ts` went from 395 to 400 lines. It is frozen by `global-constraints.md`, and is now at the cap.
- `packages/pi-host/src/policy/extension.test.ts` was also edited.
- Fix: move the new reducer cases to their own file, as the constraint asks, so the next milestone has room.

**M6. Project-scope installs run npm and npx with the trusted project's own npm configuration.**

- Where: `skills-install.ts:46-60`, `plugins.ts:69`.
- What is wrong:
  - `skills.install` with scope `project` runs `npx` with `cwd` set to the project, so the project's `.npmrc` (for example `registry=`) applies to fetching the pinned CLI.
  - Plugin installs honour a trusted project's `npmCommand`.
  - Both need a trusted project and "Save anyway?", so this is consistent with M7R140. But it is not in the `skills.md` residuals, and it means a project can redirect where the pinned CLI is fetched from.
- Fix: add a residual line to `skills.md`. Optionally, run the project-scope `npx` with `npm_config_userconfig` set and the project `.npmrc` ignored (`--prefix` in a temp folder), keeping only the install target in the project.

**M7. The trust decision is not bound to what the dialog listed.**

- Where: `send-decision.ts:21`, `ops/trust.ts:240`.
- What is wrong:
  - `trust.status` is read when the dialog opens, and `trust.set` lands after the step-up, possibly minutes later.
  - Anything added to `.pi/` in between (the owner's `git pull`, the `pi` CLI) is trusted without having been shown.
  - Agent writes to `.pi/` are protected and ask, which narrows the window, but ADR 0027 does not name it among its residuals.
- Fix: name it in ADR 0027. Or have `trust.set` carry a digest of the listed resources, recompute it in the helper, and answer `conflict` on a mismatch.

**M8. `mcp.setCodemode` rewrites the whole `settings.json` without Pi's lock folder.**

- Where: `ops/codemode-settings.ts:125`.
- What is wrong: the residual is documented, but `auth-store.ts` already implements Pi's lock protocol (`acquire`, `:47`). Holding `settings.json.lock` around the read, edit and rename would close the lost-update window with the `pi` CLI and with workers at almost no cost.
- Fix: reuse `acquire` for `settings.json.lock` here.

## Declined to judge

- **Whether the `skills` CLI (`npx skills@1.7.2 add --agent pi -g`) also writes `settings.json`.** If it does, it would sit outside the shared Pi queue (skills use `skillFiles`). Settling it needs the CLI's source or a network run.
- **Real-browser behaviour.** This covers Safari 16.4, the first-run socket start and LazyPanel focus. The VPS is headless, and the tests use happy-dom.
- **Completeness of the masking heuristics (MC32–MC42) and of the git index reader (MC7–MC12).** Each had several Opus rounds plus differential and mutation tests. I did not re-derive their residual lists.
- **Redirect handling of the Google and Bedrock provider SDK paths.** It is already a named residual in `models.md`.
- **Visual and design-token compliance of the new Settings sections.** This is a UI review, out of scope here.

## Recommendations

1. Fix I1 before merging (one line, plus aligning `web.md` and M7R130).
2. Fold M1, M3 and M4 into one small follow-up commit: about 10 lines of code plus doc lines. M2 is a one-line contract change, and the owner can decide it with the existing owner options below.
3. Owner options already pending, to put in one page, with M2 and M7 added:
   - one ruling for re-enabling global MCP servers and plugins without step-up;
   - audit rows for `mcp.add`/`undo` and skill/plugin installs;
   - an allowlist environment for `npx`, `npm` and `git` (provider keys are inherited today);
   - MC17 being stricter than owner m2.
4. Rollback note for the merge:
   - M7 adds three migrations (`202610131000`, `1020`, `1030`). A binary without them opens the database read-only (`migrate.ts:99-108`, `database_newer_than_binary`), so a revert means restoring the pre-migration snapshot from `backups/` and losing what was written since.
   - A revert without restoring the snapshot would also silently lose the read-only and chat presets.
   - Put this in the merge notes and the release note.
5. Migrate the two remaining `StepUpRunner` copies (`features/models/step-up.ts` and `features/mcp/step-up.ts`, plus the route-hosted `use-settings-step-up`) to `lib/step-up-context.tsx` when either feature is next touched. Today two password prompts can exist at once: the Settings host and the shell host.
6. Before any `SEARCH_SCHEMA_VERSION` bump, fix the sessions N10 gap, which is already noted in `sessions.md`.

## Assessment

**Ready to merge: With fixes.**

No Critical issue was found. The security contracts hold end to end across tasks:

- permissions and tokens;
- step-up placement and `confirmProtected` at both layers;
- the shared write queue;
- offline reads;
- the child environment;
- the read-only preset;
- the git filter guard and the floor;
- attachments;
- receipt hashing.

The rebase seams are coherent: the stop order, the composer join, the contracts unions, and the i18n and `skill-source` join resolutions.

The one Important item is a governance conflict, not a runtime defect. `budgets.json` contradicts owner decision 75 and the branch's own `web.md`. It is a one-line fix and should be settled before merge. The Minors are doc accuracy, one logging gap that MC57 meant to close, one permission level, and test hygiene. They can land in one follow-up commit.
