# pap — agent notes

Self-hosted agentic platform on the Pi SDK. Specs: `docs/specs/` (C = architecture). Plans: `docs/plans/`.

## Commands

- `pnpm install` · `pnpm lint` · `pnpm format:check` · `pnpm typecheck` · `pnpm knip`
- `pnpm test:unit` · `pnpm test:int` (forks real pi-host workers with a scripted provider) · `pnpm test:e2e` (browser tests of the built app: `docs/agents/e2e.md`, ADR 0071)
- `pnpm build` · `pnpm budgets` (budgets.json, bundle sizes and their enforcers) · `pnpm test:budget` (timed run: search and scanner; RSS and payload are measured by `test:int`) · `pnpm pi-compat` (newest aged Pi release in a scratch worktree, ADR 0072)
- node-pty builds at install: gcc, make, python3.
- Run the built POC: `pnpm build && node --disable-warning=ExperimentalWarning apps/daemon/dist/main.js serve`, then open the setup URL it prints (`/` answers 404 when `apps/web/dist` does not exist, so build first). From another machine of a trusted LAN (testing only, cookie in clear text): add `--host <LAN IP> --insecure-http` (ADR 0004). `pnpm smoke` boots that same build against the scripted provider and drives it end to end.
- Dev: `pnpm --filter @pap/daemon dev` (prints its URL; port and PAP_HOME derived from the worktree path), then `PAP_DEV_DAEMON=http://127.0.0.1:<that port> pnpm --filter @pap/web dev` and open http://localhost:5173 (a `--dev` daemon never dials the real pap-vmd, whose boot stops every VM it lists: agents are unavailable there unless you set `PAP_DEV_VMD=1`, only when no live pap runs on this host)

## Install

- Method 1 `scripts/install.sh` (checkout); method 2 `pnpm build:archive` then `./pap-install-<id>.sh` (offline archive, pinned SHA-256). `pap service install|uninstall|url` (systemd user unit, no instance lock). `pnpm smoke:install` boots the unit's own command line. Guide: `docs/agents/install.md`; ADRs 0055 to 0057; rulings `docs/research/m6-rulings.md`.

## Admin CLI (daemon stopped: `systemctl --user stop pap-preview`)

- `pap audit prune [--month YYYY-MM] [--dry-run]` · `pap user add <username> [--password-stdin]` · `pap passkey reset [--revoke-tokens] [--keep-password] [--password-stdin]`. `pap trace summary [--since 15m|2h|1d]` works while pap runs. Exit 0 / 1 (refusal) / 64 (usage). Details: `docs/agents/daemon.md`, `auth.md`.

## Worker settings

- Env: `PAP_MAX_WORKERS`, `PAP_MIN_FREE_MEM_MB`, `PAP_MIN_FREE_DISK_MB` (1024, `0` = off: forks, task sessions and the lane paths are refused with `disk_low` below it; `0` turns the lanes floor off too), `PAP_WORKER_IDLE_MINUTES` (30, `0` = never release), `PAP_WORKER_SCOPE` (`auto` | `off`), `PAP_WORKER_MEMORY_MAX_MB` (default max(2 GiB, 50 % RAM), at least 1024: a lower value stops the daemon at boot), `PAP_WORKER_TASKS_MAX` (4096), `PAP_MAX_TERMINALS` (running terminals per owner, 8), `PAP_HELPERS_MAX` (4, 1-16: Pi configuration helpers, a fifth is refused). Details: `docs/agents/daemon.md`.
- Test-only env: `PAP_TEST_GIT_PROTOCOLS` (`file`, `https`, `ssh`; needs `PAP_TEST_PROVIDER_SCRIPT`) lets a lane push reach a local bare repository. Never set it outside tests.
- Workers run in a `systemd-run --user --scope` only with a lingering user manager: `loginctl enable-linger <user>` once, `XDG_RUNTIME_DIR` set. Otherwise scopes are off with a boot warning. Tests run with `PAP_WORKER_SCOPE=off`; the scope tests need the manager (CI starts one): under `CI=1` they fail without it, locally they skip with a warning.

## Observability and automation settings

- `PAP_METRICS_TOKEN` (32-256 chars): `GET /metrics` with its own bearer, off (404) when unset. `PAP_OTLP_ENDPOINT` (`https://`, or `http://` to loopback only; opt-in, no exporter exists when unset) with `PAP_OTLP_HEADERS` (`name=value,...`, at most 8, never logged) and `PAP_OTLP_SERVICE_NAME` (default `pap`). Details: `docs/agents/daemon.md`, `finops.md`.
- Children pap starts without you (M10's precheck is gone since lot B1) get `unattendedEnv`'s environment (`packages/contracts/src/child-env.ts`, re-exported by `kernel/child-env.ts`; M9 writes it, M10 adds the precheck): an allowlist, never the SSH agent, `GIT_*`, `LD_*`, provider keys or credential-looking names. ADR 0046.

## Backup, update, doctor, release (M6b)

- `pap backup [--encrypt [--secrets include]]` · `pap restore <file> [--replace]` (daemon stopped) · `pap doctor [--only id]` (read-only) · `pap update check|install|apply|rollback|recover` (archive installs only; never from pap's own terminal). `--unit`/`PAP_UNIT` name the unit. Guides: `docs/agents/backup.md`, `update.md`, `doctor.md`; image, npm, releases and `get-pap.sh`: `install.md`.
- A plain backup excludes `secrets/` and is still sensitive; an archive is untrusted input (`listMembers` first, ADR 0063). An update rolls back by itself and restores the snapshot only if a migration ran (ADR 0064). Tests never contact GitHub (their daemons run with `PAP_UPDATE_CHECK=0`); a running pap checks the release feed once a day (`PAP_UPDATE_CHECK=0` turns it off). `release.yml` runs on a push to main and on `workflow_dispatch` since the v1 flip (`scripts/release-flip.ts`, ADR 0066 and 0076).
- ADRs 0063 to 0067; rulings `docs/research/m6b-rulings.md`. `pnpm release:assets`, `pnpm release:check`, `pnpm build:npm`, `pnpm build:image` are local commands.

## Agents and the sandbox (M11)

- Agents, platform ops, the vault, the sandbox, the egress proxy, subagents and their known limits: `docs/agents/agents.md`; knowledge (OKF bundles of projects and agents): `docs/agents/knowledge.md`; ADRs 0047 to 0053, 0082; rulings `docs/research/m11-rulings.md`.
- Agents run only in microVMs (ADR 0081): no host sandbox, no host bubblewrap override, no root-owned `python3` for agents. A machine without KVM or without `sudo pap vm setup` has no agents (`sandbox_unavailable`, an EmptyState); the rest of pap works. Int tests use the process backend (`PAP_TEST_AGENT_RUNTIME=process`); the pi-host VM shell test (`ops.bwrap.int.test.ts`) needs a working root-owned `/usr/bin/bwrap`, skips locally with one warning and throws under `CI=1`.
- An agent's shell has no network but the egress proxy (a VM with `sandbox.network` on: the `host[:port]` and IP entries of its list): it guarantees hosts, not content. Docs and copy never claim more. Tests never name a public host or address.
- The vault key sits beside the vault in `$PAP_HOME/secrets/vault`: a backup of the whole `$PAP_HOME` holds it. The vault's values, one-use values and `secret.request` work in the VM (ADR 0081): values reach the VM shell's environment. Through pap's own paths a value never reaches a log, an audit row, a response or a receipt; the exceptions are in ADR 0049 (a command the agent runs can print it, the redactor misses values under 8 characters and encoded ones, same-user processes read `/proc/<pid>/environ`, a whole-`$PAP_HOME` backup holds the key).
- A new platform op declares its callers, `whenTainted` and deadline in `PLATFORM_OPS`; the session type is read from the daemon's row, never from the worker.
- The daemon logs a host an agent chose as `h:<12 hex> (len N)`, unless the owner wrote it.

## Notifications and PWA (M12)

- Web Push and the PWA: classes, delivery, payload, key file, HTTPS routes, service worker, troubleshooting in `docs/agents/notifications.md`; ADRs 0058 to 0062; rulings `docs/research/m12-rulings.md`. Env: `PAP_PUSH_SUBJECT` (VAPID `sub`, https or mailto), `PAP_PUSH_EXTRA_HOSTS` (at most 8 extra push hosts), `PAP_TEST_PUSH_LOOPBACK=1` (tests only, needs `PAP_TEST_PROVIDER_SCRIPT`; never set it elsewhere).

## v1 hardening (M13)

- Parity with pi-web: `docs/agents/parity.md` (one row per behaviour, a proof file each; `scripts/parity-doc.test.ts`). Release and the v1 flip: `docs/agents/release.md`. Exit evidence: `docs/research/m13-exit-criteria.md`; rulings `docs/research/m13-rulings.md`; ADRs 0071 to 0077.
- pap does not replace pi-web (ADR 0075): both share `~/.pi/agent`. Never resume one session in both apps; pap warns when a live session's file changes outside it (ADR 0074) and never reads pi-web's files.
- Licence: AGPL-3.0-or-later (ADR 0077); the two derived vercel/ai-elements files (`Message.tsx`, `Reasoning.tsx`) stay Apache-2.0 (`LICENSES/`).

## Agents in microVMs (sub-projects 1 to 3)

- Each agent runs in its own Kata/Cloud Hypervisor microVM with bwrap inside it and no provider key in the VM (an agent's own scoped credentials may be imported by the owner, ADR 0079): `docs/agents/agents-vm.md` (runtime, gateway, mirror, relay, pap-vmd, network, setup, tests, known limits); ADRs 0078, 0079 and 0081 (specs: sub-project 2 `docs/specs/2026-10-21-agents-vm-egress-design.md`, sub-project 3 `docs/specs/2026-10-22-agents-vm-only-design.md`); install: `docs/agents/install.md` ("Agent VMs"); checks: `docs/agents/doctor.md` ("Agent VM checks"); measurements: `docs/research/agents-vm-risk-checks.md`.
- Env: `PAP_AGENTS_RUNTIME` is gone (not read; a boot warning when set). `PAP_AGENTS_MEMORY_MAX_MB` (cap on all running VMs together, each counts `memoryMb` + 512; default max(1024, half the RAM), at least 1024), `PAP_TEST_AGENT_RUNTIME=process` (tests only; needs `PAP_TEST_PROVIDER_SCRIPT`, stops the boot without it; never set it elsewhere), `PAP_TEST_VMD_SOCKET` (tests only; the pap-vmd socket a daemon with the scripted provider dials, required so a test never reaches the real `/run/pap-vm/vmd.sock`; needs `PAP_TEST_PROVIDER_SCRIPT`; never set it elsewhere).
- Needs KVM (`/dev/kvm`, x86_64) and a root service: `sudo pap vm setup --user <name>` (pinned artefacts), `sudo pap vm uninstall [--purge]`. A host without KVM has no agents. After `pap update`, run `sudo pap vm setup` again: pap-vmd and the agent bundle do not follow the update, and a thread says its VM's code is older than pap (`vm_bundle_stale`, `vm.bundle`).
- No migration: agents made in host mode are deleted and created again (`pap doctor` lists them). In a VM the shell has network only through the egress proxy (`10.213.0.1:7843`, filtered by the agent's `allowHosts` as `host[:port]` or IP entries, when `sandbox.network` is on). The daemon taints a launch's sessions from what the proxy sees, never from the VM's own report. Prechecks do not run for agents (a stored one is refused `precheck_agent`); `export_html` is unavailable, and disk backups are sub-project 4. MCP stdio servers and extension children are not confined inside the VM (ADR 0081).
- Project boxes (lot B1, ADR 0083): a project made from a name has its own box (`/boxes/<id>/{project,home,inbox,.pi}`; the project folder is pap's path), and its sessions, children and trigger tasks run in it. Files, Changes and OKF go through guest operations, search indexes session mirrors, prechecks are gone (`precheck_removed`). `PAP_BOX` (`agent:<id>` | `project:<uuid>`) replaces `PAP_AGENT_ID`, protocol 2: run `sudo pap vm setup` after the update. `PAP_AGENTS_MEMORY_MAX_MB` caps every box, agents' and projects' together. Log field `agentId` is now `box`. `docs/agents/agents-vm.md` ("Project boxes"); ADR 0083 (supersedes 0074/0075 at B4 and 0036 at B2); spec `docs/specs/2026-10-23-boxes-b1-design.md`.
- A host path never reaches a box project's content: tests that touch box projects run on the process backend with the existing guards (`PAP_TEST_VMD_SOCKET`, `testing/box-bed.ts`), never the real pap-vmd.
- Kata tests (`*.kata.int.test.ts`, project `kata`) run locally only, on a KVM host with `pap vm setup` done: `CI=1 pnpm vitest run --project kata` (no runtime variable). Without `CI=1` they skip with one warning when `/dev/kvm` or `/run/pap-vm/vmd.sock` is missing; no CI job runs them.

## Rules (CI-enforced)

- 400 lines per file at most. No baseline, no exceptions.
- A daemon module imports only `@pap/contracts`, `kernel/` and other modules' `index.ts`.
- Every RPC method declares a permission in `packages/contracts/src/methods.ts`.
- RPC handlers decode, call one service method, map typed errors. Nothing else.
- UI code uses tokens from `packages/ui/src/tokens.css`: no raw colours, no `[…]` arbitrary values, no restyling of `@pap/ui` primitives.
- The only ESLint directive accepted is `eslint-disable-next-line <rule> -- <reason>`; block and `-line` forms are refused, and so is inline config (`/* eslint max-lines: "off" */`).
- TypeScript: erasable syntax only (no enum, namespace, parameter properties); relative imports keep their `.ts` extension.
- Tests never touch `~/.pi/agent` or `~/.pap`; timers go through the kernel `Clock`; no sleeps.
- Never edit pi-web; pap imports nothing from it.

## Conventions

- Conventional Commits; rebase on the target branch before a PR; no AI attribution trailers.
- Models: `models.json` writes, keys and `enabledModels` are browser-only (`pi:admin`, a token is `forbidden`); the provider form has no key field. Details: `docs/agents/models.md`, ADRs 0068 to 0070.
- Topic notes: `docs/agents/<domain>.md` (`daemon`, `sessions`, `auth`, `policy`, `search`, `files`, `terminal`, `models`, `mcp`, `skills` (skills and plugins), `lanes` (worktrees, lanes, forges), `automation` (triggers, tasks, Inbox), `finops` (runs, cost, budgets, limits, metrics), `agents` (agents, platform ops, vault, sandbox, egress, subagents), `knowledge` (OKF knowledge), `backup` (backup and restore), `update` (update, rollback, recover, the daily check), `doctor`; UI: `web`). Rulings: `docs/research/m2-rulings.md`, `docs/research/m3-rulings.md`, `docs/research/m4-rulings.md`, `docs/research/m5-rulings.md`, `docs/research/m7-rulings.md` (+ `m7-rulings-after-join.md`), `docs/research/m8-rulings.md`, `docs/research/m9-rulings.md`, `docs/research/m10-rulings.md`, `docs/research/m11-rulings.md`, `docs/research/m6b-rulings.md`, `docs/research/models-batch-rulings.md` (models picker and providers). Deviations from spec C: an ADR in `docs/adr/`.
