# ADR 0071: e2e on the pinned Playwright image

Status: accepted · Date: 2026-10-18 · Spec: `docs/specs/2026-10-10-A-product-scope.md` (feature parity, exit criteria). Reverses R128. Rulings: M13R1 to M13R8, M13R35, M13R38, M13R40 to M13R43; owner q1, q2.

## Context

Spec A asks for feature parity with pi-web that a stranger can check. Unit and integration tests cover the daemon and the components, but nothing drove the built daemon and web app in a real browser. Ruling R128 of M1 said "Playwright is not used", and `scripts/ci-config.test.ts` pinned that. The host that builds pap is headless, with no sudo and no browser; the only browsers available are in a container image.

## Decision

Playwright 1.63.0 is admitted as an exact-pinned root dev dependency, and R128 is reversed. It is used for the fifteen e2e journeys (J01 to J15) in `scripts/e2e/` and for nothing else; unit and integration tests stay in Vitest.

- `pnpm test:e2e` (`scripts/e2e/run.ts`) runs in `local` mode when the `chromium` and `webkit` executables exist, otherwise in `container` mode: the image `mcr.microsoft.com/playwright:v<installed version>-noble` runs `run-server` with `--network host` and `--ipc=host`; tests and daemons stay on the host. A test pins the image tag to the installed version.
- Each spec file and project boots its own built daemon on a free port with a scripted provider (a worker-scoped fixture).
- Locators use roles, labels and text from the English catalog, no `waitForTimeout`. Where an element has no accessible name, a journey may use an app-owned `data-*` hook or a stable structural selector (M13-C11).
- Chromium uses a CDP virtual authenticator for the passkey half of J01; WebKit has none and takes the password path. J13 (push) runs on Chromium only with a stubbed subscription and a loopback sink under `PAP_TEST_PUSH_LOOPBACK=1`.
- E2E is a gate step at the join and at the final review, plus the CI job `e2e`. It is not in a task gate. `scripts/ci-config.test.ts` was rewritten once, by task A1, to drop the no-browser-runner rule.

## Consequences

- Cost: `scripts/` grows by about 2 000 lines of test code; the suite takes about 4.5 minutes in the container (budget 15 minutes) and adds one dev dependency.
- Known limits stay written in `docs/agents/e2e.md`: WebKit passkey, push on Chromium only, the container needs network host mode, nothing has run on macOS, Windows or WSL.
- The container image is a supply-chain input; its tag follows the installed Playwright version, which only moves by a reviewed dependency change.
