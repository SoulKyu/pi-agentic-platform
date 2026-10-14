# pap — agent notes

Self-hosted agentic platform on the Pi SDK. Specs: `docs/specs/` (C = architecture). Plans: `docs/plans/`.

## Commands

- `pnpm install` · `pnpm lint` · `pnpm format:check` · `pnpm typecheck` · `pnpm knip`
- `pnpm test:unit` · `pnpm test:int` (forks real pi-host workers with a scripted provider)
- `pnpm build` · `pnpm budgets`
- node-pty builds at install: gcc, make, python3.
- Run the built POC: `pnpm build && node --disable-warning=ExperimentalWarning apps/daemon/dist/main.js serve`, then open the setup URL it prints (`/` answers 404 when `apps/web/dist` does not exist, so build first). From another machine of a trusted LAN (testing only, cookie in clear text): add `--host <LAN IP> --insecure-http` (ADR 0004). `pnpm smoke` boots that same build against the scripted provider and drives it end to end.
- Dev: `pnpm --filter @pap/daemon dev` (prints its URL; port and PAP_HOME derived from the worktree path), then `PAP_DEV_DAEMON=http://127.0.0.1:<that port> pnpm --filter @pap/web dev` and open http://localhost:5173

## Admin CLI (daemon stopped: `systemctl --user stop pap-preview`)

- `pap audit prune [--month YYYY-MM] [--dry-run]` · `pap user add <username> [--password-stdin]` · `pap passkey reset [--revoke-tokens] [--keep-password] [--password-stdin]`. Exit 0 / 1 (refusal) / 64 (usage). Details: `docs/agents/daemon.md`, `auth.md`.

## Worker settings

- Env: `PAP_MAX_WORKERS`, `PAP_MIN_FREE_MEM_MB`, `PAP_WORKER_IDLE_MINUTES` (30, `0` = never release), `PAP_WORKER_SCOPE` (`auto` | `off`), `PAP_WORKER_MEMORY_MAX_MB` (default max(2 GiB, 50 % RAM), at least 1024: a lower value stops the daemon at boot), `PAP_WORKER_TASKS_MAX` (4096), `PAP_MAX_TERMINALS` (running terminals per owner, 8). Details: `docs/agents/daemon.md`.
- Workers run in a `systemd-run --user --scope` only with a lingering user manager: `loginctl enable-linger <user>` once, `XDG_RUNTIME_DIR` set. Otherwise scopes are off with a boot warning. Tests run with `PAP_WORKER_SCOPE=off`; the scope tests need the manager (CI starts one): under `CI=1` they fail without it, locally they skip with a warning.

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
- Topic notes: `docs/agents/<domain>.md` (`daemon`, `sessions`, `auth`, `policy`, `search`, `files`, `terminal`; UI: `web`). Rulings: `docs/research/m2-rulings.md`, `docs/research/m3-rulings.md`, `docs/research/m4-rulings.md`, `docs/research/m5-rulings.md`, `docs/research/m8-rulings.md`. Deviations from spec C: an ADR in `docs/adr/`.
