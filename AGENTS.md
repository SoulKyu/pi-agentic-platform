# pap — agent notes

Self-hosted agentic platform on the Pi SDK. Specs: `docs/specs/` (C = architecture). Plans: `docs/plans/`.

## Commands

- `pnpm install` · `pnpm lint` · `pnpm format:check` · `pnpm typecheck` · `pnpm knip`
- `pnpm test:unit` · `pnpm test:int` (forks real pi-host workers with a scripted provider)
- `pnpm build` · `pnpm e2e` (Chromium + WebKit) · `pnpm budgets`
- Dev: `pnpm --filter @pap/daemon dev` (prints its URL; port and PAP_HOME derived from the worktree path), then `PAP_DEV_DAEMON=http://127.0.0.1:<that port> pnpm --filter @pap/web dev` and open http://localhost:5173

## Rules (CI-enforced)

- 400 lines per file at most. No baseline, no exceptions.
- A daemon module imports only `@pap/contracts`, `kernel/` and other modules' `index.ts`.
- Every RPC method declares a permission in `packages/contracts/src/methods.ts`.
- RPC handlers decode, call one service method, map typed errors. Nothing else.
- UI code uses tokens from `packages/ui/src/tokens.css`: no raw colours, no `[…]` arbitrary values, no restyling of `@pap/ui` primitives.
- Every `eslint-disable` carries a reason after `--`.
- TypeScript: erasable syntax only (no enum, namespace, parameter properties); relative imports keep their `.ts` extension.
- Tests never touch `~/.pi/agent` or `~/.pap`; timers go through the kernel `Clock`; no sleeps.
- Never edit pi-web; pap imports nothing from it.

## Conventions

- Conventional Commits; rebase on the target branch before a PR; no AI attribution trailers.
- Topic notes: `docs/agents/<domain>.md`. Deviations from spec C: an ADR in `docs/adr/`.
