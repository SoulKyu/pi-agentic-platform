# End-to-end journeys

Sixteen browser journeys (J01 to J17 except J09, which tested pi-mem0 and is gone; the `.e2e.ts` files of `scripts/e2e`) drive the **built** daemon and web app with Playwright. ADR 0071 allows Playwright for this and nothing else; it is a dev dependency behind one script. Unit and integration tests stay in Vitest.

## What runs where

| Where | What | State |
| --- | --- | --- |
| A development machine | `pnpm test:e2e` after `pnpm build` | Run in container mode on the Linux host these journeys were written on (see "Verified so far") |
| CI, job `e2e` of `.github/workflows/ci.yml` | `needs: build`, downloads the `dist` artifact, installs Chromium and WebKit with their system packages, runs `pnpm test:e2e`, uploads `scripts/e2e/playwright-report` and `scripts/e2e/test-results` when it fails (25 minute timeout) | Written and pinned by `scripts/ci-config.e2e.test.ts`. The repository is public and `ci.yml` runs on pull requests and on pushes to `main`, but this job has **not yet passed on GitHub** (M13R33, M13-C9: the first GitHub run is the real check) |

Nothing here has run on macOS, Windows or WSL.

## Layout in the journeys (J16)

`j16-layout.e2e.ts` measures what the design pass promises on the rendered page (happy-dom computes no layout), on Chromium and WebKit:

- the longest agent paragraph is no wider than a `width:72ch` probe inserted next to it in the same font (0.5 px slack), and holds at most 90 characters a line on Chromium and 95 on WebKit. WebKit's fallback fonts have a narrower average glyph, so its 72ch holds 91 characters: the width is the promise, the count a sanity check;
- no page is wider than the screen at 320 px (home, a session, Settings › Appearance, Settings › Automation, Tasks, the trigger editor), with a very long project name selected;
- the first Tab of a page lands on the skip link and Enter focuses `#pane-host`;
- Day's focus outline on the active tab reaches 3:1.

The 320 px width is set in the test (`setViewportSize`) on the desktop projects, not by a phone project: the phone projects own J06 only, and a Pixel 7 is 412 px wide. Touch and 44 px targets stay J06's job. J16 injects only the read-only 72ch probe (removed at once); no screenshots, no `bypassCSP`. Time: 7.9 s on Chromium and 8.3 s on WebKit in the full run.

## Reply tools in the journeys (J17)

J17 runs with `SHELL=/bin/bash` (`papEnv`) and the DOM renderer of xterm. A scripted reply holds three bash fences; the journey clicks To terminal on each. A single line and a two-line block (bracketed paste on, bash's default) appear in the terminal's rows while their files are absent, and only the owner's Enter creates them. After `bind 'set enable-bracketed-paste off'` the two-line block is refused with the `reply.shell.multiline` alert, no row holds it and no file exists. It ends on the files in the project folder.

## Agents in the journeys (J07)

The e2e daemon has no pap-vmd and no KVM, so J07 is the "no VM stack" journey: the New agent dialog shows the microVM EmptyState ("Agents run in microVMs: this machine needs KVM and `sudo pap vm setup`. See `pap doctor`.") in place of the form, and no agent appears. The phone's Agents tab shows the same EmptyState (unit test, not e2e).

## Commands

- `pnpm build`: the journeys refuse to start without `apps/daemon/dist` and `apps/web/dist`.
- `pnpm test:e2e`: the whole suite. Arguments go to Playwright after the config: `pnpm test:e2e j14` runs one journey (a file or title argument counts as a filter; the empty-project check then applies to what was selected only).
- `pnpm test:unit`: includes the tests of the runner and of the helpers (`scripts/e2e/run.test.ts`, `catalog.test.ts`, `loopback-guard.test.ts`, `push-sink.test.ts`, `rpc.test.ts`, `fixtures.test.ts`, `git.test.ts`) and `scripts/ci-config.e2e.test.ts`. None of them starts a browser; `run.test.ts` lists the real routing of journeys to projects.

## The two modes

`scripts/e2e/run.ts` picks one (`planRun`, pinned by `run.test.ts`):

| Mode | When | What happens |
| --- | --- | --- |
| `local` | the `chromium` and `webkit` executables of Playwright both exist | Playwright launches them itself. CI is this mode |
| `container` | otherwise, and `podman` exists | A container `mcr.microsoft.com/playwright:v<installed Playwright version>-noble` named `pap-e2e-<port>` is started (`run -d --rm --network host --ipc=host`, the `playwright-core` folder mounted read-only at `/pw` with the `Z` label for SELinux, `run-server --host 127.0.0.1 --port <free port>`). Tests and daemons stay on the host; only the browsers live in the container. The runner stops it when the run ends |

`PAP_E2E_MODE=local` or `PAP_E2E_MODE=container` forces one mode and fails with a pointer to this page when it cannot run. `PAP_E2E_WS=ws://...` uses a browser server that already runs. With no browser and no `podman`, the run stops with "no browser and no podman: see docs/agents/e2e.md".

The container needs `--network host`: a rootless podman on a host without it is not supported. The job in CI leaves `PAP_E2E_MODE` and `PAP_E2E_WS` unset, so it uses the browsers it installed.

The runner lists the tests first and prints how many spec files each project holds, then the name and version of each browser engine it connects to. It fails when the list is empty, when a journey sits on a project the config does not route it to, or (for a whole-suite run) when a project has no tests, so a wrong filter cannot pass as green.

## The browser split

Projects (`scripts/e2e/playwright.config.ts`): `chromium` and `webkit` (desktop) run every journey except J06; `chromium-phone` (Pixel 7) and `webkit-phone` (iPhone 13) run J06 only (M13R40). Two workers, no retries (a retry hides a flake), 60 s per test unless a journey says otherwise.

All journeys run on both engines, with two exceptions (M13R5, M13R6):

- **J01 passkey half: Chromium only.** Chromium is driven with a CDP virtual authenticator (`WebAuthn.addVirtualAuthenticator`, ctap2, internal, resident keys). WebKit has no virtual authenticator, so its J01 runs the password path and records a `skip` annotation for the passkey half.
- **J13 push: Chromium only.** The browser has no push service here, so the test replaces `PushManager.subscribe` and the Notification permission with stubs. WebKit has no equivalent to stub; its J13 tests are skipped with that reason in the code.

## Writing a journey

1. Add a file `jNN-topic.e2e.ts` to `scripts/e2e` (a phone journey starts with `j06-`; the config routes by that prefix). Import everything from `./fixtures.ts`.
2. Fixtures (`scripts/e2e/fixtures.ts`):
   - `pap`: one built daemon per spec file and project, with a temporary HOME, `PAP_HOME` and Pi agent dir. `test.use({ papScript: scripted([...]), papEnv: { ... } })` sets its provider script and extra environment; a file with a different script or environment gets a daemon of its own. `pap.rpc(method, params)` calls the daemon as the owner; `pap.lines()` returns its JSON log lines; `pap.home`, `pap.work`, `pap.agentDir` are real folders to read back.
   - `signedIn`: a page that already holds the owner's session (J01 is the one journey that sets the owner up through the page).
   - `scripted([...])` wraps the provider script: pass it to `papScript`, never a bare array.
   - `stepUp(page, pap)` confirms the owner password before a step-up-gated action.
   - `palette(page)` and `chord(page, key)` press Control or Meta by engine.
3. Locators come from the English catalog: `t("some.key", { vars })` and `plural(...)`, never a typed string, and role, label and text are the default. Name locators with `exact: true`. For a name the catalog does not hold (a project folder), use the value you created. Where an element has no accessible name, an app-owned `data-*` hook or a stable structural selector is allowed (M13-C11).
4. Read the `error-context.md` snapshot that Playwright writes for a failed test under `scripts/e2e/test-results` before changing a locator that failed.
5. Never `goto` while the app is navigating. First clicks are plain: C8 fixed the Tooltip that used to drop one, so a journey does not need a retry around an icon button. `actUntilVisible(action, target)` in `scripts/e2e/seed.ts` stays for a click whose effect depends on something the page loads on its own.
6. No `waitForTimeout` and no sleeps: use web-first assertions and `expect.poll`. A control whose write takes a Pi helper run (a Settings › Models switch: the write, then the list read again, about 10 s on GitHub's runner) is checked from outside first: wait for the write's durable state, then for the page, each with its own wait (J10's `switchOff`).
7. End with an assertion on durable state read from outside the page: a file on disk, a database row (`dbRows`), an RPC result, a journal or log line, a process count (`liveProcesses`). A journey that only checks the DOM can pass while testing nothing. Check the journey fails when the product behaviour is broken.
8. E2E code imports no `@pap/*` package (Playwright's loader lacks the `development` condition). A file that uses DOM names starts with `/// <reference lib="dom" />`. Files stay under 400 lines.
9. The English catalog is read by `scripts/e2e/catalog.ts`; for another language read `catalogs().fr[key]` the way J15 does.

## Test seams

The daemon under test is the production build. These are the only test-only inputs, all environment or files, none in a user-facing path:

| Seam | Used by | What it does |
| --- | --- | --- |
| `PAP_TEST_PROVIDER_SCRIPT` | every journey (set by `scripts/e2e/daemon.ts`) | Points workers at a `script.json` of steps; the provider answers with those texts and tool calls and calls no model. `writeScript` in `seed.ts` writes the script of the next worker |
| `PAP_TEST_WORKER_IMPORT` | every journey | Loads the network guard in each worker: any TCP connect is refused |
| `PAP_TEST_GIT_PROTOCOLS=file` and the `gh` stub | J03 | A lane push reaches a local bare repository (`scripts/e2e/git.ts` writes the URL rewrite into the temporary `.gitconfig`). `scripts/e2e/stubs/gh` is first on the daemon's `PATH`; it answers the exact arguments pap builds and exits 2 on any other, and logs each call to `$HOME/gh-calls.log` |
| `PAP_TEST_PUSH_LOOPBACK=1` and the push sink | J13 | The daemon accepts a push endpoint on loopback, and `scripts/e2e/push-sink.ts` listens there to receive and decrypt the push |

### The loopback guard

With `PAP_TEST_PUSH_LOOPBACK=1`, `daemon.ts` starts the **daemon process only** with `--import scripts/e2e/loopback-guard.ts`. That file loads the normal network guard and lets through one thing: a connect whose host is the literal `127.0.0.1` (not `localhost`, `::1` or `::ffff:127.0.0.1`; `loopback-guard.test.ts` pins the refusals). It does not limit the port to the sink's. Workers keep the full guard.

## What the journeys do not prove

- **J13 does not compare the VAPID `k=` value** in the `Authorization` header with the daemon's public key; it checks that a push arrives, once, encrypted for the sink's key with `aes128gcm`, signed with a `vapid` scheme, carrying the generic sentence and none of the command.
- **J13 forces the Notification permission to `granted`** in the page (headless Chromium reports `denied`, and the page reads it before asking). It proves pap's handling of a granted browser, not a real permission prompt.
- **J11 and J17 remove `WebGL2RenderingContext`** from the page so xterm uses its DOM renderer, whose text a locator can read. The canvas and WebGL renderers are not exercised.
- WebKit here is Playwright's build, not Safari on iOS or macOS.
- Known limits (M13R34): WebKit passkey, push on Chromium only, the container needs network host mode, and the suite does not cover Windows or WSL.

## Time budget

Default test timeout 60 s. J13 declares 150 s (M13R43): an approval push is enqueued 60 s after the last heartbeat and suppressed while a device is present, a focused page keeps sending heartbeats, and the real clock of a built daemon cannot be advanced. So J13 closes its page, raises the approval from a node client and waits up to 100 s (`WAIT_MS`) for a push that arrives 60 to 70 s later. That is about 10 s over the worst case; a slower host raises `WAIT_MS` and the 150 s timeout together. No test-only delay variable exists for this.

The suite budget is 15 minutes in the container (M13R43). Measured on the development host, full suite, container mode, two workers: 36 passed and 2 skipped (J13 on WebKit) in 4.5 minutes by Playwright's clock before the design pass; with J16 and the design pass joined, the same 36 passed and 2 skipped in 3.3 minutes (3 min 29 s wall clock, the Playwright report: chromium 18, webkit 16, chromium-phone 1, webkit-phone 1; J10 passes). The longest tests were the two J13 tests at 1.0 to 1.1 minutes each. No test went over its own timeout in that run.

## Verified so far

On the one Linux x86 host above, container mode, Chromium and WebKit, the whole suite has passed in every run since the Tooltip fix (J1b twice, CJ1 once; the run quoted above). An earlier whole run on the same host had one failure in `webkit-phone` J06 (the Tooltip first-click drop named under "Writing a journey", which C8 fixes in the product); it passed in the next run. No journey has been run in `local` mode, on GitHub's runners, or on another host.
