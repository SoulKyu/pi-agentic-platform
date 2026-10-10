# pap M0 + M1: architecture spikes and walking skeleton — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer the eight spikes of spec C §10 (M0), then build a walking skeleton (M1) that proves the pap architecture end to end: browser → Hono + `ws` daemon → forked `pi-host` worker running the Pi SDK → `pap-policy` asks through `ctx.ui.confirm` → web approval card → result.

**Architecture:** One Node 24 daemon (`apps/daemon`: kernel + one folder per domain module) serves a React 19 SPA (`apps/web`) over HTTPS/HTTP routes and one `/ws` socket whose methods are declared once in `packages/contracts`. Each active Pi session runs in its own `child_process.fork` worker (`packages/pi-host`) that hosts the Pi SDK, loads the `pap-policy` extension, and talks to the daemon over Node IPC with records shaped like `pi --mode rpc` plus pap records. Platform state lives in `~/.pap/state.db` (`node:sqlite`); Pi transcripts stay in `~/.pi/agent` and are read in place.

**Tech Stack:** Node 24 (`node:sqlite`, native TypeScript type stripping), pnpm workspaces + catalog, TypeScript strict, zod 4, Hono + `@hono/node-server`, `ws`, `@simplewebauthn/server` + `@simplewebauthn/browser`, Pi SDK 1.1.0 (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`), React 19 + Vite + React Compiler, TanStack Router, zustand, Tailwind 4, Vitest, Playwright (Chromium + WebKit), ESLint 9 flat config + typescript-eslint + eslint-plugin-boundaries, Prettier, knip, GitHub Actions, Renovate.

**Spec:** `docs/specs/2026-10-10-C-architecture.md` (implemented here; spikes in §10), `docs/specs/2026-10-10-A-product-scope.md`, `docs/specs/2026-10-10-D-clean-start.md`, `docs/research/decisions-log.md` (decisions 1–33) and `DESIGN.md` (spec B, validated: decision 33). Milestones after M1: `docs/plans/roadmap.md`.

## Global Constraints

Copied from the specs (source in brackets). Every task implicitly includes them.

- Node 24: "Boring tech. TypeScript on Node 24, SQLite, React; no Effect, no SSR." [A §3]
- File size: "400 lines per file at most. No baseline, no exceptions." [C §1.4.2]
- Module boundary: "One module per domain (D01–D21). A module imports only `contracts`, `kernel` and other modules' `index.ts`." [C §1.4.1]
- RPC handlers: "An RPC handler decodes the request, calls one service method and maps typed errors. Nothing else." [C §1.4.3]
- Permissions: "Every RPC method declares a permission in `contracts`. A missing permission is a type error." [C §1.4.4]
- Packages: "No fourth package until a real need appears. Modules are folders, not npm packages." [C §1.4.6]
- UI look: "Primitives in `packages/ui` own their look: no raw colours, no arbitrary values." [C §1.4.5]
- Localhost bind: "The daemon binds `127.0.0.1:7777` by default." [C §4.4] · "`127.0.0.1:7777`; `--host 0.0.0.0` must be explicit" [A §5.3]
- Zero telemetry: "**Zero telemetry**. The only outbound request from pap itself is the update check, opt-out with `PAP_UPDATE_CHECK=0`." [C §9.4]
- Browser floor: "The Safari / iOS 16.4 floor, pinned by a test." [C §7.3]
- UI languages: "UI languages | English, French (zh-CN / zh-TW from upstream dropped)" [A §5.3] · "The internal i18n layer, with **en + fr**." [C §7.3]
- Errors: "Errors carry a stable code and a fixed message, with no user content and no secrets." [C §4.1]
- Default approval mode: "auto-accept edits: read and edit run without asking; exec, network and external writes ask" [A §5.3]
- Fail closed: "**Any evaluation error blocks** the call (fail closed)." [C §5.1]
- Pi files: "**Pi** owns its files; pap reads them in place and never copies them." [C §3.1] · "pap imports nothing from pi-web." / "pi-web is never modified." [D §1]
- Lint discipline: "Every disable must give a reason." [C §8.2]
- Supply chain: "pnpm with pinned versions; `minimumReleaseAge` of 3 days; a native-build allowlist (node-pty); Renovate." [C §8.2]
- Git: "Conventional Commits, rebase before PR" [C §8.3]. Rebase the branch on its target before opening or updating a PR (`git rebase <target>`).
- Commit messages must NOT contain `Co-Authored-By` or any AI attribution trailer (user rule; the commit commands in this plan show the full message).

## Plan conventions (decided by this plan)

- TypeScript sources use **erasable syntax only** (`erasableSyntaxOnly`): no `enum`, no `namespace`, no constructor parameter properties. Relative imports carry their `.ts`/`.tsx` extension. Reason: tests and dev runs fork `packages/pi-host/src/main.ts` directly with Node 24 type stripping and `--conditions=development`.
- Workspace packages export `"development": "./src/…ts"` before `"default": "./dist/…js"`. Vitest, `tsc --noEmit` and dev runs use the `development` condition; builds emit `dist/`.
- Tests never touch the real `~/.pi/agent` or `~/.pap`: every test sets temporary `PAP_HOME` / `PI_CODING_AGENT_DIR` directories.
- No sleeps in tests. Timers go through the kernel `Clock` (`createFakeClock`). Tests that wait on a real child process wait for an event with a deadline, never a fixed delay.
- The Pi SDK is pinned once in the pnpm `catalog:` (1.1.0, the version pi-web runs).
- `spikes/**` is throwaway code: excluded from ESLint, Prettier, knip and `tsc`; never imported by M1 code.
- Commands assume the repository root `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform` as working directory.

## Review Focus

Inputs and conditions the specs imply, that no feature test naturally exercises, and that are most likely to bite a person using this software. Each line names the test that pins it.

1. **Default bind over plain HTTP in Safari.** `pap serve` with defaults is `http://127.0.0.1:7777`; the session cookie is always `Secure` and WebAuthn rejects IP addresses as RP ID. A reasonable person expects login to survive a reload in Safari and passkeys to work from the printed setup link. Pinned by: Task 13 test "loopback hosts publish a localhost origin", Task 18 test "an IP origin disables passkeys instead of failing", Task 27 WebKit journey (reload after login).
2. **Reconnect after a daemon restart.** A tab holds a cursor `{epoch, seq}` from the previous daemon; the new daemon restarts `seq` at 0. Expected: a fresh snapshot, never silently skipped events. Pinned by: Task 16 test "a cursor from another epoch gets a snapshot", Task 25 test "resubscribes with the last cursor after a reconnect".
3. **The worker dies while an approval card is open** (OOM, crash, `kill -9`). Expected: the card disappears, the run is marked interrupted with a readable cause, the next prompt restarts the worker on the same Pi file. Pinned by: Task 22 test "a crash closes open dialogs and records an interrupted run", Task 23 integration test "worker killed with an open approval card".
4. **A bad working directory** (`~/proj`, a relative path, a missing folder, a file). Expected: a clear `invalid_cwd` message in en and fr, no worker spawned. Pinned by: Task 22 `cwd.test.ts`, Task 26 test "every error code has an en and fr message".
5. **The same dialog answered twice** (double click, two tabs). Expected: the first answer wins, the second gets `not_found`, nothing crashes. Pinned by: Task 22 test "answering twice returns not_found", Task 24 `once.test.ts`, Task 27 journey double-clicks "Allow once".

## Gates between milestones

- **M1 starts only when** `docs/spikes/s2.md` (Task 1) and `docs/spikes/s1.md` (Task 2) both end with `Decision: GO`, or with `Decision: FALLBACK` and the matching "Spike fallback" lines of the M1 tasks applied.
- S3 (Task 3) and S7 (Task 5) take hours: finish them before Task 14 and Task 20. S4 (Task 4) needs the S1 prototype; its numbers feed Task 13 and Task 23.
- S5, S6 and S8 (Tasks 7, 6, 8) do not block M1; run them in parallel. Their results feed roadmap milestones M3, M6 and M9.

---

## File Structure

```
pi-agentic-platform/
├─ package.json                  root scripts (lint, typecheck, knip, test:unit, test:int, build, e2e, budgets)
├─ pnpm-workspace.yaml           workspace globs, Pi SDK catalog, minimumReleaseAge, native-build allowlist
├─ .npmrc · .nvmrc               engine-strict · Node 24
├─ tsconfig.base.json            strict, erasable-only compiler options shared by every package
├─ eslint.config.js              flat config: max-lines 400, boundaries, eslint-comments, local pap rules
├─ eslint/pap-plugin.js          local rules: no-raw-colors, no-arbitrary-values, no-restyle, zustand-selector
├─ eslint/pap-plugin.test.js     RuleTester cases for the local rules and the gate settings
├─ .prettierrc.json · .prettierignore
├─ knip.json                     unused files / exports / dependencies gate
├─ vitest.config.ts              projects: unit, integration
├─ playwright.config.ts          Chromium + WebKit projects, one daemon each
├─ budgets.json                  initial bundle, session-open payload, idle worker RSS
├─ renovate.json
├─ AGENTS.md                     ≤ 150 lines: commands, rules, links
├─ .github/actions/setup/action.yml   pnpm + Node 24 + install
├─ .github/workflows/ci.yml           checks → unit → integration → build → e2e → budgets
├─ .github/workflows/pi-compat.yml    nightly integration run against the latest Pi SDK
├─ scripts/copy-sql.ts · check-budgets.ts · pi-compat-bump.ts (+ tests)
├─ docs/spikes/s1.md … s8.md     M0 findings notes
├─ docs/adr/0001…0003            deviations introduced by M1
├─ spikes/s1 … s8/               M0 throwaway prototypes
├─ e2e/                          global setup/teardown, journey spec, provider script fixture
├─ packages/contracts/src/
│   errors.ts                    ERROR_CODES, ERROR_MESSAGES, PapError
│   permissions.ts               Domain × Level permission strings
│   define.ts                    defineMethod, MethodDef
│   methods.ts                   the method catalogue
│   handlers.ts                  MethodName, ParamsOf, ResultOf, Caller, HandlerContext, HandlerTable
│   frames.ts                    /ws frames, Cursor, PROTOCOL_VERSION
│   streams.ts                   session stream events, Dialog, SessionSummary
│   pi-host.ts                   daemon ⇄ worker IPC records, parseWorkerRecord
│   index.ts                     barrel
├─ packages/pi-host/src/
│   main.ts                      worker entry: OOM score, watchdog, IPC, host loop
│   ipc.ts · watchdog.ts         typed IPC over process.send · parent watchdog + oom_score_adj
│   host.ts · commands.ts        record loop · prompt / abort / get_state
│   open-session.ts              Pi SDK services + session + extension binding
│   wire-events.ts               SDK events → JSON wire shape (no cumulative partials)
│   ui-bridge.ts · plain-theme.ts  ExtensionUIContext → extension_ui_request records
│   scripted-provider.ts         test-only scripted Pi provider loaded from a JSON script
│   policy/categories.ts · decide.ts · extension.ts   minimal pap-policy (stage 03 approval)
│   testing/network-guard.ts · fork-host.ts           test helpers (excluded from build)
├─ packages/ui/src/
│   tokens.css                   E1 Night / Day tokens (DESIGN.md §3 subset)
│   cn.ts · once.ts · index.ts
│   primitives/Button.tsx · TextField.tsx
│   ai/Message.tsx · ApprovalCard.tsx
├─ apps/daemon/src/
│   main.ts                      `pap serve` CLI
│   daemon.ts                    composition root: kernel + modules + transport
│   kernel/config.ts · clock.ts · logger.ts · ids.ts · version.ts
│   kernel/db/database.ts · migrate.ts · meta.ts · receipts.ts
│   kernel/migrations/202610100000_kernel.sql
│   kernel/http/origin.ts · static.ts · app.ts · server.ts
│   kernel/ws/stream-hub.ts · dispatcher.ts · ws-server.ts · system-handlers.ts
│   kernel/supervisor/worker.ts · kill-ladder.ts · exit.ts · env.ts · fake-worker.ts
│   modules/auth/{index,service,store,passkey-store,http,passwords,setup-token,throttle,cookies,passkeys,passkey-http}.ts + migrations/
│   modules/sessions/{index,service,store,rpc,cwd,dialogs,run-tracker,live-session,transcript}.ts + migrations/
│   testing/harness.ts · ws-client.ts · http-client.ts · free-port.ts
└─ apps/web/
    index.html · vite.config.ts · browser-targets.ts
    src/main.tsx · styles.css · browser-floor.test.ts
    src/runtime/connection.ts · rpc.ts · subscriptions.ts · http.ts · random-id.ts · use-connection-state.ts · index.ts · testing.ts
    src/stores/session-reducer.ts · session-store.ts · session-feed.ts
    src/features/auth/auth-api.ts · use-auth-gate.ts · SetupScreen.tsx · LoginScreen.tsx · AccountBar.tsx
    src/features/sessions/transcript.vm.ts · SessionListScreen.tsx · SessionScreen.tsx
    src/routes/router.tsx · RootLayout.tsx
    src/i18n/index.ts · en.ts · fr.ts
```

---

# M0 — Spikes (spec C §10)

Each spike is time-boxed. When the box runs out, stop, record what was measured and decide GO or FALLBACK with what you have. Each spike lives in `spikes/<id>/` with its own `package.json`, installed with `pnpm install --ignore-workspace` so it never joins the M1 workspace. Each findings note ends with exactly one line `Decision: GO` or `Decision: FALLBACK`.

### Task 1: S2 — scripted custom provider drives full runs (gates M1)

**Time-box:** 1 day.
**Question (C §10):** Does a scripted custom provider drive full runs (text, tool calls, quota error)? **Done when:** the integration test runs offline and deterministically. **Fallback:** replay recorded Pi events at the transport boundary (T3 style).

Known before starting: pi-ai exports `fauxProvider`, `fauxAssistantMessage`, `fauxText`, `fauxToolCall` (used by pi-web's integration tests, e.g. `pi-web/lib/mcp-read-only-policy.integration.test.mjs`). The spike checks both registration routes: `ModelRuntime.registerNativeProvider()` and the custom-provider API `pi.registerProvider(provider)` from an inline extension.

**Files:**
- Modify: `.gitignore`
- Create: `spikes/s2/package.json`, `spikes/s2/network-guard.ts`, `spikes/s2/scripted.ts`, `spikes/s2/run.ts`
- Create: `spikes/s2/fixtures/text.json`, `spikes/s2/fixtures/tool.json`, `spikes/s2/fixtures/quota.json`
- Create: `docs/spikes/s2.md`

**Interfaces:**
- Produces: the script format `{ modelId, steps: [{ text?, toolCalls?: [{ name, args, id? }], stopReason?, errorMessage? }] }` reused by Task 20 (`scripted-provider.ts`) and Task 27 (e2e fixture); the exact `fauxAssistantMessage` option names recorded in the note.

- [ ] **Step 1: Ignore installed dependencies**

Replace `.gitignore` with:

```gitignore
.superpowers/
node_modules/
```

- [ ] **Step 2: Create the spike package and install it**

`spikes/s2/package.json`:

```json
{
  "name": "spike-s2",
  "private": true,
  "type": "module",
  "dependencies": {
    "@earendil-works/pi-ai": "1.1.0",
    "@earendil-works/pi-coding-agent": "1.1.0"
  }
}
```

Run: `cd spikes/s2 && pnpm install --ignore-workspace && cd ../..`
Expected: `node_modules/@earendil-works/pi-coding-agent` exists.

- [ ] **Step 3: Write the network guard**

`spikes/s2/network-guard.ts` (any TCP/TLS connection attempt is counted and refused; Unix sockets stay allowed):

```ts
import net from "node:net";

export const blockedAttempts: string[] = [];
const originalConnect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
  const first = args[0];
  const unixSocket = typeof first === "string" || (typeof first === "object" && first !== null && "path" in first);
  if (unixSocket) return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  blockedAttempts.push(JSON.stringify(first));
  process.stderr.write(`pap-network-guard: blocked ${JSON.stringify(first)}\n`);
  throw new Error("network access is disabled in this process");
} as typeof originalConnect;
```

- [ ] **Step 4: Write the scripted provider loader**

`spikes/s2/scripted.ts`:

```ts
import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

export interface ScriptStep {
  text?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; id?: string }>;
  stopReason?: "stop" | "toolUse" | "error";
  errorMessage?: string;
}
export interface Script {
  modelId: string;
  steps: ScriptStep[];
}

export function loadScript(path: string): Script {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Script>;
  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) throw new Error(`script ${path} has no steps`);
  return { modelId: parsed.modelId ?? "scripted", steps: parsed.steps };
}

export function buildFaux(script: Script) {
  const faux = fauxProvider({ models: [{ id: script.modelId }] });
  faux.setResponses(script.steps.map((step) => () => toMessage(step)));
  return { provider: faux.provider, model: faux.getModel(script.modelId) };
}

function toMessage(step: ScriptStep) {
  const content = [
    ...(step.text === undefined ? [] : [fauxText(step.text)]),
    ...(step.toolCalls ?? []).map((call) => fauxToolCall(call.name, call.args, call.id ? { id: call.id } : {})),
  ];
  const stopReason = step.stopReason ?? ((step.toolCalls?.length ?? 0) > 0 ? "toolUse" : "stop");
  return fauxAssistantMessage(content, {
    stopReason,
    ...(step.errorMessage ? { errorMessage: step.errorMessage } : {}),
  });
}
```

If Node or the SDK rejects the `errorMessage` option at runtime, open `node_modules/@earendil-works/pi-ai/dist/**/faux*.d.ts`, use the real field name, and record it in the note (Step 8).

- [ ] **Step 5: Write the three fixtures**

`spikes/s2/fixtures/text.json` (emoji, accents, CJK and U+2028 check the IPC and JSON paths later):

```json
{ "modelId": "scripted", "steps": [{ "text": "Hello from the scripted provider 👋 ünïcödé 中文 second line" }] }
```

`spikes/s2/fixtures/tool.json`:

```json
{
  "modelId": "scripted",
  "steps": [
    { "toolCalls": [{ "name": "bash", "args": { "command": "echo s2-tool-ok" }, "id": "call-1" }] },
    { "text": "The command printed s2-tool-ok." }
  ]
}
```

`spikes/s2/fixtures/quota.json`:

```json
{
  "modelId": "scripted",
  "steps": [
    { "stopReason": "error", "errorMessage": "429 Too Many Requests: usage limit reached; resets at 2026-10-11T00:00:00Z" },
    { "stopReason": "error", "errorMessage": "429 Too Many Requests: usage limit reached; resets at 2026-10-11T00:00:00Z" },
    { "stopReason": "error", "errorMessage": "429 Too Many Requests: usage limit reached; resets at 2026-10-11T00:00:00Z" }
  ]
}
```

- [ ] **Step 6: Write the runner**

`spikes/s2/run.ts` runs each fixture 20 times through each registration route, hashes the event sequence and the normalized transcript, and prints a JSON report:

```ts
import { blockedAttempts } from "./network-guard.ts";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { buildFaux, loadScript } from "./scripted.ts";

type Route = "native" | "extension";
const RUNS = 20;
const VOLATILE = new Set(["timestamp", "id", "durationMs", "usage", "responseId"]);

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !VOLATILE.has(key))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

async function runOnce(fixture: string, route: Route) {
  const root = mkdtempSync(join(tmpdir(), "pap-s2-"));
  try {
    const faux = buildFaux(loadScript(fileURLToPath(new URL(`./fixtures/${fixture}.json`, import.meta.url))));
    const modelRuntime = await ModelRuntime.create({
      authPath: join(root, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    if (route === "native") modelRuntime.registerNativeProvider(faux.provider);
    const viaExtension: InlineExtension = {
      name: "s2-scripted-provider",
      factory: (pi) => {
        pi.registerProvider(faux.provider);
      },
    };
    const services = await createAgentSessionServices({
      cwd: root,
      agentDir: root,
      modelRuntime,
      settingsManager: SettingsManager.inMemory({
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
      } as never),
      resourceLoaderOptions: {
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: route === "extension" ? [viaExtension] : [],
      },
    });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(root),
      model: faux.model,
    });
    const events: string[] = [];
    session.subscribe((event) => {
      const nested = (event as { assistantMessageEvent?: { type: string } }).assistantMessageEvent;
      events.push(nested ? `${event.type}:${nested.type}` : event.type);
    });
    const started = performance.now();
    await session.prompt("go");
    const elapsedMs = performance.now() - started;
    const transcript = normalize(session.messages);
    session.dispose();
    return { events, transcript, elapsedMs };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const report: Record<string, unknown> = { node: process.version };
for (const fixture of ["text", "tool", "quota"]) {
  for (const route of ["native", "extension"] as const) {
    const runs = [];
    for (let index = 0; index < RUNS; index++) runs.push(await runOnce(fixture, route));
    const hashes = new Set(runs.map((run) => hash({ events: run.events, transcript: run.transcript })));
    report[`${fixture}/${route}`] = {
      deterministic: hashes.size === 1,
      distinctHashes: hashes.size,
      medianMs: Math.round(median(runs.map((run) => run.elapsedMs))),
      events: runs[0]?.events,
      transcript: runs[0]?.transcript,
    };
  }
}
report.networkAttempts = blockedAttempts.length;
console.log(JSON.stringify(report, null, 2));
```

- [ ] **Step 7: Run it and keep the raw result**

Run: `cd spikes/s2 && PI_OFFLINE=1 PI_TELEMETRY=0 node run.ts > results.json; cd ../..`
Expected: `results.json` has six entries with `"deterministic": true`, `"networkAttempts": 0`; `tool/*` events contain `tool_execution_start` and `tool_execution_end` and the transcript contains `s2-tool-ok`; `quota/*` records how Pi surfaces the error (look for `auto_retry_start` / `auto_retry_end` and the last assistant `stopReason` / `errorMessage`). If Node errors on the `.ts` files, your Node is not 24: stop and install Node 24.

- [ ] **Step 8: Write the findings note**

`docs/spikes/s2.md` (fill the bracketed measurements from `results.json`; keep the headings):

~~~markdown
# S2 — scripted custom provider

- Date / Node / Pi SDK: [date] / [process.version] / 1.1.0
- Time-box: 1 day · spent: [hours]

## Question and done-when
Does a scripted custom provider drive full runs (text, tool calls, quota error)? Done when the integration test runs offline and deterministically.

## Measurements
| Scenario | native route deterministic | extension route deterministic | median ms |
|---|---|---|---|
| text | [true/false] | [true/false] | [n] |
| tool | [true/false] | [true/false] | [n] |
| quota | [true/false] | [true/false] | [n] |

- Network attempts during 120 runs: [n]
- `fauxAssistantMessage` option names that worked: [stopReason, errorMessage | real names]
- Unicode text (emoji, CJK, U+2028) round-tripped unchanged in the transcript: [yes/no]
- How a quota error surfaces (events, retries, final stopReason/errorMessage): [summary]
- Retry settings needed to keep a quota test fast and deterministic: [e.g. retry.enabled=false]

## Result against done-when
[one paragraph]

## Consequences for the plan
- Task 20 `scripted-provider.ts`: [no change | changes]
- Task 23 / Task 27 provider scripts: [no change | changes]

Decision: [GO | FALLBACK]
~~~

GO when all six entries are deterministic, network attempts are 0, the tool scenario ran bash and the quota scenario ended in a recorded error. Otherwise FALLBACK (replay recorded Pi events at the transport boundary).

- [ ] **Step 9: Commit**

```bash
git add .gitignore spikes/s2 docs/spikes/s2.md
git commit -m "chore(spike): s2 scripted Pi provider findings"
```

---

### Task 2: S1 — Pi SDK in a forked worker with navigate_tree and a custom panel over IPC (gates M1)

**Time-box:** 2 days.
**Question (C §10):** Can `pi-host` host the SDK in a forked child and support `navigate_tree` and `ctx.ui.custom()` over IPC? **Done when:** a scripted session prompts, branches, renders a custom panel. **Fallback:** per-session `pi --mode rpc` (loses both features).

The spike also records three facts M1 depends on: the `path` Pi gives an inline extension (Task 19 `movePolicyLast`), which `tool_call` handler sees an input mutated by another extension (Task 19 ADR), and fork-to-ready time and RSS (Task 4).

**Files:**
- Create: `spikes/s1/package.json`, `spikes/s1/scripted.ts` (copy of `spikes/s2/scripted.ts`), `spikes/s1/probe-extensions.ts`, `spikes/s1/host.ts`, `spikes/s1/driver.ts`
- Create: `spikes/s1/fixtures/scenario.json`, `spikes/s1/fixtures/probe.json`
- Create: `docs/spikes/s1.md`

**Interfaces:**
- Consumes: `spikes/s2/scripted.ts` (`loadScript`, `buildFaux`) from Task 1.
- Produces: `spikes/s1/host.ts` accepting `{type:"init", cwd, agentDir, script, order, builtins}` and the records `prompt`, `get_tree`, `navigate_tree`, `custom_input`, `probe_report`, `shutdown`; emits `ready{rssMb, readyMs}`, `response`, Pi events, `custom_render`, `custom_close`, `extension_ui_request`. Task 4 forks this host.

- [ ] **Step 1: Create the package, copy the loader, install**

`spikes/s1/package.json`:

```json
{
  "name": "spike-s1",
  "private": true,
  "type": "module",
  "dependencies": {
    "@earendil-works/pi-ai": "1.1.0",
    "@earendil-works/pi-coding-agent": "1.1.0",
    "@earendil-works/pi-tui": "1.1.0"
  }
}
```

Run: `cp spikes/s2/scripted.ts spikes/s1/scripted.ts && cd spikes/s1 && pnpm install --ignore-workspace && cd ../..`

- [ ] **Step 2: Write the fixtures**

`spikes/s1/fixtures/scenario.json`:

```json
{
  "modelId": "scripted",
  "steps": [
    { "text": "reply one" },
    { "text": "reply two" },
    { "text": "reply three" },
    { "toolCalls": [{ "name": "bash", "args": { "command": "echo probe" }, "id": "probe-1" }] },
    { "text": "probe done" }
  ]
}
```

`spikes/s1/fixtures/probe.json`:

```json
{
  "modelId": "scripted",
  "steps": [
    { "toolCalls": [{ "name": "bash", "args": { "command": "echo probe" }, "id": "probe-1" }] },
    { "text": "probe done" }
  ]
}
```

- [ ] **Step 3: Write the probe extensions**

`spikes/s1/probe-extensions.ts`:

```ts
import type { InlineExtension, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";

export const probeLog: Array<{ handler: string; command: string }> = [];

const mutator: InlineExtension = {
  name: "s1-mutator",
  factory: (pi) => {
    pi.on("tool_call", (event) => {
      if (event.toolName !== "bash") return undefined;
      const input = event.input as { command: string };
      probeLog.push({ handler: "mutator", command: input.command });
      input.command = `${input.command} # mutated-by-s1`;
      return undefined;
    });
  },
};

const policyProbe: InlineExtension = {
  name: "pap-policy",
  factory: (pi) => {
    pi.on("tool_call", (event) => {
      if (event.toolName === "bash") probeLog.push({ handler: "pap-policy", command: (event.input as { command: string }).command });
      return undefined;
    });
  },
};

const panel: InlineExtension = {
  name: "s1-panel",
  factory: (pi) => {
    pi.registerCommand("panel", {
      description: "S1 custom panel",
      handler: async (_args, ctx) => {
        const choice = await ctx.ui.custom<string>((_tui, _theme, _keybindings, done) => {
          const items = ["alpha", "beta"];
          let cursor = 0;
          return {
            render: (width: number) => items.map((item, index) => `${index === cursor ? ">" : " "} ${item}`.slice(0, width)),
            handleInput: (data: string) => {
              if (data === "\u001b[B") cursor = Math.min(items.length - 1, cursor + 1);
              else if (data === "\r") done(items[cursor] ?? "none");
            },
            invalidate: () => {},
          };
        });
        ctx.ui.notify(`panel:${choice}`, "info");
      },
    });
  },
};

export type ProbeOrder = "policy-first" | "policy-last" | "override-last";

export function probeExtensions(order: ProbeOrder): InlineExtension[] {
  return order === "policy-last" ? [mutator, policyProbe, panel] : [policyProbe, mutator, panel];
}

export function moveInlinePolicyLast(base: LoadExtensionsResult): LoadExtensionsResult {
  const index = base.extensions.findIndex((extension) => extension.path.includes("pap-policy"));
  if (index < 0) return base;
  const policy = base.extensions[index];
  if (!policy) return base;
  return { ...base, extensions: [...base.extensions.filter((_, i) => i !== index), policy] };
}
```

- [ ] **Step 4: Write the worker host**

`spikes/s1/host.ts`:

```ts
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  Theme,
  VERSION,
  type AgentSession,
  type ExtensionUIContext,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { moveInlinePolicyLast, probeExtensions, probeLog, type ProbeOrder } from "./probe-extensions.ts";
import { buildFaux, loadScript } from "./scripted.ts";

interface Init { type: "init"; cwd: string; agentDir: string; script: string; order: ProbeOrder; builtins: boolean }
type Inbound =
  | Init
  | { type: "prompt"; id: string; message: string }
  | { type: "get_tree"; id: string }
  | { type: "navigate_tree"; id: string; targetId: string }
  | { type: "custom_input"; id: string; data: string }
  | { type: "probe_report"; id: string }
  | { type: "shutdown" };

class PlainTheme extends Theme {
  constructor() {
    super(
      { muted: "", text: "", thinkingXhigh: "", searchMatchText: "" } as ConstructorParameters<typeof Theme>[0],
      { selectedBg: "" } as ConstructorParameters<typeof Theme>[1],
      "truecolor",
    );
  }
  override fg(...[, text]: Parameters<Theme["fg"]>): string { return text; }
  override bg(...[, text]: Parameters<Theme["bg"]>): string { return text; }
  override bold(text: string): string { return text; }
  override italic(text: string): string { return text; }
}

const started = performance.now();
const send = (record: object) => process.send?.(record);
const rssMb = () => Math.round(process.memoryUsage().rss / 1048576);
const panels = new Map<string, (data: string) => void>();
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
const theme = new PlainTheme();
let session: AgentSession | null = null;
let extensionPaths: string[] = [];

function uiContext(): ExtensionUIContext {
  const custom = <T>(factory: Parameters<ExtensionUIContext["custom"]>[0]) =>
    new Promise<T>((resolve) => {
      const id = randomUUID();
      let component: { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void } | null = null;
      const render = () => { if (component) send({ type: "custom_render", id, lines: component.render(92) }); };
      const tui = { terminal: { columns: 92, rows: 40, kittyProtocolActive: false }, requestRender: render };
      const done = (value: unknown) => {
        panels.delete(id);
        component?.dispose?.();
        send({ type: "custom_close", id });
        resolve(value as T);
      };
      void Promise.resolve(factory(tui as never, theme, keybindings, done)).then((created) => {
        component = created;
        panels.set(id, (data) => { created.handleInput?.(data); render(); });
        render();
      });
    });
  return {
    select: async () => undefined,
    confirm: async () => true,
    input: async () => undefined,
    editor: async () => undefined,
    notify: (message: string, notifyType?: string) =>
      send({ type: "extension_ui_request", id: randomUUID(), method: "notify", message, notifyType }),
    custom,
    theme,
  } as unknown as ExtensionUIContext;
}

async function boot(init: Init): Promise<void> {
  const faux = buildFaux(loadScript(init.script));
  const modelRuntime = await ModelRuntime.create({ authPath: join(init.agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const builtins: InlineExtension[] = init.builtins ? [createCodemodeExtension(), createToolSearchExtension(), createMcpExtension()] : [];
  const services = await createAgentSessionServices({
    cwd: init.cwd,
    agentDir: init.agentDir,
    modelRuntime,
    settingsManager: SettingsManager.create(init.cwd, init.agentDir),
    resourceLoaderOptions: {
      extensionFactories: [...builtins, ...probeExtensions(init.order)],
      ...(init.order === "override-last" ? { extensionsOverride: moveInlinePolicyLast } : {}),
    },
  });
  extensionPaths = services.resourceLoader.getExtensions().extensions.map((extension) => extension.path);
  session = (await createAgentSessionFromServices({ services, sessionManager: SessionManager.create(init.cwd), model: faux.model })).session;
  session.subscribe((event) => {
    const nested = (event as { assistantMessageEvent?: { type: string; delta?: string } }).assistantMessageEvent;
    send(nested ? { type: event.type, assistantMessageEvent: { type: nested.type, delta: nested.delta } } : event);
  });
  await session.bindExtensions({ uiContext: uiContext(), mode: "rpc" });
  send({ type: "ready", sessionFile: session.sessionFile, sessionId: session.sessionId, piVersion: VERSION, readyMs: Math.round(performance.now() - started), rssMb: rssMb() });
}

process.on("message", (raw: Inbound) => {
  if (raw.type === "init") { void boot(raw); return; }
  if (raw.type === "custom_input") { panels.get(raw.id)?.(raw.data); return; }
  if (raw.type === "shutdown") { session?.dispose(); process.exit(0); }
  if (!session) return;
  const current = session;
  if (raw.type === "prompt") {
    current
      .prompt(raw.message, { preflightResult: (disposition) => send({ type: "response", id: raw.id, data: { disposition } }) })
      .catch((error: unknown) => send({ type: "response", id: raw.id, error: String(error) }));
  } else if (raw.type === "get_tree") {
    send({ type: "response", id: raw.id, data: { tree: current.sessionManager.getTree(), leafId: current.sessionManager.getLeafId(), rssMb: rssMb() } });
  } else if (raw.type === "navigate_tree") {
    void current.navigateTree(raw.targetId, { summarize: false }).then((result) => send({ type: "response", id: raw.id, data: result }));
  } else if (raw.type === "probe_report") {
    send({ type: "response", id: raw.id, data: { probeLog, extensionPaths } });
  }
});
```

- [ ] **Step 5: Write the driver**

`spikes/s1/driver.ts` forks the host, runs the scenario, prints `results.json`:

```ts
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Rec = { type: string; id?: string; [key: string]: unknown };
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

function startHost(order: string, script: string, builtins = false) {
  const root = mkdtempSync(join(tmpdir(), "pap-s1-"));
  const child: ChildProcess = fork(here("./host.ts"), [], {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: root, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    detached: true,
  });
  const records: Rec[] = [];
  const waiters = new Set<() => void>();
  child.on("message", (record: Rec) => { records.push(record); for (const wake of [...waiters]) wake(); });
  let seq = 0;
  const waitFor = (predicate: (record: Rec) => boolean, from = 0, timeoutMs = 15_000) =>
    new Promise<Rec>((resolve, reject) => {
      const check = () => {
        const hit = records.slice(from).find(predicate);
        if (hit) { waiters.delete(check); clearTimeout(timer); resolve(hit); }
      };
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error("timeout")); }, timeoutMs);
      waiters.add(check);
      check();
    });
  const request = (record: Rec) => {
    const id = `q${++seq}`;
    child.send({ ...record, id });
    return waitFor((r) => r.type === "response" && r.id === id);
  };
  const settle = async (message: string) => {
    const from = records.length;
    await request({ type: "prompt", message });
    await waitFor((r) => r.type === "agent_settled", from);
  };
  child.send({ type: "init", cwd: root, agentDir: root, script: here(script), order, builtins });
  return { child, records, waitFor, request, settle, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

type Node = { entry: { id: string; type: string; message?: { role: string; content: unknown } }; children: Node[] };
const walk = (nodes: Node[]): Node[] => nodes.flatMap((node) => [node, ...walk(node.children)]);
const textOf = (content: unknown) => JSON.stringify(content);

const results: Record<string, unknown> = {};
const main = startHost("policy-first", "./fixtures/scenario.json");
const t0 = performance.now();
const ready = await main.waitFor((r) => r.type === "ready");
results.forkToReadyMs = Math.round(performance.now() - t0);
results.readyRssMb = ready.rssMb;
await main.settle("one");
await main.settle("two");
const tree1 = (await main.request({ type: "get_tree" })).data as { tree: Node[] };
const replyOne = walk(tree1.tree).find((node) => node.entry.message?.role === "assistant" && textOf(node.entry.message.content).includes("reply one"));
if (!replyOne) throw new Error("reply one not found in the tree");
results.navigate = (await main.request({ type: "navigate_tree", targetId: replyOne.entry.id })).data;
await main.settle("three");
const tree2 = (await main.request({ type: "get_tree" })).data as { tree: Node[]; rssMb: number };
results.branched = (walk(tree2.tree).find((node) => node.entry.id === replyOne.entry.id)?.children.length ?? 0) === 2;
const panelFrom = main.records.length;
main.child.send({ type: "prompt", id: "panel", message: "/panel" });
const first = await main.waitFor((r) => r.type === "custom_render", panelFrom);
main.child.send({ type: "custom_input", id: first.id, data: "\u001b[B" });
await main.waitFor((r) => r.type === "custom_render" && JSON.stringify(r.lines).includes("> beta"), panelFrom);
main.child.send({ type: "custom_input", id: first.id, data: "\r" });
await main.waitFor((r) => r.type === "custom_close", panelFrom);
const notice = await main.waitFor((r) => r.type === "extension_ui_request" && r.method === "notify", panelFrom);
results.panel = { firstLines: first.lines, notice: notice.message };
await main.settle("probe");
results.afterRunRssMb = tree2.rssMb;
results["probe:policy-first"] = (await main.request({ type: "probe_report" })).data;
const exitStart = performance.now();
main.child.send({ type: "shutdown" });
await new Promise((resolve) => main.child.once("exit", resolve));
results.shutdownMs = Math.round(performance.now() - exitStart);
main.cleanup();

for (const order of ["policy-last", "override-last"]) {
  const host = startHost(order, "./fixtures/probe.json");
  await host.waitFor((r) => r.type === "ready");
  await host.settle("probe");
  results[`probe:${order}`] = (await host.request({ type: "probe_report" })).data;
  host.child.send({ type: "shutdown" });
  await new Promise((resolve) => host.child.once("exit", resolve));
  host.cleanup();
}
console.log(JSON.stringify(results, null, 2));
```

- [ ] **Step 6: Run the scenario**

Run: `cd spikes/s1 && node driver.ts > results.json; cd ../..`
Expected: `results.json` contains `"branched": true`, `panel.notice` equal to `"panel:beta"`, numbers for `forkToReadyMs`, `readyRssMb`, `afterRunRssMb`, `shutdownMs`, and three `probe:*` entries listing `extensionPaths` and which handler logged `# mutated-by-s1`.

- [ ] **Step 7: Write the findings note**

`docs/spikes/s1.md`:

~~~markdown
# S1 — Pi SDK in a forked worker (navigate_tree, custom panel, IPC)

- Date / Node / Pi SDK: [date] / [version] / 1.1.0
- Time-box: 2 days · spent: [hours]

## Question and done-when
Can pi-host host the SDK in a forked child and support navigate_tree and ctx.ui.custom() over IPC? Done when a scripted session prompts, branches, renders a custom panel.

## Measurements
- Prompts settled over IPC: [yes/no] · fork-to-ready: [ms] · shutdown: [ms]
- navigate_tree then prompt created a sibling branch (`branched`): [true/false]
- Custom panel: first render lines [lines], input moved the cursor, Enter closed it, command received [value]
- RSS: after ready [MB] · after the scripted runs [MB]
- Inline extension `path` reported by Pi for `pap-policy`: [exact string, e.g. `<inline:pap-policy>`]
- Extension order (paths) for policy-first / policy-last / override-last: [lists]
- Command seen by `pap-policy` in each order (mutated or not): [results]

## Result against done-when
[one paragraph]

## Consequences for the plan
- Task 19 `POLICY_EXTENSION_PATH` = [recorded path]
- Task 19 ADR 0002 (evaluate the policy last, on the final input): [confirmed | change]
- Task 4 uses this host for RAM measurement: [ok]

Decision: [GO | FALLBACK]
~~~

GO when prompts settle, `branched` is true and the panel flow completed. Otherwise FALLBACK (per-session `pi --mode rpc`; apply the "Spike fallback" lines of Tasks 19, 20 and 21).

- [ ] **Step 8: Commit**

```bash
git add spikes/s1 docs/spikes/s1.md
git commit -m "chore(spike): s1 Pi SDK worker with navigate_tree and custom panel"
```

---

### Task 3: S3 — FTS5 in Node 24's SQLite

**Time-box:** 2 hours.
**Question (C §10):** Is FTS5 compiled into Node 24's SQLite? **Done when:** `CREATE VIRTUAL TABLE … USING fts5` succeeds. **Fallback:** `better-sqlite3` (native, heavier packaging).

**Files:**
- Create: `spikes/s3/fts5.ts`
- Create: `docs/spikes/s3.md`

**Interfaces:**
- Produces: confirmation for Task 14 (`node:sqlite` engine, `STRICT`, `RETURNING`, WAL) and for roadmap M4 (FTS5 search, `node:sqlite` backup API).

- [ ] **Step 1: Write the probe**

`spikes/s3/fts5.ts` (no dependencies):

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "node:sqlite";

const db = new sqlite.DatabaseSync(":memory:");
const result = {
  node: process.version,
  sqliteVersion: (db.prepare("select sqlite_version() as v").get() as { v: string }).v,
  compileFts5: (db.prepare("pragma compile_options").all() as Array<{ compile_options: string }>).some((row) => row.compile_options === "ENABLE_FTS5"),
  fts5: false,
  bm25: false,
  snippet: false,
  diacriticsFolded: false,
  strictTables: false,
  returning: false,
  wal: false,
  backupApi: typeof (sqlite as Record<string, unknown>).backup === "function",
  index10kMs: 0,
  query10kMs: 0,
  error: null as string | null,
};

try {
  db.exec("create virtual table docs using fts5(title, body, tokenize = 'unicode61 remove_diacritics 2')");
  result.fts5 = true;
  const insert = db.prepare("insert into docs(title, body) values (?, ?)");
  const t0 = performance.now();
  db.exec("begin");
  for (let i = 0; i < 10_000; i++) insert.run(`session ${i}`, `fix the websocket reconnect bug ${i} café ${i % 7 === 0 ? "kubernetes" : "terraform"}`);
  db.exec("commit");
  result.index10kMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  const rows = db
    .prepare("select bm25(docs) as score, snippet(docs, 1, '[', ']', '…', 8) as snip from docs where docs match ? order by score limit 10")
    .all("kubernetes cafe") as Array<{ score: number; snip: string }>;
  result.query10kMs = Math.round(performance.now() - t1);
  result.bm25 = rows.length > 0 && typeof rows[0]?.score === "number";
  result.snippet = rows.some((row) => row.snip.includes("["));
  result.diacriticsFolded = rows.length > 0;
  db.exec("create table t (id integer primary key, v text not null) strict");
  result.strictTables = true;
  result.returning = (db.prepare("insert into t(v) values ('x') returning id").get() as { id: number }).id === 1;
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
}

const dir = mkdtempSync(join(tmpdir(), "pap-s3-"));
const fileDb = new sqlite.DatabaseSync(join(dir, "wal.db"));
result.wal = (fileDb.prepare("pragma journal_mode = wal").get() as { journal_mode: string }).journal_mode === "wal";
fileDb.close();
rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify(result, null, 2));
```

- [ ] **Step 2: Run it**

Run: `node spikes/s3/fts5.ts > spikes/s3/results.json`
Expected: `"fts5": true`, `"bm25": true`, `"strictTables": true`, `"returning": true`, `"wal": true`. Note whether Node prints an `ExperimentalWarning` for `node:sqlite`.

- [ ] **Step 3: Write the findings note**

`docs/spikes/s3.md`:

~~~markdown
# S3 — FTS5 in Node 24's SQLite

- Date / Node / SQLite: [date] / [node] / [sqliteVersion] · time-box 2 h · spent [h]

## Measurements
- ENABLE_FTS5 compile option: [true/false] · `CREATE VIRTUAL TABLE … USING fts5`: [ok/error]
- bm25 / snippet / diacritics folding (`cafe` matches `café`): [true/false each]
- 10 000 rows indexed in [ms], top-10 query in [ms]
- STRICT tables / RETURNING / WAL: [true/false each]
- `node:sqlite` backup() available: [true/false] (input for `pap backup`, roadmap M6)
- ExperimentalWarning printed: [yes/no]

## Consequences for the plan
- Task 14 keeps `node:sqlite`: [yes/no]
- Roadmap M4 FTS5 search: [node:sqlite | better-sqlite3]

Decision: [GO | FALLBACK]
~~~

- [ ] **Step 4: Commit**

```bash
git add spikes/s3 docs/spikes/s3.md
git commit -m "chore(spike): s3 fts5 availability in node:sqlite"
```

---

### Task 4: S4 — idle RAM of one pi-host worker

**Time-box:** 4 hours. Needs Task 2.
**Question (C §10):** Idle RAM of one `pi-host` worker. **Done when:** measured on Linux x64; this sets the default worker cap. **Fallback:** none.

**Files:**
- Create: `spikes/s4/measure.ts`
- Create: `docs/spikes/s4.md`

**Interfaces:**
- Consumes: `spikes/s1/host.ts` (init field `builtins`).
- Produces: `WORKER_BUDGET_MB` for Task 13 and `idleWorkerRssMb` for Task 23 `budgets.json`.

- [ ] **Step 1: Write the measurement driver**

`spikes/s4/measure.ts` (sleeps are allowed here: this is a measurement, not a test):

```ts
import { fork } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { totalmem, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const SAMPLES = 10;
const host = fileURLToPath(new URL("../s1/host.ts", import.meta.url));
const script = fileURLToPath(new URL("../s1/fixtures/scenario.json", import.meta.url));

function memory(pid: number) {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
  const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
  const pssKb = Number(/Pss:\s+(\d+)/.exec(rollup)?.[1] ?? 0);
  return { rssMb: Math.round(rssKb / 1024), pssMb: Math.round(pssKb / 1024) };
}

async function sample(builtins: boolean) {
  const root = mkdtempSync(join(tmpdir(), "pap-s4-"));
  const child = fork(host, [], {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: root, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const next = (type: string) => new Promise<void>((resolve) => {
    const onMessage = (record: { type: string }) => { if (record.type === type) { child.off("message", onMessage); resolve(); } };
    child.on("message", onMessage);
  });
  child.send({ type: "init", cwd: root, agentDir: root, script, order: "policy-last", builtins });
  await next("ready");
  await sleep(3000);
  const idle = memory(child.pid ?? 0);
  child.send({ type: "prompt", id: "p", message: "one" });
  await next("agent_settled");
  await sleep(3000);
  const afterPrompt = memory(child.pid ?? 0);
  child.send({ type: "shutdown" });
  await new Promise((resolve) => child.once("exit", resolve));
  rmSync(root, { recursive: true, force: true });
  return { idle, afterPrompt };
}

const pick = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))] ?? 0;
const report: Record<string, unknown> = { node: process.version, totalMemMb: Math.round(totalmem() / 1048576) };
for (const builtins of [false, true]) {
  const runs = [];
  for (let i = 0; i < SAMPLES; i++) runs.push(await sample(builtins));
  const idle = runs.map((run) => run.idle.rssMb);
  const after = runs.map((run) => run.afterPrompt.rssMb);
  const pss = runs.map((run) => run.afterPrompt.pssMb);
  report[builtins ? "builtins" : "baseline"] = {
    idleRss: { median: pick(idle, 0.5), p95: pick(idle, 0.95) },
    afterPromptRss: { median: pick(after, 0.5), p95: pick(after, 0.95) },
    afterPromptPss: { median: pick(pss, 0.5), p95: pick(pss, 0.95) },
  };
}
console.log(JSON.stringify(report, null, 2));
```

- [ ] **Step 2: Run on Linux x64**

Run: `node spikes/s4/measure.ts > spikes/s4/results.json`
Expected: two entries (`baseline`, `builtins`) with median and p95 values in MB.

- [ ] **Step 3: Write the findings note with the derived constants**

`docs/spikes/s4.md`:

~~~markdown
# S4 — idle RAM of one pi-host worker

- Date / machine (CPU, total RAM) / Node / Pi SDK: [values] · time-box 4 h · spent [h]

## Measurements (MB, 10 samples each)
| Variant | idle RSS median / p95 | after one prompt RSS median / p95 | after prompt PSS median / p95 |
|---|---|---|---|
| baseline (no built-ins) | [n] / [n] | [n] / [n] | [n] / [n] |
| with codemode + tool_search + mcp | [n] / [n] | [n] / [n] | [n] / [n] |

## Derived values
- `WORKER_BUDGET_MB` = ceil(builtins after-prompt RSS p95 × 1.5) = [n]  → Task 13 `kernel/config.ts`
- default worker cap = clamp(floor(totalMemMb × 0.5 / WORKER_BUDGET_MB), 2, 16) → on this machine [n]
- `idleWorkerRssMb` budget = ceil(baseline idle RSS p95 × 1.2) = [n]  → Task 23 `budgets.json`

Decision: GO
~~~

- [ ] **Step 4: Commit**

```bash
git add spikes/s4 docs/spikes/s4.md
git commit -m "chore(spike): s4 idle pi-host worker memory"
```

---

### Task 5: S7 — is `~/.pi/agent/trust.json` Pi's own file?

**Time-box:** 2 hours.
**Question (C §10):** Project trust: is `~/.pi/agent/trust.json` Pi's file? **Done when:** read Pi docs / pi-web `lib/project-trust.ts`. **Fallback:** pap keeps its own `project_trust` table.

Known before starting: the SDK exports `ProjectTrustStore(agentDir)` and `hasTrustRequiringProjectResources(cwd)` (`dist/core/trust-manager.d.ts`), and pi-web gates project extensions with them (`pi-web/lib/project-trust.ts`, `projectTrustReloadOptions`).

**Files:**
- Create: `spikes/s7/package.json`, `spikes/s7/trust.ts`
- Create: `docs/spikes/s7.md`

**Interfaces:**
- Produces: the trust mechanism used by Task 20 `open-session.ts` (`resolveProjectTrust`).

- [ ] **Step 1: Create the package**

`spikes/s7/package.json`:

```json
{ "name": "spike-s7", "private": true, "type": "module", "dependencies": { "@earendil-works/pi-coding-agent": "1.1.0" } }
```

Run: `cd spikes/s7 && pnpm install --ignore-workspace && cd ../..`

- [ ] **Step 2: Write the probe**

`spikes/s7/trust.ts`:

```ts
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";

const agentDir = mkdtempSync(join(tmpdir(), "pap-s7-agent-"));
const project = mkdtempSync(join(tmpdir(), "pap-s7-project-"));
const before = hasTrustRequiringProjectResources(project);
mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
const after = hasTrustRequiringProjectResources(project);
const store = new ProjectTrustStore(agentDir);
store.set(project, true);
const files = (readdirSync(agentDir, { recursive: true }) as string[]).filter((path) => statSync(join(agentDir, path)).isFile());
console.log(JSON.stringify({
  requiresTrustEmpty: before,
  requiresTrustWithExtensions: after,
  decision: store.get(project),
  files,
  contents: Object.fromEntries(files.map((file) => [file, readFileSync(join(agentDir, file), "utf8")])),
}, null, 2));
rmSync(agentDir, { recursive: true, force: true });
rmSync(project, { recursive: true, force: true });
```

- [ ] **Step 3: Run it and read the docs**

Run: `cd spikes/s7 && node trust.ts > results.json; cd ../..`
Expected: `files` lists the trust file written under the agent dir (expected `trust.json`), `decision: true`, `requiresTrustWithExtensions: true`.
Then read `pi-web/node_modules/@earendil-works/pi-coding-agent/docs/security.md` and `settings.md` (`defaultProjectTrust`) and `pi-web/lib/project-trust.ts` (read only).

- [ ] **Step 4: Write the findings note**

`docs/spikes/s7.md`:

~~~markdown
# S7 — project trust file ownership

- Date / Pi SDK: [date] / 1.1.0 · time-box 2 h · spent [h]

## Findings
- File written by `ProjectTrustStore.set()`: [relative path under agentDir] · format: [JSON shape]
- The `pi` CLI and the SDK share this store (same class): [yes/no, evidence]
- What makes a folder require trust (`hasTrustRequiringProjectResources`): [summary]
- pi-web pattern: `resolveProjectTrust: async () => new ProjectTrustStore(agentDir).get(cwd) === true` [confirmed]

## Consequences for the plan
- Task 20 uses `ProjectTrustStore` read-only; an untrusted project loads no project resources (fail closed). Trusting a project from pap UI comes in roadmap M7.

Decision: [GO | FALLBACK]
~~~

- [ ] **Step 5: Commit**

```bash
git add spikes/s7 docs/spikes/s7.md
git commit -m "chore(spike): s7 project trust store ownership"
```

---

### Task 6: S8 — bubblewrap inside the OCI image without extra privileges

**Time-box:** 4 hours. Prerequisite: Docker (and Podman if available) on a Linux x64 host. Does not block M1.
**Question (C §10):** bwrap inside the OCI image without extra privileges. **Done when:** sandboxed bash works under default Docker. **Fallback:** document the required `--security-opt`; the fail-closed rule applies.

**Files:**
- Create: `spikes/s8/Dockerfile`, `spikes/s8/probe.sh`, `spikes/s8/matrix.sh`
- Create: `docs/spikes/s8.md`

**Interfaces:**
- Produces: the container sandbox requirements for roadmap M6 (OCI image) and M11 (agent sandbox).

- [ ] **Step 1: Write the image**

`spikes/s8/Dockerfile`:

```dockerfile
FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap tini \
  && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 10001 pap
COPY --chown=pap:pap probe.sh /home/pap/probe.sh
USER pap
WORKDIR /home/pap
ENTRYPOINT ["/usr/bin/tini", "--", "sh", "/home/pap/probe.sh"]
```

- [ ] **Step 2: Write the in-container probe (pi-web's sandbox profile, `pi-web/lib/agents/sandbox.ts`)**

`spikes/s8/probe.sh`:

```sh
#!/bin/sh
set -u
mkdir -p /home/pap/agent-home
run() {
  label=$1
  shift
  if out=$("$@" 2>&1); then echo "PASS $label: $out"; else echo "FAIL $label: $out"; fi
}
run minimal bwrap --ro-bind / / --dev /dev --proc /proc -- sh -c 'echo ok'
run unshare-pid bwrap --ro-bind / / --unshare-pid --dev /dev --proc /proc -- sh -c 'echo ok'
run unshare-net bwrap --ro-bind / / --unshare-net --dev /dev --proc /proc -- sh -c 'echo ok'
run pi-web-profile bwrap --ro-bind / / --unshare-pid --proc /proc --dev /dev --unshare-ipc \
  --tmpfs /run --tmpfs /tmp --tmpfs /home/pap \
  --bind /home/pap/agent-home /home/pap/agent-home --unshare-net --die-with-parent \
  -- sh -c 'touch /home/pap/agent-home/w && echo ok'
```

- [ ] **Step 3: Write the host-side matrix**

`spikes/s8/matrix.sh`:

```sh
#!/bin/sh
set -eu
cd "$(dirname "$0")"
docker build -t pap-s8 .
for opts in "" "--security-opt seccomp=unconfined" "--security-opt apparmor=unconfined" \
  "--security-opt seccomp=unconfined --security-opt apparmor=unconfined" "--cap-add SYS_ADMIN" \
  "--security-opt systempaths=unconfined"; do
  echo "=== docker run $opts"
  # shellcheck disable=SC2086
  docker run --rm $opts pap-s8 || true
done
if command -v podman >/dev/null 2>&1; then
  podman build -t pap-s8 .
  echo "=== podman run (rootless)"
  podman run --rm pap-s8 || true
fi
```

- [ ] **Step 4: Run the matrix**

Run: `sh spikes/s8/matrix.sh > spikes/s8/results.txt 2>&1`
Expected: one PASS/FAIL line per probe for each option set; the first block is default Docker.

- [ ] **Step 5: Write the findings note**

`docs/spikes/s8.md`:

~~~markdown
# S8 — bwrap in the OCI image

- Date / Docker version / kernel / AppArmor+seccomp profile: [values] · time-box 4 h · spent [h]

## Matrix
| Option set | minimal | unshare-pid | unshare-net | pi-web profile |
|---|---|---|---|---|
| default docker | [P/F] | [P/F] | [P/F] | [P/F] |
| seccomp=unconfined | … | … | … | … |
| apparmor=unconfined | … | … | … | … |
| both | … | … | … | … |
| cap-add SYS_ADMIN | … | … | … | … |
| systempaths=unconfined | … | … | … | … |
| podman rootless | … | … | … | … |

## Result
- Minimal option set that runs the pi-web profile: [options]
- Documentation line for `compose.yaml` and the image README: [text]
- Fail-closed rule (C §9.2): an agent requiring the sandbox refuses to start when the probe fails; `pap doctor` reports it.

Decision: [GO | FALLBACK]
~~~

- [ ] **Step 6: Commit**

```bash
git add spikes/s8 docs/spikes/s8.md
git commit -m "chore(spike): s8 bubblewrap inside the OCI image"
```

---

### Task 7: S5 — diff renderer: `@pierre/diffs` vs CodeMirror merge

**Time-box:** 1 day. Does not block M1 (feeds roadmap M9, lanes review).
**Question (C §10):** Diff renderer: `@pierre/diffs` (licence, size) vs CodeMirror merge. **Done when:** lane review prototype with line comments. **Fallback:** the other candidate.

**Files:**
- Create: `spikes/s5/package.json`, `spikes/s5/index.html`, `spikes/s5/vite.config.ts`
- Create: `spikes/s5/src/main.tsx`, `spikes/s5/src/codemirror-review.ts`, `spikes/s5/src/pierre-review.tsx`, `spikes/s5/src/comments.ts`
- Create: `spikes/s5/fixtures/before.ts`, `spikes/s5/fixtures/after.ts`, `spikes/s5/measure.ts`
- Create: `docs/spikes/s5.md`

**Interfaces:**
- Produces: the diff library decision for roadmap M9.

- [ ] **Step 1: Create the prototype package and install**

`spikes/s5/package.json`:

```json
{
  "name": "spike-s5",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build:cm": "vite build --mode codemirror", "build:pierre": "vite build --mode pierre" }
}
```

Run: `cd spikes/s5 && pnpm add --ignore-workspace -E react react-dom @codemirror/state @codemirror/view @codemirror/merge @pierre/diffs && pnpm add --ignore-workspace -D -E vite @vitejs/plugin-react typescript @types/react @types/react-dom && cd ../..`

`spikes/s5/vite.config.ts` (one entry per candidate so their bundles are measured apart):

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: { __CANDIDATE__: JSON.stringify(mode === "pierre" ? "pierre" : "codemirror") },
  build: { target: ["safari16.4", "chrome111", "firefox111"], outDir: `dist-${mode}` },
}));
```

`spikes/s5/index.html`:

```html
<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>S5 diff review</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

- [ ] **Step 2: Write the fixtures**

Create `spikes/s5/fixtures/before.ts` and `spikes/s5/fixtures/after.ts` by copying two revisions of a real ~200-line TypeScript file:

Run: `git -C ../pi-web show HEAD~20:lib/auth-throttle.ts > spikes/s5/fixtures/before.ts && cp ../pi-web/lib/auth-throttle.ts spikes/s5/fixtures/after.ts`
(If the two revisions are identical, pick `HEAD~60`; the goal is a diff with additions, deletions and an unchanged block. Reading pi-web with git is allowed; nothing in pi-web is modified.)

- [ ] **Step 3: Write the shared comment model**

`spikes/s5/src/comments.ts`:

```ts
export interface LineComment {
  readonly line: number;
  readonly side: "before" | "after";
  readonly text: string;
}

export function addComment(list: readonly LineComment[], comment: LineComment): LineComment[] {
  return [...list.filter((c) => !(c.line === comment.line && c.side === comment.side)), comment].sort((a, b) => a.line - b.line);
}
```

- [ ] **Step 4: Write the CodeMirror candidate (unified view + comment gutter)**

`spikes/s5/src/codemirror-review.ts`:

```ts
import { EditorState } from "@codemirror/state";
import { EditorView, gutter, GutterMarker, lineNumbers } from "@codemirror/view";
import { unifiedMergeView } from "@codemirror/merge";

class CommentMarker extends GutterMarker {
  override toDOM(): Node {
    const span = document.createElement("span");
    span.textContent = "+";
    span.title = "Comment on this line";
    return span;
  }
}
const marker = new CommentMarker();

export function mountCodeMirrorReview(parent: HTMLElement, before: string, after: string, onComment: (line: number) => void): () => void {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: after,
      extensions: [
        lineNumbers(),
        EditorView.editable.of(false),
        unifiedMergeView({ original: before, mergeControls: false }),
        gutter({
          class: "cm-comment-gutter",
          lineMarker: () => marker,
          initialSpacer: () => marker,
          domEventHandlers: {
            mousedown: (editor, line) => {
              onComment(editor.state.doc.lineAt(line.from).number);
              return true;
            },
          },
        }),
      ],
    }),
  });
  return () => view.destroy();
}
```

- [ ] **Step 5: Write the `@pierre/diffs` candidate against the same contract**

Read `spikes/s5/node_modules/@pierre/diffs/README.md` (and its exported `.d.ts`) to find the component that renders a two-version or unified diff and its line-annotation hook. Implement `spikes/s5/src/pierre-review.tsx` with exactly this exported signature, so `main.tsx` treats both candidates the same:

```tsx
export interface ReviewProps {
  readonly before: string;
  readonly after: string;
  readonly fileName: string;
  readonly onComment: (line: number) => void;
}
export function PierreReview(props: ReviewProps): JSX.Element;
```

Record in the note which exported component and props you used; if no line hook exists, record that as a failed criterion.

- [ ] **Step 6: Write the page**

`spikes/s5/src/main.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import after from "../fixtures/after.ts?raw";
import before from "../fixtures/before.ts?raw";
import { mountCodeMirrorReview } from "./codemirror-review.ts";
import { addComment, type LineComment } from "./comments.ts";
import { PierreReview } from "./pierre-review.tsx";

declare const __CANDIDATE__: "codemirror" | "pierre";

function App() {
  const [comments, setComments] = useState<LineComment[]>([]);
  const host = useRef<HTMLDivElement>(null);
  const onComment = (line: number) => {
    const text = window.prompt(`Comment on line ${line}`) ?? "";
    if (text) setComments((list) => addComment(list, { line, side: "after", text }));
  };
  useEffect(() => {
    if (__CANDIDATE__ !== "codemirror" || !host.current) return undefined;
    return mountCodeMirrorReview(host.current, before, after, onComment);
  }, []);
  return (
    <main>
      <h1>{__CANDIDATE__}</h1>
      {__CANDIDATE__ === "pierre" ? <PierreReview before={before} after={after} fileName="auth-throttle.ts" onComment={onComment} /> : <div ref={host} />}
      <ol data-testid="comments">{comments.map((c) => <li key={`${c.side}:${c.line}`}>{c.line}: {c.text}</li>)}</ol>
    </main>
  );
}
createRoot(document.getElementById("root") as HTMLElement).render(<App />);
```

- [ ] **Step 7: Measure size and licence**

`spikes/s5/measure.ts`:

```ts
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const gzipKb = (dir: string) =>
  Math.round(
    readdirSync(join(dir, "assets"))
      .filter((file) => file.endsWith(".js"))
      .reduce((sum, file) => sum + gzipSync(readFileSync(join(dir, "assets", file))).length, 0) / 1024,
  );
const licence = (pkg: string) => (JSON.parse(readFileSync(join("node_modules", pkg, "package.json"), "utf8")) as { license?: string }).license ?? "missing";
execFileSync("pnpm", ["build:cm"], { stdio: "inherit" });
execFileSync("pnpm", ["build:pierre"], { stdio: "inherit" });
console.log(JSON.stringify({
  codemirrorGzipKb: gzipKb("dist-codemirror"),
  pierreGzipKb: gzipKb("dist-pierre"),
  licences: { "@codemirror/merge": licence("@codemirror/merge"), "@pierre/diffs": licence("@pierre/diffs") },
}, null, 2));
```

Run: `cd spikes/s5 && node measure.ts > results.json && cd ../..`
Then run `pnpm dev` in `spikes/s5` and open the page in Safari 16.4+ (or Playwright WebKit) and Chrome for each mode; add three comments, including one on a deleted line.

- [ ] **Step 8: Write the findings note**

`docs/spikes/s5.md`:

~~~markdown
# S5 — diff renderer

- Date · time-box 1 day · spent [h]

| Criterion | @pierre/diffs | CodeMirror merge |
|---|---|---|
| Licence | [spdx] | [spdx] |
| Gzip JS of the prototype | [KB] | [KB] |
| Line comments (added / deleted / unchanged lines) | [ok/no] | [ok/no] |
| Renders on WebKit (Safari 16.4 floor) | [ok/no] | [ok/no] |
| Worker / large-diff support | [notes] | [notes] |
| Fits E1 tokens (no raw colours needed) | [notes] | [notes] |
| Component / API used | [name] | unifiedMergeView + gutter |

Choice for roadmap M9: [library] because [reason].

Decision: [GO (@pierre/diffs) | FALLBACK (CodeMirror merge)]
~~~

- [ ] **Step 9: Commit**

```bash
git add spikes/s5 docs/spikes/s5.md
git commit -m "chore(spike): s5 diff renderer comparison"
```

---

### Task 8: S6 — AI Elements licence and fit with Radix + Tailwind 4

**Time-box:** 4 hours. Does not block M1 (feeds roadmap M3).
**Question (C §10):** AI Elements licence and fit with Radix + Tailwind 4. **Done when:** licence confirmed, one component ported. **Fallback:** build our own from the T3 / pi-web patterns.

**Files:**
- Create: `spikes/s6/upstream/` (fetched sources, read only), `spikes/s6/src/Message.tsx`, `spikes/s6/check.ts`
- Create: `docs/spikes/s6.md`

**Interfaces:**
- Produces: the decision for `packages/ui/src/ai/*` in roadmap M3.

- [ ] **Step 1: Confirm the repository and the licence**

Run: `gh api repos/vercel/ai-elements --jq '{full_name, license: .license.spdx_id, default_branch}' > spikes/s6/repo.json`
Expected: a JSON object with a `license` SPDX id. If the repository moved, find it with `gh search repos "ai-elements" --owner vercel` and record the real name.

- [ ] **Step 2: Fetch the Message component source (read only)**

Run:

```bash
mkdir -p spikes/s6/upstream
gh api "repos/vercel/ai-elements/git/trees/HEAD?recursive=1" --jq '.tree[].path' | grep -i 'message' > spikes/s6/upstream/paths.txt
```

Pick the `message.tsx` path from `paths.txt`, then:

```bash
gh api "repos/vercel/ai-elements/contents/<path-from-paths.txt>" --jq .content | base64 -d > spikes/s6/upstream/message.tsx
```

- [ ] **Step 3: Port it to E1 tokens without shadcn or the `ai` SDK types**

`spikes/s6/src/Message.tsx` is the ported target. Keep the upstream structure (component split, slots, ARIA) and replace its classes and imports with this token vocabulary (the same names Task 24 defines in `packages/ui/src/tokens.css`):

```tsx
import type { ReactNode } from "react";

export type Author = "agent" | "you" | "tool";

const RULE: Record<Author, string> = {
  agent: "border-agent",
  you: "border-human",
  tool: "border-line",
};

export interface MessageProps {
  readonly author: Author;
  readonly label: string;
  readonly children: ReactNode;
}

export function Message({ author, label, children }: MessageProps) {
  return (
    <article data-author={author} className={`border-l-2 ${RULE[author]} bg-bg px-3 py-2`}>
      <header className="font-mono text-label uppercase tracking-wider text-muted">{label}</header>
      <div className="mt-1 text-chat text-fg">{children}</div>
    </article>
  );
}
```

Merge the upstream parts you keep (for example avatar, content, actions) into this file under the same rules: no raw colours, no `[…]` arbitrary Tailwind values, no dependency on `ai` package types.

- [ ] **Step 4: Check the port against the design rules**

`spikes/s6/check.ts`:

```ts
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./src/Message.tsx", import.meta.url), "utf8");
const rawColour = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch)\(/;
const arbitrary = /[\w:-]+-\[[^\]\s]+\]/;
const aiTypes = /from\s+["']ai["']/;
console.log(JSON.stringify({
  rawColour: rawColour.test(source),
  arbitraryValues: arbitrary.test(source),
  importsAiSdk: aiTypes.test(source),
}, null, 2));
```

Run: `node spikes/s6/check.ts`
Expected: all three `false`.

- [ ] **Step 5: Write the findings note**

`docs/spikes/s6.md`:

~~~markdown
# S6 — AI Elements fit

- Date · time-box 4 h · spent [h]
- Repository / licence (SPDX) / commit read: [values]
- Upstream dependencies of `message.tsx` (shadcn primitives, `ai` types, other): [list]
- Port effort for one component: [h] · lines kept vs rewritten: [n / n]
- Design-rule check (raw colours / arbitrary values / ai import): [false/false/false]

## Recommendation for roadmap M3
[adopt structure with attribution | build our own from T3 / pi-web patterns], because [reason].

Decision: [GO | FALLBACK]
~~~

- [ ] **Step 6: Commit**

```bash
git add spikes/s6 docs/spikes/s6.md
git commit -m "chore(spike): s6 AI Elements licence and port"
```

---

# M1 — Walking skeleton

M1 is written for the spike success path. Where a spike fallback would change a task, the task carries one line starting with **Spike fallback**.

M1 exit criterion: `pnpm lint && pnpm typecheck && pnpm knip && pnpm test:unit && pnpm test:int && pnpm build && pnpm e2e && pnpm budgets` all pass locally and in CI, and the Playwright journey setup → login → prompt → approval → result passes on Chromium and WebKit.

### Task 9: pnpm workspace, strict TypeScript, Vitest, Prettier

**Files:**
- Modify: `.gitignore`
- Create: `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `.nvmrc`, `tsconfig.base.json`, `.prettierrc.json`, `.prettierignore`, `vitest.config.ts`, `AGENTS.md`
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`, `packages/contracts/tsconfig.build.json`, `packages/contracts/src/index.ts`
- Create: `packages/pi-host/package.json`, `packages/pi-host/tsconfig.json`, `packages/pi-host/tsconfig.build.json`
- Test: `packages/pi-host/src/type-stripping.int.test.ts`

**Interfaces:**
- Produces: root scripts `lint`, `format:check`, `typecheck`, `knip`, `test:unit`, `test:int`, `build`, `e2e`, `budgets`; Vitest projects `unit` (`*.test.ts(x)`) and `integration` (`*.int.test.ts`); the `development` export condition on every workspace package; `@pap/contracts` exporting `PROTOCOL_VERSION` (Task 12 replaces `src/index.ts` with the full barrel and keeps that export).

- [ ] **Step 1: Root files**

`.gitignore`:

```gitignore
.superpowers/
node_modules/
dist/
coverage/
test-results/
playwright-report/
e2e/.state/
*.tsbuildinfo
```

`package.json`:

```json
{
  "name": "pi-agentic-platform",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24 <25" },
  "scripts": {
    "lint": "eslint . --max-warnings=0",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "typecheck": "pnpm -r --parallel run typecheck",
    "knip": "knip",
    "test:unit": "vitest run --project unit",
    "test:int": "vitest run --project integration",
    "build": "pnpm -r run build",
    "e2e": "playwright test",
    "budgets": "node scripts/check-budgets.ts"
  }
}
```

`pnpm-workspace.yaml` (`minimumReleaseAge` is in minutes: 3 days; needs pnpm ≥ 10.16):

```yaml
packages:
  - apps/*
  - packages/*
catalog:
  "@earendil-works/pi-coding-agent": 1.1.0
  "@earendil-works/pi-ai": 1.1.0
  "@earendil-works/pi-tui": 1.1.0
minimumReleaseAge: 4320
onlyBuiltDependencies: []
```

`.npmrc`:

```ini
engine-strict=true
```

`.nvmrc`:

```text
24
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "rewriteRelativeImportExtensions": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "types": ["node"]
  }
}
```

`.prettierrc.json`:

```json
{ "printWidth": 110, "trailingComma": "all" }
```

`.prettierignore`:

```text
pnpm-lock.yaml
docs/
spikes/
**/dist/
coverage/
playwright-report/
test-results/
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["development"] },
  ssr: { resolve: { conditions: ["development"] } },
  esbuild: { jsx: "automatic" },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["{apps,packages}/*/src/**/*.test.{ts,tsx}", "eslint/**/*.test.js", "scripts/**/*.test.ts"],
          exclude: ["**/*.int.test.ts", "**/node_modules/**", "**/dist/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["{apps,packages}/*/src/**/*.int.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          pool: "forks",
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
```

- [ ] **Step 2: AGENTS.md (≤ 150 lines)**

`AGENTS.md`:

~~~markdown
# pap — agent notes

Self-hosted agentic platform on the Pi SDK. Specs: `docs/specs/` (C = architecture). Plans: `docs/plans/`.

## Commands
- `pnpm install` · `pnpm lint` · `pnpm format:check` · `pnpm typecheck` · `pnpm knip`
- `pnpm test:unit` · `pnpm test:int` (forks real pi-host workers with a scripted provider)
- `pnpm build` · `pnpm e2e` (Chromium + WebKit) · `pnpm budgets`
- Dev: `pnpm --filter @pap/daemon dev` (port and PAP_HOME derived from the worktree path) + `pnpm --filter @pap/web dev`

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
~~~

- [ ] **Step 3: Package skeletons**

`packages/contracts/package.json`:

```json
{
  "name": "@pap/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": { "development": "./src/index.ts", "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "build": "tsc -p tsconfig.build.json"
  }
}
```

`packages/contracts/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "customConditions": ["development"] },
  "include": ["src"]
}
```

`packages/contracts/tsconfig.build.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/pi-host/package.json`:

```json
{
  "name": "@pap/pi-host",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": { "development": "./src/main.ts", "default": "./dist/main.js" }
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "build": "tsc -p tsconfig.build.json"
  },
  "dependencies": {
    "@pap/contracts": "workspace:*"
  }
}
```

`packages/pi-host/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "customConditions": ["development"] },
  "include": ["src"]
}
```

`packages/pi-host/tsconfig.build.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts", "src/testing/**"]
}
```

- [ ] **Step 4: Pin the toolchain and install**

Run:

```bash
corepack enable && corepack use pnpm@10
pnpm add -Dw -E typescript vitest prettier @types/node
pnpm --filter @pap/contracts add -E zod@^4
pnpm install
```

Expected: `package.json` gains an exact `packageManager` field and exact dev dependency versions; `pnpm-lock.yaml` exists. If pnpm prints "Ignored build scripts", check each package: allow one in `onlyBuiltDependencies` only if it cannot work without its script, with a YAML comment saying why.

- [ ] **Step 5: Write the failing type-stripping test**

`packages/pi-host/src/type-stripping.int.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const piHostDir = fileURLToPath(new URL("..", import.meta.url));

describe("Node 24 type stripping across workspace packages", () => {
  it("imports @pap/contracts from its TypeScript sources under the development condition", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--conditions=development",
        "--input-type=module",
        "-e",
        "const m = await import('@pap/contracts'); process.stdout.write(String(m.PROTOCOL_VERSION));",
      ],
      { cwd: piHostDir, encoding: "utf8" },
    );
    expect(output).toBe("1");
  });
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `pnpm test:int packages/pi-host/src/type-stripping.int.test.ts`
Expected: FAIL (`Cannot find module` …`packages/contracts/src/index.ts`).

- [ ] **Step 7: Create the contracts entry**

`packages/contracts/src/index.ts`:

```ts
export const PROTOCOL_VERSION = 1;
```

- [ ] **Step 8: Run the test and the type check**

Run: `pnpm test:int packages/pi-host/src/type-stripping.int.test.ts && pnpm typecheck`
Expected: PASS, no type errors.

**Fallback if Node refuses to strip types for the linked package** (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`): `pnpm --filter @pap/pi-host add -D -E tsx`, and use `["--conditions=development", "--import", "tsx"]` wherever this plan forks TypeScript sources (Tasks 20, 21, 23, test helpers).

- [ ] **Step 9: Format and commit**

```bash
pnpm format
git add .gitignore package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .nvmrc tsconfig.base.json .prettierrc.json .prettierignore vitest.config.ts AGENTS.md packages
git commit -m "chore: scaffold pnpm workspace with strict TypeScript and Vitest"
```

---

### Task 10: ESLint gates (max-lines, boundaries, reasoned disables, design rules) and knip

**Files:**
- Create: `eslint.config.js`, `eslint/pap-plugin.js`, `knip.json`
- Test: `eslint/pap-plugin.test.js`
- Modify: `package.json` (dev dependencies)

**Interfaces:**
- Produces: boundary element types `contracts`, `ui`, `pi-host`, `kernel`, `module` (captures `domain`), `daemon-root`, `daemon-testing`, `web-runtime`, `web-stores`, `web-feature` (captures `domain`), `web-routes`, `web-i18n`, `web-root`; local rules `pap/no-raw-colors`, `pap/no-arbitrary-values`, `pap/no-restyle`, `pap/zustand-selector`.

- [ ] **Step 1: Install the lint toolchain**

Run: `pnpm add -Dw -E eslint @eslint/js typescript-eslint eslint-plugin-boundaries@5 eslint-import-resolver-typescript @eslint-community/eslint-plugin-eslint-comments eslint-plugin-react-hooks globals knip`

- [ ] **Step 2: Write the failing rule tests**

`eslint/pap-plugin.test.js`:

```js
import { ESLint, RuleTester } from "eslint";
import { describe, expect, it } from "vitest";
import tseslint from "typescript-eslint";
import pap from "./pap-plugin.js";

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
});

tester.run("no-raw-colors", pap.rules["no-raw-colors"], {
  valid: [{ code: 'const c = "text-agent bg-panel";' }, { code: 'const href = "#setup";' }],
  invalid: [
    { code: 'const c = "#A78BFA";', errors: [{ messageId: "raw" }] },
    { code: "const s = { color: `rgb(1, 2, 3)` };", errors: [{ messageId: "raw" }] },
  ],
});

tester.run("no-arbitrary-values", pap.rules["no-arbitrary-values"], {
  valid: [{ code: 'const c = "w-11 h-6.5 rounded-sm";' }],
  invalid: [
    { code: 'const c = "w-[13px]";', errors: [{ messageId: "arbitrary" }] },
    { code: 'const c = "hover:bg-[#fff] p-2";', errors: [{ messageId: "arbitrary" }] },
  ],
});

tester.run("no-restyle", pap.rules["no-restyle"], {
  valid: [{ code: 'import { Button } from "@pap/ui"; const x = <Button variant="primary">ok</Button>;' }],
  invalid: [
    {
      code: 'import { Button } from "@pap/ui"; const x = <Button className="mt-2">ok</Button>;',
      errors: [{ messageId: "restyle" }],
    },
  ],
});

tester.run("zustand-selector", pap.rules["zustand-selector"], {
  valid: [{ code: "const v = useSessionStore((s) => s.views);" }],
  invalid: [{ code: "const all = useSessionStore();", errors: [{ messageId: "selector" }] }],
});

describe("repository gates", () => {
  const eslint = new ESLint({ cwd: process.cwd() });

  it("rejects a file over 400 lines", async () => {
    const code = Array.from({ length: 401 }, (_, i) => `export const v${i} = ${i};`).join("\n");
    const [result] = await eslint.lintText(code, { filePath: "packages/contracts/src/too-long.ts" });
    expect(result?.messages.map((m) => m.ruleId)).toContain("max-lines");
  });

  it("rejects an eslint-disable without a reason", async () => {
    const code = "// eslint-disable-next-line no-console\nconsole.log(1);\n";
    const [result] = await eslint.lintText(code, { filePath: "packages/contracts/src/disable.ts" });
    expect(result?.messages.map((m) => m.ruleId)).toContain("@eslint-community/eslint-comments/require-description");
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm test:unit eslint/pap-plugin.test.js`
Expected: FAIL (`Cannot find module './pap-plugin.js'`).

- [ ] **Step 4: Write the local plugin**

`eslint/pap-plugin.js`:

```js
const RAW_COLOR = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![\w-])|\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(/;
const ARBITRARY = /(?:^|\s)[!\w:/.-]*-\[[^\]\s]+\]/;

function stringRule(messageId, message, pattern) {
  return {
    meta: { type: "problem", messages: { [messageId]: message }, schema: [] },
    create(context) {
      const check = (node, value) => {
        if (typeof value === "string" && pattern.test(value)) context.report({ node, messageId });
      };
      return {
        Literal: (node) => check(node, node.value),
        TemplateElement: (node) => check(node, node.value.cooked ?? node.value.raw),
      };
    },
  };
}

const noRestyle = {
  meta: {
    type: "problem",
    messages: { restyle: "Do not restyle the @pap/ui primitive {{name}}: add a variant to the primitive instead." },
    schema: [],
  },
  create(context) {
    const uiNames = new Set();
    return {
      ImportDeclaration(node) {
        if (node.source.value !== "@pap/ui") return;
        for (const specifier of node.specifiers) uiNames.add(specifier.local.name);
      },
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier" || !uiNames.has(node.name.name)) return;
        for (const attribute of node.attributes) {
          if (attribute.type === "JSXAttribute" && ["className", "style"].includes(attribute.name.name)) {
            context.report({ node: attribute, messageId: "restyle", data: { name: node.name.name } });
          }
        }
      },
    };
  },
};

const zustandSelector = {
  meta: {
    type: "problem",
    messages: { selector: "Read a zustand store through a selector: {{name}}((state) => state.part)." },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === "Identifier" && /^use[A-Z]\w*Store$/.test(node.callee.name) && node.arguments.length === 0) {
          context.report({ node, messageId: "selector", data: { name: node.callee.name } });
        }
      },
    };
  },
};

export default {
  meta: { name: "pap" },
  rules: {
    "no-raw-colors": stringRule("raw", "Raw colour in UI code: use a token from packages/ui/src/tokens.css.", RAW_COLOR),
    "no-arbitrary-values": stringRule("arbitrary", "Arbitrary Tailwind value: use the token scale.", ARBITRARY),
    "no-restyle": noRestyle,
    "zustand-selector": zustandSelector,
  },
};
```

- [ ] **Step 5: Write the flat config**

`eslint.config.js`:

```js
import js from "@eslint/js";
import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import boundaries from "eslint-plugin-boundaries";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";
import pap from "./eslint/pap-plugin.js";

const ELEMENTS = [
  { type: "contracts", pattern: "packages/contracts/src" },
  { type: "ui", pattern: "packages/ui/src" },
  { type: "pi-host", pattern: "packages/pi-host/src" },
  { type: "kernel", pattern: "apps/daemon/src/kernel" },
  { type: "module", pattern: "apps/daemon/src/modules/*", capture: ["domain"] },
  { type: "daemon-testing", pattern: "apps/daemon/src/testing" },
  { type: "daemon-root", pattern: "apps/daemon/src/*.ts", mode: "file" },
  { type: "web-runtime", pattern: "apps/web/src/runtime" },
  { type: "web-stores", pattern: "apps/web/src/stores" },
  { type: "web-feature", pattern: "apps/web/src/features/*", capture: ["domain"] },
  { type: "web-routes", pattern: "apps/web/src/routes" },
  { type: "web-i18n", pattern: "apps/web/src/i18n" },
  { type: "web-root", pattern: "apps/web/src/*.{ts,tsx}", mode: "file" },
];

export default defineConfig(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "spikes/**", "docs/**", "coverage/**", "playwright-report/**", "test-results/**"],
  },
  js.configs.recommended,
  tseslint.configs.strict,
  comments.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "max-lines": ["error", { max: 400, skipBlankLines: false, skipComments: false }],
      "@eslint-community/eslint-comments/require-description": "error",
      "@eslint-community/eslint-comments/no-unlimited-disable": "error",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { boundaries },
    settings: {
      "boundaries/elements": ELEMENTS,
      "import/resolver": {
        typescript: {
          alwaysTryTypes: true,
          conditionNames: ["development", "types", "import", "default"],
          project: ["apps/*/tsconfig.json", "packages/*/tsconfig.json"],
        },
      },
    },
    rules: {
      "boundaries/element-types": [
        "error",
        {
          default: "disallow",
          rules: [
            { from: "contracts", allow: ["contracts"] },
            { from: "ui", allow: ["ui"] },
            { from: "pi-host", allow: ["pi-host", "contracts"] },
            { from: "kernel", allow: ["kernel", "contracts"] },
            { from: "module", allow: ["contracts", "kernel", "module"] },
            { from: "daemon-testing", allow: ["contracts", "kernel", "module", "daemon-root", "daemon-testing"] },
            { from: "daemon-root", allow: ["contracts", "kernel", "module", "daemon-root", "daemon-testing"] },
            { from: "web-runtime", allow: ["web-runtime", "contracts"] },
            { from: "web-stores", allow: ["web-stores", "web-runtime", "contracts"] },
            {
              from: "web-feature",
              allow: [["web-feature", { domain: "${from.domain}" }], "web-stores", "web-runtime", "web-i18n", "ui", "contracts"],
            },
            { from: "web-routes", allow: ["web-routes", "web-feature", "web-runtime", "web-i18n", "ui"] },
            { from: "web-i18n", allow: ["web-i18n", "contracts"] },
            { from: "web-root", allow: ["web-root", "web-routes", "web-runtime", "web-i18n", "ui"] },
          ],
        },
      ],
      "boundaries/entry-point": [
        "error",
        {
          default: "disallow",
          rules: [
            { target: ["module"], allow: "index.ts" },
            {
              target: ["contracts", "ui", "pi-host", "kernel", "daemon-root", "daemon-testing", "web-runtime", "web-stores", "web-feature", "web-routes", "web-i18n", "web-root"],
              allow: "**",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}", "packages/ui/src/**/*.{ts,tsx}"],
    plugins: { pap, "react-hooks": reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      "pap/no-raw-colors": "error",
      "pap/no-arbitrary-values": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    rules: { "pap/no-restyle": "error", "pap/zustand-selector": "error" },
  },
);
```

- [ ] **Step 6: Write the knip configuration**

`knip.json`:

```json
{
  "ignore": ["spikes/**", "docs/**"],
  "ignoreExportsUsedInFile": true,
  "workspaces": {
    ".": { "entry": ["scripts/*.ts", "e2e/**/*.ts", "eslint/*.js"] },
    "packages/pi-host": { "entry": ["src/main.ts", "src/testing/*.ts"] }
  }
}
```

- [ ] **Step 7: Run the tests and the gates**

Run: `pnpm test:unit eslint/pap-plugin.test.js && pnpm lint && pnpm knip`
Expected: PASS; lint and knip report nothing.

- [ ] **Step 8: Commit**

```bash
git add eslint.config.js eslint knip.json package.json pnpm-lock.yaml
git commit -m "chore: add eslint gates, local design rules and knip"
```

---

### Task 11: GitHub Actions CI, nightly Pi-compat job, Renovate

**Files:**
- Create: `.github/actions/setup/action.yml`, `.github/workflows/ci.yml`, `.github/workflows/pi-compat.yml`, `renovate.json`
- Create: `scripts/pi-compat-bump.ts`
- Test: `scripts/pi-compat-bump.test.ts`

**Interfaces:**
- Produces: CI jobs `checks`, `unit`, `integration`, `build` (Task 27 adds `e2e` and `budgets`); `bumpCatalog(yaml: string): string`.

- [ ] **Step 1: Write the failing test for the catalog bump**

`scripts/pi-compat-bump.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { bumpCatalog } from "./pi-compat-bump.ts";

describe("bumpCatalog", () => {
  it("sets every @earendil-works catalog entry to latest and leaves the rest alone", () => {
    const input = [
      "packages:",
      "  - apps/*",
      "catalog:",
      '  "@earendil-works/pi-coding-agent": 1.1.0',
      '  "@earendil-works/pi-ai": 1.1.0',
      '  "zod": 4.1.0',
      "minimumReleaseAge: 4320",
    ].join("\n");
    expect(bumpCatalog(input)).toBe(
      [
        "packages:",
        "  - apps/*",
        "catalog:",
        '  "@earendil-works/pi-coding-agent": latest',
        '  "@earendil-works/pi-ai": latest',
        '  "zod": 4.1.0',
        "minimumReleaseAge: 4320",
      ].join("\n"),
    );
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm test:unit scripts/pi-compat-bump.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the script**

`scripts/pi-compat-bump.ts`:

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function bumpCatalog(yaml: string): string {
  return yaml.replace(/^(\s+"@earendil-works\/[^"]+":\s*)\S+$/gm, "$1latest");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = "pnpm-workspace.yaml";
  writeFileSync(path, bumpCatalog(readFileSync(path, "utf8")));
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm test:unit scripts/pi-compat-bump.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the composite setup action and the workflows**

`.github/actions/setup/action.yml`:

```yaml
name: setup
description: pnpm, Node 24 and a frozen install
runs:
  using: composite
  steps:
    - uses: pnpm/action-setup@v4
    - uses: actions/setup-node@v5
      with:
        node-version-file: .nvmrc
        cache: pnpm
    - run: pnpm install --frozen-lockfile
      shell: bash
```

`.github/workflows/ci.yml`:

```yaml
name: ci
on:
  pull_request:
    paths-ignore: ["docs/**", "**/*.md"]
  push:
    branches: [main]
    paths-ignore: ["docs/**", "**/*.md"]
permissions:
  contents: read
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  checks:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v5
      - uses: ./.github/actions/setup
      - run: pnpm lint
      - run: pnpm format:check
      - run: pnpm typecheck
      - run: pnpm knip
  unit:
    needs: checks
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v5
      - uses: ./.github/actions/setup
      - run: pnpm test:unit
  integration:
    needs: unit
    runs-on: ubuntu-24.04
    env:
      PI_OFFLINE: "1"
      PI_TELEMETRY: "0"
    steps:
      - uses: actions/checkout@v5
      - uses: ./.github/actions/setup
      - run: pnpm test:int
  build:
    needs: integration
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v5
      - uses: ./.github/actions/setup
      - run: pnpm build
      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: |
            apps/*/dist
            packages/*/dist
          retention-days: 3
```

`.github/workflows/pi-compat.yml`:

```yaml
name: pi-compat
on:
  schedule:
    - cron: "17 3 * * *"
  workflow_dispatch: {}
permissions:
  contents: read
jobs:
  latest-pi-sdk:
    runs-on: ubuntu-24.04
    env:
      PI_OFFLINE: "1"
      PI_TELEMETRY: "0"
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        with:
          node-version-file: .nvmrc
      - run: node scripts/pi-compat-bump.ts
      - run: pnpm install --no-frozen-lockfile --config.minimum-release-age=0
      - run: pnpm test:int
```

`renovate.json`:

```json
{
  "extends": ["config:recommended", "helpers:pinGitHubActionDigests"],
  "rangeStrategy": "pin",
  "minimumReleaseAge": "3 days",
  "packageRules": [
    { "matchPackageNames": ["@earendil-works/**"], "groupName": "pi sdk", "dependencyDashboardApproval": true }
  ]
}
```

- [ ] **Step 6: Validate locally**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit`
Expected: PASS. (`actionlint` is optional: `docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest` if available.)

- [ ] **Step 7: Commit**

```bash
git add .github renovate.json scripts/pi-compat-bump.ts scripts/pi-compat-bump.test.ts
git commit -m "ci: add gated pipeline, nightly pi-compat job and renovate"
```

---

### Task 12: contracts — errors, permissions, defineMethod, catalogue, frames, streams, IPC records

**Files:**
- Create: `packages/contracts/src/errors.ts`, `permissions.ts`, `define.ts`, `frames.ts`, `streams.ts`, `methods.ts`, `handlers.ts`, `pi-host.ts`
- Modify: `packages/contracts/src/index.ts` (becomes the barrel)
- Test: `packages/contracts/src/methods.test.ts`, `handler-table.test.ts`, `frames.test.ts`, `pi-host.test.ts`

**Interfaces:**
- Produces (all re-exported from `@pap/contracts`; a zod schema and its inferred type share one name):
  - `ERROR_CODES`, `type ErrorCode`, `ERROR_MESSAGES`, `class PapError { code: ErrorCode }`
  - `DOMAINS`, `LEVELS`, `type Permission = \`${Domain}:${Level}\``, `ALL_PERMISSIONS`
  - `defineMethod(def)`, `interface MethodDef<N, P, R>`, `methods` (keys: `system.ping`, `unsubscribe`, `sessions.create`, `sessions.list`, `sessions.prompt`, `sessions.abort`, `sessions.respondDialog`, `subscribe.session`)
  - `type MethodName`, `ParamsOf<M>`, `ResultOf<M>`, `interface Caller { userId; permissions }`, `interface HandlerContext { caller; connectionId; openSubscription(stream, key, after): string; closeSubscription(sub): void }`, `type Handler<M>`, `type HandlerTable`
  - `PROTOCOL_VERSION = 1`, `MAX_FRAME_BYTES`, `CAPABILITIES`, `Cursor`, `RequestFrame`, `ResponseFrame`, `EventFrame`, `HelloFrame`
  - `SessionStatus`, `Dialog`, `DialogResponse`, `SessionStreamEvent`, `SessionSummary`, `type StreamName`
  - `PolicyRules`, `TOOL_CATEGORIES`, `type ToolCategory`, `AuditEntry`, `InitRecord`, `DaemonToWorker`, `type CommandInput`, `ReadyRecord`, `ResponseRecord`, `UiRequestRecord`, `UiResponseRecord`, `GetStateData`, `type WorkerRecord`, `parseWorkerRecord(raw): WorkerRecord | null`

- [ ] **Step 1: Write the failing tests**

`packages/contracts/src/methods.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, methods } from "./index.ts";

describe("method catalogue", () => {
  it("keys every method by its own name and declares a known permission", () => {
    for (const [key, def] of Object.entries(methods)) {
      expect(def.name).toBe(key);
      expect(ALL_PERMISSIONS).toContain(def.permission);
    }
  });

  it("marks exactly the mutations as non-idempotent (they require a commandId)", () => {
    const mutations = Object.values(methods)
      .filter((def) => !def.idempotent)
      .map((def) => def.name)
      .sort();
    expect(mutations).toEqual(["sessions.create", "sessions.prompt", "sessions.respondDialog"]);
  });
});
```

`packages/contracts/src/handler-table.test.ts` (the `@ts-expect-error` lines fail `pnpm typecheck` if the types stop rejecting these mistakes):

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineMethod, type HandlerTable } from "./index.ts";

describe("compile-time guarantees", () => {
  it("a handler table missing a method does not compile", () => {
    // @ts-expect-error -- every method of the catalogue needs a handler
    const incomplete: HandlerTable = { "system.ping": async () => ({ now: 0 }) };
    expect(incomplete).toBeDefined();
  });

  it("a method without a permission does not compile", () => {
    // @ts-expect-error -- permission is mandatory
    const def = defineMethod({ name: "x.y", idempotent: true, params: z.object({}), result: z.object({}), errors: [] });
    expect(def.name).toBe("x.y");
  });
});
```

`packages/contracts/src/frames.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EventFrame, HelloFrame, RequestFrame, ResponseFrame } from "./index.ts";

describe("ws frames", () => {
  it("accepts a request with a commandId and rejects a negative id", () => {
    expect(RequestFrame.safeParse({ id: 1, method: "sessions.prompt", params: {}, commandId: "c-12345678" }).success).toBe(true);
    expect(RequestFrame.safeParse({ id: -1, method: "x" }).success).toBe(false);
  });

  it("accepts error responses only with a known code", () => {
    expect(ResponseFrame.safeParse({ id: 1, ok: false, error: { code: "not_found" } }).success).toBe(true);
    expect(ResponseFrame.safeParse({ id: 1, ok: false, error: { code: "teapot" } }).success).toBe(false);
  });

  it("requires epoch and seq on event frames, and protocol on hello", () => {
    expect(EventFrame.safeParse({ sub: "s1", seq: 3, event: {} }).success).toBe(false);
    expect(EventFrame.safeParse({ sub: "s1", epoch: "e", seq: 3, event: {} }).success).toBe(true);
    expect(HelloFrame.safeParse({ protocol: 1, capabilities: ["rpc"], serverVersion: "0.0.0" }).success).toBe(true);
  });
});
```

`packages/contracts/src/pi-host.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DaemonToWorker, parseWorkerRecord } from "./index.ts";

describe("worker records", () => {
  it("parses pap records strictly", () => {
    const ready = { type: "ready", sessionFile: "/s.jsonl", sessionId: "abc", piVersion: "1.1.0" };
    expect(parseWorkerRecord(ready)).toEqual(ready);
    expect(parseWorkerRecord({ type: "ready", sessionId: "abc" })).toBeNull();
  });

  it("keeps extra fields of extension_ui_request", () => {
    const record = { type: "extension_ui_request", id: "u1", method: "confirm", title: "Run?", message: "bash: ls" };
    expect(parseWorkerRecord(record)).toEqual(record);
  });

  it("wraps any other typed object as a Pi event", () => {
    expect(parseWorkerRecord({ type: "agent_settled", aborted: false })).toEqual({
      type: "pi_event",
      event: { type: "agent_settled", aborted: false },
    });
  });

  it("drops values without a string type", () => {
    expect(parseWorkerRecord(null)).toBeNull();
    expect(parseWorkerRecord({ type: 3 })).toBeNull();
    expect(parseWorkerRecord("agent_start")).toBeNull();
  });

  it("rejects unknown daemon-to-worker records", () => {
    expect(DaemonToWorker.safeParse({ type: "rm_rf" }).success).toBe(false);
    expect(DaemonToWorker.safeParse({ type: "get_state", id: "r1" }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit packages/contracts`
Expected: FAIL (`methods` and friends are not exported).

- [ ] **Step 3: Write errors and permissions**

`packages/contracts/src/errors.ts`:

```ts
export const ERROR_CODES = [
  "bad_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "payload_too_large",
  "capacity",
  "worker_failed",
  "prompt_rejected",
  "invalid_cwd",
  "read_only",
  "unknown_method",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_MESSAGES: { readonly [C in ErrorCode]: string } = {
  bad_request: "The request is invalid.",
  unauthenticated: "Sign in first.",
  forbidden: "You do not have permission for this action.",
  not_found: "Not found.",
  conflict: "This already exists or changed meanwhile.",
  rate_limited: "Too many attempts. Try again later.",
  payload_too_large: "The request is too large.",
  capacity: "The server is at capacity. Try again later.",
  worker_failed: "The session process failed.",
  prompt_rejected: "The session could not start this prompt. Check the model and provider settings.",
  invalid_cwd: "The working directory must be an absolute path to an existing folder.",
  read_only: "The database was written by a newer version and is read-only.",
  unknown_method: "Unknown method.",
  internal: "Internal error.",
};

export class PapError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "PapError";
    this.code = code;
  }
}
```

`packages/contracts/src/permissions.ts`:

```ts
export const DOMAINS = ["system", "auth", "sessions"] as const;
export const LEVELS = ["read", "operate", "admin"] as const;
export type Domain = (typeof DOMAINS)[number];
export type Level = (typeof LEVELS)[number];
export type Permission = `${Domain}:${Level}`;

export const ALL_PERMISSIONS: readonly Permission[] = DOMAINS.flatMap((domain) =>
  LEVELS.map((level): Permission => `${domain}:${level}`),
);
```

- [ ] **Step 4: Write defineMethod, frames and streams**

`packages/contracts/src/define.ts`:

```ts
import type { z } from "zod";
import type { ErrorCode } from "./errors.ts";
import type { Permission } from "./permissions.ts";

export interface MethodDef<N extends string = string, P extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType> {
  readonly name: N;
  readonly permission: Permission;
  readonly idempotent: boolean;
  readonly params: P;
  readonly result: R;
  readonly errors: readonly ErrorCode[];
}

export function defineMethod<const N extends string, P extends z.ZodType, R extends z.ZodType>(
  def: MethodDef<N, P, R>,
): MethodDef<N, P, R> {
  return def;
}
```

`packages/contracts/src/frames.ts`:

```ts
import { z } from "zod";
import { ERROR_CODES } from "./errors.ts";

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const CAPABILITIES = ["rpc", "subscribe"] as const;

export const Cursor = z.object({ epoch: z.string().min(1).max(64), seq: z.number().int().nonnegative() });
export type Cursor = z.infer<typeof Cursor>;

export const RequestFrame = z.object({
  id: z.number().int().nonnegative(),
  method: z.string().min(1).max(128),
  params: z.unknown().optional(),
  commandId: z.string().min(8).max(128).optional(),
});
export type RequestFrame = z.infer<typeof RequestFrame>;

export const ResponseFrame = z.union([
  z.object({ id: z.number().int(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.number().int(), ok: z.literal(false), error: z.object({ code: z.enum(ERROR_CODES) }) }),
]);
export type ResponseFrame = z.infer<typeof ResponseFrame>;

export const EventFrame = z.object({
  sub: z.string().min(1),
  epoch: z.string().min(1),
  seq: z.number().int().nonnegative(),
  event: z.unknown(),
});
export type EventFrame = z.infer<typeof EventFrame>;

export const HelloFrame = z.object({
  protocol: z.number().int(),
  capabilities: z.array(z.string()),
  serverVersion: z.string(),
});
export type HelloFrame = z.infer<typeof HelloFrame>;
```

`packages/contracts/src/streams.ts`:

```ts
import { z } from "zod";

export const STREAMS = ["session"] as const;
export type StreamName = (typeof STREAMS)[number];

export const SessionStatus = z.enum(["cold", "starting", "idle", "running"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const Dialog = z.object({
  id: z.string().min(1).max(128),
  method: z.enum(["select", "confirm", "input", "editor"]),
  title: z.string().max(4096),
  message: z.string().max(65_536).optional(),
  options: z.array(z.string().max(4096)).max(100).optional(),
  placeholder: z.string().max(4096).optional(),
  prefill: z.string().max(1_000_000).optional(),
  timeout: z.number().int().positive().optional(),
});
export type Dialog = z.infer<typeof Dialog>;

export const DialogResponse = z.union([
  z.object({ confirmed: z.boolean() }),
  z.object({ value: z.string().max(1_000_000) }),
  z.object({ cancelled: z.literal(true) }),
]);
export type DialogResponse = z.infer<typeof DialogResponse>;

export const PiEvent = z.looseObject({ type: z.string() });
export type PiEvent = z.infer<typeof PiEvent>;

export const SessionStreamEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), status: SessionStatus, messages: z.array(z.unknown()), dialogs: z.array(Dialog) }),
  z.object({ kind: z.literal("status"), status: SessionStatus, cause: z.string().optional() }),
  z.object({ kind: z.literal("pi"), event: PiEvent }),
  z.object({ kind: z.literal("dialog_open"), dialog: Dialog }),
  z.object({ kind: z.literal("dialog_closed"), id: z.string() }),
  z.object({ kind: z.literal("notice"), level: z.enum(["info", "warning", "error"]), text: z.string() }),
]);
export type SessionStreamEvent = z.infer<typeof SessionStreamEvent>;

export const SessionSummary = z.object({
  id: z.string(),
  cwd: z.string(),
  status: SessionStatus,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;
```

- [ ] **Step 5: Write the catalogue and the handler types**

`packages/contracts/src/methods.ts`:

```ts
import { z } from "zod";
import { defineMethod, type MethodDef } from "./define.ts";
import { Cursor } from "./frames.ts";
import { DialogResponse, SessionSummary } from "./streams.ts";

const SessionId = z.string().min(1).max(128);
const Ok = z.object({ ok: z.literal(true) });

function catalogue<const T extends { readonly [K in keyof T]: MethodDef<K & string> }>(defs: T): T {
  return defs;
}

export const methods = catalogue({
  "system.ping": defineMethod({
    name: "system.ping",
    permission: "system:read",
    idempotent: true,
    params: z.object({}),
    result: z.object({ now: z.number() }),
    errors: [],
  }),
  unsubscribe: defineMethod({
    name: "unsubscribe",
    permission: "system:read",
    idempotent: true,
    params: z.object({ sub: z.string().min(1).max(64) }),
    result: Ok,
    errors: [],
  }),
  "sessions.create": defineMethod({
    name: "sessions.create",
    permission: "sessions:operate",
    idempotent: false,
    params: z.object({ cwd: z.string().min(1).max(4096) }),
    result: z.object({ sessionId: SessionId }),
    errors: ["invalid_cwd", "capacity", "worker_failed"],
  }),
  "sessions.list": defineMethod({
    name: "sessions.list",
    permission: "sessions:read",
    idempotent: true,
    params: z.object({}),
    result: z.object({ sessions: z.array(SessionSummary) }),
    errors: [],
  }),
  "sessions.prompt": defineMethod({
    name: "sessions.prompt",
    permission: "sessions:operate",
    idempotent: false,
    params: z.object({
      sessionId: SessionId,
      text: z.string().min(1).max(200_000),
      streamingBehavior: z.enum(["steer", "followUp"]).optional(),
    }),
    result: z.object({ disposition: z.enum(["started", "queued", "handled"]) }),
    errors: ["not_found", "capacity", "worker_failed", "prompt_rejected"],
  }),
  "sessions.abort": defineMethod({
    name: "sessions.abort",
    permission: "sessions:operate",
    idempotent: true,
    params: z.object({ sessionId: SessionId }),
    result: Ok,
    errors: ["not_found"],
  }),
  "sessions.respondDialog": defineMethod({
    name: "sessions.respondDialog",
    permission: "sessions:operate",
    idempotent: false,
    params: z.object({ sessionId: SessionId, dialogId: z.string().min(1).max(128), response: DialogResponse }),
    result: Ok,
    errors: ["not_found"],
  }),
  "subscribe.session": defineMethod({
    name: "subscribe.session",
    permission: "sessions:read",
    idempotent: true,
    params: z.object({ sessionId: SessionId, after: Cursor.optional() }),
    result: z.object({ sub: z.string() }),
    errors: ["not_found"],
  }),
});
```

`packages/contracts/src/handlers.ts`:

```ts
import type { z } from "zod";
import type { Cursor } from "./frames.ts";
import type { methods } from "./methods.ts";
import type { Permission } from "./permissions.ts";
import type { StreamName } from "./streams.ts";

export type MethodName = keyof typeof methods;
export type ParamsOf<M extends MethodName> = z.output<(typeof methods)[M]["params"]>;
export type ResultOf<M extends MethodName> = z.input<(typeof methods)[M]["result"]>;

export interface Caller {
  readonly userId: string;
  readonly permissions: ReadonlySet<Permission>;
}

export interface HandlerContext {
  readonly caller: Caller;
  readonly connectionId: string;
  openSubscription(stream: StreamName, key: string, after: Cursor | undefined): string;
  closeSubscription(sub: string): void;
}

export type Handler<M extends MethodName> = (params: ParamsOf<M>, ctx: HandlerContext) => Promise<ResultOf<M>>;
export type HandlerTable = { readonly [M in MethodName]: Handler<M> };
```

- [ ] **Step 6: Write the IPC records**

`packages/contracts/src/pi-host.ts`:

```ts
import { z } from "zod";

export const PolicyRules = z.object({
  profile: z.literal("interactive"),
  approvalMode: z.enum(["auto-accept-edits"]),
});
export type PolicyRules = z.infer<typeof PolicyRules>;

export const TOOL_CATEGORIES = ["read", "edit", "exec", "network", "external-write"] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export const AuditEntry = z.object({
  toolCallId: z.string().max(256),
  tool: z.string().max(256),
  category: z.enum(TOOL_CATEGORIES),
  decision: z.enum(["allow", "block", "approved", "denied"]),
  reason: z.string().max(1024).optional(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

// daemon → worker
export const InitRecord = z.object({
  type: z.literal("init"),
  cwd: z.string(),
  agentDir: z.string(),
  sessionFile: z.string().optional(),
  policy: z.unknown(),
  testProviderScript: z.string().optional(),
});
export type InitRecord = z.infer<typeof InitRecord>;
const PromptCommand = z.object({
  type: z.literal("prompt"),
  id: z.string(),
  message: z.string(),
  streamingBehavior: z.enum(["steer", "followUp"]).optional(),
});
const AbortCommand = z.object({ type: z.literal("abort"), id: z.string() });
const GetStateCommand = z.object({ type: z.literal("get_state"), id: z.string() });
export const UiResponseRecord = z.object({
  type: z.literal("extension_ui_response"),
  id: z.string(),
  value: z.string().optional(),
  confirmed: z.boolean().optional(),
  cancelled: z.literal(true).optional(),
});
export type UiResponseRecord = z.infer<typeof UiResponseRecord>;
const ShutdownRecord = z.object({ type: z.literal("shutdown"), graceMs: z.number().int().nonnegative() });
const PolicyUpdateRecord = z.object({ type: z.literal("policy_update"), rules: z.unknown() });

export const DaemonToWorker = z.discriminatedUnion("type", [
  InitRecord,
  PromptCommand,
  AbortCommand,
  GetStateCommand,
  UiResponseRecord,
  ShutdownRecord,
  PolicyUpdateRecord,
]);
export type DaemonToWorker = z.infer<typeof DaemonToWorker>;
type CommandRecord = z.infer<typeof PromptCommand> | z.infer<typeof AbortCommand> | z.infer<typeof GetStateCommand>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type CommandInput = DistributiveOmit<CommandRecord, "id">;

// worker → daemon
export const ReadyRecord = z.object({ type: z.literal("ready"), sessionFile: z.string(), sessionId: z.string(), piVersion: z.string() });
export type ReadyRecord = z.infer<typeof ReadyRecord>;
export const ResponseRecord = z.object({
  type: z.literal("response"),
  id: z.string(),
  command: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export type ResponseRecord = z.infer<typeof ResponseRecord>;
export const UiRequestRecord = z.looseObject({ type: z.literal("extension_ui_request"), id: z.string(), method: z.string() });
export type UiRequestRecord = z.infer<typeof UiRequestRecord>;
const UiClosedRecord = z.object({ type: z.literal("extension_ui_closed"), id: z.string() });
const AuditRecord = z.object({ type: z.literal("audit"), entry: AuditEntry });
const HealthRecord = z.object({ type: z.literal("health"), rssMb: z.number().nonnegative() });
const ExtensionErrorRecord = z.object({
  type: z.literal("extension_error"),
  extensionPath: z.string(),
  event: z.string(),
  error: z.string(),
});
const PapRecord = z.discriminatedUnion("type", [
  ReadyRecord,
  ResponseRecord,
  UiRequestRecord,
  UiClosedRecord,
  AuditRecord,
  HealthRecord,
  ExtensionErrorRecord,
]);
const PiEventRecord = z.looseObject({ type: z.string() });
const PAP_TYPES = new Set(["ready", "response", "extension_ui_request", "extension_ui_closed", "audit", "health", "extension_error"]);

export type WorkerRecord = z.infer<typeof PapRecord> | { type: "pi_event"; event: z.infer<typeof PiEventRecord> };

export function parseWorkerRecord(raw: unknown): WorkerRecord | null {
  const base = PiEventRecord.safeParse(raw);
  if (!base.success) return null;
  if (PAP_TYPES.has(base.data.type)) {
    const parsed = PapRecord.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }
  return { type: "pi_event", event: base.data };
}

export const GetStateData = z.object({
  isStreaming: z.boolean(),
  isCompacting: z.boolean(),
  pendingMessageCount: z.number().int().nonnegative(),
  sessionFile: z.string(),
  sessionId: z.string(),
});
export type GetStateData = z.infer<typeof GetStateData>;
```

`packages/contracts/src/index.ts`:

```ts
export * from "./define.ts";
export * from "./errors.ts";
export * from "./frames.ts";
export * from "./handlers.ts";
export * from "./methods.ts";
export * from "./permissions.ts";
export * from "./pi-host.ts";
export * from "./streams.ts";
```

- [ ] **Step 7: Run tests, type check, lint**

Run: `pnpm test:unit packages/contracts && pnpm typecheck && pnpm lint && pnpm test:int packages/pi-host`
Expected: PASS (the type-stripping test still prints `1`).

- [ ] **Step 8: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): method catalogue with mandatory permissions, frames and worker records"
```

---

### Task 13: daemon kernel — config, clock, logger, ids, version

**Files:**
- Create: `apps/daemon/package.json`, `apps/daemon/tsconfig.json`, `apps/daemon/tsconfig.build.json`
- Create: `apps/daemon/src/kernel/config.ts`, `clock.ts`, `logger.ts`, `ids.ts`, `version.ts`
- Test: `apps/daemon/src/kernel/config.test.ts`, `clock.test.ts`, `logger.test.ts`

**Interfaces:**
- Produces:
  - `interface Clock { now(): number; setTimeout(fn, ms): TimerHandle; clearTimeout(h): void; sleep(ms): Promise<void> }`, `createSystemClock()`, `createFakeClock(start?) → FakeClock` with `advance(ms): Promise<void>` and `pending(): number`
  - `interface Logger { debug|info|warn|error(msg, fields?); child(bindings) }`, `type LogLevel`, `createLogger({ level, clock, write, bindings? })`, `redact(value)`, `silentLogger`
  - `interface Config { home; host; port; dev; tls; publicOrigin; allowedOrigins; piAgentDir; piHostEntry; piHostExecArgv; testProviderScript; maxWorkers; minFreeMemMb; staticRoot; logLevel }`, `interface ConfigInput`, `loadConfig(input)`, `ConfigError`, `defaultMaxWorkers(totalMemMb, budgetMb?)`, `WORKER_BUDGET_MB`
  - `randomToken(bytes?)`, `sha256Hex(value)`, `newId()`, `VERSION`

- [ ] **Step 1: Create the daemon package**

`apps/daemon/package.json`:

```json
{
  "name": "@pap/daemon",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "pap": "./dist/main.js" },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "build": "tsc -p tsconfig.build.json",
    "dev": "node --conditions=development --watch src/main.ts serve --dev"
  },
  "dependencies": {
    "@pap/contracts": "workspace:*"
  }
}
```

`apps/daemon/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "customConditions": ["development"] },
  "include": ["src"]
}
```

`apps/daemon/tsconfig.build.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts", "src/testing/**"]
}
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing tests**

`apps/daemon/src/kernel/clock.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createFakeClock } from "./clock.ts";

describe("fake clock", () => {
  it("runs due timers in time order and moves now", async () => {
    const clock = createFakeClock(1000);
    const calls: string[] = [];
    clock.setTimeout(() => calls.push("b@300"), 300);
    clock.setTimeout(() => calls.push("a@100"), 100);
    await clock.advance(200);
    expect(calls).toEqual(["a@100"]);
    expect(clock.now()).toBe(1200);
    await clock.advance(100);
    expect(calls).toEqual(["a@100", "b@300"]);
  });

  it("resolves sleep and runs timers scheduled by timers", async () => {
    const clock = createFakeClock();
    let woke = false;
    void clock.sleep(50).then(() => clock.sleep(50)).then(() => { woke = true; });
    await clock.advance(100);
    expect(woke).toBe(true);
  });

  it("forgets cleared timers", async () => {
    const clock = createFakeClock();
    let fired = false;
    clock.clearTimeout(clock.setTimeout(() => { fired = true; }, 10));
    await clock.advance(20);
    expect(fired).toBe(false);
    expect(clock.pending()).toBe(0);
  });
});
```

`apps/daemon/src/kernel/logger.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createFakeClock } from "./clock.ts";
import { createLogger, redact } from "./logger.ts";

describe("logger", () => {
  it("writes one JSON line per entry and filters by level", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", clock: createFakeClock(0), write: (line) => lines.push(line) });
    logger.debug("hidden");
    logger.child({ component: "auth" }).info("owner_created", { username: "owner" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({ time: "1970-01-01T00:00:00.000Z", level: "info", msg: "owner_created", component: "auth", username: "owner" });
  });

  it("redacts secret-looking keys at any depth, keeps urls, flattens errors", () => {
    expect(redact({ password: "x", nested: { apiKey: "k", url: "http://localhost:7777/setup#token=t" }, err: new Error("boom") })).toEqual({
      password: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", url: "http://localhost:7777/setup#token=t" },
      err: { name: "Error", message: "boom" },
    });
  });
});
```

`apps/daemon/src/kernel/config.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, defaultMaxWorkers, loadConfig, type ConfigInput } from "./config.ts";

let cwd: string;
let base: ConfigInput;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pap-config-"));
  base = { argv: [], env: {}, cwd, homedir: "/home/u", totalMemMb: 16_384, piHostEntry: "/x/main.js", piHostExecArgv: [], staticRoot: null };
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("loadConfig", () => {
  it("binds 127.0.0.1:7777 with ~/.pap and ~/.pi/agent by default", () => {
    const config = loadConfig(base);
    expect([config.host, config.port, config.home, config.piAgentDir]).toEqual(["127.0.0.1", 7777, "/home/u/.pap", "/home/u/.pi/agent"]);
    expect(config.tls).toBeNull();
  });

  it("loopback hosts publish a localhost origin and accept the loopback aliases", () => {
    const config = loadConfig(base);
    expect(config.publicOrigin).toBe("http://localhost:7777");
    expect([...config.allowedOrigins]).toEqual(
      expect.arrayContaining(["http://localhost:7777", "http://127.0.0.1:7777", "http://[::1]:7777"]),
    );
  });

  it("--dev derives a stable port and PAP_HOME from the worktree path", () => {
    const a = loadConfig({ ...base, argv: ["--dev"] });
    const b = loadConfig({ ...base, argv: ["--dev"] });
    expect(a.port).toBe(b.port);
    expect(a.port).toBeGreaterThanOrEqual(20_000);
    expect(a.port).toBeLessThan(30_000);
    expect(a.home.startsWith("/home/u/.pap-dev/")).toBe(true);
    expect(a.allowedOrigins.has("http://localhost:5173")).toBe(true);
  });

  it("requires --tls-cert and --tls-key together and switches the origin to https", () => {
    expect(() => loadConfig({ ...base, argv: ["--tls-cert", "/c.pem"] })).toThrow(ConfigError);
    expect(loadConfig({ ...base, argv: ["--tls-cert", "/c.pem", "--tls-key", "/k.pem"] }).publicOrigin).toBe("https://localhost:7777");
  });

  it("rejects bad ports, relative test scripts and unknown flags", () => {
    expect(() => loadConfig({ ...base, argv: ["--port", "70000"] })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, env: { PAP_TEST_PROVIDER_SCRIPT: "script.json" } })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, argv: ["--bogus"] })).toThrow();
  });

  it("uses PAP_PUBLIC_ORIGIN for a non-loopback host", () => {
    const config = loadConfig({ ...base, argv: ["--host", "0.0.0.0"], env: { PAP_PUBLIC_ORIGIN: "https://pap.example.ts.net" } });
    expect(config.publicOrigin).toBe("https://pap.example.ts.net");
    expect(config.allowedOrigins.has("https://pap.example.ts.net")).toBe(true);
  });

  it("clamps the default worker cap between 2 and 16", () => {
    expect(defaultMaxWorkers(1024, 600)).toBe(2);
    expect(defaultMaxWorkers(1_000_000, 600)).toBe(16);
    expect(defaultMaxWorkers(12_000, 600)).toBe(10);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/kernel`
Expected: FAIL (modules not found).

- [ ] **Step 4: Write clock, ids, version**

`apps/daemon/src/kernel/clock.ts`:

```ts
export interface TimerHandle {
  readonly id: number;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  sleep(ms: number): Promise<void>;
}

export function createSystemClock(): Clock {
  const timers = new Map<number, NodeJS.Timeout>();
  let nextId = 1;
  const clock: Clock = {
    now: () => Date.now(),
    setTimeout(fn, ms) {
      const id = nextId++;
      const timer = setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timer.unref();
      timers.set(id, timer);
      return { id };
    },
    clearTimeout(handle) {
      const timer = timers.get(handle.id);
      if (timer) clearTimeout(timer);
      timers.delete(handle.id);
    },
    sleep: (ms) => new Promise<void>((resolve) => { clock.setTimeout(resolve, ms); }),
  };
  return clock;
}

export interface FakeClock extends Clock {
  advance(ms: number): Promise<void>;
  pending(): number;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

export function createFakeClock(start = 1_700_000_000_000): FakeClock {
  let current = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: FakeClock = {
    now: () => current,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: current + Math.max(0, ms), fn });
      return { id };
    },
    clearTimeout(handle) {
      timers.delete(handle.id);
    },
    sleep: (ms) => new Promise<void>((resolve) => { clock.setTimeout(resolve, ms); }),
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        await flush();
        let dueId: number | null = null;
        let due: { at: number; fn: () => void } | null = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (due === null || timer.at < due.at)) {
            dueId = id;
            due = timer;
          }
        }
        if (dueId === null || due === null) break;
        timers.delete(dueId);
        current = due.at;
        due.fn();
      }
      current = target;
      await flush();
    },
    pending: () => timers.size,
  };
  return clock;
}
```

`apps/daemon/src/kernel/ids.ts`:

```ts
import { createHash, randomBytes, randomUUID } from "node:crypto";

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");
export const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");
export const newId = (): string => randomUUID();
```

`apps/daemon/src/kernel/version.ts` (two levels below the package root in both `src/` and `dist/`):

```ts
import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };
export const VERSION: string = pkg.version;
```

- [ ] **Step 5: Write the logger**

`apps/daemon/src/kernel/logger.ts`:

```ts
import type { Clock } from "./clock.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /pass(word)?|secret|token|cookie|authorization|api[-_]?key|credential/i;
const MAX_STRING = 2000;
const MAX_DEPTH = 6;

export function redact(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (value === null || typeof value !== "object" || depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? "[REDACTED]" : redact(item, depth + 1)]),
  );
}

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly clock: Clock;
  readonly write: (line: string) => void;
  readonly bindings?: LogFields;
}

export function createLogger(options: LoggerOptions): Logger {
  const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (RANK[level] < RANK[options.level]) return;
    const body = redact({ ...options.bindings, ...fields }) as LogFields;
    options.write(`${JSON.stringify({ time: new Date(options.clock.now()).toISOString(), level, msg, ...body })}\n`);
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (bindings) => createLogger({ ...options, bindings: { ...options.bindings, ...bindings } }),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
```

- [ ] **Step 6: Write the config loader**

`apps/daemon/src/kernel/config.ts`:

```ts
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import type { LogLevel } from "./logger.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7777;
const DEFAULT_MIN_FREE_MEM_MB = 512;
const VITE_DEV_ORIGIN = "http://localhost:5173";
// S4 sets this value: ceil(p95 RSS of a worker with built-ins after one prompt × 1.5), see docs/spikes/s4.md.
export const WORKER_BUDGET_MB = 600;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface Config {
  readonly home: string;
  readonly host: string;
  readonly port: number;
  readonly dev: boolean;
  readonly tls: { readonly cert: string; readonly key: string } | null;
  readonly publicOrigin: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly piAgentDir: string;
  readonly piHostEntry: string;
  readonly piHostExecArgv: readonly string[];
  readonly testProviderScript: string | null;
  readonly maxWorkers: number;
  readonly minFreeMemMb: number;
  readonly staticRoot: string | null;
  readonly logLevel: LogLevel;
}

export interface ConfigInput {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly homedir: string;
  readonly totalMemMb: number;
  readonly piHostEntry: string;
  readonly piHostExecArgv: readonly string[];
  readonly staticRoot: string | null;
}

const isLoopback = (host: string) => host === "127.0.0.1" || host === "localhost" || host === "::1";
const isWildcard = (host: string) => host === "0.0.0.0" || host === "::";

export function defaultMaxWorkers(totalMemMb: number, budgetMb = WORKER_BUDGET_MB): number {
  return Math.min(16, Math.max(2, Math.floor((totalMemMb * 0.5) / budgetMb)));
}

export function loadConfig(input: ConfigInput): Config {
  const { values } = parseArgs({
    args: [...input.argv],
    strict: true,
    allowPositionals: false,
    options: {
      dev: { type: "boolean", default: false },
      host: { type: "string" },
      port: { type: "string" },
      "tls-cert": { type: "string" },
      "tls-key": { type: "string" },
    },
  });
  const dev = values.dev === true;
  const devId = dev ? createHash("sha256").update(realpathSync(input.cwd)).digest("hex").slice(0, 8) : null;
  const host = values.host ?? DEFAULT_HOST;
  const port = values.port !== undefined ? parsePort(values.port) : devId ? 20_000 + (Number.parseInt(devId.slice(0, 4), 16) % 10_000) : DEFAULT_PORT;
  const cert = values["tls-cert"];
  const key = values["tls-key"];
  if ((cert === undefined) !== (key === undefined)) throw new ConfigError("--tls-cert and --tls-key go together");
  const tls = cert !== undefined && key !== undefined ? { cert, key } : null;
  const scheme = tls ? "https" : "http";
  const local = isLoopback(host) || isWildcard(host);
  const publicOrigin = input.env.PAP_PUBLIC_ORIGIN ? parseOrigin(input.env.PAP_PUBLIC_ORIGIN) : `${scheme}://${local ? "localhost" : host}:${port}`;
  const allowedOrigins = new Set([publicOrigin]);
  if (local) for (const name of ["localhost", "127.0.0.1", "[::1]"]) allowedOrigins.add(`${scheme}://${name}:${port}`);
  if (dev) allowedOrigins.add(VITE_DEV_ORIGIN);
  const script = input.env.PAP_TEST_PROVIDER_SCRIPT;
  if (script !== undefined && !isAbsolute(script)) throw new ConfigError("PAP_TEST_PROVIDER_SCRIPT must be an absolute path");
  return {
    home: input.env.PAP_HOME ?? (devId ? join(input.homedir, ".pap-dev", devId) : join(input.homedir, ".pap")),
    host,
    port,
    dev,
    tls,
    publicOrigin,
    allowedOrigins,
    piAgentDir: input.env.PI_CODING_AGENT_DIR ?? join(input.homedir, ".pi", "agent"),
    piHostEntry: input.piHostEntry,
    piHostExecArgv: input.piHostExecArgv,
    testProviderScript: script ?? null,
    maxWorkers: input.env.PAP_MAX_WORKERS ? parseCount(input.env.PAP_MAX_WORKERS, "PAP_MAX_WORKERS", 1) : defaultMaxWorkers(input.totalMemMb),
    minFreeMemMb: input.env.PAP_MIN_FREE_MEM_MB ? parseCount(input.env.PAP_MIN_FREE_MEM_MB, "PAP_MIN_FREE_MEM_MB", 0) : DEFAULT_MIN_FREE_MEM_MB,
    staticRoot: input.staticRoot,
    logLevel: parseLevel(input.env.PAP_LOG_LEVEL),
  };
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new ConfigError(`invalid port ${raw}`);
  return port;
}

function parseCount(raw: string, name: string, min: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new ConfigError(`${name} must be an integer ≥ ${min}`);
  return value;
}

function parseOrigin(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.origin === "null") throw new Error("opaque origin");
    return url.origin;
  } catch {
    throw new ConfigError(`PAP_PUBLIC_ORIGIN is not an origin: ${raw}`);
  }
}

function parseLevel(raw: string | undefined): LogLevel {
  if (raw === undefined) return "info";
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  throw new ConfigError(`PAP_LOG_LEVEL must be debug, info, warn or error`);
}
```

**Spike fallback / S4:** replace `WORKER_BUDGET_MB = 600` by the value computed in `docs/spikes/s4.md`, and update the third `defaultMaxWorkers` expectation accordingly.

- [ ] **Step 7: Run tests and gates**

Run: `pnpm test:unit apps/daemon/src/kernel && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/daemon pnpm-lock.yaml
git commit -m "feat(daemon): kernel config, clock, logger and ids"
```

---

### Task 14: daemon kernel — node:sqlite database, per-module migrations, snapshot, receipts

**Files:**
- Create: `apps/daemon/src/kernel/db/database.ts`, `migrate.ts`, `meta.ts`, `receipts.ts`
- Create: `apps/daemon/src/kernel/migrations/202610100000_kernel.sql`
- Create: `scripts/copy-sql.ts`
- Modify: `apps/daemon/package.json` (`build` copies SQL files)
- Test: `apps/daemon/src/kernel/db/database.test.ts`, `migrate.test.ts`, `receipts.test.ts`, `scripts/copy-sql.test.ts`

**Interfaces:**
- Consumes: `Clock`, `createFakeClock`, `Logger`, `silentLogger` (Task 13).
- Produces:
  - `interface Db { readOnly; run(sql, params?): { changes }; get<T>(sql, params?): T | undefined; all<T>(sql, params?): T[]; exec(sql): void; transaction<T>(fn: () => T): T; close(): void }`, `type SqlValue`, `openDatabase(path, { readOnly? })`
  - `interface MigrationSource { module; dir }`, `discoverMigrations(sources)`, `migrate({ dbPath, backupsDir, sources, clock, logger }) → { db, applied, snapshotDir, readOnly }`, `MigrationError`, `KERNEL_MIGRATIONS`
  - `ensureInstallTimestamp(db, clock): number`
  - `interface ReceiptStore { find(userId, commandId): { method; result } | null; save(userId, commandId, method, result): void }`, `createReceiptStore(db, clock)`
  - `copySql(packageRoot): string[]`

**Spike fallback / S3:** a FALLBACK on S3 does not change M1 (no FTS5 here). Roadmap M4 swaps `openDatabase` to `better-sqlite3` behind the same `Db` interface, with an ADR.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/kernel/db/database.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "./database.ts";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-db-"));
  db = openDatabase(join(dir, "state.db"));
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL) STRICT");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("openDatabase", () => {
  it("uses WAL, foreign keys and named parameters", () => {
    expect(db.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
    expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
    db.run("INSERT INTO t (v) VALUES ($v)", { v: "a" });
    expect(db.all<{ v: string }>("SELECT v FROM t")).toEqual([{ v: "a" }]);
  });

  it("commits a transaction and rolls it back on error", () => {
    db.transaction(() => db.run("INSERT INTO t (v) VALUES ('kept')"));
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO t (v) VALUES ('dropped')");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.all<{ v: string }>("SELECT v FROM t").map((r) => r.v)).toEqual(["kept"]);
  });

  it("runs a nested transaction inline", () => {
    db.transaction(() => db.transaction(() => db.run("INSERT INTO t (v) VALUES ('n')")));
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM t")?.c).toBe(1);
  });
});
```

`apps/daemon/src/kernel/db/migrate.test.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../clock.ts";
import { silentLogger } from "../logger.ts";
import { ensureInstallTimestamp } from "./meta.ts";
import { migrate, MigrationError, type MigrationSource } from "./migrate.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "pap-migrate-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function source(module: string, files: Record<string, string>): MigrationSource {
  const dir = join(root, "src", module);
  mkdirSync(dir, { recursive: true });
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return { module, dir };
}
const options = (sources: MigrationSource[]) => ({
  dbPath: join(root, "state.db"),
  backupsDir: join(root, "backups"),
  sources,
  clock: createFakeClock(),
  logger: silentLogger,
});
const A1 = { "202601010001_one.sql": "CREATE TABLE a1 (id INTEGER PRIMARY KEY) STRICT;" };
const B2 = { "202601010002_two.sql": "CREATE TABLE b2 (id INTEGER PRIMARY KEY) STRICT;" };

describe("migrate", () => {
  it("applies every module's migrations in timestamp order on a fresh database, without a snapshot", () => {
    const a = source("a", { ...A1, "202601010003_three.sql": "ALTER TABLE a1 ADD COLUMN v TEXT;" });
    const result = migrate(options([source("b", B2), a]));
    expect(result.applied).toEqual(["a/202601010001_one.sql", "b/202601010002_two.sql", "a/202601010003_three.sql"]);
    expect(result.snapshotDir).toBeNull();
    result.db.close();
  });

  it("does nothing the second time and snapshots before a later migration", () => {
    migrate(options([source("a", A1)])).db.close();
    const again = migrate(options([source("a", A1)]));
    expect(again.applied).toEqual([]);
    again.db.close();
    const later = migrate(options([source("a", { ...A1, "202601010009_add.sql": "ALTER TABLE a1 ADD COLUMN w TEXT;" })]));
    expect(later.applied).toEqual(["a/202601010009_add.sql"]);
    expect(later.snapshotDir).not.toBeNull();
    expect(existsSync(join(later.snapshotDir ?? "", "state.db"))).toBe(true);
    later.db.close();
  });

  it("rolls back a failing migration and refuses to continue", () => {
    const broken = source("a", { ...A1, "202601010002_bad.sql": "CREATE TABLE broken (" });
    expect(() => migrate(options([broken]))).toThrow(MigrationError);
    const reopened = migrate(options([source("a", A1)]));
    expect(reopened.applied).toEqual([]);
    expect(reopened.db.get("SELECT name FROM sqlite_master WHERE name = 'broken'")).toBeUndefined();
    reopened.db.close();
  });

  it("opens a database written by a newer binary read-only", () => {
    migrate(options([source("a", A1), source("b", B2)])).db.close();
    const older = migrate(options([source("a", A1)]));
    expect(older.readOnly).toBe(true);
    expect(() => older.db.run("INSERT INTO a1 (id) VALUES (1)")).toThrow();
    older.db.close();
  });

  it("rejects a badly named migration file", () => {
    expect(() => migrate(options([source("a", { "1_bad.sql": "SELECT 1;" })]))).toThrow(MigrationError);
  });

  it("records the install timestamp once", () => {
    const { db } = migrate(options([source("kernel", { "202601010000_meta.sql": "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;" })]));
    const clock = createFakeClock(42);
    expect(ensureInstallTimestamp(db, clock)).toBe(42);
    expect(ensureInstallTimestamp(db, createFakeClock(99))).toBe(42);
    db.close();
  });
});
```

`apps/daemon/src/kernel/db/receipts.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../clock.ts";
import { silentLogger } from "../logger.ts";
import { KERNEL_MIGRATIONS, migrate } from "./migrate.ts";
import { createReceiptStore } from "./receipts.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pap-receipts-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("receipts", () => {
  it("returns the stored result for the same user and command, and nothing for another user", () => {
    const { db } = migrate({ dbPath: join(dir, "s.db"), backupsDir: join(dir, "b"), sources: [KERNEL_MIGRATIONS], clock: createFakeClock(), logger: silentLogger });
    const receipts = createReceiptStore(db, createFakeClock());
    receipts.save("u1", "cmd-00000001", "sessions.create", { sessionId: "s1" });
    expect(receipts.find("u1", "cmd-00000001")).toEqual({ method: "sessions.create", result: { sessionId: "s1" } });
    expect(receipts.find("u2", "cmd-00000001")).toBeNull();
    db.close();
  });
});
```

`scripts/copy-sql.test.ts`:

```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copySql } from "./copy-sql.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "pap-copysql-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("copySql", () => {
  it("copies every src/**/migrations/*.sql into dist with the same relative path", () => {
    mkdirSync(join(root, "src/modules/auth/migrations"), { recursive: true });
    writeFileSync(join(root, "src/modules/auth/migrations/202601010000_auth.sql"), "SELECT 1;");
    writeFileSync(join(root, "src/modules/auth/ignored.sql"), "SELECT 2;");
    expect(copySql(root)).toEqual(["modules/auth/migrations/202601010000_auth.sql"]);
    expect(readFileSync(join(root, "dist/modules/auth/migrations/202601010000_auth.sql"), "utf8")).toBe("SELECT 1;");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/kernel/db scripts/copy-sql.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Write the database wrapper**

`apps/daemon/src/kernel/db/database.ts`:

```ts
import { DatabaseSync, type StatementSync } from "node:sqlite";

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParams = Record<string, SqlValue>;

export interface Db {
  readonly readOnly: boolean;
  run(sql: string, params?: SqlParams): { changes: number };
  get<T>(sql: string, params?: SqlParams): T | undefined;
  all<T>(sql: string, params?: SqlParams): T[];
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  close(): void;
}

export function openDatabase(path: string, options: { readOnly?: boolean } = {}): Db {
  const readOnly = options.readOnly === true;
  const raw = new DatabaseSync(path, { readOnly, enableForeignKeyConstraints: true });
  if (!readOnly) raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA journal_size_limit = 33554432;");
  raw.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  const statements = new Map<string, StatementSync>();
  const prepared = (sql: string): StatementSync => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = raw.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  };
  let depth = 0;
  return {
    readOnly,
    run: (sql, params = {}) => ({ changes: Number(prepared(sql).run(params).changes) }),
    get: <T>(sql: string, params: SqlParams = {}) => prepared(sql).get(params) as T | undefined,
    all: <T>(sql: string, params: SqlParams = {}) => prepared(sql).all(params) as T[],
    exec: (sql) => raw.exec(sql),
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      raw.exec("BEGIN IMMEDIATE");
      depth++;
      try {
        const result = fn();
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      } finally {
        depth--;
      }
    },
    close: () => raw.close(),
  };
}
```

- [ ] **Step 4: Write migrations, meta, receipts and the kernel schema**

`apps/daemon/src/kernel/db/migrate.ts`:

```ts
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Clock } from "../clock.ts";
import type { Logger } from "../logger.ts";
import { openDatabase, type Db } from "./database.ts";

export interface MigrationSource {
  readonly module: string;
  readonly dir: string;
}

interface Migration {
  readonly id: string;
  readonly stamp: string;
  readonly sql: string;
}

export const KERNEL_MIGRATIONS: MigrationSource = { module: "kernel", dir: fileURLToPath(new URL("../migrations/", import.meta.url)) };
const FILE_RE = /^(\d{12})_[a-z0-9_]+\.sql$/;

export class MigrationError extends Error {
  override name = "MigrationError";
}

export function discoverMigrations(sources: readonly MigrationSource[]): Migration[] {
  const found: Migration[] = [];
  for (const source of sources) {
    for (const file of readdirSync(source.dir).sort()) {
      if (!file.endsWith(".sql")) continue;
      const match = FILE_RE.exec(file);
      if (!match?.[1]) throw new MigrationError(`bad migration file name ${source.module}/${file}`);
      found.push({ id: `${source.module}/${file}`, stamp: match[1], sql: readFileSync(join(source.dir, file), "utf8") });
    }
  }
  return found.sort((a, b) => a.stamp.localeCompare(b.stamp) || a.id.localeCompare(b.id));
}

export interface MigrateOptions {
  readonly dbPath: string;
  readonly backupsDir: string;
  readonly sources: readonly MigrationSource[];
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface MigrateResult {
  readonly db: Db;
  readonly applied: string[];
  readonly snapshotDir: string | null;
  readonly readOnly: boolean;
}

export function migrate(options: MigrateOptions): MigrateResult {
  const migrations = discoverMigrations(options.sources);
  const existed = existsSync(options.dbPath) && statSync(options.dbPath).size > 0;
  const db = openDatabase(options.dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT");
  const applied = new Set(db.all<{ id: string }>("SELECT id FROM schema_migrations").map((row) => row.id));
  const known = new Set(migrations.map((migration) => migration.id));
  const unknown = [...applied].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    db.close();
    options.logger.warn("database_newer_than_binary", { unknown });
    return { db: openDatabase(options.dbPath, { readOnly: true }), applied: [], snapshotDir: null, readOnly: true };
  }
  const pending = migrations.filter((migration) => !applied.has(migration.id));
  if (pending.length === 0) return { db, applied: [], snapshotDir: null, readOnly: false };
  const snapshotDir = existed ? snapshot(db, options) : null;
  for (const migration of pending) {
    try {
      db.transaction(() => {
        db.exec(migration.sql);
        db.run("INSERT INTO schema_migrations (id, applied_at) VALUES ($id, $at)", { id: migration.id, at: options.clock.now() });
      });
    } catch (error) {
      db.close();
      throw new MigrationError(`migration ${migration.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    options.logger.info("migration_applied", { id: migration.id });
  }
  return { db, applied: pending.map((migration) => migration.id), snapshotDir, readOnly: false };
}

function snapshot(db: Db, options: MigrateOptions): string {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const stamp = new Date(options.clock.now()).toISOString().replace(/[:.]/g, "-");
  const dir = join(options.backupsDir, `pre-migrate-${stamp}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${options.dbPath}${suffix}`;
    if (existsSync(file)) copyFileSync(file, join(dir, `state.db${suffix}`));
  }
  options.logger.info("pre_migration_snapshot", { dir });
  return dir;
}
```

`apps/daemon/src/kernel/migrations/202610100000_kernel.sql`:

```sql
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE receipts (
  user_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  method TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, command_id)
) STRICT;
```

`apps/daemon/src/kernel/db/meta.ts`:

```ts
import type { Clock } from "../clock.ts";
import type { Db } from "./database.ts";

export function ensureInstallTimestamp(db: Db, clock: Clock): number {
  const row = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'installed_at'");
  if (row) return Number(row.value);
  const now = clock.now();
  if (!db.readOnly) db.run("INSERT INTO meta (key, value) VALUES ('installed_at', $value)", { value: String(now) });
  return now;
}
```

`apps/daemon/src/kernel/db/receipts.ts`:

```ts
import type { Clock } from "../clock.ts";
import type { Db } from "./database.ts";

export interface ReceiptStore {
  find(userId: string, commandId: string): { method: string; result: unknown } | null;
  save(userId: string, commandId: string, method: string, result: unknown): void;
}

export function createReceiptStore(db: Db, clock: Clock): ReceiptStore {
  return {
    find(userId, commandId) {
      const row = db.get<{ method: string; result: string }>(
        "SELECT method, result FROM receipts WHERE user_id = $userId AND command_id = $commandId",
        { userId, commandId },
      );
      return row ? { method: row.method, result: JSON.parse(row.result) as unknown } : null;
    },
    save(userId, commandId, method, result) {
      db.run(
        "INSERT OR IGNORE INTO receipts (user_id, command_id, method, result, created_at) VALUES ($userId, $commandId, $method, $result, $at)",
        { userId, commandId, method, result: JSON.stringify(result), at: clock.now() },
      );
    },
  };
}
```

- [ ] **Step 5: Write the SQL copy step**

`scripts/copy-sql.ts`:

```ts
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function copySql(packageRoot: string): string[] {
  const src = join(packageRoot, "src");
  const copied: string[] = [];
  for (const entry of readdirSync(src, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) continue;
    const from = join(entry.parentPath, entry.name);
    const rel = relative(src, from);
    if (!rel.split(sep).includes("migrations")) continue;
    const to = join(packageRoot, "dist", rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied.push(rel.split(sep).join("/"));
  }
  return copied.sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) copySql(process.cwd());
```

In `apps/daemon/package.json`, set `"build": "tsc -p tsconfig.build.json && node ../../scripts/copy-sql.ts"`.

- [ ] **Step 6: Run tests and gates**

Run: `pnpm test:unit apps/daemon/src/kernel/db scripts/copy-sql.test.ts && pnpm typecheck && pnpm lint && pnpm --filter @pap/daemon build && ls apps/daemon/dist/kernel/migrations`
Expected: PASS; the last command lists `202610100000_kernel.sql`.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon scripts/copy-sql.ts scripts/copy-sql.test.ts
git commit -m "feat(daemon): node:sqlite kernel with forward-only per-module migrations and receipts"
```

---

### Task 15: daemon kernel — Hono HTTP app, Origin guard, safe static serving, server start

**Files:**
- Create: `apps/daemon/src/kernel/http/origin.ts`, `static.ts`, `app.ts`, `server.ts`
- Test: `apps/daemon/src/kernel/http/app.test.ts`, `apps/daemon/src/kernel/http/server.int.test.ts`
- Modify: `apps/daemon/package.json` (dependencies `hono`, `@hono/node-server`)

**Interfaces:**
- Consumes: `Logger`, `silentLogger` (Task 13).
- Produces:
  - `originAllowed(origin, allowed): boolean`, `originGuard(allowed): MiddlewareHandler` (unsafe methods need an allowed `Origin`)
  - `createStaticHandler(root): (urlPath: string) => Response | null`
  - `createHttpApp({ allowedOrigins, staticRoot, logger, mount(app), wsProbe(c) }): Hono` — order: secure headers → Origin guard → `GET /healthz` → module routes → `GET /ws` probe → static + SPA fallback
  - `startServer({ app, host, port, tls, onUpgrade }) → Promise<{ port; close() }>`

- [ ] **Step 1: Install**

Run: `pnpm --filter @pap/daemon add -E hono @hono/node-server`

- [ ] **Step 2: Write the failing tests**

`apps/daemon/src/kernel/http/app.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../logger.ts";
import { createHttpApp } from "./app.ts";

const ORIGIN = "http://localhost:7777";
let root: string;
let web: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-http-"));
  web = join(root, "web");
  mkdirSync(join(web, "assets"), { recursive: true });
  writeFileSync(join(web, "index.html"), "<!doctype html><title>pap</title>");
  writeFileSync(join(web, "assets", "app-1234.js"), "console.log('pap')");
  writeFileSync(join(root, "secret.txt"), "do not serve");
  symlinkSync(join(root, "secret.txt"), join(web, "assets", "link.txt"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const build = (staticRoot: string | null = null) =>
  createHttpApp({
    allowedOrigins: new Set([ORIGIN]),
    staticRoot,
    logger: silentLogger,
    mount: (app) => { app.post("/auth/echo", (c) => c.json({ ok: true })); },
    wsProbe: (c) => c.json({ protocol: 1 }),
  });

describe("http app", () => {
  it("answers /healthz and sets nosniff", async () => {
    const response = await build().request("/healthz");
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects a POST without Origin or with a forged Origin", async () => {
    const app = build();
    expect((await app.request("/auth/echo", { method: "POST" })).status).toBe(403);
    expect((await app.request("/auth/echo", { method: "POST", headers: { origin: "http://evil.example" } })).status).toBe(403);
    expect((await app.request("/auth/echo", { method: "POST", headers: { origin: ORIGIN } })).status).toBe(200);
  });

  it("serves hashed assets immutable and index.html revalidated", async () => {
    const app = build(web);
    const asset = await app.request("/assets/app-1234.js");
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    const index = await app.request("/");
    expect(index.headers.get("cache-control")).toBe("no-cache");
  });

  it("falls back to index.html for app routes and 404s missing files", async () => {
    const app = build(web);
    expect(await (await app.request("/s/abc")).text()).toContain("<title>pap</title>");
    expect((await app.request("/assets/missing.js")).status).toBe(404);
  });

  it("never serves a file outside the static root", async () => {
    const app = build(web);
    for (const path of ["/assets/..%2f..%2fsecret.txt", "/..%2fsecret.txt", "/assets/link.txt", "/%00"]) {
      const response = await app.request(path);
      expect(await response.text()).not.toContain("do not serve");
    }
  });
});
```

`apps/daemon/src/kernel/http/server.int.test.ts`:

```ts
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { startServer } from "./server.ts";

const app = new Hono().get("/healthz", (c) => c.json({ status: "ok" }));
const noUpgrade = (_req: unknown, socket: { destroy(): void }) => socket.destroy();

describe("startServer", () => {
  it("serves on an ephemeral port and closes", async () => {
    const server = await startServer({ app, host: "127.0.0.1", port: 0, tls: null, onUpgrade: noUpgrade });
    expect(await (await fetch(`http://127.0.0.1:${server.port}/healthz`)).json()).toEqual({ status: "ok" });
    await server.close();
  });

  it("rejects a port already in use", async () => {
    const first = await startServer({ app, host: "127.0.0.1", port: 0, tls: null, onUpgrade: noUpgrade });
    await expect(startServer({ app, host: "127.0.0.1", port: first.port, tls: null, onUpgrade: noUpgrade })).rejects.toThrow(/EADDRINUSE/);
    await first.close();
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/kernel/http && pnpm test:int apps/daemon/src/kernel/http`
Expected: FAIL (modules not found).

- [ ] **Step 4: Write origin, static, app, server**

`apps/daemon/src/kernel/http/origin.ts`:

```ts
import type { MiddlewareHandler } from "hono";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function originAllowed(origin: string | null | undefined, allowed: ReadonlySet<string>): boolean {
  return typeof origin === "string" && allowed.has(origin);
}

export function originGuard(allowed: ReadonlySet<string>): MiddlewareHandler {
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method) && !originAllowed(c.req.header("origin"), allowed)) {
      return c.json({ error: { code: "forbidden" } }, 403);
    }
    await next();
  };
}
```

`apps/daemon/src/kernel/http/static.ts`:

```ts
import { createReadStream, realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`);

export function createStaticHandler(root: string): (urlPath: string) => Response | null {
  const realRoot = realpathSync(root);
  return (urlPath) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    if (decoded.includes("\0")) return null;
    const target = resolve(realRoot, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
    if (!inside(target, realRoot)) return null;
    let real: string;
    try {
      real = realpathSync(target);
    } catch {
      return null;
    }
    if (!inside(real, realRoot)) return null;
    const stats = statSync(real);
    if (!stats.isFile()) return null;
    return new Response(Readable.toWeb(createReadStream(real)) as ReadableStream, {
      headers: {
        "content-type": TYPES[extname(real)] ?? "application/octet-stream",
        "content-length": String(stats.size),
        "cache-control": decoded.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      },
    });
  };
}
```

`apps/daemon/src/kernel/http/app.ts`:

```ts
import { Hono, type Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { Logger } from "../logger.ts";
import { originGuard } from "./origin.ts";
import { createStaticHandler } from "./static.ts";

export interface HttpAppOptions {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly staticRoot: string | null;
  readonly logger: Logger;
  mount(app: Hono): void;
  wsProbe(c: Context): Response | Promise<Response>;
}

const notFound = (c: Context) => c.json({ error: { code: "not_found" } }, 404);

export function createHttpApp(options: HttpAppOptions): Hono {
  const app = new Hono();
  app.use("*", secureHeaders());
  app.use("*", originGuard(options.allowedOrigins));
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  options.mount(app);
  app.get("/ws", (c) => options.wsProbe(c));
  if (options.staticRoot) {
    const serve = createStaticHandler(options.staticRoot);
    app.get("*", (c) => {
      const path = c.req.path;
      const hit = serve(path === "/" ? "/index.html" : path);
      if (hit) return hit;
      if (path.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(path)) return notFound(c);
      return serve("/index.html") ?? notFound(c);
    });
  }
  app.notFound(notFound);
  app.onError((error, c) => {
    options.logger.error("http_error", { err: error, path: c.req.path });
    return c.json({ error: { code: "internal" } }, 500);
  });
  return app;
}
```

`apps/daemon/src/kernel/http/server.ts`:

```ts
import { readFileSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";

export interface RunningServer {
  readonly port: number;
  close(): Promise<void>;
}

export interface StartServerOptions {
  readonly app: Hono;
  readonly host: string;
  readonly port: number;
  readonly tls: { readonly cert: string; readonly key: string } | null;
  onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const server = serve({
    fetch: options.app.fetch,
    hostname: options.host,
    port: options.port,
    ...(options.tls
      ? { createServer: createHttpsServer, serverOptions: { cert: readFileSync(options.tls.cert), key: readFileSync(options.tls.key) } }
      : {}),
  }) as Server;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
  server.on("upgrade", options.onUpgrade);
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
```

- [ ] **Step 5: Run tests and gates**

Run: `pnpm test:unit apps/daemon/src/kernel/http && pnpm test:int apps/daemon/src/kernel/http && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon pnpm-lock.yaml
git commit -m "feat(daemon): hono http app with origin guard and safe static serving"
```

---

### Task 16: daemon kernel — `/ws` socket: dispatcher, stream hub with cursor resume, upgrade gate

**Files:**
- Create: `apps/daemon/src/kernel/ws/stream-hub.ts`, `dispatcher.ts`, `ws-server.ts`, `system-handlers.ts`
- Create: `docs/adr/0003-event-frames-carry-an-epoch.md`
- Test: `apps/daemon/src/kernel/ws/stream-hub.test.ts`, `dispatcher.test.ts`, `ws-server.int.test.ts`
- Modify: `apps/daemon/package.json` (dependency `ws`, dev dependency `@types/ws`)

**Interfaces:**
- Consumes: contracts (`methods`, frames, `HandlerTable`, `PapError`), `ReceiptStore` (Task 14), `Clock`, `Logger` (Task 13), `originAllowed`, `startServer` (Task 15).
- Produces:
  - `createStreamHub(epoch?) → StreamHub { epoch; registerSnapshot(stream, provider); publish(stream, key, event); open({ connectionId, sub, stream, key, after, send }); close(connectionId, sub?) }`, `MAX_REPLAY_EVENTS = 128`, `MAX_REPLAY_BYTES = 1 MiB`; a snapshot provider returns the whole snapshot event synchronously
  - `createDispatcher({ handlers, receipts, logger }) → Dispatch = (frame, ctx) => Promise<ResponseFrame>`
  - `createWsServer({ allowedOrigins, authenticate(req), dispatch, hub, logger, clock, serverVersion }) → { handleUpgrade(req, socket, head); close() }`
  - `systemHandlers(clock): Pick<HandlerTable, "system.ping" | "unsubscribe">`

- [ ] **Step 1: Install**

Run: `pnpm --filter @pap/daemon add -E ws && pnpm --filter @pap/daemon add -D -E @types/ws`

- [ ] **Step 2: Write the failing hub and dispatcher tests**

`apps/daemon/src/kernel/ws/stream-hub.test.ts`:

```ts
import type { EventFrame } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createStreamHub, MAX_REPLAY_EVENTS } from "./stream-hub.ts";

function setup() {
  const hub = createStreamHub("epoch-1");
  hub.registerSnapshot("session", (key) => ({ kind: "snapshot", key }));
  const frames: EventFrame[] = [];
  const open = (after?: { epoch: string; seq: number }, sub = "s1") =>
    hub.open({ connectionId: "c1", sub, stream: "session", key: "k", after, send: (frame) => frames.push(frame) });
  return { hub, frames, open };
}

describe("stream hub", () => {
  it("sends a snapshot first, then live events with increasing seq", () => {
    const { hub, frames, open } = setup();
    hub.publish("session", "k", { n: 1 });
    open();
    hub.publish("session", "k", { n: 2 });
    expect(frames).toEqual([
      { sub: "s1", epoch: "epoch-1", seq: 1, event: { kind: "snapshot", key: "k" } },
      { sub: "s1", epoch: "epoch-1", seq: 2, event: { n: 2 } },
    ]);
  });

  it("replays only the gap for a cursor of the same epoch", () => {
    const { hub, frames, open } = setup();
    for (const n of [1, 2, 3]) hub.publish("session", "k", { n });
    open({ epoch: "epoch-1", seq: 1 });
    expect(frames.map((f) => f.seq)).toEqual([2, 3]);
  });

  it("sends nothing when the cursor is current", () => {
    const { hub, frames, open } = setup();
    hub.publish("session", "k", { n: 1 });
    open({ epoch: "epoch-1", seq: 1 });
    expect(frames).toEqual([]);
  });

  it("a cursor from another epoch gets a snapshot", () => {
    const { hub, frames, open } = setup();
    hub.publish("session", "k", { n: 1 });
    open({ epoch: "epoch-0", seq: 1 });
    expect(frames[0]?.event).toEqual({ kind: "snapshot", key: "k" });
  });

  it("a cursor older than the ring, or ahead of the server, gets a snapshot", () => {
    const { hub, frames, open } = setup();
    for (let n = 0; n < MAX_REPLAY_EVENTS + 5; n++) hub.publish("session", "k", { n });
    open({ epoch: "epoch-1", seq: 1 }, "old");
    open({ epoch: "epoch-1", seq: 10_000 }, "ahead");
    expect(frames.filter((f) => (f.event as { kind?: string }).kind === "snapshot").map((f) => f.sub)).toEqual(["old", "ahead"]);
  });

  it("trims the ring by bytes", () => {
    const { hub, frames, open } = setup();
    for (let n = 0; n < 3; n++) hub.publish("session", "k", { blob: "x".repeat(600_000) });
    open({ epoch: "epoch-1", seq: 0 });
    expect((frames[0]?.event as { kind?: string }).kind).toBe("snapshot");
  });

  it("stops delivery after close", () => {
    const { hub, frames, open } = setup();
    open();
    hub.close("c1", "s1");
    hub.publish("session", "k", { n: 1 });
    expect(frames).toHaveLength(1);
  });
});
```

`apps/daemon/src/kernel/ws/dispatcher.test.ts`:

```ts
import { ALL_PERMISSIONS, PapError, type Caller, type HandlerContext, type HandlerTable } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../clock.ts";
import type { ReceiptStore } from "../db/receipts.ts";
import { silentLogger } from "../logger.ts";
import { createDispatcher } from "./dispatcher.ts";
import { systemHandlers } from "./system-handlers.ts";

const owner: Caller = { userId: "u1", permissions: new Set(ALL_PERMISSIONS) };
const ctx = (caller: Caller = owner): HandlerContext => ({ caller, connectionId: "c1", openSubscription: () => "s1", closeSubscription: () => {} });

function setup() {
  const stored = new Map<string, { method: string; result: unknown }>();
  const receipts: ReceiptStore = {
    find: (userId, commandId) => stored.get(`${userId}:${commandId}`) ?? null,
    save: (userId, commandId, method, result) => { stored.set(`${userId}:${commandId}`, { method, result }); },
  };
  const create = vi.fn(async () => ({ sessionId: "s-1" }));
  const handlers = {
    ...systemHandlers(createFakeClock(5)),
    "sessions.create": create,
    "sessions.list": async () => { throw new PapError("not_found"); },
    "sessions.abort": async () => { throw new Error("attempt to write a readonly database"); },
    "sessions.respondDialog": async () => { throw new Error("boom"); },
  } as unknown as HandlerTable;
  return { dispatch: createDispatcher({ handlers, receipts, logger: silentLogger }), create };
}

describe("dispatcher", () => {
  it("answers unknown_method for unknown names and prototype keys", async () => {
    const { dispatch } = setup();
    for (const method of ["nope", "constructor", "__proto__", "toString"]) {
      expect(await dispatch({ id: 1, method }, ctx())).toEqual({ id: 1, ok: false, error: { code: "unknown_method" } });
    }
  });

  it("checks the permission before anything else", async () => {
    const { dispatch, create } = setup();
    const reader: Caller = { userId: "u1", permissions: new Set(["sessions:read"]) };
    expect(await dispatch({ id: 2, method: "sessions.create", params: { cwd: "/tmp" }, commandId: "cmd-00000001" }, ctx(reader))).toEqual({ id: 2, ok: false, error: { code: "forbidden" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects invalid params and mutations without commandId", async () => {
    const { dispatch } = setup();
    expect((await dispatch({ id: 3, method: "sessions.create", params: { cwd: 42 }, commandId: "cmd-00000002" }, ctx())).ok).toBe(false);
    expect(await dispatch({ id: 4, method: "sessions.create", params: { cwd: "/tmp" } }, ctx())).toEqual({ id: 4, ok: false, error: { code: "bad_request" } });
  });

  it("returns the stored result for a repeated commandId without re-running the handler", async () => {
    const { dispatch, create } = setup();
    const frame = { id: 5, method: "sessions.create", params: { cwd: "/tmp" }, commandId: "cmd-00000003" };
    const [a, b] = await Promise.all([dispatch(frame, ctx()), dispatch({ ...frame, id: 6 }, ctx())]);
    const c = await dispatch({ ...frame, id: 7 }, ctx());
    expect([a, b, c]).toEqual([
      { id: 5, ok: true, result: { sessionId: "s-1" } },
      { id: 6, ok: true, result: { sessionId: "s-1" } },
      { id: 7, ok: true, result: { sessionId: "s-1" } },
    ]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("maps PapError to its code, readonly errors to read_only, anything else to internal", async () => {
    const { dispatch } = setup();
    expect(await dispatch({ id: 8, method: "sessions.list", params: {} }, ctx())).toEqual({ id: 8, ok: false, error: { code: "not_found" } });
    expect(await dispatch({ id: 9, method: "sessions.abort", params: { sessionId: "s" } }, ctx())).toEqual({ id: 9, ok: false, error: { code: "read_only" } });
    const internal = await dispatch({ id: 10, method: "sessions.respondDialog", params: { sessionId: "s", dialogId: "d", response: { confirmed: true } }, commandId: "cmd-00000004" }, ctx());
    expect(internal).toEqual({ id: 10, ok: false, error: { code: "internal" } });
  });

  it("answers system.ping with the clock time", async () => {
    const { dispatch } = setup();
    expect(await dispatch({ id: 11, method: "system.ping", params: {} }, ctx())).toEqual({ id: 11, ok: true, result: { now: 5 } });
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/kernel/ws`
Expected: FAIL (modules not found).

- [ ] **Step 4: Write the hub, the dispatcher and the system handlers**

`apps/daemon/src/kernel/ws/stream-hub.ts`:

```ts
import { randomBytes } from "node:crypto";
import type { Cursor, EventFrame, StreamName } from "@pap/contracts";

export const MAX_REPLAY_EVENTS = 128;
export const MAX_REPLAY_BYTES = 1024 * 1024;

export type SnapshotProvider = (key: string) => unknown;

interface Entry {
  readonly seq: number;
  readonly event: unknown;
  readonly bytes: number;
}

interface Channel {
  seq: number;
  ring: Entry[];
  ringBytes: number;
  readonly subscribers: Map<string, { readonly sub: string; send(frame: EventFrame): void }>;
}

export interface OpenInput {
  readonly connectionId: string;
  readonly sub: string;
  readonly stream: StreamName;
  readonly key: string;
  readonly after: Cursor | undefined;
  send(frame: EventFrame): void;
}

export interface StreamHub {
  readonly epoch: string;
  registerSnapshot(stream: StreamName, provider: SnapshotProvider): void;
  publish(stream: StreamName, key: string, event: unknown): void;
  open(input: OpenInput): void;
  close(connectionId: string, sub?: string): void;
}

function canReplay(channel: Channel, after: Cursor | undefined, epoch: string): after is Cursor {
  if (!after || after.epoch !== epoch || after.seq > channel.seq) return false;
  if (after.seq === channel.seq) return true;
  const first = channel.ring[0];
  return first !== undefined && first.seq <= after.seq + 1;
}

export function createStreamHub(epoch: string = randomBytes(8).toString("hex")): StreamHub {
  const channels = new Map<string, Channel>();
  const providers = new Map<StreamName, SnapshotProvider>();
  const subscriptions = new Map<string, string>();
  const channelOf = (stream: StreamName, key: string): [string, Channel] => {
    const id = `${stream}:${key}`;
    let channel = channels.get(id);
    if (!channel) {
      channel = { seq: 0, ring: [], ringBytes: 0, subscribers: new Map() };
      channels.set(id, channel);
    }
    return [id, channel];
  };
  return {
    epoch,
    registerSnapshot(stream, provider) {
      providers.set(stream, provider);
    },
    publish(stream, key, event) {
      const [, channel] = channelOf(stream, key);
      const seq = ++channel.seq;
      const bytes = Buffer.byteLength(JSON.stringify(event));
      channel.ring.push({ seq, event, bytes });
      channel.ringBytes += bytes;
      while (channel.ring.length > MAX_REPLAY_EVENTS || channel.ringBytes > MAX_REPLAY_BYTES) {
        const dropped = channel.ring.shift();
        if (!dropped) break;
        channel.ringBytes -= dropped.bytes;
      }
      for (const subscriber of channel.subscribers.values()) subscriber.send({ sub: subscriber.sub, epoch, seq, event });
    },
    open(input) {
      const [id, channel] = channelOf(input.stream, input.key);
      if (canReplay(channel, input.after, epoch)) {
        const after = input.after.seq;
        for (const entry of channel.ring) if (entry.seq > after) input.send({ sub: input.sub, epoch, seq: entry.seq, event: entry.event });
      } else {
        const provider = providers.get(input.stream);
        if (!provider) throw new Error(`no snapshot provider for stream ${input.stream}`);
        input.send({ sub: input.sub, epoch, seq: channel.seq, event: provider(input.key) });
      }
      const subKey = `${input.connectionId}:${input.sub}`;
      channel.subscribers.set(subKey, { sub: input.sub, send: input.send });
      subscriptions.set(subKey, id);
    },
    close(connectionId, sub) {
      for (const [subKey, channelId] of [...subscriptions]) {
        if (!subKey.startsWith(`${connectionId}:`)) continue;
        if (sub !== undefined && subKey !== `${connectionId}:${sub}`) continue;
        channels.get(channelId)?.subscribers.delete(subKey);
        subscriptions.delete(subKey);
      }
    },
  };
}
```

`apps/daemon/src/kernel/ws/dispatcher.ts`:

```ts
import {
  methods,
  PapError,
  type ErrorCode,
  type HandlerContext,
  type HandlerTable,
  type MethodDef,
  type RequestFrame,
  type ResponseFrame,
} from "@pap/contracts";
import type { ReceiptStore } from "../db/receipts.ts";
import type { Logger } from "../logger.ts";

export type Dispatch = (frame: RequestFrame, ctx: HandlerContext) => Promise<ResponseFrame>;
type AnyHandler = (params: unknown, ctx: HandlerContext) => Promise<unknown>;

const ok = (id: number, result: unknown): ResponseFrame => ({ id, ok: true, result });
const fail = (id: number, code: ErrorCode): ResponseFrame => ({ id, ok: false, error: { code } });
const isReadOnlyError = (error: unknown) => error instanceof Error && /readonly database/i.test(error.message);

export function createDispatcher(options: { handlers: HandlerTable; receipts: ReceiptStore; logger: Logger }): Dispatch {
  const catalogue = methods as unknown as Record<string, MethodDef>;
  const handlers = options.handlers as unknown as Record<string, AnyHandler>;
  const inflight = new Map<string, Promise<ResponseFrame>>();

  async function run(id: number, def: MethodDef, params: unknown, ctx: HandlerContext, commandId: string | null): Promise<ResponseFrame> {
    try {
      const handler = handlers[def.name];
      if (!handler) return fail(id, "unknown_method");
      const result = def.result.parse(await handler(params, ctx));
      if (commandId) options.receipts.save(ctx.caller.userId, commandId, def.name, result);
      return ok(id, result);
    } catch (error) {
      if (error instanceof PapError) return fail(id, error.code);
      if (isReadOnlyError(error)) return fail(id, "read_only");
      options.logger.error("rpc_handler_failed", { method: def.name, err: error });
      return fail(id, "internal");
    }
  }

  return async (frame, ctx) => {
    if (!Object.hasOwn(catalogue, frame.method)) return fail(frame.id, "unknown_method");
    const def = catalogue[frame.method] as MethodDef;
    if (!ctx.caller.permissions.has(def.permission)) return fail(frame.id, "forbidden");
    const params = def.params.safeParse(frame.params ?? {});
    if (!params.success) return fail(frame.id, "bad_request");
    if (def.idempotent) return run(frame.id, def, params.data, ctx, null);
    if (!frame.commandId) return fail(frame.id, "bad_request");
    const stored = options.receipts.find(ctx.caller.userId, frame.commandId);
    if (stored) return stored.method === frame.method ? ok(frame.id, stored.result) : fail(frame.id, "conflict");
    const key = `${ctx.caller.userId}:${frame.commandId}`;
    const running = inflight.get(key);
    if (running) return { ...(await running), id: frame.id };
    const pending = run(frame.id, def, params.data, ctx, frame.commandId);
    inflight.set(key, pending);
    try {
      return await pending;
    } finally {
      inflight.delete(key);
    }
  };
}
```

`apps/daemon/src/kernel/ws/system-handlers.ts`:

```ts
import type { HandlerTable } from "@pap/contracts";
import type { Clock } from "../clock.ts";

export function systemHandlers(clock: Clock): Pick<HandlerTable, "system.ping" | "unsubscribe"> {
  return {
    "system.ping": async () => ({ now: clock.now() }),
    unsubscribe: async ({ sub }, ctx) => {
      ctx.closeSubscription(sub);
      return { ok: true as const };
    },
  };
}
```

- [ ] **Step 5: Run the unit tests**

Run: `pnpm test:unit apps/daemon/src/kernel/ws`
Expected: PASS.

- [ ] **Step 6: Write the failing socket test**

`apps/daemon/src/kernel/ws/ws-server.int.test.ts`:

```ts
import { ALL_PERMISSIONS, type Caller, type HandlerTable } from "@pap/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createSystemClock } from "../clock.ts";
import { startServer, type RunningServer } from "../http/server.ts";
import { silentLogger } from "../logger.ts";
import { createDispatcher } from "./dispatcher.ts";
import { createStreamHub, type StreamHub } from "./stream-hub.ts";
import { createWsServer, type WsServer } from "./ws-server.ts";

const ORIGIN = "http://localhost:7777";
const owner: Caller = { userId: "u1", permissions: new Set(ALL_PERMISSIONS) };
let server: RunningServer;
let ws: WsServer;
let hub: StreamHub;

beforeEach(async () => {
  hub = createStreamHub("epoch-1");
  hub.registerSnapshot("session", (key) => ({ kind: "snapshot", key }));
  const handlers = {
    "system.ping": async () => ({ now: 1 }),
    "subscribe.session": async ({ sessionId, after }: { sessionId: string; after?: { epoch: string; seq: number } }, ctx: { openSubscription(s: string, k: string, a: unknown): string }) => ({ sub: ctx.openSubscription("session", sessionId, after) }),
  } as unknown as HandlerTable;
  const dispatch = createDispatcher({ handlers, receipts: { find: () => null, save: () => {} }, logger: silentLogger });
  ws = createWsServer({
    allowedOrigins: new Set([ORIGIN]),
    authenticate: (req) => (req.headers.cookie === "pap_session=good" ? owner : null),
    dispatch,
    hub,
    logger: silentLogger,
    clock: createSystemClock(),
    serverVersion: "0.0.0-test",
  });
  server = await startServer({ app: new Hono(), host: "127.0.0.1", port: 0, tls: null, onUpgrade: (req, socket, head) => ws.handleUpgrade(req, socket, head) });
});
afterEach(async () => {
  ws.close();
  await server.close();
});

function connect(headers: Record<string, string>, path = "/ws?proto=1") {
  return new Promise<{ socket: WebSocket; next(): Promise<unknown> }>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}${path}`, { headers });
    const queue: unknown[] = [];
    const waiting: Array<(frame: unknown) => void> = [];
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as unknown;
      const waiter = waiting.shift();
      if (waiter) waiter(frame);
      else queue.push(frame);
    });
    socket.on("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    socket.on("open", () =>
      resolve({ socket, next: () => (queue.length > 0 ? Promise.resolve(queue.shift()) : new Promise((r) => waiting.push(r))) }),
    );
  });
}
const good = { origin: ORIGIN, cookie: "pap_session=good" };

describe("/ws", () => {
  it("rejects a forged Origin, an old protocol and a missing session", async () => {
    await expect(connect({ ...good, origin: "http://evil.example" })).rejects.toThrow("status 403");
    await expect(connect(good, "/ws?proto=0")).rejects.toThrow("status 426");
    await expect(connect({ origin: ORIGIN })).rejects.toThrow("status 401");
  });

  it("greets with hello, then answers requests", async () => {
    const client = await connect(good);
    expect(await client.next()).toEqual({ protocol: 1, capabilities: ["rpc", "subscribe"], serverVersion: "0.0.0-test" });
    client.socket.send(JSON.stringify({ id: 1, method: "system.ping", params: {} }));
    expect(await client.next()).toEqual({ id: 1, ok: true, result: { now: 1 } });
    client.socket.close();
  });

  it("keeps the socket open after bad JSON and invalid params", async () => {
    const client = await connect(good);
    await client.next();
    client.socket.send("not json");
    client.socket.send(JSON.stringify({ id: 2, method: "subscribe.session", params: {} }));
    expect(await client.next()).toEqual({ id: 2, ok: false, error: { code: "bad_request" } });
    client.socket.send(JSON.stringify({ id: 3, method: "system.ping", params: {} }));
    expect(await client.next()).toEqual({ id: 3, ok: true, result: { now: 1 } });
    client.socket.close();
  });

  it("closes with 1009 on a frame above 1 MiB", async () => {
    const client = await connect(good);
    await client.next();
    const closed = new Promise<number>((resolve) => client.socket.on("close", (code) => resolve(code)));
    client.socket.send(JSON.stringify({ id: 4, method: "system.ping", params: { pad: "x".repeat(1024 * 1024) } }));
    expect(await closed).toBe(1009);
  });

  it("sends the subscribe response before the snapshot, then live events", async () => {
    const client = await connect(good);
    await client.next();
    client.socket.send(JSON.stringify({ id: 5, method: "subscribe.session", params: { sessionId: "k" } }));
    expect(await client.next()).toEqual({ id: 5, ok: true, result: { sub: "s1" } });
    expect(await client.next()).toEqual({ sub: "s1", epoch: "epoch-1", seq: 0, event: { kind: "snapshot", key: "k" } });
    hub.publish("session", "k", { n: 1 });
    expect(await client.next()).toEqual({ sub: "s1", epoch: "epoch-1", seq: 1, event: { n: 1 } });
    client.socket.close();
  });
});
```

- [ ] **Step 7: Run it to see it fail**

Run: `pnpm test:int apps/daemon/src/kernel/ws`
Expected: FAIL (`ws-server.ts` not found).

- [ ] **Step 8: Write the socket server**

`apps/daemon/src/kernel/ws/ws-server.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  CAPABILITIES,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  RequestFrame,
  type Caller,
  type Cursor,
  type EventFrame,
  type StreamName,
} from "@pap/contracts";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { Clock, TimerHandle } from "../clock.ts";
import { originAllowed } from "../http/origin.ts";
import type { Logger } from "../logger.ts";
import type { Dispatch } from "./dispatcher.ts";
import type { StreamHub } from "./stream-hub.ts";

export const SERVER_PING_MS = 15_000;
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const STATUS_TEXT: Record<number, string> = { 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 426: "Upgrade Required" };

export interface WsServerOptions {
  readonly allowedOrigins: ReadonlySet<string>;
  authenticate(req: IncomingMessage): Caller | null;
  readonly dispatch: Dispatch;
  readonly hub: StreamHub;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly serverVersion: string;
}

export interface WsServer {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
}

function reject(socket: Duplex, status: number): void {
  socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function createWsServer(options: WsServerOptions): WsServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  function attach(ws: WebSocket, caller: Caller): void {
    const connectionId = randomUUID();
    let alive = true;
    let nextSub = 0;
    let timer: TimerHandle | null = null;
    const send = (frame: unknown) => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        options.logger.warn("ws_slow_consumer", { connectionId });
        ws.terminate();
        return;
      }
      ws.send(JSON.stringify(frame));
    };
    const heartbeat = () => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
      timer = options.clock.setTimeout(heartbeat, SERVER_PING_MS);
    };
    timer = options.clock.setTimeout(heartbeat, SERVER_PING_MS);

    const onText = async (text: string): Promise<void> => {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        options.logger.debug("ws_bad_json", { connectionId });
        return;
      }
      const parsed = RequestFrame.safeParse(raw);
      if (!parsed.success) {
        const id = (raw as { id?: unknown } | null)?.id;
        if (typeof id === "number" && Number.isInteger(id) && id >= 0) send({ id, ok: false, error: { code: "bad_request" } });
        return;
      }
      const afterResponse: Array<() => void> = [];
      const response = await options.dispatch(parsed.data, {
        caller,
        connectionId,
        openSubscription(stream: StreamName, key: string, after: Cursor | undefined) {
          const sub = `s${++nextSub}`;
          afterResponse.push(() => {
            try {
              options.hub.open({ connectionId, sub, stream, key, after, send: (frame: EventFrame) => send(frame) });
            } catch (error) {
              options.logger.error("subscription_failed", { stream, err: error });
            }
          });
          return sub;
        },
        closeSubscription(sub: string) {
          options.hub.close(connectionId, sub);
        },
      });
      send(response);
      if (response.ok) for (const open of afterResponse) open();
    };

    ws.on("pong", () => { alive = true; });
    ws.on("message", (data: RawData, isBinary: boolean) => {
      alive = true;
      if (!isBinary) void onText(data.toString());
    });
    ws.on("close", () => {
      if (timer) options.clock.clearTimeout(timer);
      options.hub.close(connectionId);
    });
    ws.on("error", (error) => options.logger.debug("ws_error", { err: error }));
    send({ protocol: PROTOCOL_VERSION, capabilities: [...CAPABILITIES], serverVersion: options.serverVersion });
  }

  return {
    handleUpgrade(req, socket, head) {
      const url = new URL(req.url ?? "/", "http://pap.invalid");
      if (url.pathname !== "/ws") return reject(socket, 404);
      if (!originAllowed(req.headers.origin, options.allowedOrigins)) return reject(socket, 403);
      if (url.searchParams.get("proto") !== String(PROTOCOL_VERSION)) return reject(socket, 426);
      const caller = options.authenticate(req);
      if (!caller) return reject(socket, 401);
      wss.handleUpgrade(req, socket, head, (ws) => attach(ws, caller));
    },
    close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}
```

- [ ] **Step 9: Record the epoch deviation**

`docs/adr/0003-event-frames-carry-an-epoch.md`:

~~~markdown
# ADR 0003 — subscription frames carry an epoch

Status: accepted · Date: [today] · Spec: C §4.2–4.3

Spec C shapes subscription frames as `{sub, seq, event}` and cursors as the last `seq`. Sequence numbers live in daemon memory and restart at 0 when the daemon restarts, so a tab reconnecting with `after: 500` after a restart could match a new, unrelated `seq` 500 and skip events.

Decision: frames are `{sub, epoch, seq, event}` and cursors are `{epoch, seq}`. `epoch` is random per daemon start. A cursor from another epoch always gets a bounded snapshot. Everything else in §4.3 is unchanged.
~~~

- [ ] **Step 10: Run tests and gates**

Run: `pnpm test:unit apps/daemon/src/kernel/ws && pnpm test:int apps/daemon/src/kernel/ws && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/daemon docs/adr/0003-event-frames-carry-an-epoch.md pnpm-lock.yaml
git commit -m "feat(daemon): /ws socket with typed dispatch, receipts and cursor resume"
```

---

### Task 17: auth module — setup URL, scrypt passwords, hashed cookie sessions, login throttle

**Files:**
- Create: `apps/daemon/src/modules/auth/migrations/202610100100_auth.sql`
- Create: `apps/daemon/src/modules/auth/passwords.ts`, `setup-token.ts`, `throttle.ts`, `cookies.ts`, `store.ts`, `service.ts`, `http.ts`, `index.ts`
- Test: `apps/daemon/src/modules/auth/passwords.test.ts`, `throttle.test.ts`, `service.test.ts`, `http.test.ts`

**Interfaces:**
- Consumes: `Db`, `migrate`, `KERNEL_MIGRATIONS`, `MigrationSource` (Task 14), `Clock`, `Logger`, `randomToken`, `sha256Hex`, `newId` (Task 13), `createHttpApp` (Task 15), contracts `PapError`, `ALL_PERMISSIONS`, `Caller`.
- Produces (`modules/auth/index.ts`):
  - `AUTH_MIGRATIONS: MigrationSource`
  - `createAuthModule({ db, clock, logger, publicOrigin, allowedOrigins }) → AuthModule { mount(app: Hono): void; authenticateCookieHeader(header: string | undefined): Caller | null; setupUrl(): string | null }`
  - HTTP: `GET /auth/status → { setupRequired, authenticated, username, passkeysAvailable }`, `POST /auth/setup {token, username, password} → 201 + cookie`, `POST /auth/login {username, password} → 200 + cookie | 401 | 429`, `POST /auth/logout → 204`
  - Internals used by Task 18: `AuthService.startSession(userId, userAgent)`, `AuthService.authenticate(cookieValue)`, `AuthStore`, `errorResponse(c, error)`, `setSessionCookie(c, session)`, `readJson(c, schema)`, `SESSION_COOKIE`

- [ ] **Step 1: Write the failing unit tests**

`apps/daemon/src/modules/auth/passwords.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./passwords.ts";

describe("passwords", () => {
  it("verifies the right password only", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored.startsWith("scrypt$32768$8$1$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("correct horse battery stapl", stored)).toBe(false);
  });

  it("treats composed and decomposed accents as the same password", async () => {
    const stored = await hashPassword("café-crème-2026");
    expect(await verifyPassword("café-crème-2026", stored)).toBe(true);
  });

  it("rejects a malformed stored hash without throwing", async () => {
    expect(await verifyPassword("anything", "md5$abc")).toBe(false);
  });
});
```

`apps/daemon/src/modules/auth/throttle.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createThrottle } from "./throttle.ts";

describe("login throttle", () => {
  it("doubles the wait per failure up to 60 s and takes the max over keys", async () => {
    const clock = createFakeClock();
    const throttle = createThrottle(clock);
    throttle.fail(["ip:a", "user:owner"]);
    expect(throttle.retryAfterMs(["ip:a"])).toBe(1000);
    throttle.fail(["user:owner"]);
    expect(throttle.retryAfterMs(["ip:b", "user:owner"])).toBe(2000);
    for (let i = 0; i < 10; i++) throttle.fail(["ip:a"]);
    expect(throttle.retryAfterMs(["ip:a"])).toBe(60_000);
  });

  it("forgets a key after five idle minutes and on success", async () => {
    const clock = createFakeClock();
    const throttle = createThrottle(clock);
    throttle.fail(["ip:a"]);
    await clock.advance(5 * 60_000);
    throttle.fail(["ip:a"]);
    expect(throttle.retryAfterMs(["ip:a"])).toBe(1000);
    throttle.succeed(["ip:a"]);
    expect(throttle.retryAfterMs(["ip:a"])).toBe(0);
  });
});
```

`apps/daemon/src/modules/auth/service.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { AUTH_MIGRATIONS } from "./index.ts";
import { createAuthService, RateLimitedError, type AuthService } from "./service.ts";
import { createSetupToken } from "./setup-token.ts";
import { createAuthStore } from "./store.ts";
import { createThrottle } from "./throttle.ts";

let dir: string;
let db: Db;
let clock: FakeClock;
let service: AuthService;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-auth-"));
  clock = createFakeClock();
  db = migrate({ dbPath: join(dir, "s.db"), backupsDir: join(dir, "b"), sources: [KERNEL_MIGRATIONS, AUTH_MIGRATIONS], clock, logger: silentLogger }).db;
  service = createAuthService({ store: createAuthStore(db), clock, logger: silentLogger, publicOrigin: "http://localhost:7777", throttle: createThrottle(clock), setupToken: createSetupToken(true) });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const tokenOf = (url: string | null) => new URL(url ?? "http://x").hash.replace("#token=", "");
const setupInput = (token: string, username = "owner") => ({ token, username, password: "correct horse battery staple", ip: "127.0.0.1", userAgent: "test" });

describe("auth service", () => {
  it("publishes a one-time setup URL with the token in the fragment", async () => {
    const url = service.setupUrl();
    expect(url?.startsWith("http://localhost:7777/setup#token=")).toBe(true);
    await service.setup(setupInput(tokenOf(url)));
    expect(service.setupUrl()).toBeNull();
    expect(service.status(undefined).setupRequired).toBe(false);
  });

  it("refuses a wrong setup token and any second setup", async () => {
    await expect(service.setup(setupInput("wrong"))).rejects.toThrow(PapError);
    const token = tokenOf(service.setupUrl());
    await clock.advance(2000);
    await service.setup(setupInput(token));
    await clock.advance(2000);
    await expect(service.setup(setupInput(token, "second"))).rejects.toThrow(PapError);
  });

  it("creates exactly one owner when two setups race", async () => {
    const token = tokenOf(service.setupUrl());
    const results = await Promise.allSettled([service.setup(setupInput(token, "one")), service.setup(setupInput(token, "two"))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM users")?.c).toBe(1);
  });

  it("logs in with the right password, rejects a wrong one, then throttles", async () => {
    await service.setup(setupInput(tokenOf(service.setupUrl())));
    const session = await service.login({ username: "OWNER", password: "correct horse battery staple", ip: "10.0.0.1", userAgent: undefined });
    expect(service.authenticate(session.cookieValue)?.username).toBe("owner");
    await expect(service.login({ username: "owner", password: "nope-nope-nope", ip: "10.0.0.1", userAgent: undefined })).rejects.toThrow(PapError);
    await expect(service.login({ username: "owner", password: "correct horse battery staple", ip: "10.0.0.1", userAgent: undefined })).rejects.toThrow(RateLimitedError);
  });

  it("slides a session forward and drops it after expiry or logout", async () => {
    const session = await service.setup(setupInput(tokenOf(service.setupUrl())));
    await clock.advance(2 * 24 * 3600 * 1000);
    expect(service.authenticate(session.cookieValue)).not.toBeNull();
    await clock.advance(29 * 24 * 3600 * 1000);
    expect(service.authenticate(session.cookieValue)).not.toBeNull();
    service.logout(session.cookieValue);
    expect(service.authenticate(session.cookieValue)).toBeNull();
    const other = await service.login({ username: "owner", password: "correct horse battery staple", ip: "1.1.1.1", userAgent: undefined });
    await clock.advance(31 * 24 * 3600 * 1000);
    expect(service.authenticate(other.cookieValue)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/auth`
Expected: FAIL (modules not found).

- [ ] **Step 3: Write the schema, passwords, token, throttle, cookies, store**

`apps/daemon/src/modules/auth/migrations/202610100100_auth.sql`:

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE auth_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
) STRICT;

CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
```

`apps/daemon/src/modules/auth/passwords.ts`:

```ts
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_LENGTH = 64;

function scrypt(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCallback(password.normalize("NFC"), salt, KEY_LENGTH, options, (error, key) => (error ? reject(error) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, PARAMS);
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, expected] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !expected) return false;
  const key = await scrypt(password, Buffer.from(salt, "base64url"), { N: Number(n), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem });
  const wanted = Buffer.from(expected, "base64url");
  return wanted.length === key.length && timingSafeEqual(wanted, key);
}

let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword("pap-dummy-password-for-timing");
  return dummy;
}
```

`apps/daemon/src/modules/auth/setup-token.ts`:

```ts
import { timingSafeEqual } from "node:crypto";
import { randomToken, sha256Hex } from "../../kernel/ids.ts";

export interface SetupToken {
  current(): string | null;
  verify(candidate: string): boolean;
  consume(): void;
}

export function createSetupToken(active: boolean): SetupToken {
  let token = active ? randomToken(32) : null;
  return {
    current: () => token,
    verify(candidate) {
      if (token === null || candidate.length > 256) return false;
      return timingSafeEqual(Buffer.from(sha256Hex(candidate)), Buffer.from(sha256Hex(token)));
    },
    consume() {
      token = null;
    },
  };
}
```

`apps/daemon/src/modules/auth/throttle.ts`:

```ts
import type { Clock } from "../../kernel/clock.ts";

const BASE_MS = 1000;
const MAX_MS = 60_000;
const RESET_AFTER_MS = 5 * 60_000;
const MAX_KEYS = 10_000;

export interface Throttle {
  retryAfterMs(keys: readonly string[]): number;
  fail(keys: readonly string[]): void;
  succeed(keys: readonly string[]): void;
}

interface Entry {
  failures: number;
  lastFailureAt: number;
  blockedUntil: number;
}

const backoffMs = (failures: number) => Math.min(BASE_MS * 2 ** Math.min(failures - 1, 31), MAX_MS);

export function createThrottle(clock: Clock): Throttle {
  const entries = new Map<string, Entry>();
  const live = (key: string): Entry | undefined => {
    const entry = entries.get(key);
    if (entry && clock.now() - entry.lastFailureAt >= RESET_AFTER_MS) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    retryAfterMs: (keys) => Math.max(0, ...keys.map((key) => (live(key)?.blockedUntil ?? 0) - clock.now())),
    fail(keys) {
      if (entries.size > MAX_KEYS) for (const key of [...entries.keys()]) live(key);
      for (const key of keys) {
        const entry = live(key) ?? { failures: 0, lastFailureAt: 0, blockedUntil: 0 };
        entry.failures += 1;
        entry.lastFailureAt = clock.now();
        entry.blockedUntil = clock.now() + backoffMs(entry.failures);
        entries.set(key, entry);
      }
    },
    succeed(keys) {
      for (const key of keys) entries.delete(key);
    },
  };
}
```

`apps/daemon/src/modules/auth/cookies.ts`:

```ts
export const SESSION_COOKIE = "pap_session";
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}
```

`apps/daemon/src/modules/auth/store.ts`:

```ts
import type { Db } from "../../kernel/db/database.ts";

export interface UserRow {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
}

export interface SessionRow {
  readonly idHash: string;
  readonly userId: string;
  readonly username: string;
  readonly expiresAt: number;
}

export interface NewSession {
  readonly idHash: string;
  readonly userId: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
  readonly userAgent: string | null;
}

export interface AuthStore {
  countUsers(): number;
  insertFirstUser(user: { id: string; username: string; passwordHash: string; createdAt: number }): boolean;
  findUserByName(username: string): UserRow | undefined;
  findUserById(id: string): UserRow | undefined;
  insertSession(session: NewSession): void;
  findSession(idHash: string): SessionRow | undefined;
  extendSession(idHash: string, lastSeenAt: number, expiresAt: number): void;
  deleteSession(idHash: string): void;
}

const USER_COLUMNS = "id, username, password_hash AS passwordHash";

export function createAuthStore(db: Db): AuthStore {
  return {
    countUsers: () => db.get<{ c: number }>("SELECT count(*) AS c FROM users")?.c ?? 0,
    insertFirstUser: (user) =>
      db.run(
        "INSERT INTO users (id, username, password_hash, created_at) SELECT $id, $username, $passwordHash, $createdAt WHERE NOT EXISTS (SELECT 1 FROM users)",
        user,
      ).changes === 1,
    findUserByName: (username) => db.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE username = $username`, { username }),
    findUserById: (id) => db.get<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $id`, { id }),
    insertSession: (session) => {
      db.run(
        "INSERT INTO auth_sessions (id_hash, user_id, created_at, last_seen_at, expires_at, user_agent) VALUES ($idHash, $userId, $createdAt, $lastSeenAt, $expiresAt, $userAgent)",
        { ...session },
      );
    },
    findSession: (idHash) =>
      db.get<SessionRow>(
        "SELECT s.id_hash AS idHash, s.user_id AS userId, u.username AS username, s.expires_at AS expiresAt FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = $idHash",
        { idHash },
      ),
    extendSession: (idHash, lastSeenAt, expiresAt) => {
      db.run("UPDATE auth_sessions SET last_seen_at = $lastSeenAt, expires_at = $expiresAt WHERE id_hash = $idHash", { idHash, lastSeenAt, expiresAt });
    },
    deleteSession: (idHash) => {
      db.run("DELETE FROM auth_sessions WHERE id_hash = $idHash", { idHash });
    },
  };
}
```

- [ ] **Step 4: Write the service**

`apps/daemon/src/modules/auth/service.ts`:

```ts
import { ALL_PERMISSIONS, PapError, type Caller, type Permission } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { newId, randomToken, sha256Hex } from "../../kernel/ids.ts";
import type { Logger } from "../../kernel/logger.ts";
import { SESSION_TTL_MS } from "./cookies.ts";
import { dummyHash, hashPassword, verifyPassword } from "./passwords.ts";
import type { SetupToken } from "./setup-token.ts";
import type { AuthStore } from "./store.ts";
import type { Throttle } from "./throttle.ts";

const SLIDE_AFTER_MS = 24 * 3600 * 1000;
const OWNER_PERMISSIONS: ReadonlySet<Permission> = new Set(ALL_PERMISSIONS);

export class RateLimitedError extends PapError {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("rate_limited");
    this.retryAfterMs = retryAfterMs;
  }
}

export interface StartedSession {
  readonly cookieValue: string;
  readonly maxAgeSeconds: number;
}

export interface AuthServiceDeps {
  readonly store: AuthStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly publicOrigin: string;
  readonly throttle: Throttle;
  readonly setupToken: SetupToken;
}

export interface Credentials {
  readonly username: string;
  readonly password: string;
  readonly ip: string;
  readonly userAgent: string | undefined;
}

export interface AuthService {
  status(cookieValue: string | undefined): { setupRequired: boolean; authenticated: boolean; username: string | null };
  setup(input: Credentials & { token: string }): Promise<StartedSession>;
  login(input: Credentials): Promise<StartedSession>;
  logout(cookieValue: string | undefined): void;
  authenticate(cookieValue: string | undefined): (Caller & { username: string }) | null;
  startSession(userId: string, userAgent: string | undefined): StartedSession;
  setupUrl(): string | null;
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const guard = (keys: string[]) => {
    const wait = deps.throttle.retryAfterMs(keys);
    if (wait > 0) throw new RateLimitedError(wait);
  };
  const startSession = (userId: string, userAgent: string | undefined): StartedSession => {
    const cookieValue = randomToken(32);
    const now = deps.clock.now();
    deps.store.insertSession({ idHash: sha256Hex(cookieValue), userId, createdAt: now, lastSeenAt: now, expiresAt: now + SESSION_TTL_MS, userAgent: userAgent?.slice(0, 256) ?? null });
    return { cookieValue, maxAgeSeconds: SESSION_TTL_MS / 1000 };
  };
  const authenticate = (cookieValue: string | undefined) => {
    if (!cookieValue || cookieValue.length > 128) return null;
    const session = deps.store.findSession(sha256Hex(cookieValue));
    const now = deps.clock.now();
    if (!session || session.expiresAt <= now) return null;
    if (session.expiresAt - now < SESSION_TTL_MS - SLIDE_AFTER_MS) deps.store.extendSession(session.idHash, now, now + SESSION_TTL_MS);
    return { userId: session.userId, username: session.username, permissions: OWNER_PERMISSIONS };
  };
  return {
    status(cookieValue) {
      const caller = authenticate(cookieValue);
      return { setupRequired: deps.store.countUsers() === 0, authenticated: caller !== null, username: caller?.username ?? null };
    },
    async setup(input) {
      const keys = [`ip:${input.ip}`];
      guard(keys);
      if (deps.store.countUsers() > 0 || !deps.setupToken.verify(input.token)) {
        deps.throttle.fail(keys);
        throw new PapError("unauthenticated");
      }
      const id = newId();
      const passwordHash = await hashPassword(input.password);
      if (!deps.store.insertFirstUser({ id, username: input.username, passwordHash, createdAt: deps.clock.now() })) throw new PapError("conflict");
      deps.setupToken.consume();
      deps.throttle.succeed(keys);
      deps.logger.info("owner_created", { username: input.username });
      return startSession(id, input.userAgent);
    },
    async login(input) {
      const keys = [`ip:${input.ip}`, `user:${input.username.toLowerCase()}`];
      guard(keys);
      const user = deps.store.findUserByName(input.username);
      const valid = await verifyPassword(input.password, user?.passwordHash ?? (await dummyHash()));
      if (!user || !valid) {
        deps.throttle.fail(keys);
        throw new PapError("unauthenticated");
      }
      deps.throttle.succeed(keys);
      return startSession(user.id, input.userAgent);
    },
    logout(cookieValue) {
      if (cookieValue) deps.store.deleteSession(sha256Hex(cookieValue));
    },
    authenticate,
    startSession,
    setupUrl() {
      const token = deps.setupToken.current();
      return token && deps.store.countUsers() === 0 ? `${deps.publicOrigin}/setup#token=${token}` : null;
    },
  };
}
```

- [ ] **Step 5: Run the unit tests**

Run: `pnpm test:unit apps/daemon/src/modules/auth/passwords.test.ts apps/daemon/src/modules/auth/throttle.test.ts`
Expected: PASS (`service.test.ts` still fails: `index.ts` is missing).

- [ ] **Step 6: Write the failing HTTP test**

`apps/daemon/src/modules/auth/http.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { createHttpApp } from "../../kernel/http/app.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { AUTH_MIGRATIONS, createAuthModule, type AuthModule } from "./index.ts";

const ORIGIN = "http://localhost:7777";
let dir: string;
let db: Db;
let auth: AuthModule;
let app: Hono;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-auth-http-"));
  const clock = createFakeClock();
  db = migrate({ dbPath: join(dir, "s.db"), backupsDir: join(dir, "b"), sources: [KERNEL_MIGRATIONS, AUTH_MIGRATIONS], clock, logger: silentLogger }).db;
  auth = createAuthModule({ db, clock, logger: silentLogger, publicOrigin: ORIGIN, allowedOrigins: new Set([ORIGIN]) });
  app = createHttpApp({ allowedOrigins: new Set([ORIGIN]), staticRoot: null, logger: silentLogger, mount: (a) => auth.mount(a), wsProbe: (c) => c.json({}) });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const token = () => new URL(auth.setupUrl() ?? "http://x").hash.replace("#token=", "");
const owner = { username: "owner", password: "correct horse battery staple" };

describe("auth routes", () => {
  it("setup sets an HttpOnly, Secure, SameSite=Strict cookie that authenticates", async () => {
    const response = await post("/auth/setup", { token: token(), ...owner });
    expect(response.status).toBe(201);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^pap_session=[\w-]+;/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    const value = cookie.split(";")[0] ?? "";
    expect(auth.authenticateCookieHeader(value)?.userId).toBeTruthy();
    const status = await (await app.request("/auth/status", { headers: { cookie: value } })).json();
    expect(status).toMatchObject({ setupRequired: false, authenticated: true, username: "owner" });
  });

  it("answers 401 with a fixed code, then 429 with Retry-After", async () => {
    await post("/auth/setup", { token: token(), ...owner });
    const bad = await post("/auth/login", { username: "owner", password: "wrong-password-123" });
    expect([bad.status, await bad.json()]).toEqual([401, { error: { code: "unauthenticated" } }]);
    const throttled = await post("/auth/login", owner);
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("logout clears the cookie and the session", async () => {
    const value = ((await post("/auth/setup", { token: token(), ...owner })).headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const out = await post("/auth/logout", {}, { cookie: value });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(auth.authenticateCookieHeader(value)).toBeNull();
  });

  it("validates input and rejects bodies above 64 KB", async () => {
    expect((await post("/auth/setup", { token: token(), username: "bad name!", password: "correct horse battery staple" })).status).toBe(400);
    expect((await post("/auth/setup", { token: token(), username: "owner", password: "short" })).status).toBe(400);
    expect((await post("/auth/login", { username: "owner", password: "x".repeat(70_000) })).status).toBe(413);
  });
});
```

- [ ] **Step 7: Write the routes and the module entry**

`apps/daemon/src/modules/auth/http.ts`:

```ts
import { getConnInfo } from "@hono/node-server/conninfo";
import { PapError } from "@pap/contracts";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { SESSION_COOKIE } from "./cookies.ts";
import { RateLimitedError, type AuthService, type StartedSession } from "./service.ts";

const Username = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
const Password = z.string().min(12).max(1024);
const SetupBody = z.object({ token: z.string().min(1).max(256), username: Username, password: Password });
const LoginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(1024) });

export async function readJson<T>(c: Context, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const parsed = schema.safeParse(await c.req.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function setSessionCookie(c: Context, session: StartedSession): void {
  setCookie(c, SESSION_COOKIE, session.cookieValue, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: session.maxAgeSeconds });
}

export function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof RateLimitedError) {
    c.header("retry-after", String(Math.ceil(error.retryAfterMs / 1000)));
    return c.json({ error: { code: error.code } }, 429);
  }
  if (error instanceof PapError) {
    const status = error.code === "unauthenticated" ? 401 : error.code === "conflict" ? 409 : error.code === "not_found" ? 404 : 400;
    return c.json({ error: { code: error.code } }, status);
  }
  throw error;
}

export function clientIp(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

const badRequest = (c: Context) => c.json({ error: { code: "bad_request" } }, 400);

export function mountAuthRoutes(app: Hono, deps: { service: AuthService; passkeysAvailable: boolean }): void {
  app.use("/auth/*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: { code: "payload_too_large" } }, 413) }));
  app.get("/auth/status", (c) => c.json({ ...deps.service.status(getCookie(c, SESSION_COOKIE)), passkeysAvailable: deps.passkeysAvailable }));
  app.post("/auth/setup", async (c) => {
    const body = await readJson(c, SetupBody);
    if (!body) return badRequest(c);
    try {
      setSessionCookie(c, await deps.service.setup({ ...body, ip: clientIp(c), userAgent: c.req.header("user-agent") }));
      return c.json({ ok: true }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });
  app.post("/auth/login", async (c) => {
    const body = await readJson(c, LoginBody);
    if (!body) return badRequest(c);
    try {
      setSessionCookie(c, await deps.service.login({ ...body, ip: clientIp(c), userAgent: c.req.header("user-agent") }));
      return c.json({ ok: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  });
  app.post("/auth/logout", (c) => {
    deps.service.logout(getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true, httpOnly: true, sameSite: "Strict" });
    return c.body(null, 204);
  });
}
```

`apps/daemon/src/modules/auth/index.ts`:

```ts
import { fileURLToPath } from "node:url";
import type { Caller } from "@pap/contracts";
import type { Hono } from "hono";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { MigrationSource } from "../../kernel/db/migrate.ts";
import type { Logger } from "../../kernel/logger.ts";
import { readCookie, SESSION_COOKIE } from "./cookies.ts";
import { mountAuthRoutes } from "./http.ts";
import { createAuthService } from "./service.ts";
import { createSetupToken } from "./setup-token.ts";
import { createAuthStore } from "./store.ts";
import { createThrottle } from "./throttle.ts";

export const AUTH_MIGRATIONS: MigrationSource = { module: "auth", dir: fileURLToPath(new URL("./migrations/", import.meta.url)) };

export interface AuthModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly publicOrigin: string;
  readonly allowedOrigins: ReadonlySet<string>;
}

export interface AuthModule {
  mount(app: Hono): void;
  authenticateCookieHeader(header: string | undefined): Caller | null;
  setupUrl(): string | null;
}

export function createAuthModule(deps: AuthModuleDeps): AuthModule {
  const store = createAuthStore(deps.db);
  const service = createAuthService({
    store,
    clock: deps.clock,
    logger: deps.logger.child({ module: "auth" }),
    publicOrigin: deps.publicOrigin,
    throttle: createThrottle(deps.clock),
    setupToken: createSetupToken(store.countUsers() === 0),
  });
  return {
    mount: (app) => mountAuthRoutes(app, { service, passkeysAvailable: false }),
    authenticateCookieHeader: (header) => service.authenticate(readCookie(header, SESSION_COOKIE)),
    setupUrl: () => service.setupUrl(),
  };
}
```

Run: `pnpm --filter @pap/daemon add -E zod@^4`

- [ ] **Step 8: Run tests and gates**

Run: `pnpm test:unit apps/daemon/src/modules/auth && pnpm typecheck && pnpm lint && pnpm knip`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/daemon pnpm-lock.yaml
git commit -m "feat(auth): one-time setup url, scrypt passwords, hashed cookie sessions and throttle"
```

---

### Task 18: auth module — passkeys with `@simplewebauthn/server`

**Files:**
- Create: `apps/daemon/src/modules/auth/migrations/202610100110_passkeys.sql`, `apps/daemon/src/modules/auth/passkey-store.ts`, `apps/daemon/src/modules/auth/passkeys.ts`, `apps/daemon/src/modules/auth/passkey-http.ts`
- Modify: `apps/daemon/src/modules/auth/store.ts` (extends `PasskeyStore`), `apps/daemon/src/modules/auth/index.ts` (wire passkeys, `passkeysAvailable`)
- Test: `apps/daemon/src/modules/auth/passkeys.test.ts`, `apps/daemon/src/modules/auth/passkey-http.test.ts`

**Interfaces:**
- Consumes: `AuthStore`, `AuthService.startSession/authenticate`, `errorResponse`, `setSessionCookie`, `readJson`, `SESSION_COOKIE` (Task 17).
- Produces:
  - `rpIdFor(origin): string | null` (null for IP hosts: WebAuthn rejects IP RP IDs)
  - `createPasskeyService({ store, clock, publicOrigin, allowedOrigins, lib? }) → { available; registerOptions(userId); registerVerify(userId, flowId, response); loginOptions(); loginVerify(flowId, response): Promise<userId> }`
  - HTTP: `POST /auth/passkey/register/options` (session required), `/register/verify`, `/login/options`, `/login/verify` (sets the cookie)
  - Real cryptographic verification is covered by the Chromium virtual-authenticator journey in Task 27.

- [ ] **Step 1: Install**

Run: `pnpm --filter @pap/daemon add -E @simplewebauthn/server@^13`

- [ ] **Step 2: Write the failing tests**

`apps/daemon/src/modules/auth/passkeys.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { AUTH_MIGRATIONS } from "./index.ts";
import { createPasskeyService, rpIdFor, type WebAuthnLib } from "./passkeys.ts";
import { createAuthStore, type AuthStore } from "./store.ts";

const fakeLib = {
  generateRegistrationOptions: async (options: { rpID: string }) => ({ challenge: "reg-challenge", rp: { id: options.rpID } }),
  verifyRegistrationResponse: async ({ expectedChallenge }: { expectedChallenge: string }) => ({
    verified: expectedChallenge === "reg-challenge",
    registrationInfo: { credential: { id: "cred-1", publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] } },
  }),
  generateAuthenticationOptions: async () => ({ challenge: "auth-challenge" }),
  verifyAuthenticationResponse: async ({ credential }: { credential: { id: string } }) => ({
    verified: credential.id === "cred-1",
    authenticationInfo: { newCounter: 5 },
  }),
} as unknown as WebAuthnLib;

let dir: string;
let db: Db;
let store: AuthStore;
let clock: FakeClock;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-passkeys-"));
  clock = createFakeClock();
  db = migrate({ dbPath: join(dir, "s.db"), backupsDir: join(dir, "b"), sources: [KERNEL_MIGRATIONS, AUTH_MIGRATIONS], clock, logger: silentLogger }).db;
  store = createAuthStore(db);
  store.insertFirstUser({ id: "u1", username: "owner", passwordHash: "scrypt$x", createdAt: 0 });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const service = (publicOrigin = "http://localhost:7777") =>
  createPasskeyService({ store, clock, publicOrigin, allowedOrigins: new Set([publicOrigin, "http://127.0.0.1:7777"]), lib: fakeLib });

describe("passkeys", () => {
  it("an IP origin disables passkeys instead of failing", async () => {
    expect(rpIdFor("http://127.0.0.1:7777")).toBeNull();
    expect(rpIdFor("http://[::1]:7777")).toBeNull();
    expect(rpIdFor("https://pap.example.ts.net")).toBe("pap.example.ts.net");
    const ip = service("http://127.0.0.1:7777");
    expect(ip.available).toBe(false);
    await expect(ip.loginOptions()).rejects.toThrow(PapError);
  });

  it("registers, then signs in and stores the new counter", async () => {
    const passkeys = service();
    const registration = await passkeys.registerOptions("u1");
    await passkeys.registerVerify("u1", registration.flowId, { id: "cred-1" });
    const login = await passkeys.loginOptions();
    expect(await passkeys.loginVerify(login.flowId, { id: "cred-1" })).toBe("u1");
    expect(store.findPasskey("cred-1")?.counter).toBe(5);
  });

  it("uses a flow once, expires it after five minutes, and binds it to its user", async () => {
    const passkeys = service();
    const registration = await passkeys.registerOptions("u1");
    await expect(passkeys.registerVerify("u2", registration.flowId, { id: "cred-1" })).rejects.toThrow(PapError);
    await expect(passkeys.registerVerify("u1", registration.flowId, { id: "cred-1" })).rejects.toThrow(PapError);
    const late = await passkeys.loginOptions();
    await clock.advance(5 * 60_000 + 1);
    await expect(passkeys.loginVerify(late.flowId, { id: "cred-1" })).rejects.toThrow(PapError);
  });
});
```

`apps/daemon/src/modules/auth/passkey-http.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { createHttpApp } from "../../kernel/http/app.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { AUTH_MIGRATIONS, createAuthModule } from "./index.ts";

const ORIGIN = "http://localhost:7777";
let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-passkey-http-"));
  db = migrate({ dbPath: join(dir, "s.db"), backupsDir: join(dir, "b"), sources: [KERNEL_MIGRATIONS, AUTH_MIGRATIONS], clock: createFakeClock(), logger: silentLogger }).db;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function appFor(publicOrigin: string) {
  const auth = createAuthModule({ db, clock: createFakeClock(), logger: silentLogger, publicOrigin, allowedOrigins: new Set([publicOrigin]) });
  return createHttpApp({ allowedOrigins: new Set([publicOrigin]), staticRoot: null, logger: silentLogger, mount: (a) => auth.mount(a), wsProbe: (c) => c.json({}) });
}

describe("passkey routes", () => {
  it("reports availability from the public origin", async () => {
    expect(await (await appFor(ORIGIN).request("/auth/status")).json()).toMatchObject({ passkeysAvailable: true });
    expect(await (await appFor("http://127.0.0.1:7777").request("/auth/status")).json()).toMatchObject({ passkeysAvailable: false });
  });

  it("requires a session to register a passkey", async () => {
    const response = await appFor(ORIGIN).request("/auth/passkey/register/options", { method: "POST", headers: { origin: ORIGIN } });
    expect(response.status).toBe(401);
  });

  it("returns login options with a flow id", async () => {
    const response = await appFor(ORIGIN).request("/auth/passkey/login/options", { method: "POST", headers: { origin: ORIGIN } });
    const body = (await response.json()) as { flowId: string; options: { challenge: string; rpId: string } };
    expect(body.flowId.length).toBeGreaterThan(10);
    expect(body.options.rpId).toBe("localhost");
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/auth/passkey`
Expected: FAIL (modules not found).

- [ ] **Step 4: Write the schema and extend the store**

`apps/daemon/src/modules/auth/migrations/202610100110_passkeys.sql`:

```sql
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX passkeys_user ON passkeys(user_id);
```

Create `apps/daemon/src/modules/auth/passkey-store.ts` (passkey rows; the auth module's own table, kept apart so `store.ts` stays small), and extend `AuthStore` with it:

```ts
import type { Db } from "../../kernel/db/database.ts";

export interface PasskeyRow {
  readonly id: string;
  readonly userId: string;
  readonly publicKey: Uint8Array;
  readonly counter: number;
  readonly transports: string[];
}

export interface PasskeyStore {
  listPasskeys(userId: string): PasskeyRow[];
  findPasskey(id: string): PasskeyRow | undefined;
  insertPasskey(row: PasskeyRow & { readonly createdAt: number }): void;
  updatePasskeyCounter(id: string, counter: number): void;
}

type RawPasskey = Omit<PasskeyRow, "transports"> & { transports: string };
const toPasskey = (row: RawPasskey): PasskeyRow => ({ ...row, transports: JSON.parse(row.transports) as string[] });
const COLUMNS = "id, user_id AS userId, public_key AS publicKey, counter, transports";

export function createPasskeyStore(db: Db): PasskeyStore {
  return {
    listPasskeys: (userId) => db.all<RawPasskey>(`SELECT ${COLUMNS} FROM passkeys WHERE user_id = $userId`, { userId }).map(toPasskey),
    findPasskey: (id) => {
      const row = db.get<RawPasskey>(`SELECT ${COLUMNS} FROM passkeys WHERE id = $id`, { id });
      return row ? toPasskey(row) : undefined;
    },
    insertPasskey: (row) => {
      db.run(
        "INSERT INTO passkeys (id, user_id, public_key, counter, transports, created_at) VALUES ($id, $userId, $publicKey, $counter, $transports, $createdAt)",
        { id: row.id, userId: row.userId, publicKey: row.publicKey, counter: row.counter, transports: JSON.stringify(row.transports), createdAt: row.createdAt },
      );
    },
    updatePasskeyCounter: (id, counter) => {
      db.run("UPDATE passkeys SET counter = $counter WHERE id = $id", { id, counter });
    },
  };
}
```

In `apps/daemon/src/modules/auth/store.ts`: add `import { createPasskeyStore, type PasskeyStore } from "./passkey-store.ts";`, change the declaration to `export interface AuthStore extends PasskeyStore {`, and make `createAuthStore` return `{ ...createPasskeyStore(db), countUsers: …, …the existing members }`.

- [ ] **Step 5: Write the passkey service and routes**

`apps/daemon/src/modules/auth/passkeys.ts`:

```ts
import { isIP } from "node:net";
import { PapError } from "@pap/contracts";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import type { Clock } from "../../kernel/clock.ts";
import { randomToken } from "../../kernel/ids.ts";
import type { AuthStore } from "./store.ts";

const FLOW_TTL_MS = 5 * 60_000;
const MAX_FLOWS = 1000;

export interface WebAuthnLib {
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
}
const realLib: WebAuthnLib = { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse };

export function rpIdFor(origin: string): string | null {
  const host = new URL(origin).hostname.replace(/^\[|\]$/g, "");
  return isIP(host) === 0 ? host : null;
}

export interface PasskeyService {
  readonly available: boolean;
  registerOptions(userId: string): Promise<{ flowId: string; options: unknown }>;
  registerVerify(userId: string, flowId: string, response: unknown): Promise<void>;
  loginOptions(): Promise<{ flowId: string; options: unknown }>;
  loginVerify(flowId: string, response: unknown): Promise<string>;
}

export interface PasskeyDeps {
  readonly store: AuthStore;
  readonly clock: Clock;
  readonly publicOrigin: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly lib?: WebAuthnLib;
}

export function createPasskeyService(deps: PasskeyDeps): PasskeyService {
  const rpID = rpIdFor(deps.publicOrigin);
  const lib = deps.lib ?? realLib;
  const origins = [...deps.allowedOrigins].filter((origin) => rpIdFor(origin) === rpID);
  const flows = new Map<string, { challenge: string; userId: string | null; expiresAt: number }>();
  const requireRp = (): string => {
    if (!rpID) throw new PapError("not_found");
    return rpID;
  };
  const prune = () => {
    const now = deps.clock.now();
    for (const [id, flow] of flows) if (flow.expiresAt <= now) flows.delete(id);
    if (flows.size > MAX_FLOWS) flows.clear();
  };
  const remember = (challenge: string, userId: string | null): string => {
    prune();
    const flowId = randomToken(16);
    flows.set(flowId, { challenge, userId, expiresAt: deps.clock.now() + FLOW_TTL_MS });
    return flowId;
  };
  const take = (flowId: string, userId: string | null) => {
    const flow = flows.get(flowId);
    flows.delete(flowId);
    if (!flow || flow.expiresAt <= deps.clock.now() || flow.userId !== userId) throw new PapError("unauthenticated");
    return flow;
  };
  return {
    available: rpID !== null,
    async registerOptions(userId) {
      const rp = requireRp();
      const user = deps.store.findUserById(userId);
      if (!user) throw new PapError("unauthenticated");
      const options = await lib.generateRegistrationOptions({
        rpName: "pap",
        rpID: rp,
        userName: user.username,
        userID: new TextEncoder().encode(user.id),
        attestationType: "none",
        excludeCredentials: deps.store.listPasskeys(userId).map((p) => ({ id: p.id, transports: p.transports as AuthenticatorTransportFuture[] })),
        authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
      });
      return { flowId: remember(options.challenge, userId), options };
    },
    async registerVerify(userId, flowId, response) {
      const rp = requireRp();
      const flow = take(flowId, userId);
      const result = await lib
        .verifyRegistrationResponse({ response: response as never, expectedChallenge: flow.challenge, expectedOrigin: origins, expectedRPID: rp, requireUserVerification: false })
        .catch(() => null);
      if (!result?.verified || !result.registrationInfo) throw new PapError("unauthenticated");
      const { credential } = result.registrationInfo;
      deps.store.insertPasskey({ id: credential.id, userId, publicKey: credential.publicKey, counter: credential.counter, transports: credential.transports ?? [], createdAt: deps.clock.now() });
    },
    async loginOptions() {
      const rp = requireRp();
      const options = await lib.generateAuthenticationOptions({ rpID: rp, userVerification: "preferred", allowCredentials: [] });
      return { flowId: remember(options.challenge, null), options };
    },
    async loginVerify(flowId, response) {
      const rp = requireRp();
      const flow = take(flowId, null);
      const id = (response as { id?: unknown } | null)?.id;
      const passkey = typeof id === "string" ? deps.store.findPasskey(id) : undefined;
      if (!passkey) throw new PapError("unauthenticated");
      const result = await lib
        .verifyAuthenticationResponse({
          response: response as never,
          expectedChallenge: flow.challenge,
          expectedOrigin: origins,
          expectedRPID: rp,
          credential: { id: passkey.id, publicKey: passkey.publicKey as Uint8Array<ArrayBuffer>, counter: passkey.counter, transports: passkey.transports as AuthenticatorTransportFuture[] },
          requireUserVerification: false,
        })
        .catch(() => null);
      if (!result?.verified) throw new PapError("unauthenticated");
      deps.store.updatePasskeyCounter(passkey.id, result.authenticationInfo.newCounter);
      return passkey.userId;
    },
  };
}
```

`apps/daemon/src/modules/auth/passkey-http.ts`:

```ts
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { SESSION_COOKIE } from "./cookies.ts";
import { errorResponse, readJson, setSessionCookie } from "./http.ts";
import type { PasskeyService } from "./passkeys.ts";
import type { AuthService } from "./service.ts";

const FlowBody = z.object({ flowId: z.string().min(1).max(64), response: z.record(z.string(), z.unknown()) });
const unauthenticated = (c: Context) => c.json({ error: { code: "unauthenticated" } }, 401);
const badRequest = (c: Context) => c.json({ error: { code: "bad_request" } }, 400);

export function mountPasskeyRoutes(app: Hono, deps: { passkeys: PasskeyService; auth: AuthService }): void {
  app.post("/auth/passkey/register/options", async (c) => {
    const caller = deps.auth.authenticate(getCookie(c, SESSION_COOKIE));
    if (!caller) return unauthenticated(c);
    try {
      return c.json(await deps.passkeys.registerOptions(caller.userId));
    } catch (error) {
      return errorResponse(c, error);
    }
  });
  app.post("/auth/passkey/register/verify", async (c) => {
    const caller = deps.auth.authenticate(getCookie(c, SESSION_COOKIE));
    if (!caller) return unauthenticated(c);
    const body = await readJson(c, FlowBody);
    if (!body) return badRequest(c);
    try {
      await deps.passkeys.registerVerify(caller.userId, body.flowId, body.response);
      return c.json({ ok: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  });
  app.post("/auth/passkey/login/options", async (c) => {
    try {
      return c.json(await deps.passkeys.loginOptions());
    } catch (error) {
      return errorResponse(c, error);
    }
  });
  app.post("/auth/passkey/login/verify", async (c) => {
    const body = await readJson(c, FlowBody);
    if (!body) return badRequest(c);
    try {
      const userId = await deps.passkeys.loginVerify(body.flowId, body.response);
      setSessionCookie(c, deps.auth.startSession(userId, c.req.header("user-agent")));
      return c.json({ ok: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  });
}
```

In `apps/daemon/src/modules/auth/index.ts`, build the passkey service and mount both route sets:

```ts
// imports to add:
import { mountPasskeyRoutes } from "./passkey-http.ts";
import { createPasskeyService } from "./passkeys.ts";

// inside createAuthModule, after `service`:
  const passkeys = createPasskeyService({ store, clock: deps.clock, publicOrigin: deps.publicOrigin, allowedOrigins: deps.allowedOrigins });

// replace `mount`:
    mount: (app) => {
      mountAuthRoutes(app, { service, passkeysAvailable: passkeys.available });
      mountPasskeyRoutes(app, { passkeys, auth: service });
    },
```

- [ ] **Step 6: Run tests and gates**

Run: `pnpm test:unit apps/daemon/src/modules/auth && pnpm typecheck && pnpm lint && pnpm knip`
Expected: PASS. If `@simplewebauthn/server` 13 names a field differently (`credential` vs `authenticator`), follow its exported `.d.ts` and keep the tests' behaviour.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon pnpm-lock.yaml
git commit -m "feat(auth): passkey registration and login with simplewebauthn"
```

---

### Task 19: pi-host — minimal `pap-policy` (stage 03 approval, fail closed) and the extension UI bridge

**Files:**
- Create: `packages/pi-host/src/policy/categories.ts`, `packages/pi-host/src/policy/decide.ts`, `packages/pi-host/src/policy/extension.ts`
- Create: `packages/pi-host/src/ui-bridge.ts`, `packages/pi-host/src/plain-theme.ts`
- Create: `docs/adr/0002-policy-evaluated-last.md`
- Modify: `packages/pi-host/package.json` (Pi SDK and zod dependencies)
- Test: `packages/pi-host/src/policy/decide.test.ts`, `packages/pi-host/src/policy/extension.test.ts`, `packages/pi-host/src/ui-bridge.test.ts`

**Interfaces:**
- Consumes: contracts `PolicyRules`, `ToolCategory`, `AuditEntry`, `UiResponseRecord` (Task 12).
- Produces:
  - `toolCategory(toolName): ToolCategory`, `describeCall(toolName, input): string` (≤ 4000 characters of payload)
  - `decide(category, rules): "allow" | "ask" | "block"`
  - `evaluateToolCall(event, ctx, deps)`, `createPapPolicyExtension({ rules(): PolicyRules | null; audit(entry): void }): InlineExtension`, `movePolicyLast(base: LoadExtensionsResult)`, `POLICY_EXTENSION_PATH`, `DENIED_REASON`, `FAIL_CLOSED_REASON`
  - `createUiBridge(send, { newId?, setTimer?, clearTimer? }) → { context: ExtensionUIContext; resolve(response); cancelAll(); pendingCount() }`; worker records `extension_ui_request{id, method, …}` and `extension_ui_closed{id}`
  - `PLAIN_THEME: Theme`

M1 scope: only stage 03 (approval) of spec C §5.2, for the `interactive` profile in `auto-accept-edits` mode. `confirm` gives two answers (Allow once / Deny); session/always answers, taint and the other stages arrive in roadmap M5. `ctx.ui.custom()` resolves `undefined` here (like Pi's RPC mode); custom panels arrive in roadmap M2 using the S1 mechanism.

**Spike fallback / S1:** the policy ships as an extension file passed to `pi --mode rpc -e <file>`; `movePolicyLast` becomes the order of `-e` flags; delete `ui-bridge.ts` and `plain-theme.ts` (Pi's RPC mode provides the dialogs).

- [ ] **Step 1: Install**

Run: `pnpm --filter @pap/pi-host add "@earendil-works/pi-coding-agent@catalog:" "@earendil-works/pi-ai@catalog:" && pnpm --filter @pap/pi-host add -E zod@^4`

- [ ] **Step 2: Write the failing policy tests**

`packages/pi-host/src/policy/decide.test.ts`:

```ts
import type { PolicyRules } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { toolCategory } from "./categories.ts";
import { decide } from "./decide.ts";

const interactive: PolicyRules = { profile: "interactive", approvalMode: "auto-accept-edits" };

describe("decide (interactive, auto-accept edits)", () => {
  it.each([
    ["read", "allow"],
    ["grep", "allow"],
    ["ls", "allow"],
    ["edit", "allow"],
    ["write", "allow"],
    ["bash", "ask"],
    ["powershell", "ask"],
    ["web_fetch", "ask"],
    ["some_extension_tool", "ask"],
    ["mcp__github__create_issue", "ask"],
  ])("%s → %s", (tool, expected) => {
    expect(decide(toolCategory(tool), interactive)).toBe(expected);
  });
});
```

`packages/pi-host/src/policy/extension.test.ts`:

```ts
import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import type { AuditEntry, PolicyRules } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { DENIED_REASON, evaluateToolCall, FAIL_CLOSED_REASON, movePolicyLast, POLICY_EXTENSION_PATH } from "./extension.ts";

const rules: PolicyRules = { profile: "interactive", approvalMode: "auto-accept-edits" };

function harness(options: { confirm?: () => Promise<boolean>; rules?: PolicyRules | null; hasUI?: boolean; audit?: (entry: AuditEntry) => void } = {}) {
  const audits: AuditEntry[] = [];
  const asked: string[] = [];
  const run = (toolName: string, input: unknown) =>
    evaluateToolCall(
      { toolCallId: "c1", toolName, input: input as Record<string, unknown> },
      {
        hasUI: options.hasUI ?? true,
        ui: {
          confirm: async (title: string, message: string) => {
            asked.push(`${title}|${message}`);
            return (options.confirm ?? (async () => true))();
          },
        },
      },
      { rules: () => (options.rules === undefined ? rules : options.rules), audit: options.audit ?? ((entry) => audits.push(entry)) },
    );
  return { audits, asked, run };
}

describe("pap-policy approval stage", () => {
  it("allows read and edit tools without asking", async () => {
    const h = harness();
    expect(await h.run("read", { path: "a.ts" })).toBeUndefined();
    expect(await h.run("write", { path: "a.ts", content: "x" })).toBeUndefined();
    expect(h.asked).toEqual([]);
    expect(h.audits.map((a) => a.decision)).toEqual(["allow", "allow"]);
  });

  it("asks before bash and lets it run when approved", async () => {
    const h = harness();
    expect(await h.run("bash", { command: "echo hi" })).toBeUndefined();
    expect(h.asked).toEqual(["Run a command?|bash: echo hi"]);
    expect(h.audits[0]).toEqual({ toolCallId: "c1", tool: "bash", category: "exec", decision: "approved" });
  });

  it("blocks with the user's reason when denied", async () => {
    const h = harness({ confirm: async () => false });
    expect(await h.run("bash", { command: "rm -rf build" })).toEqual({ block: true, reason: DENIED_REASON });
    expect(h.audits[0]?.decision).toBe("denied");
  });

  it("blocks every call, even reads, when the rules are missing (fail closed)", async () => {
    const h = harness({ rules: null });
    expect(await h.run("read", { path: "a.ts" })).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
    expect(h.asked).toEqual([]);
  });

  it("blocks when the dialog throws, when no UI is bound, or when the audit line fails", async () => {
    expect(await harness({ confirm: async () => { throw new Error("ui gone"); } }).run("bash", { command: "ls" })).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
    expect((await harness({ hasUI: false }).run("bash", { command: "ls" }))?.block).toBe(true);
    expect(await harness({ audit: () => { throw new Error("disk full"); } }).run("read", { path: "a" })).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
  });

  it("truncates very long payloads in the approval message", async () => {
    const h = harness();
    await h.run("bash", { command: "x".repeat(10_000) });
    expect(h.asked[0]?.length).toBeLessThan(4200);
    expect(h.asked[0]).toContain("(10000 characters)");
  });
});

describe("movePolicyLast", () => {
  const ext = (path: string) => ({ path }) as unknown as LoadExtensionsResult["extensions"][number];
  const base = (paths: string[]) => ({ extensions: paths.map(ext), errors: [], runtime: {} }) as unknown as LoadExtensionsResult;

  it("moves pap-policy after every other extension", () => {
    const result = movePolicyLast(base([POLICY_EXTENSION_PATH, "/user/a.ts", "/user/b.ts"]));
    expect(result.extensions.map((e) => e.path)).toEqual(["/user/a.ts", "/user/b.ts", POLICY_EXTENSION_PATH]);
  });

  it("refuses to start a session without pap-policy", () => {
    expect(() => movePolicyLast(base(["/user/a.ts"]))).toThrow(/pap-policy/);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm test:unit packages/pi-host/src/policy`
Expected: FAIL (modules not found).

- [ ] **Step 4: Write categories, decide and the extension**

`packages/pi-host/src/policy/categories.ts`:

```ts
import type { ToolCategory } from "@pap/contracts";

const READ = new Set(["read", "grep", "find", "ls"]);
const EDIT = new Set(["edit", "write"]);
const EXEC = new Set(["bash", "powershell"]);
const NETWORK = new Set(["web_fetch", "web_search", "fetch"]);
const MAX_PAYLOAD = 4000;

export function toolCategory(toolName: string): ToolCategory {
  if (READ.has(toolName)) return "read";
  if (EDIT.has(toolName)) return "edit";
  if (EXEC.has(toolName)) return "exec";
  if (NETWORK.has(toolName)) return "network";
  return "external-write";
}

export function describeCall(toolName: string, input: unknown): string {
  const command = (input as { command?: unknown } | null)?.command;
  const payload = typeof command === "string" ? command : JSON.stringify(input ?? {});
  const shown = payload.length > MAX_PAYLOAD ? `${payload.slice(0, MAX_PAYLOAD)}… (${payload.length} characters)` : payload;
  return `${toolName}: ${shown}`;
}
```

Unknown tools (extension and MCP tools) are treated as `external-write`, so they ask in interactive mode: spec C §5.3 does not classify them, and asking is the fail-safe default. Roadmap M5 refines this with MCP `readOnlyHint` and per-tool declarations.

`packages/pi-host/src/policy/decide.ts`:

```ts
import type { PolicyRules, ToolCategory } from "@pap/contracts";

export type Decision = "allow" | "ask" | "block";

const INTERACTIVE_AUTO_ACCEPT_EDITS: Readonly<Record<ToolCategory, Decision>> = {
  read: "allow",
  edit: "allow",
  exec: "ask",
  network: "ask",
  "external-write": "ask",
};

export function decide(category: ToolCategory, rules: PolicyRules): Decision {
  if (rules.profile === "interactive" && rules.approvalMode === "auto-accept-edits") return INTERACTIVE_AUTO_ACCEPT_EDITS[category];
  return "block";
}
```

`packages/pi-host/src/policy/extension.ts`:

```ts
import type { ExtensionUIContext, InlineExtension, LoadExtensionsResult, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { AuditEntry, PolicyRules, ToolCategory } from "@pap/contracts";
import { describeCall, toolCategory } from "./categories.ts";
import { decide } from "./decide.ts";

export const POLICY_EXTENSION_NAME = "pap-policy";
// S1 records the path Pi gives an inline extension; use the value from docs/spikes/s1.md if it differs.
export const POLICY_EXTENSION_PATH = `<inline:${POLICY_EXTENSION_NAME}>`;
export const DENIED_REASON = "Denied by the user.";
export const FAIL_CLOSED_REASON = "pap-policy could not evaluate this call, so it was blocked (fail closed).";

const TITLES: Readonly<Record<ToolCategory, string>> = {
  read: "Allow reading?",
  edit: "Allow this edit?",
  exec: "Run a command?",
  network: "Allow a network request?",
  "external-write": "Allow this tool?",
};

export interface PolicyDeps {
  rules(): PolicyRules | null;
  audit(entry: AuditEntry): void;
}

interface PolicyEvent {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

interface PolicyContext {
  readonly hasUI: boolean;
  readonly ui: Pick<ExtensionUIContext, "confirm">;
}

export async function evaluateToolCall(event: PolicyEvent, ctx: PolicyContext, deps: PolicyDeps): Promise<ToolCallEventResult | undefined> {
  try {
    const category = toolCategory(event.toolName);
    const record = (decision: AuditEntry["decision"], reason?: string) =>
      deps.audit({ toolCallId: event.toolCallId, tool: event.toolName, category, decision, ...(reason ? { reason } : {}) });
    const rules = deps.rules();
    if (!rules) {
      record("block", "no valid policy rules");
      return { block: true, reason: FAIL_CLOSED_REASON };
    }
    const decision = decide(category, rules);
    if (decision === "allow") {
      record("allow");
      return undefined;
    }
    if (decision === "block" || !ctx.hasUI) {
      record("block", decision === "block" ? "category blocked" : "no UI to ask");
      return { block: true, reason: `pap-policy blocked this ${category} call.` };
    }
    const approved = await ctx.ui.confirm(TITLES[category], describeCall(event.toolName, event.input));
    record(approved ? "approved" : "denied");
    return approved ? undefined : { block: true, reason: DENIED_REASON };
  } catch {
    return { block: true, reason: FAIL_CLOSED_REASON };
  }
}

export function createPapPolicyExtension(deps: PolicyDeps): InlineExtension {
  return {
    name: POLICY_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.on("tool_call", (event, ctx) => evaluateToolCall(event, ctx, deps));
    },
  };
}

export function movePolicyLast(base: LoadExtensionsResult): LoadExtensionsResult {
  const index = base.extensions.findIndex((extension) => extension.path === POLICY_EXTENSION_PATH);
  const policy = base.extensions[index];
  if (index < 0 || !policy) throw new Error("pap-policy is not loaded: refusing to start the session");
  return { ...base, extensions: [...base.extensions.filter((_, i) => i !== index), policy] };
}
```

- [ ] **Step 5: Run the policy tests**

Run: `pnpm test:unit packages/pi-host/src/policy`
Expected: PASS.

- [ ] **Step 6: Write the failing UI bridge test**

`packages/pi-host/src/ui-bridge.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createUiBridge } from "./ui-bridge.ts";

function setup() {
  const sent: Array<Record<string, unknown>> = [];
  const timers: Array<() => void> = [];
  let next = 0;
  const bridge = createUiBridge((record) => sent.push(record), {
    newId: () => `u${++next}`,
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
  });
  return { bridge, sent, timers };
}

describe("extension UI bridge", () => {
  it("emits a confirm request and resolves with the answer", async () => {
    const { bridge, sent } = setup();
    const answer = bridge.context.confirm("Run a command?", "bash: ls");
    expect(sent).toEqual([{ type: "extension_ui_request", id: "u1", method: "confirm", title: "Run a command?", message: "bash: ls" }]);
    bridge.resolve({ type: "extension_ui_response", id: "u1", confirmed: true });
    expect(await answer).toBe(true);
    expect(bridge.pendingCount()).toBe(0);
  });

  it("resolves a cancelled dialog with its fallback", async () => {
    const { bridge } = setup();
    const choice = bridge.context.select("Pick", ["a", "b"]);
    bridge.resolve({ type: "extension_ui_response", id: "u1", cancelled: true });
    expect(await choice).toBeUndefined();
  });

  it("closes a dialog on timeout or abort and tells the daemon", async () => {
    const { bridge, sent, timers } = setup();
    const timed = bridge.context.confirm("t", "m", { timeout: 1000 });
    timers[0]?.();
    expect(await timed).toBe(false);
    const controller = new AbortController();
    const aborted = bridge.context.input("Name?", undefined, { signal: controller.signal });
    controller.abort();
    expect(await aborted).toBeUndefined();
    expect(sent.filter((r) => r.type === "extension_ui_closed").map((r) => r.id)).toEqual(["u1", "u2"]);
  });

  it("cancelAll resolves every pending dialog", async () => {
    const { bridge } = setup();
    const a = bridge.context.confirm("a", "a");
    const b = bridge.context.editor("b", "text");
    bridge.cancelAll();
    expect([await a, await b]).toEqual([false, undefined]);
  });

  it("forwards decorations and ignores component widgets and custom panels", async () => {
    const { bridge, sent } = setup();
    bridge.context.notify("hello", "warning");
    bridge.context.setStatus("ext", "busy");
    bridge.context.setWidget("w", ["line"]);
    bridge.context.setWidget("w2", (() => ({ render: () => [], invalidate: () => {} })) as never);
    expect(sent.map((r) => r.method)).toEqual(["notify", "setStatus", "setWidget"]);
    expect(await bridge.context.custom(() => ({ render: () => [], invalidate: () => {} }) as never)).toBeUndefined();
  });
});
```

- [ ] **Step 7: Run it to see it fail**

Run: `pnpm test:unit packages/pi-host/src/ui-bridge.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 8: Write the theme and the bridge**

`packages/pi-host/src/plain-theme.ts` (the pattern pi-web uses for extension UI outside a terminal):

```ts
import { Theme } from "@earendil-works/pi-coding-agent";

class PlainTheme extends Theme {
  constructor() {
    super(
      { muted: "", text: "", thinkingXhigh: "", searchMatchText: "" } as ConstructorParameters<typeof Theme>[0],
      { selectedBg: "" } as ConstructorParameters<typeof Theme>[1],
      "truecolor",
    );
  }

  override fg(...[, text]: Parameters<Theme["fg"]>): string { return text; }
  override bg(...[, text]: Parameters<Theme["bg"]>): string { return text; }
  override bold(text: string): string { return text; }
  override italic(text: string): string { return text; }
  override underline(text: string): string { return text; }
  override inverse(text: string): string { return text; }
  override strikethrough(text: string): string { return text; }
  override getFgAnsi(): string { return ""; }
  override getBgAnsi(): string { return ""; }
  override getThinkingBorderColor(): (text: string) => string { return (text) => text; }
  override getBashModeBorderColor(): (text: string) => string { return (text) => text; }
}

export const PLAIN_THEME: Theme = new PlainTheme();
```

`packages/pi-host/src/ui-bridge.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { UiResponseRecord } from "@pap/contracts";
import { PLAIN_THEME } from "./plain-theme.ts";

export type UiOutbound =
  | ({ type: "extension_ui_request"; id: string; method: string } & Record<string, unknown>)
  | { type: "extension_ui_closed"; id: string };

export interface UiBridge {
  readonly context: ExtensionUIContext;
  resolve(response: UiResponseRecord): void;
  cancelAll(): void;
  pendingCount(): number;
}

export interface UiBridgeOptions {
  newId?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

type Request = Record<string, unknown> & { method: string };

export function createUiBridge(send: (record: UiOutbound) => void, options: UiBridgeOptions = {}): UiBridge {
  const newId = options.newId ?? randomUUID;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  const pending = new Map<string, (response: UiResponseRecord | null) => void>();

  function dialog<T>(request: Request, fallback: T, parse: (response: UiResponseRecord) => T, opts?: ExtensionUIDialogOptions): Promise<T> {
    if (opts?.signal?.aborted) return Promise.resolve(fallback);
    const id = newId();
    return new Promise<T>((resolve) => {
      let timer: unknown;
      const onAbort = () => finish(null);
      const finish = (response: UiResponseRecord | null) => {
        if (!pending.delete(id)) return;
        if (timer !== undefined) clearTimer(timer);
        opts?.signal?.removeEventListener("abort", onAbort);
        if (response === null) send({ type: "extension_ui_closed", id });
        resolve(response === null || response.cancelled ? fallback : parse(response));
      };
      pending.set(id, finish);
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts?.timeout) timer = setTimer(() => finish(null), opts.timeout);
      send({ type: "extension_ui_request", id, ...request, ...(opts?.timeout ? { timeout: opts.timeout } : {}) });
    });
  }

  const fire = (request: Request) => send({ type: "extension_ui_request", id: newId(), ...request });
  const setWidget = ((key: string, content: unknown) => {
    if (content === undefined || Array.isArray(content)) fire({ method: "setWidget", widgetKey: key, widgetLines: content });
  }) as ExtensionUIContext["setWidget"];

  const context: ExtensionUIContext = {
    select: (title, items, opts) => dialog({ method: "select", title, options: items }, undefined, (r) => r.value, opts),
    confirm: (title, message, opts) => dialog({ method: "confirm", title, message }, false, (r) => r.confirmed === true, opts),
    input: (title, placeholder, opts) =>
      dialog({ method: "input", title, ...(placeholder === undefined ? {} : { placeholder }) }, undefined, (r) => r.value, opts),
    editor: (title, prefill) => dialog({ method: "editor", title, ...(prefill === undefined ? {} : { prefill }) }, undefined, (r) => r.value),
    notify: (message, type) => fire({ method: "notify", message, notifyType: type ?? "info" }),
    onTerminalInput: () => () => {},
    setStatus: (key, text) => fire({ method: "setStatus", statusKey: key, statusText: text }),
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget,
    setFooter: () => {},
    setHeader: () => {},
    setTitle: (title) => fire({ method: "setTitle", title }),
    custom: <T>() => Promise.resolve(undefined as T),
    pasteToEditor: (text) => fire({ method: "set_editor_text", text }),
    setEditorText: (text) => fire({ method: "set_editor_text", text }),
    getEditorText: () => "",
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: PLAIN_THEME,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Themes are not supported in pap." }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };

  return {
    context,
    resolve: (response) => pending.get(response.id)?.(response),
    cancelAll: () => {
      for (const finish of [...pending.values()]) finish(null);
    },
    pendingCount: () => pending.size,
  };
}
```

- [ ] **Step 9: Record the ordering decision**

`docs/adr/0002-policy-evaluated-last.md`:

~~~markdown
# ADR 0002 — pap-policy evaluates the final tool input

Status: accepted · Date: [today] · Spec: C §5.1

Spec C says pap-policy "is loaded first in pi-host, before user extensions, and cannot be bypassed". Pi passes `tool_call` events to extension handlers in order, and `event.input` is mutable: a later handler sees, and can change, what earlier handlers approved (Pi `ToolCallEvent` docs; measured in S1, `docs/spikes/s1.md`). A policy that runs first could approve `echo hi` and then a user extension could rewrite it.

Decision: pap-policy is always present (a session refuses to start without it, `movePolicyLast`) and runs **last** in the `tool_call` chain, so it judges the exact input that will execute. "Cannot be bypassed" holds: a single block blocks, and nothing runs after it.
~~~

- [ ] **Step 10: Run tests and gates**

Run: `pnpm test:unit packages/pi-host && pnpm typecheck && pnpm lint && pnpm knip`
Expected: PASS (the new exports are imported by this task's tests).

- [ ] **Step 11: Commit**

```bash
git add packages/pi-host docs/adr/0002-policy-evaluated-last.md pnpm-lock.yaml
git commit -m "feat(pi-host): minimal fail-closed pap-policy and extension UI bridge"
```

---

### Task 20: pi-host — the worker (IPC, watchdog, Pi SDK session, prompt/abort/get_state)

**Files:**
- Create: `packages/pi-host/src/main.ts`, `ipc.ts`, `watchdog.ts`, `host.ts`, `commands.ts`, `open-session.ts`, `wire-events.ts`, `scripted-provider.ts`
- Create: `packages/pi-host/src/testing/network-guard.ts`, `packages/pi-host/src/testing/fork-host.ts`
- Create: `docs/adr/0001-pi-host-boot-and-closed-records.md`
- Test: `packages/pi-host/src/wire-events.test.ts`, `watchdog.test.ts`, `scripted-provider.test.ts`, `host.int.test.ts`

**Interfaces:**
- Consumes: Task 19 (`createPapPolicyExtension`, `movePolicyLast`, `createUiBridge`), contracts records (Task 12).
- Produces: the worker entry `packages/pi-host/src/main.ts` (`dist/main.js` when built), speaking:
  - daemon → worker: `init{cwd, agentDir, sessionFile?, policy, testProviderScript?}` first, then `prompt{id,message,streamingBehavior?}`, `abort{id}`, `get_state{id}`, `extension_ui_response{id,…}`, `policy_update{rules}`, `shutdown{graceMs}`
  - worker → daemon: `ready{sessionFile, sessionId, piVersion}`, `response{id, command, success, data?, error?}`, Pi session events (JSON wire shape), `extension_ui_request`, `extension_ui_closed`, `audit{entry}`, `health{rssMb}`, `extension_error`
  - `ProviderScript` (zod), `buildScriptedProvider(script)`, `loadScriptedProvider(path)`
  - Test helpers: `forkHost(env, cwd) → ForkedHost`, `PI_HOST_MAIN`, `NETWORK_GUARD`, `DEV_EXEC_ARGV`
- Worker env expectations: `PI_CODING_AGENT_DIR` names the agent dir (Pi derives the session directory from it); the daemon sets it (Task 21 `workerEnv`).

**Spike fallback / S1:** replace `open-session.ts`, `host.ts` and `commands.ts` by `rpc-transport.ts`, which spawns `pi --mode rpc --session <file> -e <pap-policy file>` with LF-only framing (never `readline`) and maps the same records; `navigate_tree` and `custom` stay unsupported for these sessions.
**Spike fallback / S2:** delete `scripted-provider.ts` and the `testProviderScript` init field; Task 23 replays recorded events instead.
**Spike fallback / S7:** replace `ProjectTrustStore` by a boolean `projectTrusted` in `init`, decided by a pap `project_trust` table.

- [ ] **Step 1: Write the failing unit tests**

`packages/pi-host/src/wire-events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toWireEvent } from "./wire-events.ts";

describe("toWireEvent", () => {
  it("drops cumulative partials from message_update and keeps delta and usage", () => {
    const event = {
      type: "message_update",
      message: { role: "assistant", usage: { input: 3, output: 1 } },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi", partial: { content: [{ type: "text", text: "Hi" }] } },
    };
    expect(toWireEvent(event as never)).toEqual({
      type: "message_update",
      usage: { input: 3, output: 1 },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi" },
    });
  });

  it("names the tool call on toolcall_start", () => {
    const event = {
      type: "message_update",
      message: { usage: {} },
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, partial: { content: [{ type: "text" }, { type: "toolCall", id: "call-1", name: "bash" }] } },
    };
    expect(toWireEvent(event as never)).toMatchObject({ assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "call-1", toolName: "bash" } });
  });

  it("passes other events through unchanged", () => {
    expect(toWireEvent({ type: "agent_settled", aborted: false } as never)).toEqual({ type: "agent_settled", aborted: false });
  });
});
```

`packages/pi-host/src/watchdog.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyOomScore, startParentWatchdog } from "./watchdog.ts";

afterEach(() => vi.useRealTimers());

describe("watchdog", () => {
  it("calls onOrphan once the parent pid changes", () => {
    vi.useFakeTimers();
    let ppid = 10;
    const onOrphan = vi.fn();
    const stop = startParentWatchdog({ initialPpid: 10, currentPpid: () => ppid, intervalMs: 1000, onOrphan });
    vi.advanceTimersByTime(1000);
    expect(onOrphan).not.toHaveBeenCalled();
    ppid = 1;
    vi.advanceTimersByTime(1000);
    expect(onOrphan).toHaveBeenCalledTimes(1);
    stop();
  });

  it("writes 800 to oom_score_adj on Linux only", () => {
    const writes: Array<[string, string]> = [];
    expect(applyOomScore(800, { platform: "linux", write: (path, value) => { writes.push([path, value]); } })).toBe(true);
    expect(writes).toEqual([["/proc/self/oom_score_adj", "800"]]);
    expect(applyOomScore(800, { platform: "darwin", write: () => {} })).toBe(false);
    expect(applyOomScore(800, { platform: "linux", write: () => { throw new Error("EACCES"); } })).toBe(false);
  });
});
```

`packages/pi-host/src/scripted-provider.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildScriptedProvider, ProviderScript } from "./scripted-provider.ts";

describe("scripted provider", () => {
  it("rejects a script without steps", () => {
    expect(ProviderScript.safeParse({ steps: [] }).success).toBe(false);
  });

  it("builds a provider and its model", () => {
    const { model, provider } = buildScriptedProvider(ProviderScript.parse({ steps: [{ text: "hi" }] }));
    expect(model.id).toBe("scripted");
    expect(provider).toBeDefined();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit packages/pi-host/src/wire-events.test.ts packages/pi-host/src/watchdog.test.ts packages/pi-host/src/scripted-provider.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Write wire events, watchdog, scripted provider, IPC**

`packages/pi-host/src/wire-events.ts`:

```ts
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type WireEvent = { type: string } & Record<string, unknown>;

interface RawMessageUpdate {
  readonly message?: { usage?: unknown };
  readonly assistantMessageEvent: Record<string, unknown> & { type: string; contentIndex?: number; partial?: { content?: unknown[] } };
}

function toolCallIdentity(partial: { content?: unknown[] } | undefined, index: number | undefined): Record<string, string> {
  const block = typeof index === "number" ? partial?.content?.[index] : undefined;
  if (!block || typeof block !== "object") return {};
  const { id, name } = block as { id?: unknown; name?: unknown };
  return { ...(typeof id === "string" ? { id } : {}), ...(typeof name === "string" ? { toolName: name } : {}) };
}

export function toWireEvent(event: AgentSessionEvent): WireEvent {
  if (event.type !== "message_update") return event as unknown as WireEvent;
  const raw = event as unknown as RawMessageUpdate;
  const { partial, ...rest } = raw.assistantMessageEvent;
  const identity = rest.type === "toolcall_start" ? toolCallIdentity(partial, rest.contentIndex) : {};
  return { type: "message_update", usage: raw.message?.usage, assistantMessageEvent: { ...rest, ...identity } };
}
```

`packages/pi-host/src/watchdog.ts`:

```ts
import { writeFileSync } from "node:fs";

export function applyOomScore(
  score: number,
  env: { platform: NodeJS.Platform; write(path: string, value: string): void } = { platform: process.platform, write: (path, value) => writeFileSync(path, value) },
): boolean {
  if (env.platform !== "linux") return false;
  try {
    env.write("/proc/self/oom_score_adj", String(score));
    return true;
  } catch {
    return false;
  }
}

export function startParentWatchdog(options: { initialPpid: number; currentPpid?: () => number; intervalMs?: number; onOrphan(): void }): () => void {
  const current = options.currentPpid ?? (() => process.ppid);
  let fired = false;
  const timer = setInterval(() => {
    if (!fired && current() !== options.initialPpid) {
      fired = true;
      options.onOrphan();
    }
  }, options.intervalMs ?? 1000);
  timer.unref();
  return () => clearInterval(timer);
}
```

`packages/pi-host/src/scripted-provider.ts` (test-only provider: the daemon passes a script path in `init` only when `PAP_TEST_PROVIDER_SCRIPT` is set):

```ts
import { readFile } from "node:fs/promises";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { z } from "zod";

const ScriptStep = z.object({
  text: z.string().optional(),
  toolCalls: z.array(z.object({ name: z.string().min(1), args: z.record(z.string(), z.unknown()), id: z.string().optional() })).optional(),
  stopReason: z.enum(["stop", "toolUse", "error"]).optional(),
  errorMessage: z.string().optional(),
});
type ScriptStep = z.infer<typeof ScriptStep>;

export const ProviderScript = z.object({ modelId: z.string().min(1).default("scripted"), steps: z.array(ScriptStep).min(1) });
export type ProviderScript = z.infer<typeof ProviderScript>;

function stepMessage(step: ScriptStep) {
  const content = [
    ...(step.text === undefined ? [] : [fauxText(step.text)]),
    ...(step.toolCalls ?? []).map((call) => fauxToolCall(call.name, call.args, call.id ? { id: call.id } : {})),
  ];
  const stopReason = step.stopReason ?? ((step.toolCalls?.length ?? 0) > 0 ? "toolUse" : "stop");
  return fauxAssistantMessage(content, { stopReason, ...(step.errorMessage ? { errorMessage: step.errorMessage } : {}) });
}

export function buildScriptedProvider(script: ProviderScript) {
  const faux = fauxProvider({ models: [{ id: script.modelId }] });
  faux.setResponses(script.steps.map((step) => () => stepMessage(step)));
  const model = faux.getModel(script.modelId);
  if (!model) throw new Error(`scripted model ${script.modelId} is missing`);
  return { provider: faux.provider, model };
}

export async function loadScriptedProvider(path: string) {
  return buildScriptedProvider(ProviderScript.parse(JSON.parse(await readFile(path, "utf8"))));
}
```

Use the option names recorded in `docs/spikes/s2.md` if they differ from `stopReason` / `errorMessage`.

`packages/pi-host/src/ipc.ts`:

```ts
import { DaemonToWorker } from "@pap/contracts";

export type Outbound = { type: string } & Record<string, unknown>;

export interface Ipc {
  send(record: Outbound): void;
  onMessage(listener: (record: DaemonToWorker) => void): () => void;
  onDisconnect(listener: () => void): void;
}

export function createIpc(proc: NodeJS.Process): Ipc {
  const send = proc.send?.bind(proc);
  if (!send) throw new Error("pi-host needs an IPC channel: start it with child_process.fork");
  return {
    send(record) {
      try {
        send(record);
      } catch (error) {
        proc.stderr.write(`pi-host: ipc send failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    },
    onMessage(listener) {
      const handler = (raw: unknown) => {
        const parsed = DaemonToWorker.safeParse(raw);
        if (parsed.success) listener(parsed.data);
        else proc.stderr.write("pi-host: dropped a malformed record\n");
      };
      proc.on("message", handler);
      return () => {
        proc.off("message", handler);
      };
    },
    onDisconnect(listener) {
      proc.once("disconnect", listener);
    },
  };
}
```

- [ ] **Step 4: Run the unit tests**

Run: `pnpm test:unit packages/pi-host`
Expected: PASS.

- [ ] **Step 5: Write the test helpers**

`packages/pi-host/src/testing/network-guard.ts` (loaded with `--import` in every test that forks a worker; any TCP/TLS attempt fails loudly):

```ts
import net from "node:net";

const originalConnect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
  const first = args[0];
  const unixSocket = typeof first === "string" || (typeof first === "object" && first !== null && "path" in first);
  if (unixSocket) return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  process.stderr.write(`pap-network-guard: blocked ${JSON.stringify(first)}\n`);
  throw new Error("network access is disabled in tests");
} as typeof originalConnect;
```

`packages/pi-host/src/testing/fork-host.ts`:

```ts
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PI_HOST_MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));
export const NETWORK_GUARD = fileURLToPath(new URL("./network-guard.ts", import.meta.url));
export const DEV_EXEC_ARGV = ["--conditions=development", "--import", NETWORK_GUARD];

export type HostRecord = { type: string } & Record<string, unknown>;

export interface ForkedHost {
  readonly child: ChildProcess;
  readonly records: HostRecord[];
  readonly exited: Promise<number | null>;
  send(record: object): void;
  request(record: HostRecord): Promise<HostRecord>;
  waitFor(predicate: (record: HostRecord) => boolean, options?: { from?: number; timeoutMs?: number }): Promise<HostRecord>;
  kill(): void;
}

export function forkHost(env: NodeJS.ProcessEnv, cwd: string): ForkedHost {
  const child = fork(PI_HOST_MAIN, [], { cwd, env, execArgv: DEV_EXEC_ARGV, stdio: ["ignore", "pipe", "pipe", "ipc"], detached: true });
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
  child.stdout?.resume();
  const records: HostRecord[] = [];
  const wakers = new Set<() => void>();
  child.on("message", (record: HostRecord) => {
    records.push(record);
    for (const wake of [...wakers]) wake();
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => {
      for (const wake of [...wakers]) wake();
      resolve(code);
    }),
  );
  const waitFor = (predicate: (record: HostRecord) => boolean, { from = 0, timeoutMs = 20_000 } = {}) =>
    new Promise<HostRecord>((resolve, reject) => {
      const check = () => {
        const hit = records.slice(from).find(predicate);
        if (hit) {
          done();
          resolve(hit);
        } else if (child.exitCode !== null || child.signalCode !== null) {
          done();
          reject(new Error(`pi-host exited: ${stderr.join("")}`));
        }
      };
      const deadline = setTimeout(() => {
        done();
        reject(new Error(`timed out waiting for a record; stderr: ${stderr.join("")}`));
      }, timeoutMs);
      const done = () => {
        clearTimeout(deadline);
        wakers.delete(check);
      };
      wakers.add(check);
      check();
    });
  let nextId = 0;
  return {
    child,
    records,
    exited,
    send: (record) => child.send(record),
    request: (record) => {
      const id = `t${++nextId}`;
      child.send({ ...record, id });
      return waitFor((r) => r.type === "response" && r.id === id);
    },
    waitFor,
    kill: () => {
      try {
        process.kill(-(child.pid ?? 0), "SIGKILL");
      } catch {
        // already gone
      }
    },
  };
}
```

- [ ] **Step 6: Write the failing worker integration test**

`packages/pi-host/src/host.int.test.ts`:

```ts
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEV_EXEC_ARGV, forkHost, PI_HOST_MAIN, type ForkedHost, type HostRecord } from "./testing/fork-host.ts";

const RULES = { profile: "interactive", approvalMode: "auto-accept-edits" };
let root: string;
let host: ForkedHost | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-host-"));
  mkdirSync(join(root, "agent"));
  mkdirSync(join(root, "work"));
});
afterEach(async () => {
  host?.kill();
  await host?.exited;
  host = undefined;
  rmSync(root, { recursive: true, force: true });
});

function start(script: object, policy: unknown = RULES): Promise<HostRecord> {
  const scriptPath = join(root, "script.json");
  writeFileSync(scriptPath, JSON.stringify(script));
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  host = forkHost({ ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" }, cwd);
  host.send({ type: "init", cwd, agentDir, policy, testProviderScript: scriptPath });
  return host.waitFor((r) => r.type === "ready");
}
const bash = (command: string) => ({ steps: [{ toolCalls: [{ name: "bash", args: { command }, id: "call-1" }] }, { text: "done" }] });
const textOf = (message: unknown) =>
  ((message as { content?: Array<{ type: string; text?: string }> }).content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
const toolText = (record: HostRecord) => JSON.stringify(record.result);
const live = (): ForkedHost => {
  if (!host) throw new Error("host not started");
  return host;
};

describe("pi-host worker", () => {
  it("reports ready with its session file and Pi version, and sets oom_score_adj", async () => {
    const ready = await start({ steps: [{ text: "hi" }] });
    expect(String(ready.sessionFile)).toMatch(/\.jsonl$/);
    expect(ready.piVersion).toBe("1.1.0");
    if (process.platform === "linux") expect(readFileSync(`/proc/${live().child.pid}/oom_score_adj`, "utf8").trim()).toBe("800");
  });

  it("streams a run, settles, reports idle, and keeps Unicode intact over IPC", async () => {
    const text = "Bonjour 👋 中文 fin";
    await start({ steps: [{ text }] });
    const response = await live().request({ type: "prompt", message: "go" });
    expect(response).toMatchObject({ success: true, data: { disposition: "started" } });
    await live().waitFor((r) => r.type === "agent_settled");
    const end = await live().waitFor((r) => r.type === "message_end" && (r.message as { role?: string }).role === "assistant");
    expect(textOf(end.message)).toBe(text);
    const state = await live().request({ type: "get_state" });
    expect(state.data).toMatchObject({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
  });

  it("asks before bash and runs it once approved", async () => {
    await start(bash("echo pap-ok"));
    await live().request({ type: "prompt", message: "go" });
    const ask = await live().waitFor((r) => r.type === "extension_ui_request" && r.method === "confirm");
    expect(String(ask.message)).toContain("echo pap-ok");
    live().send({ type: "extension_ui_response", id: ask.id, confirmed: true });
    const end = await live().waitFor((r) => r.type === "tool_execution_end");
    expect(end.isError).toBe(false);
    expect(toolText(end)).toContain("pap-ok");
    expect(live().records.find((r) => r.type === "audit")).toMatchObject({ entry: { tool: "bash", decision: "approved" } });
  });

  it("blocks a denied call and returns the reason to the model", async () => {
    await start(bash("echo nope"));
    await live().request({ type: "prompt", message: "go" });
    const ask = await live().waitFor((r) => r.type === "extension_ui_request" && r.method === "confirm");
    live().send({ type: "extension_ui_response", id: ask.id, confirmed: false });
    const end = await live().waitFor((r) => r.type === "tool_execution_end");
    expect(end.isError).toBe(true);
    expect(toolText(end)).toContain("Denied by the user.");
  });

  it("blocks every tool call without asking when the policy rules are invalid (fail closed)", async () => {
    await start({ steps: [{ toolCalls: [{ name: "read", args: { path: "x.txt" }, id: "call-1" }] }, { text: "done" }] }, { bogus: true });
    await live().request({ type: "prompt", message: "go" });
    const end = await live().waitFor((r) => r.type === "tool_execution_end");
    expect(end.isError).toBe(true);
    expect(toolText(end)).toContain("fail closed");
    expect(live().records.some((r) => r.type === "extension_ui_request" && r.method === "confirm")).toBe(false);
  });

  it("aborts a running command", async () => {
    await start(bash("sleep 30"));
    await live().request({ type: "prompt", message: "go" });
    const ask = await live().waitFor((r) => r.type === "extension_ui_request" && r.method === "confirm");
    live().send({ type: "extension_ui_response", id: ask.id, confirmed: true });
    await live().waitFor((r) => r.type === "tool_execution_start");
    expect(await live().request({ type: "abort" })).toMatchObject({ success: true });
    expect(await live().waitFor((r) => r.type === "agent_settled")).toMatchObject({ aborted: true });
  });

  it("exits when its parent dies", async () => {
    const source = [
      'import { fork } from "node:child_process";',
      `const child = fork(${JSON.stringify(PI_HOST_MAIN)}, [], { execArgv: ${JSON.stringify(DEV_EXEC_ARGV)}, stdio: ["ignore", "ignore", "ignore", "ipc"] });`,
      'process.stdout.write(String(child.pid) + "\\n");',
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parent = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "inherit"] });
    const pid = await new Promise<number>((resolve) => parent.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim()))));
    parent.kill("SIGKILL");
    const deadline = Date.now() + 5000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });
});
```

The last test polls a real process with a deadline; that is waiting for an event, not a fixed sleep.

- [ ] **Step 7: Run it to see it fail**

Run: `pnpm test:int packages/pi-host/src/host.int.test.ts`
Expected: FAIL (`main.ts` does not exist).

- [ ] **Step 8: Write the session opener, commands, host loop and entry**

`packages/pi-host/src/open-session.ts`:

```ts
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  hasTrustRequiringProjectResources,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { AuditEntry, InitRecord, PolicyRules } from "@pap/contracts";
import { createPapPolicyExtension, movePolicyLast } from "./policy/extension.ts";
import { loadScriptedProvider } from "./scripted-provider.ts";
import type { UiBridge } from "./ui-bridge.ts";

export interface OpenSessionDeps {
  readonly ui: UiBridge;
  rules(): PolicyRules | null;
  audit(entry: AuditEntry): void;
  onEvent(event: AgentSessionEvent): void;
  onExtensionError(error: { extensionPath: string; event: string; error: string }): void;
}

export async function openSession(init: InitRecord, deps: OpenSessionDeps): Promise<AgentSession> {
  const { cwd, agentDir } = init;
  const scripted = init.testProviderScript ? await loadScriptedProvider(init.testProviderScript) : null;
  let modelRuntime: ModelRuntime | undefined;
  if (scripted) {
    modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(scripted.provider);
  }
  const trustStore = new ProjectTrustStore(agentDir);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
    ...(modelRuntime ? { modelRuntime } : {}),
    resourceLoaderOptions: {
      extensionFactories: [createPapPolicyExtension({ rules: deps.rules, audit: deps.audit })],
      extensionsOverride: movePolicyLast,
    },
    ...(hasTrustRequiringProjectResources(cwd)
      ? { resourceLoaderReloadOptions: { resolveProjectTrust: async () => trustStore.get(cwd) === true } }
      : {}),
  });
  const sessionManager = init.sessionFile ? SessionManager.open(init.sessionFile) : SessionManager.create(cwd);
  const { session } = await createAgentSessionFromServices({ services, sessionManager, ...(scripted ? { model: scripted.model } : {}) });
  session.subscribe((event) => deps.onEvent(event));
  await session.bindExtensions({
    uiContext: deps.ui.context,
    mode: "rpc",
    onError: (error) => deps.onExtensionError({ extensionPath: error.extensionPath, event: error.event, error: error.error }),
  });
  return session;
}
```

`packages/pi-host/src/commands.ts`:

```ts
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Outbound } from "./ipc.ts";

type Send = (record: Outbound) => void;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 2000);

export function handlePrompt(session: AgentSession, command: { id: string; message: string; streamingBehavior?: "steer" | "followUp" | undefined }, send: Send): void {
  let answered = false;
  const answer = (fields: Record<string, unknown>) => {
    if (answered) return;
    answered = true;
    send({ type: "response", id: command.id, command: "prompt", ...fields });
  };
  session
    .prompt(command.message, {
      ...(command.streamingBehavior ? { streamingBehavior: command.streamingBehavior } : {}),
      preflightResult: (disposition) => answer({ success: true, data: { disposition } }),
    })
    .then(() => answer({ success: true, data: { disposition: "handled" } }))
    .catch((error: unknown) => answer({ success: false, error: messageOf(error) }));
}

export async function handleAbort(session: AgentSession, command: { id: string }, send: Send): Promise<void> {
  try {
    await session.abort();
    send({ type: "response", id: command.id, command: "abort", success: true });
  } catch (error) {
    send({ type: "response", id: command.id, command: "abort", success: false, error: messageOf(error) });
  }
}

export function handleGetState(session: AgentSession, command: { id: string }, send: Send): void {
  send({
    type: "response",
    id: command.id,
    command: "get_state",
    success: true,
    data: {
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      pendingMessageCount: session.pendingMessageCount,
      sessionFile: session.sessionFile ?? "",
      sessionId: session.sessionId,
    },
  });
}
```

`packages/pi-host/src/host.ts`:

```ts
import { VERSION, type AgentSession } from "@earendil-works/pi-coding-agent";
import { PolicyRules, type DaemonToWorker, type InitRecord } from "@pap/contracts";
import { handleAbort, handleGetState, handlePrompt } from "./commands.ts";
import type { Ipc } from "./ipc.ts";
import { openSession } from "./open-session.ts";
import { createUiBridge } from "./ui-bridge.ts";
import { toWireEvent } from "./wire-events.ts";

const HEALTH_INTERVAL_MS = 30_000;

const parseRules = (raw: unknown): PolicyRules | null => {
  const parsed = PolicyRules.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

function nextInit(ipc: Ipc): Promise<InitRecord> {
  return new Promise((resolve) => {
    const off = ipc.onMessage((record) => {
      if (record.type !== "init") return;
      off();
      resolve(record);
    });
  });
}

function exit(session: AgentSession | null, code: number): never {
  try {
    session?.dispose();
  } finally {
    process.exit(code);
  }
}

export async function runHost(ipc: Ipc): Promise<void> {
  let session: AgentSession | null = null;
  ipc.onDisconnect(() => exit(session, 0));
  const init = await nextInit(ipc);
  let rules = parseRules(init.policy);
  const ui = createUiBridge((record) => ipc.send(record));
  const opened = await openSession(init, {
    ui,
    rules: () => rules,
    audit: (entry) => ipc.send({ type: "audit", entry }),
    onEvent: (event) => ipc.send(toWireEvent(event)),
    onExtensionError: (error) => ipc.send({ type: "extension_error", ...error }),
  });
  session = opened;
  const dispatch = (record: DaemonToWorker): void => {
    switch (record.type) {
      case "prompt":
        handlePrompt(opened, record, ipc.send);
        return;
      case "abort":
        void handleAbort(opened, record, ipc.send);
        return;
      case "get_state":
        handleGetState(opened, record, ipc.send);
        return;
      case "extension_ui_response":
        ui.resolve(record);
        return;
      case "policy_update":
        rules = parseRules(record.rules);
        return;
      case "shutdown":
        ui.cancelAll();
        exit(opened, 0);
        return;
      case "init":
        return;
    }
  };
  ipc.onMessage(dispatch);
  ipc.send({ type: "ready", sessionFile: opened.sessionFile ?? "", sessionId: opened.sessionId, piVersion: VERSION });
  const health = () => ipc.send({ type: "health", rssMb: Math.round(process.memoryUsage().rss / 1048576) });
  health();
  setInterval(health, HEALTH_INTERVAL_MS).unref();
}
```

`packages/pi-host/src/main.ts`:

```ts
import { runHost } from "./host.ts";
import { createIpc } from "./ipc.ts";
import { applyOomScore, startParentWatchdog } from "./watchdog.ts";

applyOomScore(800);
startParentWatchdog({ initialPpid: process.ppid, onOrphan: () => process.exit(1) });
runHost(createIpc(process)).catch((error: unknown) => {
  process.stderr.write(`pi-host: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(70);
});
```

- [ ] **Step 9: Record the protocol additions**

`docs/adr/0001-pi-host-boot-and-closed-records.md`:

~~~markdown
# ADR 0001 — two pap records added to the daemon ⇄ pi-host protocol

Status: accepted · Date: [today] · Spec: C §2.3

1. `init{cwd, agentDir, sessionFile?, policy, testProviderScript?}` (daemon → worker, first record). Spec C §2.3 lists no boot record, but the worker needs its session file, cwd and policy before it can send `ready`. Passing them in the environment would leak into every bash child; passing them on argv exposes them in `ps`. `policy` replaces the "rules sent at worker boot" of §5.1; `policy_update` stays the hot-reload path.
2. `extension_ui_closed{id}` (worker → daemon). When Pi resolves a dialog on its own (extension timeout or abort signal), the daemon must remove the card. pi-web already used this record.

`testProviderScript` exists only for tests: the daemon sends it when `PAP_TEST_PROVIDER_SCRIPT` is set and logs a warning at boot.
~~~

- [ ] **Step 10: Run tests and gates**

Run: `pnpm test:unit packages/pi-host && pnpm test:int packages/pi-host && pnpm typecheck && pnpm lint && pnpm knip`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/pi-host docs/adr/0001-pi-host-boot-and-closed-records.md pnpm-lock.yaml
git commit -m "feat(pi-host): forked Pi SDK worker with IPC, watchdog and scripted test provider"
```

---

### Task 21: daemon kernel — worker supervisor (fork, request correlation, kill ladder, exit causes, env)

**Files:**
- Create: `apps/daemon/src/kernel/supervisor/exit.ts`, `kill-ladder.ts`, `env.ts`, `worker.ts`, `fake-worker.ts`
- Test: `apps/daemon/src/kernel/supervisor/exit.test.ts`, `kill-ladder.test.ts`, `env.test.ts`, `fake-worker.test.ts`, `worker.int.test.ts`

**Interfaces:**
- Consumes: contracts records (Task 12), `Clock`, `createFakeClock`, `Logger` (Task 13), the worker entry (Task 20).
- Produces:
  - `type ExitCause = "clean" | "exit_code" | "signal" | "killed" | "spawn_failure"`, `interface WorkerExit { code; signal; cause }`, `classifyExit(code, signal)`, `describeExit(exit): string`
  - `killLadder({ shutdown(graceMs), signal(sig): boolean, exited }, clock) → Promise<WorkerExit>`; rungs: `shutdown{graceMs: 2000}` → 2 s → SIGTERM to the process group → 3 s → SIGKILL
  - `workerEnv(base, extra)`: base minus `PAP_*`, plus `PI_TELEMETRY=0`, `PI_SKIP_VERSION_CHECK=1`, plus `extra`
  - `spawnWorker({ entry, execArgv, cwd, env, clock, logger }) → WorkerHandle { pid; exited; send(record): boolean; request(command, timeoutMs?): Promise<ResponseRecord>; onRecord(listener): () => void; stop(): Promise<WorkerExit>; outputTail(): string }`
  - `createFakeWorker({ onSend?, reply?, pid? }) → FakeWorker` (test support used by Task 22): `sent`, `requests`, `emit(record)`, `respond(id, reply)`, `crash(exit)`, `stopped()`

**Spike fallback / S1:** `spawnWorker` uses `spawn("pi", ["--mode", "rpc", …])` with stdio pipes and LF framing instead of `fork` + IPC; the kill ladder, exit causes and request correlation stay the same.

- [ ] **Step 1: Write the failing unit tests**

`apps/daemon/src/kernel/supervisor/exit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classifyExit, describeExit } from "./exit.ts";

describe("exit causes", () => {
  it("classifies exits", () => {
    expect(classifyExit(0, null).cause).toBe("clean");
    expect(classifyExit(70, null).cause).toBe("exit_code");
    expect(classifyExit(null, "SIGTERM").cause).toBe("signal");
    expect(classifyExit(null, "SIGKILL").cause).toBe("killed");
  });

  it("describes them for a banner", () => {
    expect(describeExit(classifyExit(null, "SIGKILL"))).toBe("Agent process killed (SIGKILL), possibly out of memory.");
    expect(describeExit(classifyExit(70, null))).toBe("Agent process exited with code 70.");
    expect(describeExit({ code: null, signal: null, cause: "spawn_failure" })).toBe("Agent process could not start.");
  });
});
```

`apps/daemon/src/kernel/supervisor/kill-ladder.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../clock.ts";
import type { WorkerExit } from "./exit.ts";
import { killLadder } from "./kill-ladder.ts";

function target() {
  const calls: string[] = [];
  let finish: (exit: WorkerExit) => void = () => {};
  const exited = new Promise<WorkerExit>((resolve) => { finish = resolve; });
  return {
    calls,
    exit: (exit: WorkerExit) => finish(exit),
    target: { shutdown: (graceMs: number) => { calls.push(`shutdown:${graceMs}`); }, signal: (signal: string) => { calls.push(signal); return true; }, exited },
  };
}

describe("kill ladder", () => {
  it("stops at the shutdown rung when the worker exits in time", async () => {
    const clock = createFakeClock();
    const t = target();
    const done = killLadder(t.target, clock);
    await clock.advance(1000);
    t.exit({ code: 0, signal: null, cause: "clean" });
    expect((await done).cause).toBe("clean");
    expect(t.calls).toEqual(["shutdown:2000"]);
  });

  it("sends SIGTERM to the group after 2 s, then SIGKILL after 3 more", async () => {
    const clock = createFakeClock();
    const t = target();
    const done = killLadder(t.target, clock);
    await clock.advance(2000);
    expect(t.calls).toEqual(["shutdown:2000", "SIGTERM"]);
    await clock.advance(3000);
    expect(t.calls).toEqual(["shutdown:2000", "SIGTERM", "SIGKILL"]);
    t.exit({ code: null, signal: "SIGKILL", cause: "killed" });
    expect((await done).cause).toBe("killed");
  });
});
```

`apps/daemon/src/kernel/supervisor/env.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { workerEnv } from "./env.ts";

describe("workerEnv", () => {
  it("drops PAP_* variables, disables Pi telemetry and the version check, applies extras", () => {
    const env = workerEnv({ PATH: "/usr/bin", PAP_HOME: "/secret", PAP_TEST_PROVIDER_SCRIPT: "/s.json", HOME: "/home/u" }, { PI_CODING_AGENT_DIR: "/agent" });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/u", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", PI_CODING_AGENT_DIR: "/agent" });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/kernel/supervisor`
Expected: FAIL (modules not found).

- [ ] **Step 3: Write exit, kill ladder, env**

`apps/daemon/src/kernel/supervisor/exit.ts`:

```ts
export type ExitCause = "clean" | "exit_code" | "signal" | "killed" | "spawn_failure";

export interface WorkerExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly cause: ExitCause;
}

export function classifyExit(code: number | null, signal: NodeJS.Signals | null): WorkerExit {
  if (signal === "SIGKILL") return { code, signal, cause: "killed" };
  if (signal) return { code, signal, cause: "signal" };
  return { code, signal, cause: code === 0 ? "clean" : "exit_code" };
}

export function describeExit(exit: WorkerExit): string {
  switch (exit.cause) {
    case "clean":
      return "Agent process stopped.";
    case "exit_code":
      return `Agent process exited with code ${exit.code ?? "unknown"}.`;
    case "signal":
      return `Agent process stopped by ${exit.signal ?? "a signal"}.`;
    case "killed":
      return "Agent process killed (SIGKILL), possibly out of memory.";
    case "spawn_failure":
      return "Agent process could not start.";
  }
}
```

`apps/daemon/src/kernel/supervisor/kill-ladder.ts`:

```ts
import type { Clock, TimerHandle } from "../clock.ts";
import type { WorkerExit } from "./exit.ts";

export const SHUTDOWN_GRACE_MS = 2000;
export const SIGTERM_GRACE_MS = 3000;

export interface LadderTarget {
  shutdown(graceMs: number): void;
  signal(signal: "SIGTERM" | "SIGKILL"): boolean;
  readonly exited: Promise<WorkerExit>;
}

async function exitsWithin(exited: Promise<WorkerExit>, ms: number, clock: Clock): Promise<boolean> {
  let timer: TimerHandle | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = clock.setTimeout(() => resolve(false), ms);
  });
  const result = await Promise.race([exited.then(() => true as const), timeout]);
  if (timer) clock.clearTimeout(timer);
  return result;
}

export async function killLadder(target: LadderTarget, clock: Clock): Promise<WorkerExit> {
  try {
    target.shutdown(SHUTDOWN_GRACE_MS);
  } catch {
    // the IPC channel may already be closed; the next rungs still apply
  }
  if (await exitsWithin(target.exited, SHUTDOWN_GRACE_MS, clock)) return target.exited;
  target.signal("SIGTERM");
  if (await exitsWithin(target.exited, SIGTERM_GRACE_MS, clock)) return target.exited;
  target.signal("SIGKILL");
  return target.exited;
}
```

`apps/daemon/src/kernel/supervisor/env.ts`:

```ts
export function workerEnv(base: NodeJS.ProcessEnv, extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined && !key.startsWith("PAP_")) env[key] = value;
  return { ...env, PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", ...extra };
}
```

- [ ] **Step 4: Run the unit tests**

Run: `pnpm test:unit apps/daemon/src/kernel/supervisor`
Expected: PASS.

- [ ] **Step 5: Write the failing integration test against a real worker**

`apps/daemon/src/kernel/supervisor/worker.int.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerRecord } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSystemClock } from "../clock.ts";
import { silentLogger } from "../logger.ts";
import { workerEnv } from "./env.ts";
import { spawnWorker, type WorkerHandle } from "./worker.ts";

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const ENTRY = join(REPO, "packages/pi-host/src/main.ts");
const EXEC_ARGV = ["--conditions=development", "--import", join(REPO, "packages/pi-host/src/testing/network-guard.ts")];
let root: string;
let worker: WorkerHandle | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-supervisor-"));
  mkdirSync(join(root, "agent"));
  mkdirSync(join(root, "work"));
  writeFileSync(join(root, "script.json"), JSON.stringify({ steps: [{ text: "hello" }] }));
});
afterEach(async () => {
  if (worker) await worker.stop();
  worker = undefined;
  rmSync(root, { recursive: true, force: true });
});

function boot(): Promise<WorkerHandle> {
  const handle = spawnWorker({
    entry: ENTRY,
    execArgv: EXEC_ARGV,
    cwd: join(root, "work"),
    env: workerEnv({ ...process.env, PI_OFFLINE: "1" }, { PI_CODING_AGENT_DIR: join(root, "agent") }),
    clock: createSystemClock(),
    logger: silentLogger,
  });
  worker = handle;
  const ready = new Promise<WorkerRecord>((resolve) => {
    const off = handle.onRecord((record) => {
      if (record.type === "ready") {
        off();
        resolve(record);
      }
    });
  });
  handle.send({ type: "init", cwd: join(root, "work"), agentDir: join(root, "agent"), policy: { profile: "interactive", approvalMode: "auto-accept-edits" }, testProviderScript: join(root, "script.json") });
  return ready.then(() => handle);
}

describe("spawnWorker", () => {
  it("boots, answers get_state, and stops at the first rung of the kill ladder", async () => {
    const handle = await boot();
    const state = await handle.request({ type: "get_state" }, 5000);
    expect(state).toMatchObject({ success: true, data: { isStreaming: false } });
    const started = Date.now();
    expect((await handle.stop()).cause).toBe("clean");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("rejects pending requests and reports a kill when the worker dies", async () => {
    const handle = await boot();
    process.kill(-(handle.pid ?? 0), "SIGKILL");
    await expect(handle.request({ type: "get_state" })).rejects.toThrow();
    expect((await handle.exited).cause).toBe("killed");
  });
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `pnpm test:int apps/daemon/src/kernel/supervisor`
Expected: FAIL (`worker.ts` not found).

- [ ] **Step 7: Write the supervisor and the fake worker**

`apps/daemon/src/kernel/supervisor/worker.ts`:

```ts
import { fork } from "node:child_process";
import { PapError, parseWorkerRecord, type CommandInput, type DaemonToWorker, type ResponseRecord, type WorkerRecord } from "@pap/contracts";
import type { Clock, TimerHandle } from "../clock.ts";
import type { Logger } from "../logger.ts";
import { classifyExit, type WorkerExit } from "./exit.ts";
import { killLadder } from "./kill-ladder.ts";

const OUTPUT_TAIL_BYTES = 8 * 1024;

export interface SpawnWorkerOptions {
  readonly entry: string;
  readonly execArgv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface WorkerHandle {
  readonly pid: number | undefined;
  readonly exited: Promise<WorkerExit>;
  send(record: DaemonToWorker): boolean;
  request(command: CommandInput, timeoutMs?: number): Promise<ResponseRecord>;
  onRecord(listener: (record: WorkerRecord) => void): () => void;
  stop(): Promise<WorkerExit>;
  outputTail(): string;
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

export function spawnWorker(options: SpawnWorkerOptions): WorkerHandle {
  const child = fork(options.entry, [], {
    cwd: options.cwd,
    env: options.env,
    execArgv: [...options.execArgv],
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "json",
  });
  let tail = Buffer.alloc(0);
  const keep = (chunk: Buffer) => {
    tail = Buffer.concat([tail, chunk]);
    if (tail.length > OUTPUT_TAIL_BYTES) tail = tail.subarray(tail.length - OUTPUT_TAIL_BYTES);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const listeners = new Set<(record: WorkerRecord) => void>();
  const pending = new Map<string, { resolve(record: ResponseRecord): void; reject(error: Error): void; timer: TimerHandle | undefined }>();
  let alive = true;
  let nextId = 0;
  const exited = new Promise<WorkerExit>((resolve) => {
    const finish = (exit: WorkerExit) => {
      if (!alive) return;
      alive = false;
      for (const entry of pending.values()) {
        if (entry.timer) options.clock.clearTimeout(entry.timer);
        entry.reject(new PapError("worker_failed"));
      }
      pending.clear();
      resolve(exit);
    };
    child.once("error", (error) => {
      options.logger.warn("worker_error", { err: error });
      if (child.pid === undefined) finish({ code: null, signal: null, cause: "spawn_failure" });
    });
    child.once("exit", (code, signal) => finish(classifyExit(code, signal)));
  });
  child.on("message", (raw) => {
    const record = parseWorkerRecord(raw);
    if (!record) {
      options.logger.warn("worker_record_dropped", { pid: child.pid });
      return;
    }
    if (record.type === "response") {
      const entry = pending.get(record.id);
      if (!entry) return;
      pending.delete(record.id);
      if (entry.timer) options.clock.clearTimeout(entry.timer);
      entry.resolve(record);
      return;
    }
    for (const listener of listeners) listener(record);
  });
  const send = (record: DaemonToWorker): boolean => {
    if (!alive || !child.connected) return false;
    try {
      return child.send(record);
    } catch {
      return false;
    }
  };
  return {
    get pid() {
      return child.pid;
    },
    exited,
    send,
    request(command, timeoutMs) {
      const id = `r${++nextId}`;
      return new Promise<ResponseRecord>((resolve, reject) => {
        const timer = timeoutMs === undefined ? undefined : options.clock.setTimeout(() => {
          pending.delete(id);
          reject(new PapError("worker_failed"));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        if (!send({ ...command, id } as DaemonToWorker)) {
          pending.delete(id);
          if (timer) options.clock.clearTimeout(timer);
          reject(new PapError("worker_failed"));
        }
      });
    },
    onRecord(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop: () =>
      alive
        ? killLadder({ shutdown: (graceMs) => { send({ type: "shutdown", graceMs }); }, signal: (signal) => signalGroup(child.pid, signal), exited }, options.clock)
        : exited,
    outputTail: () => tail.toString("utf8"),
  };
}
```

`apps/daemon/src/kernel/supervisor/fake-worker.ts`:

```ts
import { PapError, type CommandInput, type DaemonToWorker, type ResponseRecord, type WorkerRecord } from "@pap/contracts";
import type { WorkerExit } from "./exit.ts";
import type { WorkerHandle } from "./worker.ts";

type Reply = Partial<Omit<ResponseRecord, "type" | "id">>;

export interface FakeWorker extends WorkerHandle {
  readonly sent: DaemonToWorker[];
  readonly requests: Array<CommandInput & { id: string }>;
  emit(record: WorkerRecord): void;
  respond(id: string, reply: Reply): void;
  crash(exit: WorkerExit): void;
  stopped(): boolean;
}

export interface FakeWorkerOptions {
  onSend?(record: DaemonToWorker, worker: FakeWorker): void;
  reply?(command: CommandInput): Reply | undefined;
  pid?: number;
}

export function createFakeWorker(options: FakeWorkerOptions = {}): FakeWorker {
  const listeners = new Set<(record: WorkerRecord) => void>();
  const pending = new Map<string, { resolve(record: ResponseRecord): void; reject(error: Error): void }>();
  let resolveExit: (exit: WorkerExit) => void = () => {};
  const exited = new Promise<WorkerExit>((resolve) => { resolveExit = resolve; });
  let alive = true;
  let stopCalled = false;
  let nextId = 0;
  const finish = (exit: WorkerExit) => {
    if (!alive) return;
    alive = false;
    for (const entry of pending.values()) entry.reject(new PapError("worker_failed"));
    pending.clear();
    resolveExit(exit);
  };
  const worker: FakeWorker = {
    pid: options.pid ?? 4242,
    exited,
    sent: [],
    requests: [],
    send(record) {
      if (!alive) return false;
      worker.sent.push(record);
      options.onSend?.(record, worker);
      return true;
    },
    request(command) {
      const id = `r${++nextId}`;
      worker.requests.push({ ...command, id } as CommandInput & { id: string });
      if (!alive) return Promise.reject(new PapError("worker_failed"));
      const reply = options.reply?.(command);
      if (reply) return Promise.resolve({ type: "response", id, command: command.type, success: true, ...reply });
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    onRecord(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async stop() {
      stopCalled = true;
      finish({ code: 0, signal: null, cause: "clean" });
      return exited;
    },
    outputTail: () => "",
    emit(record) {
      for (const listener of [...listeners]) listener(record);
    },
    respond(id, reply) {
      const entry = pending.get(id);
      if (!entry) throw new Error(`no pending request ${id}`);
      pending.delete(id);
      entry.resolve({ type: "response", id, command: "", success: true, ...reply });
    },
    crash: (exit) => finish(exit),
    stopped: () => stopCalled,
  };
  return worker;
}
```

`apps/daemon/src/kernel/supervisor/fake-worker.test.ts` (the double must behave like the real handle where Task 22 relies on it):

```ts
import { describe, expect, it } from "vitest";
import { createFakeWorker } from "./fake-worker.ts";

describe("fake worker", () => {
  it("answers scripted requests, holds others, and rejects them on a crash", async () => {
    const worker = createFakeWorker({ reply: (command) => (command.type === "get_state" ? { data: { ok: 1 } } : undefined) });
    expect(await worker.request({ type: "get_state" })).toMatchObject({ success: true, data: { ok: 1 } });
    const held = worker.request({ type: "abort" });
    worker.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await expect(held).rejects.toThrow();
    expect((await worker.exited).cause).toBe("killed");
    expect(worker.send({ type: "get_state", id: "x" })).toBe(false);
  });
});
```

- [ ] **Step 8: Run tests and gates**

Run: `pnpm test:unit apps/daemon/src/kernel/supervisor && pnpm test:int apps/daemon/src/kernel/supervisor && pnpm typecheck && pnpm lint && pnpm knip`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/daemon
git commit -m "feat(daemon): worker supervisor with kill ladder, exit causes and scrubbed env"
```

---

### Task 22: sessions module — create in a cwd, prompt, stream, dialogs, run boundaries, index row

**Files:**
- Create: `apps/daemon/src/modules/sessions/migrations/202610100200_sessions.sql`
- Create: `apps/daemon/src/modules/sessions/cwd.ts`, `store.ts`, `dialogs.ts`, `run-tracker.ts`, `transcript.ts`, `live-session.ts`, `service.ts`, `rpc.ts`, `index.ts`
- Modify: `apps/daemon/package.json` (Pi SDK dependency for transcript reading)
- Test: `apps/daemon/src/modules/sessions/cwd.test.ts`, `dialogs.test.ts`, `run-tracker.test.ts`, `transcript.test.ts`, `live-session.test.ts`, `service.test.ts`

**Interfaces:**
- Consumes: kernel (`Db`, `migrate`, `Clock`, `Logger`, `StreamHub`, `WorkerHandle`, `spawnWorker`, `workerEnv`, `describeExit`, `createFakeWorker`, `Config`), contracts (records, `SessionStreamEvent`, `Dialog`, `DialogResponse`, `HandlerTable`, `PapError`).
- Produces (`modules/sessions/index.ts`):
  - `SESSIONS_MIGRATIONS: MigrationSource`
  - `createSessionsModule({ db, clock, logger, hub, config, env }) → SessionsModule { rpc: Pick<HandlerTable, "sessions.create" | "sessions.list" | "sessions.prompt" | "sessions.abort" | "sessions.respondDialog" | "subscribe.session">; shutdownAll(): Promise<void>; inspect(sessionId): { pid; rssMb } | null }`
  - Session stream events (contracts `SessionStreamEvent`): `snapshot` (status, last 75 transcript messages, open dialogs), `status` (with a readable `cause` when a worker dies), `pi` (Pi wire events and extension decorations), `dialog_open`, `dialog_closed`, `notice`
  - Rules: run end = `agent_settled` confirmed by up to 3 `get_state` probes 100 ms apart, cancelled by new input; abort terminates the worker when compaction runs or the run has not settled within 5 s; at most 64 open dialogs / 8 MiB, unknown dialog methods auto-cancelled; a crashed worker is not restarted until the next prompt, which reopens the same Pi file; capacity = `maxWorkers` and `minFreeMemMb`, refused with `capacity`.

- [ ] **Step 1: Install**

Run: `pnpm --filter @pap/daemon add "@earendil-works/pi-coding-agent@catalog:"`

- [ ] **Step 2: Write the failing tests for the pure parts**

`apps/daemon/src/modules/sessions/cwd.test.ts`:

```ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSessionCwd } from "./cwd.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-cwd-"));
  mkdirSync(join(root, "proj"));
  writeFileSync(join(root, "file.txt"), "x");
  symlinkSync(join(root, "proj"), join(root, "link"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const codeOf = (input: string) => {
  try {
    resolveSessionCwd(input);
    return null;
  } catch (error) {
    return (error as PapError).code;
  }
};

describe("resolveSessionCwd", () => {
  it.each([["relative path", "proj"], ["tilde path", "~/proj"], ["missing folder", "/definitely/missing/pap-folder"], ["empty", ""]])(
    "rejects a %s with invalid_cwd",
    (_label, input) => {
      expect(codeOf(input)).toBe("invalid_cwd");
    },
  );

  it("rejects a file with invalid_cwd", () => {
    expect(codeOf(join(root, "file.txt"))).toBe("invalid_cwd");
  });

  it("resolves a symlink to the real folder", () => {
    expect(resolveSessionCwd(join(root, "link"))).toBe(realpathSync(join(root, "proj")));
  });
});
```

`apps/daemon/src/modules/sessions/dialogs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createDialogRegistry } from "./dialogs.ts";

const request = (id: string, fields: Record<string, unknown> = {}) => ({ type: "extension_ui_request" as const, id, method: "confirm", title: "Run a command?", message: "bash: ls", ...fields });

describe("dialog registry", () => {
  it("opens known dialogs, hands each one out once, and clears", () => {
    const dialogs = createDialogRegistry();
    expect(dialogs.offer(request("d1")).kind).toBe("opened");
    expect(dialogs.list().map((d) => d.id)).toEqual(["d1"]);
    expect(dialogs.take("d1")?.id).toBe("d1");
    expect(dialogs.take("d1")).toBeNull();
    dialogs.offer(request("d2"));
    expect(dialogs.clear().map((d) => d.id)).toEqual(["d2"]);
    expect(dialogs.list()).toEqual([]);
  });

  it("cancels unknown methods and malformed dialogs, passes decorations through", () => {
    const dialogs = createDialogRegistry();
    expect(dialogs.offer(request("x", { method: "custom" })).kind).toBe("cancel");
    expect(dialogs.offer(request("y", { title: 42 })).kind).toBe("cancel");
    expect(dialogs.offer(request("z", { method: "notify", message: "hi" })).kind).toBe("decoration");
  });

  it("cancels beyond 64 open dialogs and beyond 8 MiB", () => {
    const byCount = createDialogRegistry();
    for (let i = 0; i < 64; i++) expect(byCount.offer(request(`c${i}`)).kind).toBe("opened");
    expect(byCount.offer(request("c64")).kind).toBe("cancel");
    const bySize = createDialogRegistry();
    for (let i = 0; i < 8; i++) expect(bySize.offer(request(`s${i}`, { method: "editor", prefill: "x".repeat(1_000_000) })).kind).toBe("opened");
    expect(bySize.offer(request("s8", { method: "editor", prefill: "x".repeat(1_000_000) })).kind).toBe("cancel");
  });
});
```

`apps/daemon/src/modules/sessions/run-tracker.test.ts`:

```ts
import type { GetStateData } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createRunTracker } from "./run-tracker.ts";

const idle: GetStateData = { isStreaming: false, isCompacting: false, pendingMessageCount: 0, sessionFile: "/f", sessionId: "s" };
const busy: GetStateData = { ...idle, pendingMessageCount: 1 };

function setup(states: GetStateData[]) {
  const clock = createFakeClock();
  const log: string[] = [];
  let probes = 0;
  const tracker = createRunTracker({
    clock,
    probe: async () => states[Math.min(probes++, states.length - 1)] ?? idle,
    onRunStart: () => log.push("start"),
    onRunEnd: ({ aborted }) => log.push(`end:${aborted}`),
  });
  return { clock, log, tracker, probes: () => probes };
}

describe("run tracker", () => {
  it("ends a run only after agent_settled is confirmed idle by get_state", async () => {
    const { clock, log, tracker } = setup([idle]);
    tracker.onEvent({ type: "agent_start" });
    tracker.onEvent({ type: "agent_end" });
    await clock.advance(0);
    expect(log).toEqual(["start"]);
    tracker.onEvent({ type: "agent_settled", aborted: false });
    await clock.advance(0);
    expect(log).toEqual(["start", "end:false"]);
  });

  it("probes three times 100 ms apart and stays running if Pi is never idle", async () => {
    const { clock, log, tracker, probes } = setup([busy]);
    tracker.onEvent({ type: "agent_start" });
    tracker.onEvent({ type: "agent_settled", aborted: false });
    await clock.advance(300);
    expect(probes()).toBe(3);
    expect(tracker.running).toBe(true);
    expect(log).toEqual(["start"]);
  });

  it("ends on a later probe, and a new input cancels a pending probe", async () => {
    const ends = setup([busy, idle]);
    ends.tracker.onEvent({ type: "agent_start" });
    ends.tracker.onEvent({ type: "agent_settled", aborted: true });
    await ends.clock.advance(100);
    expect(ends.log).toEqual(["start", "end:true"]);
    const cancelled = setup([busy, idle]);
    cancelled.tracker.onEvent({ type: "agent_start" });
    cancelled.tracker.onEvent({ type: "agent_settled", aborted: false });
    await cancelled.clock.advance(0);
    cancelled.tracker.onInput();
    await cancelled.clock.advance(200);
    expect(cancelled.probes()).toBe(1);
    expect(cancelled.tracker.running).toBe(true);
  });

  it("waitIdle resolves true at the end of the run and false after its timeout", async () => {
    const { clock, tracker } = setup([idle]);
    tracker.onEvent({ type: "agent_start" });
    const late = tracker.waitIdle(50);
    await clock.advance(50);
    expect(await late).toBe(false);
    const ok = tracker.waitIdle(5000);
    tracker.onEvent({ type: "agent_settled", aborted: false });
    await clock.advance(0);
    expect(await ok).toBe(true);
  });
});
```

`apps/daemon/src/modules/sessions/transcript.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTranscriptTail } from "./transcript.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pap-transcript-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const lines = [
  { type: "session", version: 3, id: "11111111-1111-4111-8111-111111111111", timestamp: "2026-10-10T00:00:00.000Z", cwd: "/w" },
  { type: "message", id: "a1", parentId: null, timestamp: "2026-10-10T00:00:01.000Z", message: { role: "user", content: "hi", timestamp: 1 } },
  {
    type: "message",
    id: "a2",
    parentId: "a1",
    timestamp: "2026-10-10T00:00:02.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "hello" }], api: "x", provider: "x", model: "x", usage, stopReason: "stop", timestamp: 2 },
  },
];

describe("readTranscriptTail", () => {
  it("returns nothing for a missing or unreadable file", () => {
    expect(readTranscriptTail(join(dir, "missing.jsonl"))).toEqual([]);
    writeFileSync(join(dir, "bad.jsonl"), "not json\n");
    expect(readTranscriptTail(join(dir, "bad.jsonl"))).toEqual([]);
  });

  it("reads the active branch of a Pi session file, keeping only the tail", () => {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    expect(readTranscriptTail(file).map((m) => (m as { role: string }).role)).toEqual(["user", "assistant"]);
    expect(readTranscriptTail(file, 1).map((m) => (m as { role: string }).role)).toEqual(["assistant"]);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/sessions`
Expected: FAIL (modules not found).

- [ ] **Step 4: Write cwd, dialogs, run tracker, transcript**

`apps/daemon/src/modules/sessions/cwd.ts`:

```ts
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { PapError } from "@pap/contracts";

export function resolveSessionCwd(input: string): string {
  if (!input || !isAbsolute(input)) throw new PapError("invalid_cwd");
  let real: string;
  try {
    real = realpathSync(input);
  } catch {
    throw new PapError("invalid_cwd");
  }
  if (!statSync(real).isDirectory()) throw new PapError("invalid_cwd");
  return real;
}
```

`apps/daemon/src/modules/sessions/dialogs.ts`:

```ts
import { Dialog, type UiRequestRecord } from "@pap/contracts";

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const DECORATION_METHODS = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);
const MAX_DIALOGS = 64;
const MAX_DIALOG_BYTES = 8 * 1024 * 1024;

export type DialogVerdict = { kind: "opened"; dialog: Dialog } | { kind: "cancel" } | { kind: "decoration" };

export interface DialogRegistry {
  offer(request: UiRequestRecord): DialogVerdict;
  take(id: string): Dialog | null;
  list(): Dialog[];
  clear(): Dialog[];
}

export function createDialogRegistry(): DialogRegistry {
  const open = new Map<string, { dialog: Dialog; bytes: number }>();
  let bytes = 0;
  return {
    offer(request) {
      if (DECORATION_METHODS.has(request.method)) return { kind: "decoration" };
      if (!DIALOG_METHODS.has(request.method)) return { kind: "cancel" };
      const parsed = Dialog.safeParse(request);
      if (!parsed.success) return { kind: "cancel" };
      const size = Buffer.byteLength(JSON.stringify(parsed.data));
      if (open.size >= MAX_DIALOGS || bytes + size > MAX_DIALOG_BYTES) return { kind: "cancel" };
      open.set(parsed.data.id, { dialog: parsed.data, bytes: size });
      bytes += size;
      return { kind: "opened", dialog: parsed.data };
    },
    take(id) {
      const entry = open.get(id);
      if (!entry) return null;
      open.delete(id);
      bytes -= entry.bytes;
      return entry.dialog;
    },
    list: () => [...open.values()].map((entry) => entry.dialog),
    clear() {
      const all = [...open.values()].map((entry) => entry.dialog);
      open.clear();
      bytes = 0;
      return all;
    },
  };
}
```

`apps/daemon/src/modules/sessions/run-tracker.ts`:

```ts
import type { GetStateData } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";

const PROBE_ATTEMPTS = 3;
const PROBE_INTERVAL_MS = 100;

export interface RunTrackerDeps {
  readonly clock: Clock;
  probe(): Promise<GetStateData>;
  onRunStart(): void;
  onRunEnd(result: { aborted: boolean }): void;
}

export interface RunTracker {
  readonly running: boolean;
  onInput(): void;
  onEvent(event: { type: string } & Record<string, unknown>): void;
  waitIdle(timeoutMs: number): Promise<boolean>;
  reset(): void;
}

const isIdle = (state: GetStateData) => !state.isStreaming && !state.isCompacting && state.pendingMessageCount === 0;

export function createRunTracker(deps: RunTrackerDeps): RunTracker {
  let running = false;
  let revision = 0;
  const idleWaiters = new Set<() => void>();
  const wakeWaiters = () => {
    for (const wake of [...idleWaiters]) wake();
  };
  const endRun = (aborted: boolean) => {
    running = false;
    deps.onRunEnd({ aborted });
    wakeWaiters();
  };
  const confirm = async (rev: number, aborted: boolean): Promise<void> => {
    for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
      if (attempt > 0) await deps.clock.sleep(PROBE_INTERVAL_MS);
      if (rev !== revision || !running) return;
      const state = await deps.probe().catch(() => null);
      if (rev !== revision || !running) return;
      if (state && isIdle(state)) {
        endRun(aborted);
        return;
      }
    }
  };
  return {
    get running() {
      return running;
    },
    onInput() {
      revision++;
    },
    onEvent(event) {
      if (event.type === "agent_start" && !running) {
        running = true;
        deps.onRunStart();
      } else if (event.type === "agent_settled") {
        void confirm(revision, event.aborted === true);
      }
    },
    waitIdle(timeoutMs) {
      if (!running) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        let timer: TimerHandle | undefined;
        const done = (idle: boolean) => {
          idleWaiters.delete(onIdle);
          if (timer) deps.clock.clearTimeout(timer);
          resolve(idle);
        };
        const onIdle = () => done(true);
        idleWaiters.add(onIdle);
        timer = deps.clock.setTimeout(() => done(false), timeoutMs);
      });
    },
    reset() {
      running = false;
      revision++;
      wakeWaiters();
    },
  };
}
```

If three probes never see Pi idle, the run stays `running` until the next `agent_settled`; spec C §2.4 does not say what to do in that case (noted in the plan summary).

`apps/daemon/src/modules/sessions/transcript.ts` (pure parsing of the Pi file: never writes, never migrates the file on disk):

```ts
import { existsSync, readFileSync } from "node:fs";
import { buildSessionContext, migrateSessionEntries, parseSessionEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";

const SNAPSHOT_MESSAGES = 75;

export function readTranscriptTail(filePath: string, limit = SNAPSHOT_MESSAGES): unknown[] {
  if (!existsSync(filePath)) return [];
  try {
    const entries = parseSessionEntries(readFileSync(filePath, "utf8"));
    migrateSessionEntries(entries);
    const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
    return buildSessionContext(sessionEntries).messages.slice(-limit);
  } catch {
    return [];
  }
}
```

- [ ] **Step 5: Run the pure tests**

Run: `pnpm test:unit apps/daemon/src/modules/sessions/cwd.test.ts apps/daemon/src/modules/sessions/dialogs.test.ts apps/daemon/src/modules/sessions/run-tracker.test.ts apps/daemon/src/modules/sessions/transcript.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing live-session and service tests**

`apps/daemon/src/modules/sessions/live-session.test.ts`:

```ts
import type { InitRecord, PapError, SessionStreamEvent } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import type { WorkerExit } from "../../kernel/supervisor/exit.ts";
import { createFakeWorker } from "../../kernel/supervisor/fake-worker.ts";
import { startLiveSession } from "./live-session.ts";

const INIT: InitRecord = { type: "init", cwd: "/w", agentDir: "/a", policy: {} };
const confirm = { type: "extension_ui_request" as const, id: "d1", method: "confirm", title: "Run a command?", message: "bash: ls" };

function setup(options: { compacting?: boolean; promptFails?: boolean } = {}) {
  const clock = createFakeClock();
  const published: SessionStreamEvent[] = [];
  const recorded: Array<[string, unknown]> = [];
  const exits: WorkerExit[] = [];
  const worker = createFakeWorker({
    reply: (command) => {
      if (command.type === "get_state") return { data: { isStreaming: false, isCompacting: options.compacting ?? false, pendingMessageCount: 0, sessionFile: "/f", sessionId: "s1" } };
      if (command.type === "prompt") return options.promptFails ? { success: false, error: "No API key for provider x" } : { data: { disposition: "started" } };
      return {};
    },
  });
  const live = startLiveSession(
    { handle: worker, clock, logger: silentLogger, publish: (e) => published.push(e), record: (kind, data) => recorded.push([kind, data]), onExit: (e) => exits.push(e) },
    INIT,
  );
  worker.emit({ type: "ready", sessionFile: "/f", sessionId: "s1", piVersion: "1.1.0" });
  return { clock, published, recorded, exits, worker, live };
}
const codeOf = async (promise: Promise<unknown>) => promise.then(() => null, (error: PapError) => error.code);

describe("live session", () => {
  it("sends init first and reports idle on ready", async () => {
    const { worker, live, published } = setup();
    expect(worker.sent[0]?.type).toBe("init");
    expect((await live.ready).sessionId).toBe("s1");
    expect(live.status()).toBe("idle");
    expect(published).toContainEqual({ kind: "status", status: "idle" });
  });

  it("opens a card, forwards the answer once, and answering twice returns not_found", () => {
    const { worker, live, published } = setup();
    worker.emit(confirm);
    expect(published).toContainEqual({ kind: "dialog_open", dialog: { id: "d1", method: "confirm", title: "Run a command?", message: "bash: ls" } });
    live.answer("d1", { confirmed: true });
    expect(worker.sent.at(-1)).toEqual({ type: "extension_ui_response", id: "d1", confirmed: true });
    expect(published.at(-1)).toEqual({ kind: "dialog_closed", id: "d1" });
    expect(() => live.answer("d1", { confirmed: true })).toThrow(expect.objectContaining({ code: "not_found" }));
  });

  it("cancels unknown dialog methods at once", () => {
    const { worker } = setup();
    worker.emit({ ...confirm, id: "x1", method: "custom" });
    expect(worker.sent.at(-1)).toEqual({ type: "extension_ui_response", id: "x1", cancelled: true });
  });

  it("records a run from agent_start to a confirmed agent_settled", async () => {
    const { worker, live, clock, recorded } = setup();
    worker.emit({ type: "pi_event", event: { type: "agent_start" } });
    expect(live.status()).toBe("running");
    worker.emit({ type: "pi_event", event: { type: "agent_settled", aborted: false } });
    await clock.advance(0);
    expect(live.status()).toBe("idle");
    expect(recorded.map(([kind]) => kind)).toEqual(["run_start", "run_end"]);
  });

  it("a crash closes open dialogs and records an interrupted run", async () => {
    const { worker, live, clock, published, recorded, exits } = setup();
    worker.emit(confirm);
    worker.emit({ type: "pi_event", event: { type: "agent_start" } });
    worker.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await clock.advance(0);
    expect(published).toContainEqual({ kind: "dialog_closed", id: "d1" });
    expect(published.at(-1)).toEqual({ kind: "status", status: "cold", cause: "Agent process killed (SIGKILL), possibly out of memory." });
    expect(recorded).toContainEqual(["run_end", { interrupted: "killed" }]);
    expect(live.dialogs()).toEqual([]);
    expect(exits).toHaveLength(1);
  });

  it("terminates the worker when abort meets compaction or no settle within 5 s", async () => {
    const compacting = setup({ compacting: true });
    compacting.worker.emit({ type: "pi_event", event: { type: "agent_start" } });
    await compacting.live.abort();
    expect(compacting.worker.stopped()).toBe(true);
    const stuck = setup();
    stuck.worker.emit({ type: "pi_event", event: { type: "agent_start" } });
    const pending = stuck.live.abort();
    await stuck.clock.advance(5000);
    await pending;
    expect(stuck.worker.stopped()).toBe(true);
  });

  it("maps a rejected prompt to prompt_rejected", async () => {
    const { live } = setup({ promptFails: true });
    expect(await codeOf(live.prompt("go"))).toBe("prompt_rejected");
  });
});
```

`apps/daemon/src/modules/sessions/service.test.ts`:

```ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ALL_PERMISSIONS, type Caller, type PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createFakeWorker, type FakeWorker } from "../../kernel/supervisor/fake-worker.ts";
import { createStreamHub } from "../../kernel/ws/stream-hub.ts";
import { SESSIONS_MIGRATIONS } from "./index.ts";
import { createSessionsService, type SessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";

const owner: Caller = { userId: "u1", permissions: new Set(ALL_PERMISSIONS) };
const stranger: Caller = { userId: "u2", permissions: new Set(ALL_PERMISSIONS) };
let dir: string;
let work: string;
let db: Db;
let clock: FakeClock;
let spawned: FakeWorker[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-sessions-"));
  work = join(dir, "work");
  mkdirSync(work);
  clock = createFakeClock();
  db = migrate({ dbPath: join(dir, "s.db"), backupsDir: join(dir, "b"), sources: [KERNEL_MIGRATIONS, SESSIONS_MIGRATIONS], clock, logger: silentLogger }).db;
  spawned = [];
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function service(limits = { maxWorkers: 4, minFreeMemMb: 0 }, freeMemMb = 4096): SessionsService {
  return createSessionsService({
    store: createSessionsStore(db),
    clock,
    logger: silentLogger,
    hub: createStreamHub("e1"),
    limits,
    worker: { agentDir: "/agent", testProviderScript: null },
    freeMemMb: () => freeMemMb,
    spawn: () => {
      const worker = createFakeWorker({
        onSend: (record, self) => {
          if (record.type !== "init") return;
          const sessionId = record.sessionFile ? basename(record.sessionFile, ".jsonl") : `s${spawned.length}`;
          queueMicrotask(() => self.emit({ type: "ready", sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, piVersion: "1.1.0" }));
        },
        reply: (command) => (command.type === "prompt" ? { data: { disposition: "started" } } : undefined),
      });
      spawned.push(worker);
      return worker;
    },
  });
}
const codeOf = async (promise: Promise<unknown>) => promise.then(() => null, (error: PapError) => error.code);

describe("sessions service", () => {
  it("creates a session in a real folder and lists it as idle", async () => {
    const sessions = service();
    expect(await sessions.create(work, owner)).toEqual({ sessionId: "s1" });
    expect(sessions.list(owner)).toEqual([expect.objectContaining({ id: "s1", cwd: realpathSync(work), status: "idle" })]);
  });

  it("refuses a bad working directory before spawning anything", async () => {
    expect(await codeOf(service().create("relative/path", owner))).toBe("invalid_cwd");
    expect(spawned).toHaveLength(0);
  });

  it("refuses new workers above the cap or under the free-memory floor", async () => {
    const capped = service({ maxWorkers: 1, minFreeMemMb: 0 });
    await capped.create(work, owner);
    expect(await codeOf(capped.create(work, owner))).toBe("capacity");
    expect(await codeOf(service({ maxWorkers: 4, minFreeMemMb: 512 }, 100).create(work, owner))).toBe("capacity");
  });

  it("restarts a cold session once, on its own file, even with concurrent prompts", async () => {
    const sessions = service();
    await sessions.create(work, owner);
    spawned[0]?.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await clock.advance(0);
    await Promise.all([
      sessions.prompt({ sessionId: "s1", text: "one" }, owner),
      sessions.prompt({ sessionId: "s1", text: "two" }, owner),
    ]);
    expect(spawned).toHaveLength(2);
    expect(spawned[1]?.sent[0]).toMatchObject({ type: "init", sessionFile: "/sessions/s1.jsonl" });
  });

  it("hides other users' sessions", async () => {
    const sessions = service();
    await sessions.create(work, owner);
    expect(sessions.list(stranger)).toEqual([]);
    expect(await codeOf(sessions.prompt({ sessionId: "s1", text: "hi" }, stranger))).toBe("not_found");
  });

  it("answers a dialog once; the second answer gets not_found", async () => {
    const sessions = service();
    await sessions.create(work, owner);
    spawned[0]?.emit({ type: "extension_ui_request", id: "d1", method: "confirm", title: "Run?", message: "bash: ls" });
    sessions.respondDialog({ sessionId: "s1", dialogId: "d1", response: { confirmed: true } }, owner);
    expect(() => sessions.respondDialog({ sessionId: "s1", dialogId: "d1", response: { confirmed: true } }, owner)).toThrow(expect.objectContaining({ code: "not_found" }));
  });

  it("snapshots status, open dialogs and the transcript tail", async () => {
    const sessions = service();
    await sessions.create(work, owner);
    spawned[0]?.emit({ type: "extension_ui_request", id: "d1", method: "confirm", title: "Run?", message: "bash: ls" });
    expect(sessions.snapshot("s1")).toEqual({ kind: "snapshot", status: "idle", messages: [], dialogs: [{ id: "d1", method: "confirm", title: "Run?", message: "bash: ls" }] });
  });
});
```

- [ ] **Step 7: Run them to see them fail**

Run: `pnpm test:unit apps/daemon/src/modules/sessions/live-session.test.ts apps/daemon/src/modules/sessions/service.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 8: Write the schema, store, live session, service, rpc and module entry**

`apps/daemon/src/modules/sessions/migrations/202610100200_sessions.sql`:

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL UNIQUE,
  cwd TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX sessions_owner ON sessions(owner_id, updated_at DESC);

CREATE TABLE session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX session_events_session ON session_events(session_id, id);
```

`apps/daemon/src/modules/sessions/store.ts`:

```ts
import type { Db } from "../../kernel/db/database.ts";

export interface SessionRow {
  readonly id: string;
  readonly filePath: string;
  readonly cwd: string;
  readonly ownerId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SessionsStore {
  insert(row: SessionRow): void;
  get(id: string): SessionRow | undefined;
  listByOwner(ownerId: string): SessionRow[];
  touch(id: string, at: number): void;
  appendEvent(sessionId: string, kind: string, data: unknown, at: number): void;
}

const COLUMNS = "id, file_path AS filePath, cwd, owner_id AS ownerId, created_at AS createdAt, updated_at AS updatedAt";

export function createSessionsStore(db: Db): SessionsStore {
  return {
    insert: (row) => {
      db.run(
        "INSERT INTO sessions (id, file_path, cwd, owner_id, created_at, updated_at) VALUES ($id, $filePath, $cwd, $ownerId, $createdAt, $updatedAt)",
        { ...row },
      );
    },
    get: (id) => db.get<SessionRow>(`SELECT ${COLUMNS} FROM sessions WHERE id = $id`, { id }),
    listByOwner: (ownerId) => db.all<SessionRow>(`SELECT ${COLUMNS} FROM sessions WHERE owner_id = $ownerId ORDER BY updated_at DESC`, { ownerId }),
    touch: (id, at) => {
      db.run("UPDATE sessions SET updated_at = $at WHERE id = $id", { id, at });
    },
    appendEvent: (sessionId, kind, data, at) => {
      db.run("INSERT INTO session_events (session_id, kind, data, created_at) VALUES ($sessionId, $kind, $data, $at)", { sessionId, kind, data: JSON.stringify(data ?? null), at });
    },
  };
}
```

`apps/daemon/src/modules/sessions/live-session.ts`:

```ts
import {
  GetStateData,
  PapError,
  type Dialog,
  type DialogResponse,
  type InitRecord,
  type ReadyRecord,
  type SessionStatus,
  type SessionStreamEvent,
  type WorkerRecord,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { describeExit, type WorkerExit } from "../../kernel/supervisor/exit.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import { createDialogRegistry } from "./dialogs.ts";
import { createRunTracker } from "./run-tracker.ts";

const ABORT_SETTLE_MS = 5000;
const GET_STATE_TIMEOUT_MS = 2000;

export interface LiveSessionDeps {
  readonly handle: WorkerHandle;
  readonly clock: Clock;
  readonly logger: Logger;
  publish(event: SessionStreamEvent): void;
  record(kind: string, data: unknown): void;
  onExit(exit: WorkerExit): void;
}

export interface LiveSession {
  readonly ready: Promise<ReadyRecord>;
  status(): SessionStatus;
  rssMb(): number | null;
  pid(): number | undefined;
  dialogs(): Dialog[];
  prompt(text: string, streamingBehavior?: "steer" | "followUp"): Promise<{ disposition: "started" | "queued" | "handled" }>;
  abort(): Promise<void>;
  answer(dialogId: string, response: DialogResponse): void;
  stop(): Promise<void>;
}

export function startLiveSession(deps: LiveSessionDeps, init: InitRecord): LiveSession {
  const { handle } = deps;
  let status: SessionStatus = "starting";
  let rss: number | null = null;
  const dialogs = createDialogRegistry();
  const setStatus = (next: SessionStatus, cause?: string) => {
    status = next;
    deps.publish({ kind: "status", status: next, ...(cause ? { cause } : {}) });
  };
  const getState = async (): Promise<GetStateData> => {
    const response = await handle.request({ type: "get_state" }, GET_STATE_TIMEOUT_MS);
    const parsed = GetStateData.safeParse(response.data);
    if (!response.success || !parsed.success) throw new PapError("worker_failed");
    return parsed.data;
  };
  const tracker = createRunTracker({
    clock: deps.clock,
    probe: getState,
    onRunStart: () => {
      setStatus("running");
      deps.record("run_start", { origin: "user" });
    },
    onRunEnd: ({ aborted }) => {
      setStatus("idle");
      deps.record("run_end", { aborted });
    },
  });
  const ready = new Promise<ReadyRecord>((resolve, reject) => {
    const off = handle.onRecord((record) => {
      if (record.type !== "ready") return;
      off();
      setStatus("idle");
      resolve(record);
    });
    void handle.exited.then(() => reject(new PapError("worker_failed")));
  });
  ready.catch(() => undefined);

  const onRecord = (record: WorkerRecord): void => {
    switch (record.type) {
      case "extension_ui_request": {
        const verdict = dialogs.offer(record);
        if (verdict.kind === "opened") deps.publish({ kind: "dialog_open", dialog: verdict.dialog });
        else if (verdict.kind === "cancel") handle.send({ type: "extension_ui_response", id: record.id, cancelled: true });
        else deps.publish({ kind: "pi", event: record });
        return;
      }
      case "extension_ui_closed":
        if (dialogs.take(record.id)) deps.publish({ kind: "dialog_closed", id: record.id });
        return;
      case "audit":
        deps.record("policy", record.entry);
        return;
      case "health":
        rss = record.rssMb;
        return;
      case "extension_error":
        deps.logger.warn("extension_error", { extensionPath: record.extensionPath, event: record.event });
        deps.publish({ kind: "notice", level: "error", text: `An extension failed during ${record.event}.` });
        return;
      case "pi_event":
        tracker.onEvent(record.event);
        deps.publish({ kind: "pi", event: record.event });
        return;
      case "ready":
      case "response":
        return;
    }
  };
  handle.onRecord(onRecord);
  void handle.exited.then((exit) => {
    const wasRunning = tracker.running;
    tracker.reset();
    for (const dialog of dialogs.clear()) deps.publish({ kind: "dialog_closed", id: dialog.id });
    if (wasRunning) deps.record("run_end", { interrupted: exit.cause });
    deps.record("worker_exit", exit);
    setStatus("cold", describeExit(exit));
    deps.onExit(exit);
  });
  if (!handle.send(init)) deps.logger.warn("worker_init_not_sent");

  return {
    ready,
    status: () => status,
    rssMb: () => rss,
    pid: () => handle.pid,
    dialogs: () => dialogs.list(),
    async prompt(text, streamingBehavior) {
      tracker.onInput();
      const response = await handle.request({ type: "prompt", message: text, ...(streamingBehavior ? { streamingBehavior } : {}) });
      if (!response.success) {
        deps.logger.info("prompt_rejected", { error: response.error });
        throw new PapError("prompt_rejected");
      }
      const disposition = (response.data as { disposition?: unknown } | undefined)?.disposition;
      return { disposition: disposition === "queued" || disposition === "handled" ? disposition : "started" };
    },
    async abort() {
      const state = await getState().catch(() => null);
      if (!state || state.isCompacting) {
        await handle.stop();
        return;
      }
      await handle.request({ type: "abort" }, ABORT_SETTLE_MS).catch(() => undefined);
      if (!(await tracker.waitIdle(ABORT_SETTLE_MS))) await handle.stop();
    },
    answer(dialogId, response) {
      if (!dialogs.take(dialogId)) throw new PapError("not_found");
      handle.send({ type: "extension_ui_response", id: dialogId, ...response });
      deps.publish({ kind: "dialog_closed", id: dialogId });
    },
    stop: async () => {
      await handle.stop();
    },
  };
}
```

`apps/daemon/src/modules/sessions/service.ts`:

```ts
import { PapError, type Caller, type DialogResponse, type PolicyRules, type ReadyRecord, type SessionStreamEvent, type SessionSummary } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import { resolveSessionCwd } from "./cwd.ts";
import { startLiveSession, type LiveSession } from "./live-session.ts";
import type { SessionRow, SessionsStore } from "./store.ts";
import { readTranscriptTail } from "./transcript.ts";

const INTERACTIVE_POLICY: PolicyRules = { profile: "interactive", approvalMode: "auto-accept-edits" };

export interface SessionsServiceDeps {
  readonly store: SessionsStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly hub: StreamHub;
  readonly limits: { readonly maxWorkers: number; readonly minFreeMemMb: number };
  readonly worker: { readonly agentDir: string; readonly testProviderScript: string | null };
  spawn(cwd: string): WorkerHandle;
  freeMemMb(): number;
}

export interface PromptInput {
  readonly sessionId: string;
  readonly text: string;
  readonly streamingBehavior?: "steer" | "followUp" | undefined;
}

export interface SessionsService {
  create(cwd: string, caller: Caller): Promise<{ sessionId: string }>;
  list(caller: Caller): SessionSummary[];
  prompt(input: PromptInput, caller: Caller): Promise<{ disposition: "started" | "queued" | "handled" }>;
  abort(sessionId: string, caller: Caller): Promise<void>;
  respondDialog(input: { sessionId: string; dialogId: string; response: DialogResponse }, caller: Caller): void;
  assertReadable(sessionId: string, caller: Caller): void;
  snapshot(sessionId: string): SessionStreamEvent;
  shutdownAll(): Promise<void>;
  inspect(sessionId: string): { pid: number | undefined; rssMb: number | null } | null;
}

export function createSessionsService(deps: SessionsServiceDeps): SessionsService {
  const live = new Map<string, LiveSession>();
  const launching = new Map<string, Promise<LiveSession>>();

  const checkCapacity = () => {
    if (live.size + launching.size >= deps.limits.maxWorkers || deps.freeMemMb() < deps.limits.minFreeMemMb) throw new PapError("capacity");
  };

  async function launch(cwd: string, sessionFile: string | undefined, knownId: string | undefined): Promise<{ session: LiveSession; ready: ReadyRecord }> {
    checkCapacity();
    const id = { current: knownId ?? null };
    const handle = deps.spawn(cwd);
    const session: LiveSession = startLiveSession(
      {
        handle,
        clock: deps.clock,
        logger: deps.logger.child({ component: "session" }),
        publish: (event) => {
          if (id.current) deps.hub.publish("session", id.current, event);
        },
        record: (kind, data) => {
          if (!id.current) return;
          try {
            deps.store.appendEvent(id.current, kind, data, deps.clock.now());
          } catch (error) {
            deps.logger.warn("session_event_dropped", { kind, err: error });
          }
        },
        onExit: () => {
          if (id.current && live.get(id.current) === session) live.delete(id.current);
        },
      },
      {
        type: "init",
        cwd,
        agentDir: deps.worker.agentDir,
        policy: INTERACTIVE_POLICY,
        ...(sessionFile ? { sessionFile } : {}),
        ...(deps.worker.testProviderScript ? { testProviderScript: deps.worker.testProviderScript } : {}),
      },
    );
    const ready = await session.ready;
    id.current = ready.sessionId;
    return { session, ready };
  }

  async function ensureLive(row: SessionRow): Promise<LiveSession> {
    const current = live.get(row.id);
    if (current) return current;
    const pending = launching.get(row.id);
    if (pending) return pending;
    const starting = (async () => {
      const { session, ready } = await launch(row.cwd, row.filePath, row.id);
      if (ready.sessionId !== row.id) {
        await session.stop();
        throw new PapError("worker_failed");
      }
      live.set(row.id, session);
      return session;
    })();
    launching.set(row.id, starting);
    try {
      return await starting;
    } finally {
      launching.delete(row.id);
    }
  }

  const owned = (sessionId: string, caller: Caller): SessionRow => {
    const row = deps.store.get(sessionId);
    if (!row || row.ownerId !== caller.userId) throw new PapError("not_found");
    return row;
  };

  return {
    async create(cwdInput, caller) {
      const cwd = resolveSessionCwd(cwdInput);
      const { session, ready } = await launch(cwd, undefined, undefined);
      const now = deps.clock.now();
      deps.store.insert({ id: ready.sessionId, filePath: ready.sessionFile, cwd, ownerId: caller.userId, createdAt: now, updatedAt: now });
      live.set(ready.sessionId, session);
      return { sessionId: ready.sessionId };
    },
    list: (caller) =>
      deps.store.listByOwner(caller.userId).map((row) => ({
        id: row.id,
        cwd: row.cwd,
        status: live.get(row.id)?.status() ?? "cold",
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    async prompt(input, caller) {
      const row = owned(input.sessionId, caller);
      const session = await ensureLive(row);
      deps.store.touch(row.id, deps.clock.now());
      return session.prompt(input.text, input.streamingBehavior);
    },
    async abort(sessionId, caller) {
      owned(sessionId, caller);
      await live.get(sessionId)?.abort();
    },
    respondDialog(input, caller) {
      owned(input.sessionId, caller);
      const session = live.get(input.sessionId);
      if (!session) throw new PapError("not_found");
      session.answer(input.dialogId, input.response);
    },
    assertReadable(sessionId, caller) {
      owned(sessionId, caller);
    },
    snapshot(sessionId) {
      const row = deps.store.get(sessionId);
      const session = live.get(sessionId);
      return { kind: "snapshot", status: session?.status() ?? "cold", messages: row ? readTranscriptTail(row.filePath) : [], dialogs: session?.dialogs() ?? [] };
    },
    async shutdownAll() {
      await Promise.allSettled([...live.values()].map((session) => session.stop()));
    },
    inspect(sessionId) {
      const session = live.get(sessionId);
      return session ? { pid: session.pid(), rssMb: session.rssMb() } : null;
    },
  };
}
```

`apps/daemon/src/modules/sessions/rpc.ts`:

```ts
import type { HandlerTable } from "@pap/contracts";
import type { SessionsService } from "./service.ts";

export type SessionsRpc = Pick<HandlerTable, "sessions.create" | "sessions.list" | "sessions.prompt" | "sessions.abort" | "sessions.respondDialog" | "subscribe.session">;

export function sessionsRpc(service: SessionsService): SessionsRpc {
  return {
    "sessions.create": async ({ cwd }, ctx) => service.create(cwd, ctx.caller),
    "sessions.list": async (_params, ctx) => ({ sessions: service.list(ctx.caller) }),
    "sessions.prompt": async (params, ctx) => service.prompt(params, ctx.caller),
    "sessions.abort": async ({ sessionId }, ctx) => {
      await service.abort(sessionId, ctx.caller);
      return { ok: true as const };
    },
    "sessions.respondDialog": async (params, ctx) => {
      service.respondDialog(params, ctx.caller);
      return { ok: true as const };
    },
    "subscribe.session": async ({ sessionId, after }, ctx) => {
      service.assertReadable(sessionId, ctx.caller);
      return { sub: ctx.openSubscription("session", sessionId, after) };
    },
  };
}
```

`apps/daemon/src/modules/sessions/index.ts`:

```ts
import { freemem } from "node:os";
import { fileURLToPath } from "node:url";
import type { Clock } from "../../kernel/clock.ts";
import type { Config } from "../../kernel/config.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { MigrationSource } from "../../kernel/db/migrate.ts";
import type { Logger } from "../../kernel/logger.ts";
import { workerEnv } from "../../kernel/supervisor/env.ts";
import { spawnWorker } from "../../kernel/supervisor/worker.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import { sessionsRpc, type SessionsRpc } from "./rpc.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";

export const SESSIONS_MIGRATIONS: MigrationSource = { module: "sessions", dir: fileURLToPath(new URL("./migrations/", import.meta.url)) };

export interface SessionsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly hub: StreamHub;
  readonly config: Pick<Config, "piAgentDir" | "piHostEntry" | "piHostExecArgv" | "testProviderScript" | "maxWorkers" | "minFreeMemMb">;
  readonly env: NodeJS.ProcessEnv;
}

export interface SessionsModule {
  readonly rpc: SessionsRpc;
  shutdownAll(): Promise<void>;
  inspect(sessionId: string): { pid: number | undefined; rssMb: number | null } | null;
}

export function createSessionsModule(deps: SessionsModuleDeps): SessionsModule {
  const logger = deps.logger.child({ module: "sessions" });
  const service = createSessionsService({
    store: createSessionsStore(deps.db),
    clock: deps.clock,
    logger,
    hub: deps.hub,
    limits: { maxWorkers: deps.config.maxWorkers, minFreeMemMb: deps.config.minFreeMemMb },
    worker: { agentDir: deps.config.piAgentDir, testProviderScript: deps.config.testProviderScript },
    freeMemMb: () => Math.floor(freemem() / 1048576),
    spawn: (cwd) =>
      spawnWorker({
        entry: deps.config.piHostEntry,
        execArgv: deps.config.piHostExecArgv,
        cwd,
        env: workerEnv(deps.env, { PI_CODING_AGENT_DIR: deps.config.piAgentDir }),
        clock: deps.clock,
        logger: logger.child({ component: "worker" }),
      }),
  });
  deps.hub.registerSnapshot("session", (key) => service.snapshot(key));
  return { rpc: sessionsRpc(service), shutdownAll: () => service.shutdownAll(), inspect: (id) => service.inspect(id) };
}
```

- [ ] **Step 9: Run tests and gates**

Run: `pnpm test:unit apps/daemon/src/modules/sessions && pnpm typecheck && pnpm lint && pnpm knip`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/daemon pnpm-lock.yaml
git commit -m "feat(sessions): worker-backed sessions with approvals, run boundaries and snapshots"
```

---

### Task 23: daemon composition, `pap serve`, and the end-to-end integration test with the scripted provider

**Files:**
- Create: `apps/daemon/src/daemon.ts`, `apps/daemon/src/main.ts`
- Create: `apps/daemon/src/testing/free-port.ts`, `http-client.ts`, `ws-client.ts`, `harness.ts`
- Create: `budgets.json`
- Modify: `apps/daemon/package.json` (`@pap/pi-host` dependency), `knip.json` (daemon entry)
- Test: `apps/daemon/src/daemon.int.test.ts`

**Interfaces:**
- Consumes: every kernel piece, `createAuthModule`/`AUTH_MIGRATIONS` (Tasks 17–18), `createSessionsModule`/`SESSIONS_MIGRATIONS` (Task 22).
- Produces:
  - `createDaemon(config, { clock?, logger?, env? }) → Promise<DaemonHandle { url; port; setupUrl; inspect: { workerPid(id); workerRssMb(id) }; stop() }>`
  - CLI `pap serve [--dev] [--host] [--port] [--tls-cert --tls-key]`; JSON log lines `setup_url` (`url` field) and `listening` (`url`, `port`) on stdout — Task 27 parses them
  - `GET /ws?proto=N` (plain GET) answers 426 for an old protocol, 401 without a session, 200 otherwise (the browser cannot read the status of a failed upgrade, Task 25 probes this route)
  - `budgets.json { initialBundleGzipKb, sessionOpenPayloadKb, idleWorkerRssMb }`
  - Test harness `startTestDaemon(script) → { daemon, origin, cwd, root, login(): Promise<cookie>, connect(cookie): Promise<TestClient>, stop() }`

**Spike fallback / S2:** the harness passes no `testProviderScript`; `createDaemon` receives a `spawn` override that returns a `ReplayWorker` (a `WorkerHandle` replaying `apps/daemon/src/testing/fixtures/approval.events.jsonl`, recorded once from a real Pi run). The assertions below stay unchanged.

- [ ] **Step 1: Wire dependencies and budgets**

Run: `pnpm --filter @pap/daemon add "@pap/pi-host@workspace:*"`

`budgets.json`:

```json
{ "initialBundleGzipKb": 180, "sessionOpenPayloadKb": 64, "idleWorkerRssMb": 400 }
```

**Spike fallback / S4:** set `idleWorkerRssMb` to the value computed in `docs/spikes/s4.md` (ceil of baseline idle RSS p95 × 1.2).

In `knip.json`, add `"apps/daemon": { "entry": ["src/main.ts"] }` under `workspaces`.

- [ ] **Step 2: Write the test helpers**

`apps/daemon/src/testing/free-port.ts`:

```ts
import { createServer } from "node:net";

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
```

`apps/daemon/src/testing/http-client.ts` (Node's `fetch` may refuse an explicit `Origin` header; `node:http` does not):

```ts
import { request } from "node:http";

export interface HttpReply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

export function httpRequest(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: init.method ?? "GET", headers: init.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}
```

`apps/daemon/src/testing/ws-client.ts`:

```ts
import { methods, type EventFrame, type MethodName, type ParamsOf, type ResponseFrame } from "@pap/contracts";
import { WebSocket } from "ws";

export interface TestClient {
  readonly events: EventFrame[];
  call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResponseFrame>;
  waitForEvent(predicate: (frame: EventFrame) => boolean, timeoutMs?: number): Promise<EventFrame>;
  close(): void;
}

let commandCounter = 0;

export function connectTestClient(url: string, headers: Record<string, string>): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const events: EventFrame[] = [];
    const pending = new Map<number, (frame: ResponseFrame) => void>();
    const wakers = new Set<() => void>();
    let nextId = 0;
    let greeted = false;
    const client: TestClient = {
      events,
      call(method, params) {
        const id = ++nextId;
        const commandId = methods[method].idempotent ? undefined : `cmd-${process.pid}-${++commandCounter}`;
        return new Promise((done) => {
          pending.set(id, done);
          socket.send(JSON.stringify({ id, method, params, ...(commandId ? { commandId } : {}) }));
        });
      },
      waitForEvent(predicate, timeoutMs = 30_000) {
        return new Promise((done, fail) => {
          const check = () => {
            const hit = events.find(predicate);
            if (!hit) return;
            wakers.delete(check);
            clearTimeout(deadline);
            done(hit);
          };
          const deadline = setTimeout(() => {
            wakers.delete(check);
            fail(new Error(`no matching event; got ${JSON.stringify(events.map((e) => e.event)).slice(0, 2000)}`));
          }, timeoutMs);
          wakers.add(check);
          check();
        });
      },
      close: () => socket.close(),
    };
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      if (!greeted) {
        greeted = true;
        resolve(client);
        return;
      }
      if ("sub" in frame) {
        events.push(frame as unknown as EventFrame);
        for (const wake of [...wakers]) wake();
        return;
      }
      const id = frame.id as number;
      pending.get(id)?.(frame as unknown as ResponseFrame);
      pending.delete(id);
    });
    socket.on("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    socket.on("error", reject);
  });
}
```

`apps/daemon/src/testing/harness.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDaemon, type DaemonHandle } from "../daemon.ts";
import type { Config } from "../kernel/config.ts";
import { silentLogger } from "../kernel/logger.ts";
import { freePort } from "./free-port.ts";
import { httpRequest } from "./http-client.ts";
import { connectTestClient, type TestClient } from "./ws-client.ts";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

export interface TestDaemon {
  readonly daemon: DaemonHandle;
  readonly origin: string;
  readonly cwd: string;
  readonly root: string;
  login(): Promise<string>;
  connect(cookie: string): Promise<TestClient>;
  stop(): Promise<void>;
}

export async function startTestDaemon(script: object): Promise<TestDaemon> {
  const root = mkdtempSync(join(tmpdir(), "pap-int-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  mkdirSync(agentDir);
  mkdirSync(cwd);
  const scriptPath = join(root, "script.json");
  writeFileSync(scriptPath, JSON.stringify(script));
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const config: Config = {
    home: join(root, "home"),
    host: "127.0.0.1",
    port,
    dev: false,
    tls: null,
    publicOrigin: origin,
    allowedOrigins: new Set([origin, `http://127.0.0.1:${port}`]),
    piAgentDir: agentDir,
    piHostEntry: join(REPO, "packages/pi-host/src/main.ts"),
    piHostExecArgv: ["--conditions=development", "--import", join(REPO, "packages/pi-host/src/testing/network-guard.ts")],
    testProviderScript: scriptPath,
    maxWorkers: 4,
    minFreeMemMb: 0,
    staticRoot: null,
    logLevel: "warn",
  };
  const daemon = await createDaemon(config, { env: { ...process.env, PI_OFFLINE: "1" }, logger: silentLogger });
  return {
    daemon,
    origin,
    cwd,
    root,
    async login() {
      const token = new URL(daemon.setupUrl ?? "http://invalid").hash.replace("#token=", "");
      const reply = await httpRequest(`http://127.0.0.1:${port}/auth/setup`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ token, username: "owner", password: "correct horse battery staple" }),
      });
      if (reply.status !== 201) throw new Error(`setup failed: ${reply.status} ${reply.body}`);
      const header = reply.headers["set-cookie"];
      return ((Array.isArray(header) ? header[0] : header) ?? "").split(";")[0] ?? "";
    },
    connect: (cookie) => connectTestClient(`ws://127.0.0.1:${port}/ws?proto=1`, { origin, cookie }),
    async stop() {
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
```

- [ ] **Step 3: Write the failing integration test**

`apps/daemon/src/daemon.int.test.ts`:

```ts
import { readFileSync } from "node:fs";
import type { EventFrame } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";
import type { TestClient } from "./testing/ws-client.ts";

const budgets = JSON.parse(readFileSync(new URL("../../../budgets.json", import.meta.url), "utf8")) as { sessionOpenPayloadKb: number; idleWorkerRssMb: number };
const SCRIPT = {
  steps: [
    { toolCalls: [{ name: "bash", args: { command: "echo pap-int-ok" }, id: "call-1" }] },
    { text: "The command printed pap-int-ok." },
  ],
};

type StreamEvent = { kind?: string; status?: string; cause?: string; dialog?: { id: string; message?: string }; event?: { type?: string; isError?: boolean } };
const ev = (frame: EventFrame) => frame.event as StreamEvent;
const kind = (k: string) => (frame: EventFrame) => ev(frame).kind === k;
const pi = (type: string) => (frame: EventFrame) => ev(frame).kind === "pi" && ev(frame).event?.type === type;
const statusIs = (status: string, after = -1) => (frame: EventFrame) => kind("status")(frame) && ev(frame).status === status && frame.seq > after;

let t: TestDaemon;
beforeEach(async () => { t = await startTestDaemon(SCRIPT); });
afterEach(async () => { await t.stop(); });

async function openSession(): Promise<{ client: TestClient; sessionId: string; cookie: string }> {
  const cookie = await t.login();
  const client = await t.connect(cookie);
  const created = await client.call("sessions.create", { cwd: t.cwd });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const sessionId = (created.result as { sessionId: string }).sessionId;
  expect((await client.call("subscribe.session", { sessionId })).ok).toBe(true);
  return { client, sessionId, cookie };
}

async function promptAndApprove(client: TestClient, sessionId: string, confirmed: boolean, after = -1): Promise<EventFrame> {
  expect(await client.call("sessions.prompt", { sessionId, text: "Run the check" })).toMatchObject({ ok: true, result: { disposition: "started" } });
  const open = await client.waitForEvent((f) => kind("dialog_open")(f) && f.seq > after);
  expect(ev(open).dialog?.message).toContain("echo pap-int-ok");
  expect(await client.call("sessions.respondDialog", { sessionId, dialogId: ev(open).dialog?.id ?? "", response: { confirmed } })).toMatchObject({ ok: true });
  return open;
}

describe("pap daemon end to end (scripted provider)", () => {
  it("prompt → approval card → result, within the session-open and idle-RAM budgets", async () => {
    const { client, sessionId } = await openSession();
    const snapshot = await client.waitForEvent(kind("snapshot"));
    expect(Buffer.byteLength(JSON.stringify(snapshot)) / 1024).toBeLessThan(budgets.sessionOpenPayloadKb);
    const open = await promptAndApprove(client, sessionId, true);
    const toolEnd = await client.waitForEvent(pi("tool_execution_end"));
    expect(JSON.stringify(toolEnd.event)).toContain("pap-int-ok");
    await client.waitForEvent(statusIs("idle", open.seq));
    expect(client.events.some((f) => pi("message_end")(f) && JSON.stringify(f.event).includes("The command printed pap-int-ok."))).toBe(true);
    expect(t.daemon.inspect.workerRssMb(sessionId) ?? Number.POSITIVE_INFINITY).toBeLessThan(budgets.idleWorkerRssMb);
    client.close();
  });

  it("a denied call reaches the model as an error", async () => {
    const { client, sessionId } = await openSession();
    await promptAndApprove(client, sessionId, false);
    const toolEnd = await client.waitForEvent(pi("tool_execution_end"));
    expect(ev(toolEnd).event?.isError).toBe(true);
    expect(JSON.stringify(toolEnd.event)).toContain("Denied by the user.");
    client.close();
  });

  it("resumes a second connection from a cursor without a snapshot", async () => {
    const { client, sessionId, cookie } = await openSession();
    const open = await promptAndApprove(client, sessionId, true);
    await client.waitForEvent(statusIs("idle", open.seq));
    const middle = client.events[Math.floor(client.events.length / 2)];
    if (!middle) throw new Error("no events");
    const second = await t.connect(cookie);
    expect((await second.call("subscribe.session", { sessionId, after: { epoch: middle.epoch, seq: middle.seq } })).ok).toBe(true);
    const first = await second.waitForEvent(() => true);
    expect(first.seq).toBe(middle.seq + 1);
    expect(kind("snapshot")(first)).toBe(false);
    second.close();
    client.close();
  });

  it("worker killed with an open approval card: card closed, cause shown, next prompt restarts on the same file", async () => {
    const { client, sessionId } = await openSession();
    expect(await client.call("sessions.prompt", { sessionId, text: "Run the check" })).toMatchObject({ ok: true });
    const open = await client.waitForEvent(kind("dialog_open"));
    const firstPid = t.daemon.inspect.workerPid(sessionId);
    process.kill(-(firstPid ?? 0), "SIGKILL");
    await client.waitForEvent((f) => kind("dialog_closed")(f) && f.seq > open.seq);
    const cold = await client.waitForEvent(statusIs("cold", open.seq));
    expect(ev(cold).cause).toContain("SIGKILL");
    await promptAndApprove(client, sessionId, true, cold.seq);
    await client.waitForEvent((f) => pi("message_end")(f) && f.seq > cold.seq && JSON.stringify(f.event).includes("The command printed"));
    expect(t.daemon.inspect.workerPid(sessionId)).not.toBe(firstPid);
    client.close();
  });
});
```

- [ ] **Step 4: Run it to see it fail**

Run: `pnpm test:int apps/daemon/src/daemon.int.test.ts`
Expected: FAIL (`daemon.ts` not found).

- [ ] **Step 5: Write the composition root and the CLI**

`apps/daemon/src/daemon.ts`:

```ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION, type HandlerTable } from "@pap/contracts";
import type { Context } from "hono";
import { createSystemClock, type Clock } from "./kernel/clock.ts";
import type { Config } from "./kernel/config.ts";
import { ensureInstallTimestamp } from "./kernel/db/meta.ts";
import { KERNEL_MIGRATIONS, migrate } from "./kernel/db/migrate.ts";
import { createReceiptStore } from "./kernel/db/receipts.ts";
import { createHttpApp } from "./kernel/http/app.ts";
import { startServer } from "./kernel/http/server.ts";
import { createLogger, type Logger } from "./kernel/logger.ts";
import { VERSION } from "./kernel/version.ts";
import { createDispatcher } from "./kernel/ws/dispatcher.ts";
import { createStreamHub } from "./kernel/ws/stream-hub.ts";
import { systemHandlers } from "./kernel/ws/system-handlers.ts";
import { createWsServer } from "./kernel/ws/ws-server.ts";
import { AUTH_MIGRATIONS, createAuthModule } from "./modules/auth/index.ts";
import { createSessionsModule, SESSIONS_MIGRATIONS } from "./modules/sessions/index.ts";

export interface DaemonHandle {
  readonly url: string;
  readonly port: number;
  readonly setupUrl: string | null;
  readonly inspect: { workerPid(sessionId: string): number | undefined; workerRssMb(sessionId: string): number | null };
  stop(): Promise<void>;
}

export interface DaemonDeps {
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly env?: NodeJS.ProcessEnv;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export async function createDaemon(config: Config, deps: DaemonDeps = {}): Promise<DaemonHandle> {
  const clock = deps.clock ?? createSystemClock();
  const logger = deps.logger ?? createLogger({ level: config.logLevel, clock, write: (line) => process.stdout.write(line) });
  for (const dir of [config.home, join(config.home, "logs"), join(config.home, "backups")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { db, readOnly } = migrate({
    dbPath: join(config.home, "state.db"),
    backupsDir: join(config.home, "backups"),
    sources: [KERNEL_MIGRATIONS, AUTH_MIGRATIONS, SESSIONS_MIGRATIONS],
    clock,
    logger,
  });
  ensureInstallTimestamp(db, clock);
  if (readOnly) logger.warn("read_only_mode", { hint: "This database was written by a newer pap. Upgrade pap or restore a backup." });
  if (config.testProviderScript) logger.warn("test_provider_enabled", { script: config.testProviderScript });

  const hub = createStreamHub();
  const auth = createAuthModule({ db, clock, logger, publicOrigin: config.publicOrigin, allowedOrigins: config.allowedOrigins });
  const sessions = createSessionsModule({ db, clock, logger, hub, config, env: deps.env ?? process.env });
  const handlers: HandlerTable = { ...systemHandlers(clock), ...sessions.rpc };
  const dispatch = createDispatcher({ handlers, receipts: createReceiptStore(db, clock), logger });
  const ws = createWsServer({
    allowedOrigins: config.allowedOrigins,
    authenticate: (req) => auth.authenticateCookieHeader(req.headers.cookie),
    dispatch,
    hub,
    logger,
    clock,
    serverVersion: VERSION,
  });
  const wsProbe = (c: Context) => {
    if (c.req.query("proto") !== String(PROTOCOL_VERSION)) return c.json({ protocol: PROTOCOL_VERSION }, 426);
    if (!auth.authenticateCookieHeader(c.req.header("cookie"))) return c.json({ error: { code: "unauthenticated" } }, 401);
    return c.json({ protocol: PROTOCOL_VERSION });
  };
  const app = createHttpApp({ allowedOrigins: config.allowedOrigins, staticRoot: config.staticRoot, logger, mount: (a) => auth.mount(a), wsProbe });
  const server = await startServer({ app, host: config.host, port: config.port, tls: config.tls, onUpgrade: (req, socket, head) => ws.handleUpgrade(req, socket, head) });

  const setupUrl = auth.setupUrl();
  if (setupUrl) logger.info("setup_url", { url: setupUrl, hint: "Open this URL once to create the owner account." });
  if (!LOOPBACK.has(config.host) && !config.tls) logger.warn("plain_http_on_network", { hint: "Passkeys, secure cookies and Web Push need HTTPS: use Tailscale serve, a reverse proxy or --tls-cert/--tls-key." });
  logger.info("listening", { url: config.publicOrigin, host: config.host, port: server.port });

  let stopped = false;
  return {
    url: config.publicOrigin,
    port: server.port,
    setupUrl,
    inspect: {
      workerPid: (id) => sessions.inspect(id)?.pid,
      workerRssMb: (id) => sessions.inspect(id)?.rssMb ?? null,
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await sessions.shutdownAll();
      ws.close();
      await server.close();
      db.close();
    },
  };
}
```

`apps/daemon/src/main.ts`:

```ts
#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDaemon } from "./daemon.ts";
import { ConfigError, loadConfig, type Config } from "./kernel/config.ts";

const USAGE = "usage: pap serve [--dev] [--host <address>] [--port <port>] [--tls-cert <file> --tls-key <file>]\n";

function readConfig(argv: string[]): Config | null {
  const require = createRequire(import.meta.url);
  const webDist = fileURLToPath(new URL("../../web/dist/", import.meta.url));
  try {
    return loadConfig({
      argv,
      env: process.env,
      cwd: process.cwd(),
      homedir: homedir(),
      totalMemMb: Math.floor(totalmem() / 1048576),
      piHostEntry: require.resolve("@pap/pi-host"),
      piHostExecArgv: process.execArgv.filter((arg) => arg.startsWith("--conditions")),
      staticRoot: existsSync(join(webDist, "index.html")) ? webDist : null,
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (error instanceof ConfigError || code?.startsWith("ERR_PARSE_ARGS")) {
      process.stderr.write(`pap: ${(error as Error).message}\n${USAGE}`);
      return null;
    }
    throw error;
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command !== "serve") {
  process.stderr.write(USAGE);
  process.exitCode = 64;
} else {
  const config = readConfig(rest);
  if (!config) {
    process.exitCode = 64;
  } else {
    const daemon = await createDaemon(config);
    const shutdown = () => {
      void daemon.stop().finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
}
```

- [ ] **Step 6: Run the integration test, then the whole suite**

Run: `pnpm test:int apps/daemon/src/daemon.int.test.ts`
Expected: PASS (4 tests).
Run: `pnpm test:unit && pnpm test:int && pnpm typecheck && pnpm lint && pnpm knip`
Expected: PASS.

- [ ] **Step 7: Smoke-run the CLI against a throwaway home**

Run: `PAP_HOME=$(mktemp -d) PI_CODING_AGENT_DIR=$(mktemp -d) timeout 5 node --conditions=development apps/daemon/src/main.ts serve --port 7799 | head -n 5`
Expected: JSON lines containing `"msg":"setup_url"` with `"url":"http://localhost:7799/setup#token=` and `"msg":"listening"`. `node apps/daemon/src/main.ts serve --port 0` prints `pap: invalid port 0` and the usage line.

- [ ] **Step 8: Commit**

```bash
git add apps/daemon budgets.json knip.json pnpm-lock.yaml
git commit -m "feat(daemon): pap serve composition with end-to-end scripted-provider integration test"
```

---

### Task 24: `packages/ui` — E1 tokens (DESIGN.md subset), owned primitives, Message and ApprovalCard

**Files:**
- Create: `packages/ui/package.json`, `packages/ui/tsconfig.json`
- Create: `packages/ui/src/tokens.css`, `cn.ts`, `once.ts`, `index.ts`, `primitives/Button.tsx`, `primitives/TextField.tsx`, `ai/Message.tsx`, `ai/ApprovalCard.tsx`
- Test: `packages/ui/src/tokens.test.ts`, `once.test.ts`, `ai/ApprovalCard.test.tsx`

**Interfaces:**
- Produces (`@pap/ui`): `Button({ variant?: "primary" | "secondary" | "danger", …button props without className/style })`, `TextField({ label, value, onChange(value), type?, hint?, error?, multiline?, name?, autoComplete?, disabled?, onSubmitShortcut? })`, `Message({ author: "agent" | "you" | "tool", label, children })`, `ApprovalCard({ title, detail, allowLabel, denyLabel, onAnswer(approved) })` (answers once), `once(fn)`, `cn(...parts)`; CSS `@pap/ui/tokens.css` defining Tailwind theme tokens `bg panel line fg muted agent agent-fill human human-fill on-fill attention ok error`, font sizes `label ui chat`, radii `sm`(2px) `md`(3px), fonts `sans` (Manrope) and `mono` (JetBrains Mono).
- The tokens are a subset of DESIGN.md §3.1–3.2 (validated): same values, M1 names. The full DESIGN.md token schema (names, high-contrast theme, densities) replaces them in roadmap M3.

- [ ] **Step 1: Create the package**

`packages/ui/package.json`:

```json
{
  "name": "@pap/ui",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts", "./tokens.css": "./src/tokens.css" },
  "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" },
  "peerDependencies": { "react": "^19" }
}
```

`packages/ui/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "lib": ["es2023", "dom", "dom.iterable"],
    "types": ["node"],
    "jsx": "react-jsx",
    "module": "esnext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true
  },
  "include": ["src"]
}
```

Run: `pnpm --filter @pap/ui add -D -E react react-dom @types/react @types/react-dom`

- [ ] **Step 2: Write the failing tests**

`packages/ui/src/once.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { once } from "./once.ts";

describe("once", () => {
  it("runs the callback for the first call only", () => {
    const spy = vi.fn();
    const answer = once(spy);
    expect(answer(true)).toBe(true);
    expect(answer(false)).toBe(false);
    expect(spy).toHaveBeenCalledExactlyOnceWith(true);
  });
});
```

`packages/ui/src/tokens.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

describe("E1 tokens", () => {
  it("defines every themed variable for night, system-light and day", () => {
    const names = [...css.matchAll(/var\(--pap-([a-z-]+)\)/g)].map((match) => match[1]);
    expect(names.length).toBeGreaterThan(10);
    for (const name of new Set(names)) expect(css.split(`--pap-${name}:`).length - 1, name).toBe(3);
  });

  it("keeps the decision 11 role colours", () => {
    for (const hex of ["#110f18", "#a78bfa", "#fb923c", "#ec4899", "#faf9f6", "#6d28d9", "#c2410c", "#be185d"]) expect(css.toLowerCase()).toContain(hex);
  });
});
```

`packages/ui/src/ai/ApprovalCard.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApprovalCard } from "./ApprovalCard.tsx";

describe("ApprovalCard", () => {
  it("renders an accessible alertdialog with the request and both answers", () => {
    const html = renderToStaticMarkup(
      <ApprovalCard title="Approval needed" detail={"Run a command?\nbash: echo hi"} allowLabel="Allow once" denyLabel="Deny" onAnswer={() => {}} />,
    );
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-label="Approval needed"');
    expect(html).toContain("bash: echo hi");
    expect(html).toContain(">Allow once<");
    expect(html).toContain(">Deny<");
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm test:unit packages/ui`
Expected: FAIL (modules not found).

- [ ] **Step 4: Write tokens and helpers**

`packages/ui/src/tokens.css`:

```css
/* E1 tokens: a subset of DESIGN.md §3.1–3.2 (validated, decision 33). The full token schema
   (DESIGN.md names, high-contrast theme, densities) lands in roadmap M3. */
@theme inline {
  --color-bg: var(--pap-bg);
  --color-panel: var(--pap-panel);
  --color-line: var(--pap-line);
  --color-fg: var(--pap-fg);
  --color-muted: var(--pap-muted);
  --color-agent: var(--pap-agent);
  --color-agent-fill: var(--pap-agent-fill);
  --color-human: var(--pap-human);
  --color-human-fill: var(--pap-human-fill);
  --color-on-fill: var(--pap-on-fill);
  --color-attention: var(--pap-attention);
  --color-ok: var(--pap-ok);
  --color-error: var(--pap-error);
  --font-sans: "Manrope", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --text-label: 0.6875rem;
  --text-ui: 0.8125rem;
  --text-chat: 0.875rem;
  --radius-sm: 2px;
  --radius-md: 3px;
}

:root,
[data-theme="night"] {
  color-scheme: dark;
  --pap-bg: #110f18;
  --pap-panel: #1a1724;
  --pap-line: #2d2840;
  --pap-fg: #f2effa;
  --pap-muted: #9c95b5;
  --pap-agent: #a78bfa;
  --pap-agent-fill: #a78bfa;
  --pap-human: #fb923c;
  --pap-human-fill: #fb923c;
  --pap-on-fill: #110f18;
  --pap-attention: #ec4899;
  --pap-ok: #34d399;
  --pap-error: #f87171;
}

@media (prefers-color-scheme: light) {
  :root:not([data-theme="night"]) {
    color-scheme: light;
    --pap-bg: #faf9f6;
    --pap-panel: #f3f1ec;
    --pap-line: #e2ded5;
    --pap-fg: #1c1917;
    --pap-muted: #6b645a;
    --pap-agent: #6d28d9;
    --pap-agent-fill: #7c3aed;
    --pap-human: #c2410c;
    --pap-human-fill: #fb923c;
    --pap-on-fill: #1c1917;
    --pap-attention: #be185d;
    --pap-ok: #047857;
    --pap-error: #dc2626;
  }
}

[data-theme="day"] {
  color-scheme: light;
  --pap-bg: #faf9f6;
  --pap-panel: #f3f1ec;
  --pap-line: #e2ded5;
  --pap-fg: #1c1917;
  --pap-muted: #6b645a;
  --pap-agent: #6d28d9;
  --pap-agent-fill: #7c3aed;
  --pap-human: #c2410c;
  --pap-human-fill: #fb923c;
  --pap-on-fill: #1c1917;
  --pap-attention: #be185d;
  --pap-ok: #047857;
  --pap-error: #dc2626;
}
```

`packages/ui/src/cn.ts`:

```ts
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
```

`packages/ui/src/once.ts`:

```ts
export function once<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => boolean {
  let done = false;
  return (...args) => {
    if (done) return false;
    done = true;
    fn(...args);
    return true;
  };
}
```

- [ ] **Step 5: Write the primitives and AI components**

`packages/ui/src/primitives/Button.tsx` (26 px controls per decision 27, 44 px touch targets on coarse pointers, orange focus ring):

```tsx
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../cn.ts";

type Variant = "primary" | "secondary" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-human-fill text-on-fill hover:opacity-90",
  secondary: "border border-line bg-panel text-fg hover:border-muted",
  danger: "border border-attention bg-bg text-attention hover:bg-panel",
};

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style"> {
  readonly variant?: Variant;
}

export function Button({ variant = "secondary", type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex h-6.5 items-center justify-center rounded-sm px-3 font-sans text-ui font-semibold pointer-coarse:min-h-11",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-human disabled:cursor-not-allowed disabled:opacity-50",
        VARIANTS[variant],
      )}
      {...rest}
    />
  );
}
```

`packages/ui/src/primitives/TextField.tsx`:

```tsx
import { useId } from "react";

export interface TextFieldProps {
  readonly label: string;
  readonly value: string;
  onChange(value: string): void;
  readonly type?: "text" | "password";
  readonly hint?: string;
  readonly error?: string | null;
  readonly multiline?: boolean;
  readonly name?: string;
  readonly autoComplete?: string;
  readonly disabled?: boolean;
  onSubmitShortcut?(): void;
}

const FIELD = "w-full rounded-sm border border-line bg-bg px-2 py-1 font-sans text-chat text-fg focus-visible:outline-2 focus-visible:outline-human";

export function TextField(props: TextFieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = props.error ?? props.hint;
  const shared = {
    id,
    name: props.name,
    value: props.value,
    disabled: props.disabled,
    autoComplete: props.autoComplete,
    "aria-describedby": note ? noteId : undefined,
    "aria-invalid": props.error ? true : undefined,
    className: FIELD,
  };
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-mono text-label uppercase tracking-wider text-muted">
        {props.label}
      </label>
      {props.multiline ? (
        <textarea
          {...shared}
          rows={3}
          onChange={(event) => props.onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) props.onSubmitShortcut?.();
          }}
        />
      ) : (
        <input {...shared} type={props.type ?? "text"} onChange={(event) => props.onChange(event.target.value)} />
      )}
      {note ? (
        <p id={noteId} className={props.error ? "text-ui text-attention" : "text-ui text-muted"}>
          {note}
        </p>
      ) : null}
    </div>
  );
}
```

`packages/ui/src/ai/Message.tsx` (2 px author rule: violet agent, orange you; decision 11):

```tsx
import type { ReactNode } from "react";
import { cn } from "../cn.ts";

export type Author = "agent" | "you" | "tool";

const RULE: Record<Author, string> = { agent: "border-agent", you: "border-human", tool: "border-line" };

export interface MessageProps {
  readonly author: Author;
  readonly label: string;
  readonly children: ReactNode;
}

export function Message({ author, label, children }: MessageProps) {
  return (
    <article data-author={author} className={cn("border-l-2 bg-bg px-3 py-2", RULE[author])}>
      <header className="font-mono text-label uppercase tracking-wider text-muted">{label}</header>
      <div className="mt-1 whitespace-pre-wrap break-words text-chat text-fg">{children}</div>
    </article>
  );
}
```

`packages/ui/src/ai/ApprovalCard.tsx` (pink = waiting for you; answers once so a double click or a second tab cannot send two answers from this card):

```tsx
import { useState } from "react";
import { once } from "../once.ts";
import { Button } from "../primitives/Button.tsx";

export interface ApprovalCardProps {
  readonly title: string;
  readonly detail: string;
  readonly allowLabel: string;
  readonly denyLabel: string;
  onAnswer(approved: boolean): void;
}

export function ApprovalCard(props: ApprovalCardProps) {
  const [answered, setAnswered] = useState(false);
  const [answer] = useState(() =>
    once((approved: boolean) => {
      setAnswered(true);
      props.onAnswer(approved);
    }),
  );
  return (
    <section role="alertdialog" aria-label={props.title} className="rounded-sm border border-attention bg-panel p-3">
      <h3 className="font-mono text-label uppercase tracking-wider text-attention">{props.title}</h3>
      <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-ui text-fg">{props.detail}</pre>
      <div className="mt-3 flex gap-2">
        <Button variant="primary" disabled={answered} onClick={() => answer(true)}>
          {props.allowLabel}
        </Button>
        <Button variant="secondary" disabled={answered} onClick={() => answer(false)}>
          {props.denyLabel}
        </Button>
      </div>
    </section>
  );
}
```

`packages/ui/src/index.ts`:

```ts
export { ApprovalCard, type ApprovalCardProps } from "./ai/ApprovalCard.tsx";
export { Message, type Author, type MessageProps } from "./ai/Message.tsx";
export { cn } from "./cn.ts";
export { once } from "./once.ts";
export { Button, type ButtonProps } from "./primitives/Button.tsx";
export { TextField, type TextFieldProps } from "./primitives/TextField.tsx";
```

- [ ] **Step 6: Run tests and gates**

Run: `pnpm test:unit packages/ui && pnpm typecheck && pnpm lint`
Expected: PASS; the design rules report nothing (only token classes, no raw colours outside `tokens.css`).

- [ ] **Step 7: Commit**

```bash
git add packages/ui pnpm-lock.yaml
git commit -m "feat(ui): E1 tokens from DESIGN.md, owned primitives and approval card"
```

---

### Task 25: web runtime — connection supervisor, typed RPC proxy, subscriptions with cursors

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`
- Create: `apps/web/src/runtime/connection.ts`, `rpc.ts`, `subscriptions.ts`, `http.ts`, `random-id.ts`, `use-connection-state.ts`, `index.ts`, `testing.ts`
- Modify: `knip.json` (temporary web entry `src/runtime/index.ts` until Task 26 adds `src/main.tsx`)
- Test: `apps/web/src/runtime/connection.test.ts`, `rpc.test.ts`, `subscriptions.test.ts`

**Interfaces:**
- Consumes: contracts (`methods`, frames, `ParamsOf`, `ResultOf`, `PROTOCOL_VERSION`, `MAX_FRAME_BYTES`), `GET /ws?proto=1` probe (Task 23).
- Produces (`apps/web/src/runtime/index.ts`):
  - `getRuntime() → { connection, rpc, subscriptions }` (one per tab; the only code touching the socket)
  - `createConnection({ url, createSocket, probe, timers, random }) → Connection { state; start(); stop(); send(frame); onFrame(l); onState(l); nudge() }`; states `idle | connecting | open | waiting | outdated | signed-out`; jittered backoff `min(30 s, 0.5 s·2^n)·(0.5–1)`, reset after 10 s stable; a peer silent for 15 s is closed; the probe decides between retry, "new version, reload" and sign-in
  - `createRpcClient(connection, { newCommandId, timers }) → { call(method, params) }`; mutations get a `commandId`; pending calls are rejected (never replayed) when the connection drops; `system.ping` every 5 s while open; `RpcError { code }` with client codes `offline`, `connection_lost`, `payload_too_large`
  - `createSubscriptions(connection, rpc, timers) → { subscribe("session", key, onEvent): unsubscribe }`; keeps `{epoch, seq}` and resubscribes with `after` on reconnect; keeps a cursor 5 minutes after the last listener leaves
  - `useConnectionState(connection)`, `probeServer()`, `getJson(path)`, `postJson(path, body)`, `randomId()` (uses `crypto.getRandomValues`, which works in non-secure contexts such as `http://<LAN IP>`)

- [ ] **Step 1: Create the web package**

`apps/web/package.json`:

```json
{
  "name": "@pap/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "browserslist": ["chrome 111", "edge 111", "firefox 111", "safari 16.4", "ios_saf 16.4"],
  "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" },
  "dependencies": { "@pap/contracts": "workspace:*" }
}
```

`apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "lib": ["es2023", "dom", "dom.iterable"],
    "types": ["node", "vite/client"],
    "jsx": "react-jsx",
    "module": "esnext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "customConditions": ["development"]
  },
  "include": ["src", "vite.config.ts", "browser-targets.ts"]
}
```

Run: `pnpm --filter @pap/web add -E react react-dom && pnpm --filter @pap/web add -D -E @types/react @types/react-dom vite`

In `knip.json`, add `"apps/web": { "entry": ["src/runtime/index.ts"] }` under `workspaces` (Task 26 replaces it with the app entry).

- [ ] **Step 2: Write the failing connection test**

`apps/web/src/runtime/connection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { backoffDelay, createConnection, type ProbeResult, type SocketLike } from "./connection.ts";

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string) { this.sent.push(data); }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

function setup(probe: ProbeResult = "ok") {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const sockets: FakeSocket[] = [];
  const connection = createConnection({
    url: "ws://localhost/ws?proto=1",
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    probe: async () => probe,
    timers: { set: (fn, ms) => { pending.set(nextId, { at: now + ms, fn }); return nextId++; }, clear: (id) => { pending.delete(id); } },
    random: () => 0.5,
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= now && pending.has(id)) {
        pending.delete(id);
        timer.fn();
      }
    }
  };
  const latest = () => sockets[sockets.length - 1] as FakeSocket;
  const hello = (protocol = 1) => latest().receive({ protocol, capabilities: ["rpc"], serverVersion: "0.0.0" });
  return { connection, sockets, advance, latest, hello, delays: () => [...pending.values()].map((t) => t.at - now) };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("connection supervisor", () => {
  it("opens after a matching hello and forwards later frames", () => {
    const { connection, hello, latest } = setup();
    const frames: unknown[] = [];
    connection.onFrame((frame) => frames.push(frame));
    connection.start();
    expect(connection.state).toBe("connecting");
    hello();
    expect(connection.state).toBe("open");
    latest().receive({ id: 1, ok: true, result: {} });
    expect(frames).toEqual([{ id: 1, ok: true, result: {} }]);
  });

  it("marks the tab outdated on a hello from another protocol version", () => {
    const { connection, hello } = setup();
    connection.start();
    hello(2);
    expect(connection.state).toBe("outdated");
  });

  it("probes after a drop, then retries with jittered backoff capped at 30 s", async () => {
    const { connection, hello, latest, delays, advance } = setup();
    connection.start();
    hello();
    for (let attempt = 0; attempt < 8; attempt++) {
      latest().close();
      await flush();
      expect(connection.state).toBe("waiting");
      expect(delays()).toContain(backoffDelay(attempt, 0.5));
      advance(backoffDelay(attempt, 0.5));
    }
    expect(backoffDelay(10, 1)).toBe(30_000);
  });

  it("stops retrying when the probe says signed-out or outdated", async () => {
    const signedOut = setup("signed-out");
    signedOut.connection.start();
    signedOut.latest().close();
    await flush();
    expect(signedOut.connection.state).toBe("signed-out");
    expect(signedOut.delays()).toEqual([]);
    const outdated = setup("outdated");
    outdated.connection.start();
    outdated.latest().close();
    await flush();
    expect(outdated.connection.state).toBe("outdated");
  });

  it("closes a peer silent for 15 s, and nudge reconnects at once while waiting", async () => {
    const { connection, hello, sockets, advance } = setup();
    connection.start();
    hello();
    advance(15_000);
    await flush();
    expect(connection.state).toBe("waiting");
    connection.nudge();
    await flush();
    expect(sockets).toHaveLength(2);
    expect(connection.state).toBe("connecting");
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm test:unit apps/web/src/runtime/connection.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Write the connection supervisor**

`apps/web/src/runtime/connection.ts`:

```ts
import { HelloFrame, PROTOCOL_VERSION } from "@pap/contracts";

export type ConnectionState = "idle" | "connecting" | "open" | "waiting" | "outdated" | "signed-out";
export type ProbeResult = "ok" | "outdated" | "signed-out" | "offline";

export interface SocketLike {
  send(data: string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface Timers {
  set(fn: () => void, ms: number): number;
  clear(id: number): void;
}

export interface ConnectionDeps {
  readonly url: string;
  createSocket(url: string): SocketLike;
  probe(): Promise<ProbeResult>;
  readonly timers: Timers;
  random(): number;
}

export interface Connection {
  readonly state: ConnectionState;
  start(): void;
  stop(): void;
  send(frame: object): boolean;
  onFrame(listener: (frame: unknown) => void): () => void;
  onState(listener: (state: ConnectionState) => void): () => void;
  nudge(): void;
}

const DEAD_AFTER_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;
const STABLE_AFTER_MS = 10_000;

export function backoffDelay(attempt: number, random: number): number {
  return Math.round(Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt) * (0.5 + random / 2));
}

export function createConnection(deps: ConnectionDeps): Connection {
  let state: ConnectionState = "idle";
  let socket: SocketLike | null = null;
  let attempt = 0;
  let stopped = true;
  const timers: { retry: number | null; dead: number | null; stable: number | null } = { retry: null, dead: null, stable: null };
  const frameListeners = new Set<(frame: unknown) => void>();
  const stateListeners = new Set<(state: ConnectionState) => void>();

  const clear = (key: keyof typeof timers) => {
    const id = timers[key];
    if (id !== null) deps.timers.clear(id);
    timers[key] = null;
  };
  const setState = (next: ConnectionState) => {
    if (state === next) return;
    state = next;
    for (const listener of [...stateListeners]) listener(next);
  };
  const armDead = () => {
    clear("dead");
    timers.dead = deps.timers.set(() => socket?.close(), DEAD_AFTER_MS);
  };
  const applyProbe = (probe: ProbeResult): boolean => {
    if (probe === "outdated") setState("outdated");
    else if (probe === "signed-out") setState("signed-out");
    else return true;
    return false;
  };

  const connect = () => {
    clear("retry");
    setState("connecting");
    const current = deps.createSocket(deps.url);
    socket = current;
    current.onopen = armDead;
    current.onerror = () => {};
    current.onclose = () => {
      void onDrop(current);
    };
    current.onmessage = (event) => {
      if (current !== socket) return;
      armDead();
      let frame: unknown;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (state === "connecting") {
        const hello = HelloFrame.safeParse(frame);
        if (hello.success && hello.data.protocol === PROTOCOL_VERSION) {
          setState("open");
          timers.stable = deps.timers.set(() => {
            attempt = 0;
          }, STABLE_AFTER_MS);
        } else {
          setState("outdated");
          current.close();
        }
        return;
      }
      for (const listener of [...frameListeners]) listener(frame);
    };
  };

  const onDrop = async (dropped: SocketLike) => {
    if (dropped !== socket) return;
    socket = null;
    clear("dead");
    clear("stable");
    if (stopped || state === "outdated" || state === "signed-out") return;
    setState("waiting");
    const probe = await deps.probe();
    if (stopped || socket) return;
    if (!applyProbe(probe)) return;
    timers.retry = deps.timers.set(connect, backoffDelay(attempt++, deps.random()));
  };

  return {
    get state() {
      return state;
    },
    start() {
      if (!stopped) return;
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      clear("retry");
      clear("dead");
      clear("stable");
      const current = socket;
      socket = null;
      current?.close();
      setState("idle");
    },
    send(frame) {
      if (state !== "open" || !socket) return false;
      socket.send(JSON.stringify(frame));
      return true;
    },
    onFrame(listener) {
      frameListeners.add(listener);
      return () => {
        frameListeners.delete(listener);
      };
    },
    onState(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    nudge() {
      if (state !== "waiting" || timers.retry === null) return;
      clear("retry");
      void deps.probe().then((probe) => {
        if (!stopped && !socket && applyProbe(probe)) connect();
      });
    },
  };
}
```

- [ ] **Step 5: Write the failing RPC and subscription tests**

`apps/web/src/runtime/testing.ts` (a connection double shared by the runtime tests; never imported by app code, so it never reaches the bundle):

```ts
import type { Connection, ConnectionState } from "./connection.ts";

export function fakeConnection(initial: ConnectionState = "open") {
  let state = initial;
  const frameListeners = new Set<(frame: unknown) => void>();
  const stateListeners = new Set<(state: ConnectionState) => void>();
  const sent: Array<Record<string, unknown>> = [];
  const connection: Connection = {
    get state() { return state; },
    start: () => {},
    stop: () => {},
    send: (frame) => { sent.push(frame as Record<string, unknown>); return state === "open"; },
    onFrame: (listener) => { frameListeners.add(listener); return () => { frameListeners.delete(listener); }; },
    onState: (listener) => { stateListeners.add(listener); return () => { stateListeners.delete(listener); }; },
    nudge: () => {},
  };
  return {
    connection,
    sent,
    deliver: (frame: unknown) => { for (const listener of [...frameListeners]) listener(frame); },
    setState: (next: ConnectionState) => { state = next; for (const listener of [...stateListeners]) listener(next); },
  };
}
```

`apps/web/src/runtime/rpc.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createRpcClient, RpcError } from "./rpc.ts";
import { fakeConnection } from "./testing.ts";

function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return { timers: { set: (fn: () => void) => { pending.set(next, fn); return next++; }, clear: (id: number) => { pending.delete(id); } }, fire: () => { for (const [id, fn] of [...pending]) { pending.delete(id); fn(); } } };
}

describe("rpc client", () => {
  it("resolves with the result and adds a commandId to mutations only", async () => {
    const fake = fakeConnection();
    const rpc = createRpcClient(fake.connection, { newCommandId: () => "cmd-00000001", timers: manualTimers().timers });
    const listed = rpc.call("sessions.list", {});
    const created = rpc.call("sessions.create", { cwd: "/w" });
    expect(fake.sent).toEqual([
      { id: 1, method: "sessions.list", params: {} },
      { id: 2, method: "sessions.create", params: { cwd: "/w" }, commandId: "cmd-00000001" },
    ]);
    fake.deliver({ id: 1, ok: true, result: { sessions: [] } });
    fake.deliver({ id: 2, ok: true, result: { sessionId: "s1" } });
    expect(await listed).toEqual({ sessions: [] });
    expect(await created).toEqual({ sessionId: "s1" });
  });

  it("rejects with the server error code", async () => {
    const fake = fakeConnection();
    const rpc = createRpcClient(fake.connection, { newCommandId: () => "cmd-00000002", timers: manualTimers().timers });
    const call = rpc.call("sessions.create", { cwd: "relative" });
    fake.deliver({ id: 1, ok: false, error: { code: "invalid_cwd" } });
    await expect(call).rejects.toEqual(new RpcError("invalid_cwd"));
  });

  it("rejects pending calls when the connection drops, and never resends them", async () => {
    const fake = fakeConnection();
    const rpc = createRpcClient(fake.connection, { newCommandId: () => "cmd-00000003", timers: manualTimers().timers });
    const call = rpc.call("sessions.prompt", { sessionId: "s1", text: "hi" });
    fake.setState("waiting");
    await expect(call).rejects.toEqual(new RpcError("connection_lost"));
    fake.setState("open");
    expect(fake.sent.filter((f) => f.method === "sessions.prompt")).toHaveLength(1);
  });

  it("refuses frames above 1 MiB and calls while offline", async () => {
    const fake = fakeConnection();
    const rpc = createRpcClient(fake.connection, { newCommandId: () => "cmd-00000004", timers: manualTimers().timers });
    await expect(rpc.call("sessions.prompt", { sessionId: "s1", text: "x".repeat(1024 * 1024) })).rejects.toEqual(new RpcError("payload_too_large"));
    fake.setState("waiting");
    await expect(rpc.call("sessions.list", {})).rejects.toEqual(new RpcError("offline"));
  });

  it("pings while open", () => {
    const fake = fakeConnection("connecting");
    const manual = manualTimers();
    createRpcClient(fake.connection, { newCommandId: () => "cmd-00000005", timers: manual.timers });
    fake.setState("open");
    manual.fire();
    expect(fake.sent.at(-1)).toMatchObject({ method: "system.ping" });
  });
});
```

`apps/web/src/runtime/subscriptions.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { RpcClient } from "./rpc.ts";
import { createSubscriptions } from "./subscriptions.ts";
import { fakeConnection } from "./testing.ts";

function setup() {
  const fake = fakeConnection();
  const calls: Array<[string, unknown]> = [];
  const rpc = {
    call: vi.fn(async (method: string, params: unknown) => {
      calls.push([method, params]);
      return method === "subscribe.session" ? { sub: `s${calls.length}` } : { ok: true };
    }),
  } as unknown as RpcClient;
  const pending = new Map<number, () => void>();
  let next = 1;
  const timers = { set: (fn: () => void) => { pending.set(next, fn); return next++; }, clear: (id: number) => { pending.delete(id); } };
  const subscriptions = createSubscriptions(fake.connection, rpc, timers);
  return { fake, calls, subscriptions, expire: () => { for (const [id, fn] of [...pending]) { pending.delete(id); fn(); } } };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("subscriptions", () => {
  it("subscribes while open and delivers events of its sub", async () => {
    const { fake, calls, subscriptions } = setup();
    const events: unknown[] = [];
    subscriptions.subscribe("session", "k", (event) => events.push(event));
    await flush();
    expect(calls).toEqual([["subscribe.session", { sessionId: "k" }]]);
    fake.deliver({ sub: "s1", epoch: "e1", seq: 0, event: { kind: "snapshot" } });
    fake.deliver({ sub: "other", epoch: "e1", seq: 1, event: { kind: "noise" } });
    expect(events).toEqual([{ kind: "snapshot" }]);
  });

  it("resubscribes with the last cursor after a reconnect", async () => {
    const { fake, calls, subscriptions } = setup();
    subscriptions.subscribe("session", "k", () => {});
    await flush();
    fake.deliver({ sub: "s1", epoch: "e1", seq: 3, event: {} });
    fake.setState("waiting");
    fake.setState("open");
    await flush();
    expect(calls.at(-1)).toEqual(["subscribe.session", { sessionId: "k", after: { epoch: "e1", seq: 3 } }]);
  });

  it("unsubscribes when the last listener leaves and keeps the cursor for 5 minutes", async () => {
    const { fake, calls, subscriptions, expire } = setup();
    const off = subscriptions.subscribe("session", "k", () => {});
    await flush();
    fake.deliver({ sub: "s1", epoch: "e1", seq: 7, event: {} });
    off();
    expect(calls.at(-1)).toEqual(["unsubscribe", { sub: "s1" }]);
    const offAgain = subscriptions.subscribe("session", "k", () => {});
    await flush();
    expect(calls.at(-1)).toEqual(["subscribe.session", { sessionId: "k", after: { epoch: "e1", seq: 7 } }]);
    offAgain();
    expire();
    subscriptions.subscribe("session", "k", () => {});
    await flush();
    expect(calls.at(-1)).toEqual(["subscribe.session", { sessionId: "k" }]);
  });
});
```

- [ ] **Step 6: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/runtime`
Expected: FAIL (`rpc.ts`, `subscriptions.ts` not found).

- [ ] **Step 7: Write RPC, subscriptions, HTTP, ids, hook and the runtime entry**

`apps/web/src/runtime/rpc.ts`:

```ts
import { MAX_FRAME_BYTES, methods, ResponseFrame, type MethodName, type ParamsOf, type ResultOf } from "@pap/contracts";
import type { Connection, Timers } from "./connection.ts";

const PING_EVERY_MS = 5_000;

export class RpcError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "RpcError";
    this.code = code;
  }
}

export interface RpcClient {
  call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>;
}

export function createRpcClient(connection: Connection, deps: { newCommandId(): string; timers: Timers }): RpcClient {
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 1;
  let ping: number | null = null;

  const client: RpcClient = {
    call(method, params) {
      if (connection.state !== "open") return Promise.reject(new RpcError("offline"));
      const id = nextId++;
      const frame = { id, method, params, ...(methods[method].idempotent ? {} : { commandId: deps.newCommandId() }) };
      if (new TextEncoder().encode(JSON.stringify(frame)).length > MAX_FRAME_BYTES) return Promise.reject(new RpcError("payload_too_large"));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        if (!connection.send(frame)) {
          pending.delete(id);
          reject(new RpcError("offline"));
        }
      });
    },
  };

  const schedulePing = () => {
    ping = deps.timers.set(() => {
      void client.call("system.ping", {}).catch(() => undefined);
      schedulePing();
    }, PING_EVERY_MS);
  };

  connection.onFrame((frame) => {
    const parsed = ResponseFrame.safeParse(frame);
    if (!parsed.success) return;
    const entry = pending.get(parsed.data.id);
    if (!entry) return;
    pending.delete(parsed.data.id);
    if (parsed.data.ok) entry.resolve(parsed.data.result);
    else entry.reject(new RpcError(parsed.data.error.code));
  });
  connection.onState((state) => {
    if (state === "open") {
      schedulePing();
      return;
    }
    if (ping !== null) deps.timers.clear(ping);
    ping = null;
    for (const entry of pending.values()) entry.reject(new RpcError("connection_lost"));
    pending.clear();
  });
  return client;
}
```

`apps/web/src/runtime/subscriptions.ts`:

```ts
import { EventFrame, type Cursor, type StreamName } from "@pap/contracts";
import type { Connection, Timers } from "./connection.ts";
import type { RpcClient } from "./rpc.ts";

const CURSOR_CACHE_MS = 5 * 60_000;

export interface Subscriptions {
  subscribe(stream: StreamName, key: string, onEvent: (event: unknown) => void): () => void;
}

interface Entry {
  readonly key: string;
  cursor: Cursor | null;
  sub: string | null;
  expiry: number | null;
  readonly listeners: Set<(event: unknown) => void>;
}

export function createSubscriptions(connection: Connection, rpc: RpcClient, timers: Timers): Subscriptions {
  const entries = new Map<string, Entry>();
  const bySub = new Map<string, Entry>();

  const open = (entry: Entry) => {
    void rpc
      .call("subscribe.session", { sessionId: entry.key, ...(entry.cursor ? { after: entry.cursor } : {}) })
      .then((result) => {
        if (entry.listeners.size === 0) return;
        entry.sub = result.sub;
        bySub.set(result.sub, entry);
      })
      .catch(() => undefined);
  };

  connection.onFrame((frame) => {
    const parsed = EventFrame.safeParse(frame);
    if (!parsed.success) return;
    const entry = bySub.get(parsed.data.sub);
    if (!entry) return;
    entry.cursor = { epoch: parsed.data.epoch, seq: parsed.data.seq };
    for (const listener of [...entry.listeners]) listener(parsed.data.event);
  });
  connection.onState((state) => {
    if (state !== "open") {
      bySub.clear();
      for (const entry of entries.values()) entry.sub = null;
      return;
    }
    for (const entry of entries.values()) if (entry.listeners.size > 0) open(entry);
  });

  return {
    subscribe(_stream, key, onEvent) {
      let entry = entries.get(key);
      if (!entry) {
        entry = { key, cursor: null, sub: null, expiry: null, listeners: new Set() };
        entries.set(key, entry);
      }
      if (entry.expiry !== null) timers.clear(entry.expiry);
      entry.expiry = null;
      const first = entry.listeners.size === 0;
      entry.listeners.add(onEvent);
      if (first && connection.state === "open") open(entry);
      const current = entry;
      return () => {
        current.listeners.delete(onEvent);
        if (current.listeners.size > 0) return;
        if (current.sub) {
          bySub.delete(current.sub);
          void rpc.call("unsubscribe", { sub: current.sub }).catch(() => undefined);
          current.sub = null;
        }
        current.expiry = timers.set(() => entries.delete(current.key), CURSOR_CACHE_MS);
      };
    },
  };
}
```

`apps/web/src/runtime/http.ts`:

```ts
import { PROTOCOL_VERSION } from "@pap/contracts";
import type { ProbeResult } from "./connection.ts";

export interface HttpResult<T> {
  readonly status: number;
  readonly body: T | null;
  readonly retryAfterSeconds: number | null;
}

async function read<T>(response: Response): Promise<HttpResult<T>> {
  const text = await response.text();
  let body: T | null = null;
  try {
    body = text ? (JSON.parse(text) as T) : null;
  } catch {
    body = null;
  }
  const retry = response.headers.get("retry-after");
  return { status: response.status, body, retryAfterSeconds: retry ? Number(retry) : null };
}

export async function getJson<T>(path: string): Promise<HttpResult<T>> {
  return read<T>(await fetch(path, { credentials: "same-origin" }));
}

export async function postJson<T>(path: string, body: unknown): Promise<HttpResult<T>> {
  return read<T>(await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }));
}

export async function probeServer(): Promise<ProbeResult> {
  try {
    const response = await fetch(`/ws?proto=${PROTOCOL_VERSION}`, { credentials: "same-origin" });
    if (response.status === 426) return "outdated";
    if (response.status === 401) return "signed-out";
    return response.ok ? "ok" : "offline";
  } catch {
    return "offline";
  }
}
```

`apps/web/src/runtime/random-id.ts`:

```ts
export function randomId(bytes = 16): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
```

`apps/web/src/runtime/use-connection-state.ts`:

```ts
import { useSyncExternalStore } from "react";
import type { Connection, ConnectionState } from "./connection.ts";

export function useConnectionState(connection: Connection): ConnectionState {
  return useSyncExternalStore(
    (onChange) => connection.onState(() => onChange()),
    () => connection.state,
  );
}
```

`apps/web/src/runtime/index.ts`:

```ts
import { PROTOCOL_VERSION } from "@pap/contracts";
import { createConnection, type Connection, type SocketLike, type Timers } from "./connection.ts";
import { probeServer } from "./http.ts";
import { randomId } from "./random-id.ts";
import { createRpcClient, type RpcClient } from "./rpc.ts";
import { createSubscriptions, type Subscriptions } from "./subscriptions.ts";

export interface Runtime {
  readonly connection: Connection;
  readonly rpc: RpcClient;
  readonly subscriptions: Subscriptions;
}

let runtime: Runtime | null = null;

export function getRuntime(): Runtime {
  if (runtime) return runtime;
  const timers: Timers = { set: (fn, ms) => window.setTimeout(fn, ms), clear: (id) => window.clearTimeout(id) };
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const connection = createConnection({
    url: `${scheme}://${location.host}/ws?proto=${PROTOCOL_VERSION}`,
    createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    probe: probeServer,
    timers,
    random: Math.random,
  });
  const rpc = createRpcClient(connection, { newCommandId: () => randomId(), timers });
  const subscriptions = createSubscriptions(connection, rpc, timers);
  window.addEventListener("online", () => connection.nudge());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") connection.nudge();
  });
  runtime = { connection, rpc, subscriptions };
  return runtime;
}

export type { ConnectionState } from "./connection.ts";
export { getJson, postJson } from "./http.ts";
export { RpcError } from "./rpc.ts";
export { useConnectionState } from "./use-connection-state.ts";
```

- [ ] **Step 8: Run tests and gates**

Run: `pnpm test:unit apps/web/src/runtime && pnpm typecheck && pnpm lint && pnpm knip`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web knip.json pnpm-lock.yaml
git commit -m "feat(web): connection supervisor, typed rpc proxy and cursor subscriptions"
```

---

### Task 26: web app — i18n en/fr, session store, auth and session screens, router, Safari floor

**Files:**
- Create: `apps/web/index.html`, `apps/web/vite.config.ts`, `apps/web/browser-targets.ts`
- Create: `apps/web/src/main.tsx`, `apps/web/src/styles.css`
- Create: `apps/web/src/i18n/en.ts`, `fr.ts`, `index.ts`
- Create: `apps/web/src/stores/session-reducer.ts`, `session-store.ts`, `session-feed.ts`
- Create: `apps/web/src/features/auth/auth-api.ts`, `use-auth-gate.ts`, `SetupScreen.tsx`, `LoginScreen.tsx`, `AccountBar.tsx`
- Create: `apps/web/src/features/sessions/transcript.vm.ts`, `SessionListScreen.tsx`, `SessionScreen.tsx`
- Create: `apps/web/src/routes/router.tsx`, `apps/web/src/routes/RootLayout.tsx`
- Modify: `apps/web/package.json` (build script, dependencies), `knip.json` (web entry), `AGENTS.md` (dev command)
- Test: `apps/web/src/browser-floor.test.ts`, `apps/web/src/i18n/i18n.test.ts`, `apps/web/src/stores/session-reducer.test.ts`, `apps/web/src/features/sessions/transcript.vm.test.ts`

**Interfaces:**
- Consumes: runtime (Task 25), `@pap/ui` (Task 24), contracts, auth HTTP routes (Tasks 17–18).
- Produces: the SPA served from `apps/web/dist` (the daemon finds it at `apps/web/dist`, Task 23). Accessible names the e2e journey relies on (Task 27): headings "Sessions", "Create the owner account", "Sign in"; fields "Username", "Password", "Working directory", "Message"; buttons "Create account", "Sign in", "Sign in with a passkey", "Add a passkey", "Sign out", "New session", "Send", "Allow once", "Deny"; alertdialog "Approval needed"; text "Passkey added."
- `reduceSession(view, event)`, `EMPTY_VIEW`, `useSessionStore`, `feedSession(subscriptions, sessionId)`, `transcriptItems(view)`, `t(key, vars?)`, `errorKey(code)`, `pickLocale(languages, stored)`, `setLocale(locale)`.

- [ ] **Step 1: Install and declare the build**

Run:

```bash
pnpm --filter @pap/web add -E @tanstack/react-router zustand @simplewebauthn/browser@^13 "@pap/ui@workspace:*"
pnpm --filter @pap/web add -D -E @vitejs/plugin-react babel-plugin-react-compiler tailwindcss @tailwindcss/vite
```

In `apps/web/package.json` add the scripts `"build": "vite build"` and `"dev": "vite"`. In `knip.json` set `"apps/web": { "entry": ["src/main.tsx"] }`. In `AGENTS.md`, replace the Dev line with: `- Dev: pnpm --filter @pap/daemon dev (prints its URL; port and PAP_HOME derived from the worktree path), then PAP_DEV_DAEMON=http://127.0.0.1:<that port> pnpm --filter @pap/web dev and open http://localhost:5173`.

- [ ] **Step 2: Write the failing tests**

`apps/web/src/browser-floor.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BROWSER_TARGETS } from "../browser-targets.ts";

describe("browser floor", () => {
  it("pins Safari / iOS 16.4 in browserslist and in the Vite build target", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { browserslist: string[] };
    expect(pkg.browserslist).toEqual(["chrome 111", "edge 111", "firefox 111", "safari 16.4", "ios_saf 16.4"]);
    expect(BROWSER_TARGETS).toEqual(["chrome111", "edge111", "firefox111", "safari16.4", "ios16.4"]);
  });
});
```

`apps/web/src/i18n/i18n.test.ts`:

```ts
import { ERROR_CODES } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { en } from "./en.ts";
import { fr } from "./fr.ts";
import { CLIENT_ERROR_CODES, errorKey, pickLocale, translate } from "./index.ts";

describe("i18n", () => {
  it("every error code has an en and fr message", () => {
    for (const code of [...ERROR_CODES, ...CLIENT_ERROR_CODES]) {
      const key = errorKey(code);
      expect(key, code).toBe(`error.${code}`);
      expect(en[key].length).toBeGreaterThan(0);
      expect(fr[key].length).toBeGreaterThan(0);
    }
    expect(errorKey("teapot")).toBe("error.internal");
  });

  it("translates every key into French", () => {
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(fr[key], key).toBeTruthy();
      if (key !== "app.name") expect(fr[key], key).not.toBe(en[key]);
    }
  });

  it("picks French for French browsers, English otherwise, and a stored choice wins", () => {
    expect(pickLocale(["fr-FR", "en"], null)).toBe("fr");
    expect(pickLocale(["de-DE"], null)).toBe("en");
    expect(pickLocale(["fr-FR"], "en")).toBe("en");
  });

  it("interpolates variables", () => {
    expect(translate("en", "login.throttled", { seconds: 4 })).toBe("Too many attempts. Wait 4 s.");
    expect(translate("fr", "login.throttled", { seconds: 4 })).toBe("Trop de tentatives. Attendez 4 s.");
  });
});
```

`apps/web/src/stores/session-reducer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EMPTY_VIEW, reduceSession } from "./session-reducer.ts";

const user = { role: "user", content: "hi", timestamp: 1 };
const reply = { role: "assistant", content: [{ type: "text", text: "Hello!" }], timestamp: 2 };
const pi = (event: Record<string, unknown>) => ({ kind: "pi", event });

describe("reduceSession", () => {
  it("replaces the view on a snapshot", () => {
    const view = reduceSession(EMPTY_VIEW, { kind: "snapshot", status: "idle", messages: [user], dialogs: [] });
    expect(view).toMatchObject({ status: "idle", loaded: true, messages: [{ key: "user:1", role: "user", text: "hi" }] });
  });

  it("builds a partial reply from text deltas and replaces it on message_end", () => {
    let view = reduceSession(EMPTY_VIEW, pi({ type: "message_start", message: { role: "assistant" } }));
    view = reduceSession(view, pi({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } }));
    view = reduceSession(view, pi({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo!" } }));
    expect(view.partialText).toBe("Hello!");
    view = reduceSession(view, pi({ type: "message_end", message: reply }));
    expect(view.partialText).toBeNull();
    expect(view.messages.map((m) => m.text)).toEqual(["Hello!"]);
  });

  it("does not duplicate a message present in both the snapshot and a live event", () => {
    let view = reduceSession(EMPTY_VIEW, { kind: "snapshot", status: "running", messages: [user, reply], dialogs: [] });
    view = reduceSession(view, pi({ type: "message_end", message: reply }));
    expect(view.messages).toHaveLength(2);
  });

  it("opens a dialog once and closes it", () => {
    const dialog = { id: "d1", method: "confirm", title: "Run a command?", message: "bash: ls" };
    let view = reduceSession(EMPTY_VIEW, { kind: "dialog_open", dialog });
    view = reduceSession(view, { kind: "dialog_open", dialog });
    expect(view.dialogs).toHaveLength(1);
    view = reduceSession(view, { kind: "dialog_closed", id: "d1" });
    expect(view.dialogs).toEqual([]);
  });

  it("turns a status cause into a notice and ignores unknown events", () => {
    const view = reduceSession(EMPTY_VIEW, { kind: "status", status: "cold", cause: "Agent process killed (SIGKILL), possibly out of memory." });
    expect(view.notices).toEqual([{ level: "error", text: "Agent process killed (SIGKILL), possibly out of memory." }]);
    expect(reduceSession(view, { kind: "future_kind", x: 1 })).toBe(view);
    expect(reduceSession(view, pi({ type: "future_event" }))).toBe(view);
  });
});
```

`apps/web/src/features/sessions/transcript.vm.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EMPTY_VIEW, reduceSession } from "../../stores/session-reducer.ts";
import { transcriptItems } from "./transcript.vm.ts";

describe("transcriptItems", () => {
  it("maps authors, shows tool calls and results, and appends the partial reply", () => {
    let view = reduceSession(EMPTY_VIEW, {
      kind: "snapshot",
      status: "running",
      dialogs: [],
      messages: [
        { role: "user", content: "Run the check", timestamp: 1 },
        { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo ok" } }], timestamp: 2 },
        { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "ok\n" }], timestamp: 3 },
      ],
    });
    view = reduceSession(view, { kind: "pi", event: { type: "message_start", message: { role: "assistant" } } });
    view = reduceSession(view, { kind: "pi", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done" } } });
    expect(transcriptItems(view).map((item) => [item.author, item.text])).toEqual([
      ["you", "Run the check"],
      ["agent", "bash: echo ok"],
      ["tool", "ok\n"],
      ["agent", "Done"],
    ]);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm test:unit apps/web/src/browser-floor.test.ts apps/web/src/i18n apps/web/src/stores apps/web/src/features`
Expected: FAIL (modules not found).

- [ ] **Step 4: Write build config, entry HTML and styles**

`apps/web/browser-targets.ts`:

```ts
export const BROWSER_TARGETS = ["chrome111", "edge111", "firefox111", "safari16.4", "ios16.4"];
```

`apps/web/vite.config.ts`:

```ts
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { BROWSER_TARGETS } from "./browser-targets.ts";

const daemon = process.env.PAP_DEV_DAEMON ?? "http://127.0.0.1:7777";

export default defineConfig({
  plugins: [react({ babel: { plugins: ["babel-plugin-react-compiler"] } }), tailwindcss()],
  build: { target: BROWSER_TARGETS, outDir: "dist", sourcemap: false },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/auth": daemon, "/healthz": daemon, "/ws": { target: daemon.replace(/^http/, "ws"), ws: true } },
  },
});
```

`apps/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="dark light" />
    <title>pap</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/styles.css`:

```css
@import "tailwindcss";
@import "@pap/ui/tokens.css";
@source "../../../packages/ui/src";

html,
body,
#root {
  height: 100%;
}

body {
  @apply bg-bg font-sans text-ui text-fg;
}
```

- [ ] **Step 5: Write the i18n layer**

`apps/web/src/i18n/en.ts`:

```ts
export const en = {
  "app.name": "pap",
  "app.loading": "Loading…",
  "setup.title": "Create the owner account",
  "setup.username": "Username",
  "setup.password": "Password",
  "setup.passwordHint": "At least 12 characters.",
  "setup.submit": "Create account",
  "setup.missingToken": "Open the setup link printed in the server log.",
  "login.title": "Sign in",
  "login.submit": "Sign in",
  "login.passkey": "Sign in with a passkey",
  "login.failed": "Wrong username or password.",
  "login.throttled": "Too many attempts. Wait {seconds} s.",
  "account.addPasskey": "Add a passkey",
  "account.passkeyAdded": "Passkey added.",
  "account.logout": "Sign out",
  "sessions.title": "Sessions",
  "sessions.cwd": "Working directory",
  "sessions.cwdHint": "Absolute path of an existing folder.",
  "sessions.create": "New session",
  "sessions.empty": "No session yet.",
  "session.composer": "Message",
  "session.send": "Send",
  "session.stop": "Stop",
  "session.status.cold": "Stopped",
  "session.status.starting": "Starting",
  "session.status.idle": "Ready",
  "session.status.running": "Working",
  "author.you": "You",
  "author.agent": "Agent",
  "author.tool": "Tool",
  "approval.title": "Approval needed",
  "approval.allow": "Allow once",
  "approval.deny": "Deny",
  "dialog.unsupported": "An extension asked for input that this screen cannot show yet.",
  "dialog.cancel": "Cancel",
  "connection.outdated": "A new version of pap is available. Reload the page.",
  "connection.reconnecting": "Reconnecting…",
  "error.bad_request": "The request is invalid.",
  "error.unauthenticated": "Sign in first.",
  "error.forbidden": "You do not have permission for this action.",
  "error.not_found": "Not found.",
  "error.conflict": "This already exists or changed meanwhile.",
  "error.rate_limited": "Too many attempts. Try again later.",
  "error.payload_too_large": "The message is too large.",
  "error.capacity": "The server is at capacity. Try again later.",
  "error.worker_failed": "The session process failed.",
  "error.prompt_rejected": "The session could not start this prompt. Check the model and provider settings.",
  "error.invalid_cwd": "The working directory must be an absolute path to an existing folder.",
  "error.read_only": "The database was written by a newer pap and is read-only.",
  "error.unknown_method": "This version of the page does not match the server. Reload it.",
  "error.internal": "Something went wrong.",
  "error.connection_lost": "The connection dropped before the answer arrived.",
  "error.offline": "pap is unreachable right now.",
  "error.passkey_cancelled": "The passkey prompt was cancelled.",
} as const;
```

`apps/web/src/i18n/fr.ts`:

```ts
import type { en } from "./en.ts";

export const fr: { readonly [K in keyof typeof en]: string } = {
  "app.name": "pap",
  "app.loading": "Chargement…",
  "setup.title": "Créer le compte propriétaire",
  "setup.username": "Nom d'utilisateur",
  "setup.password": "Mot de passe",
  "setup.passwordHint": "Au moins 12 caractères.",
  "setup.submit": "Créer le compte",
  "setup.missingToken": "Ouvrez le lien d'installation affiché dans le journal du serveur.",
  "login.title": "Connexion",
  "login.submit": "Se connecter",
  "login.passkey": "Se connecter avec une clé d'accès",
  "login.failed": "Nom d'utilisateur ou mot de passe incorrect.",
  "login.throttled": "Trop de tentatives. Attendez {seconds} s.",
  "account.addPasskey": "Ajouter une clé d'accès",
  "account.passkeyAdded": "Clé d'accès ajoutée.",
  "account.logout": "Se déconnecter",
  "sessions.title": "Sessions de travail",
  "sessions.cwd": "Dossier de travail",
  "sessions.cwdHint": "Chemin absolu d'un dossier existant.",
  "sessions.create": "Nouvelle session",
  "sessions.empty": "Aucune session pour l'instant.",
  "session.composer": "Message à envoyer",
  "session.send": "Envoyer",
  "session.stop": "Arrêter",
  "session.status.cold": "Arrêtée",
  "session.status.starting": "Démarrage",
  "session.status.idle": "Prête",
  "session.status.running": "En cours",
  "author.you": "Vous",
  "author.agent": "Agent IA",
  "author.tool": "Outil",
  "approval.title": "Approbation requise",
  "approval.allow": "Autoriser une fois",
  "approval.deny": "Refuser",
  "dialog.unsupported": "Une extension demande une saisie que cet écran ne sait pas encore afficher.",
  "dialog.cancel": "Annuler",
  "connection.outdated": "Une nouvelle version de pap est disponible. Rechargez la page.",
  "connection.reconnecting": "Reconnexion…",
  "error.bad_request": "La requête est invalide.",
  "error.unauthenticated": "Connectez-vous d'abord.",
  "error.forbidden": "Vous n'avez pas la permission pour cette action.",
  "error.not_found": "Introuvable.",
  "error.conflict": "Cet élément existe déjà ou a changé entre-temps.",
  "error.rate_limited": "Trop de tentatives. Réessayez plus tard.",
  "error.payload_too_large": "Le message est trop volumineux.",
  "error.capacity": "Le serveur est à pleine capacité. Réessayez plus tard.",
  "error.worker_failed": "Le processus de la session a échoué.",
  "error.prompt_rejected": "La session n'a pas pu lancer cette demande. Vérifiez le modèle et le fournisseur.",
  "error.invalid_cwd": "Le dossier de travail doit être le chemin absolu d'un dossier existant.",
  "error.read_only": "La base a été écrite par une version plus récente de pap et reste en lecture seule.",
  "error.unknown_method": "Cette version de la page ne correspond pas au serveur. Rechargez-la.",
  "error.internal": "Une erreur s'est produite.",
  "error.connection_lost": "La connexion a été coupée avant la réponse.",
  "error.offline": "pap est injoignable pour le moment.",
  "error.passkey_cancelled": "La demande de clé d'accès a été annulée.",
};
```

`apps/web/src/i18n/index.ts`:

```ts
import { en } from "./en.ts";
import { fr } from "./fr.ts";

export type MessageKey = keyof typeof en;
export type Locale = "en" | "fr";

export const CLIENT_ERROR_CODES = ["connection_lost", "offline", "passkey_cancelled"] as const;
const CATALOGS: Record<Locale, { readonly [K in MessageKey]: string }> = { en, fr };
let current: Locale = "en";

export function pickLocale(languages: readonly string[], stored: string | null): Locale {
  if (stored === "en" || stored === "fr") return stored;
  return languages.some((language) => language.toLowerCase().startsWith("fr")) ? "fr" : "en";
}

export function setLocale(locale: Locale): void {
  current = locale;
}

export function translate(locale: Locale, key: MessageKey, vars: Record<string, string | number> = {}): string {
  return CATALOGS[locale][key].replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export const t = (key: MessageKey, vars?: Record<string, string | number>): string => translate(current, key, vars);

export function errorKey(code: string): MessageKey {
  const key = `error.${code}`;
  return Object.hasOwn(en, key) ? (key as MessageKey) : "error.internal";
}
```

- [ ] **Step 6: Write the store, the feed and the transcript view-model**

`apps/web/src/stores/session-reducer.ts`:

```ts
import { SessionStreamEvent, type Dialog, type SessionStatus } from "@pap/contracts";

export interface ToolCallView {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
}

export interface MessageView {
  readonly key: string;
  readonly role: "user" | "assistant" | "toolResult" | "other";
  readonly text: string;
  readonly toolCalls: readonly ToolCallView[];
}

export interface SessionView {
  readonly status: SessionStatus;
  readonly messages: readonly MessageView[];
  readonly partialText: string | null;
  readonly dialogs: readonly Dialog[];
  readonly notices: ReadonlyArray<{ readonly level: string; readonly text: string }>;
  readonly loaded: boolean;
}

export const EMPTY_VIEW: SessionView = { status: "cold", messages: [], partialText: null, dialogs: [], notices: [], loaded: false };
const MAX_NOTICES = 20;

const summarize = (args: unknown): string => {
  const command = (args as { command?: unknown } | null)?.command;
  const text = typeof command === "string" ? command : JSON.stringify(args ?? {});
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
};

export function toMessageView(raw: unknown, index: number): MessageView {
  const message = (raw ?? {}) as { role?: unknown; content?: unknown; timestamp?: unknown };
  const role = message.role === "user" || message.role === "assistant" || message.role === "toolResult" ? message.role : "other";
  const blocks: Array<Record<string, unknown>> =
    typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
  const text = blocks.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text as string).join("");
  const toolCalls = blocks
    .filter((block) => block.type === "toolCall")
    .map((block) => ({ id: String(block.id ?? ""), name: String(block.name ?? "tool"), summary: summarize(block.arguments ?? block.args ?? block.input) }));
  return { key: typeof message.timestamp === "number" ? `${role}:${message.timestamp}` : `${role}:#${index}`, role, text, toolCalls };
}

const withNotice = (view: SessionView, level: string, text: string): SessionView => ({ ...view, notices: [...view.notices, { level, text }].slice(-MAX_NOTICES) });

function reducePi(view: SessionView, event: { type: string } & Record<string, unknown>): SessionView {
  switch (event.type) {
    case "message_start":
      return (event.message as { role?: unknown } | undefined)?.role === "assistant" ? { ...view, partialText: "" } : view;
    case "message_update": {
      const update = event.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
      return update?.type === "text_delta" && typeof update.delta === "string" ? { ...view, partialText: (view.partialText ?? "") + update.delta } : view;
    }
    case "message_end": {
      const message = toMessageView(event.message, view.messages.length);
      const known = view.messages.some((existing) => existing.key === message.key);
      return { ...view, messages: known ? view.messages : [...view.messages, message], partialText: message.role === "assistant" ? null : view.partialText };
    }
    case "extension_ui_request":
      return event.method === "notify" && typeof event.message === "string" ? withNotice(view, String(event.notifyType ?? "info"), event.message) : view;
    default:
      return view;
  }
}

export function reduceSession(view: SessionView, raw: unknown): SessionView {
  const parsed = SessionStreamEvent.safeParse(raw);
  if (!parsed.success) return view;
  const event = parsed.data;
  switch (event.kind) {
    case "snapshot":
      return { ...EMPTY_VIEW, status: event.status, messages: event.messages.map(toMessageView), dialogs: event.dialogs, loaded: true };
    case "status": {
      const next = { ...view, status: event.status };
      return event.cause ? withNotice(next, "error", event.cause) : next;
    }
    case "dialog_open":
      return view.dialogs.some((dialog) => dialog.id === event.dialog.id) ? view : { ...view, dialogs: [...view.dialogs, event.dialog] };
    case "dialog_closed":
      return { ...view, dialogs: view.dialogs.filter((dialog) => dialog.id !== event.id) };
    case "notice":
      return withNotice(view, event.level, event.text);
    case "pi":
      return reducePi(view, event.event);
  }
}
```

`apps/web/src/stores/session-store.ts`:

```ts
import { create } from "zustand";
import { EMPTY_VIEW, reduceSession, type SessionView } from "./session-reducer.ts";

interface SessionStoreState {
  readonly views: Readonly<Record<string, SessionView>>;
  apply(sessionId: string, event: unknown): void;
}

export const useSessionStore = create<SessionStoreState>()((set) => ({
  views: {},
  apply: (sessionId, event) =>
    set((state) => ({ views: { ...state.views, [sessionId]: reduceSession(state.views[sessionId] ?? EMPTY_VIEW, event) } })),
}));
```

`apps/web/src/stores/session-feed.ts`:

```ts
import type { Runtime } from "../runtime/index.ts";
import { useSessionStore } from "./session-store.ts";

export function feedSession(subscriptions: Runtime["subscriptions"], sessionId: string): () => void {
  return subscriptions.subscribe("session", sessionId, (event) => useSessionStore.getState().apply(sessionId, event));
}
```

`apps/web/src/features/sessions/transcript.vm.ts`:

```ts
import type { SessionView } from "../../stores/session-reducer.ts";

export interface TranscriptItem {
  readonly key: string;
  readonly author: "agent" | "you" | "tool";
  readonly text: string;
}

export function transcriptItems(view: SessionView): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const message of view.messages) {
    const author = message.role === "user" ? "you" : message.role === "assistant" ? "agent" : "tool";
    const text = [message.text, ...message.toolCalls.map((call) => `${call.name}: ${call.summary}`)].filter(Boolean).join("\n");
    if (text) items.push({ key: message.key, author, text });
  }
  if (view.partialText) items.push({ key: "partial", author: "agent", text: view.partialText });
  return items;
}
```

- [ ] **Step 7: Run the pure tests**

Run: `pnpm test:unit apps/web/src/browser-floor.test.ts apps/web/src/i18n apps/web/src/stores apps/web/src/features`
Expected: PASS.

- [ ] **Step 8: Write the auth feature**

`apps/web/src/features/auth/auth-api.ts`:

```ts
import { startAuthentication, startRegistration, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { getJson, postJson } from "../../runtime/index.ts";

export interface AuthStatus {
  readonly setupRequired: boolean;
  readonly authenticated: boolean;
  readonly username: string | null;
  readonly passkeysAvailable: boolean;
}

export type AuthResult = { ok: true } | { ok: false; code: string; retryAfterSeconds: number | null };
type ErrorBody = { error?: { code?: string } };

const failure = (result: { body: ErrorBody | null; retryAfterSeconds: number | null }): AuthResult => ({
  ok: false,
  code: result.body?.error?.code ?? "internal",
  retryAfterSeconds: result.retryAfterSeconds,
});

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const result = await getJson<AuthStatus>("/auth/status");
  if (result.status !== 200 || !result.body) throw new Error("auth status unavailable");
  return result.body;
}

export async function setupOwner(token: string, username: string, password: string): Promise<AuthResult> {
  const result = await postJson<ErrorBody>("/auth/setup", { token, username, password });
  return result.status === 201 ? { ok: true } : failure(result);
}

export async function login(username: string, password: string): Promise<AuthResult> {
  const result = await postJson<ErrorBody>("/auth/login", { username, password });
  return result.status === 200 ? { ok: true } : failure(result);
}

export async function logout(): Promise<void> {
  await postJson("/auth/logout", {});
}

export async function registerPasskey(): Promise<AuthResult> {
  const options = await postJson<{ flowId: string; options: PublicKeyCredentialCreationOptionsJSON } & ErrorBody>("/auth/passkey/register/options", {});
  if (options.status !== 200 || !options.body) return failure(options);
  let response: unknown;
  try {
    response = await startRegistration({ optionsJSON: options.body.options });
  } catch {
    return { ok: false, code: "passkey_cancelled", retryAfterSeconds: null };
  }
  const verify = await postJson<ErrorBody>("/auth/passkey/register/verify", { flowId: options.body.flowId, response });
  return verify.status === 200 ? { ok: true } : failure(verify);
}

export async function loginWithPasskey(): Promise<AuthResult> {
  const options = await postJson<{ flowId: string; options: PublicKeyCredentialRequestOptionsJSON } & ErrorBody>("/auth/passkey/login/options", {});
  if (options.status !== 200 || !options.body) return failure(options);
  let response: unknown;
  try {
    response = await startAuthentication({ optionsJSON: options.body.options });
  } catch {
    return { ok: false, code: "passkey_cancelled", retryAfterSeconds: null };
  }
  const verify = await postJson<ErrorBody>("/auth/passkey/login/verify", { flowId: options.body.flowId, response });
  return verify.status === 200 ? { ok: true } : failure(verify);
}
```

`apps/web/src/features/auth/use-auth-gate.ts`:

```ts
import { useCallback, useEffect, useState } from "react";
import { fetchAuthStatus } from "./auth-api.ts";

export type GateState =
  | { readonly phase: "loading" }
  | { readonly phase: "error" }
  | { readonly phase: "setup" }
  | { readonly phase: "login"; readonly passkeysAvailable: boolean }
  | { readonly phase: "ready"; readonly username: string | null; readonly passkeysAvailable: boolean };

export function useAuthGate(): { state: GateState; refresh(): void } {
  const [state, setState] = useState<GateState>({ phase: "loading" });
  const refresh = useCallback(() => {
    fetchAuthStatus().then(
      (status) =>
        setState(
          status.setupRequired
            ? { phase: "setup" }
            : status.authenticated
              ? { phase: "ready", username: status.username, passkeysAvailable: status.passkeysAvailable }
              : { phase: "login", passkeysAvailable: status.passkeysAvailable },
        ),
      () => setState({ phase: "error" }),
    );
  }, []);
  useEffect(refresh, [refresh]);
  return { state, refresh };
}
```

`apps/web/src/features/auth/SetupScreen.tsx`:

```tsx
import { Button, TextField } from "@pap/ui";
import { useState } from "react";
import { errorKey, t } from "../../i18n/index.ts";
import { setupOwner } from "./auth-api.ts";

export function SetupScreen({ onDone }: { onDone(): void }) {
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(token ? null : t("setup.missingToken"));
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const result = await setupOwner(token, username, password);
    setBusy(false);
    if (!result.ok) {
      setError(t(errorKey(result.code)));
      return;
    }
    window.history.replaceState(null, "", "/");
    onDone();
  };
  return (
    <main className="mx-auto flex w-full max-w-sm flex-col gap-4 p-6">
      <h1 className="text-xl font-extrabold text-fg">{t("setup.title")}</h1>
      <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <TextField label={t("setup.username")} value={username} onChange={setUsername} name="username" autoComplete="username" />
        <TextField label={t("setup.password")} value={password} onChange={setPassword} type="password" name="password" autoComplete="new-password" hint={t("setup.passwordHint")} error={error} />
        <Button type="submit" variant="primary" disabled={busy || !token || password.length < 12 || username === ""}>
          {t("setup.submit")}
        </Button>
      </form>
    </main>
  );
}
```

`apps/web/src/features/auth/LoginScreen.tsx`:

```tsx
import { Button, TextField } from "@pap/ui";
import { useState } from "react";
import { errorKey, t } from "../../i18n/index.ts";
import { login, loginWithPasskey, type AuthResult } from "./auth-api.ts";

export function LoginScreen({ passkeysAvailable, onDone }: { passkeysAvailable: boolean; onDone(): void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const finish = (result: AuthResult) => {
    setBusy(false);
    if (result.ok) {
      window.history.replaceState(null, "", "/");
      onDone();
    } else if (result.code === "rate_limited") setError(t("login.throttled", { seconds: result.retryAfterSeconds ?? 1 }));
    else if (result.code === "unauthenticated") setError(t("login.failed"));
    else setError(t(errorKey(result.code)));
  };
  return (
    <main className="mx-auto flex w-full max-w-sm flex-col gap-4 p-6">
      <h1 className="text-xl font-extrabold text-fg">{t("login.title")}</h1>
      <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); setBusy(true); void login(username, password).then(finish); }}>
        <TextField label={t("setup.username")} value={username} onChange={setUsername} name="username" autoComplete="username webauthn" />
        <TextField label={t("setup.password")} value={password} onChange={setPassword} type="password" name="password" autoComplete="current-password" error={error} />
        <Button type="submit" variant="primary" disabled={busy || username === "" || password === ""}>
          {t("login.submit")}
        </Button>
      </form>
      {passkeysAvailable ? (
        <Button disabled={busy} onClick={() => { setBusy(true); void loginWithPasskey().then(finish); }}>
          {t("login.passkey")}
        </Button>
      ) : null}
    </main>
  );
}
```

`apps/web/src/features/auth/AccountBar.tsx`:

```tsx
import { Button } from "@pap/ui";
import { useState } from "react";
import { errorKey, t } from "../../i18n/index.ts";
import { logout, registerPasskey } from "./auth-api.ts";

export function AccountBar({ username, passkeysAvailable, onSignedOut }: { username: string | null; passkeysAvailable: boolean; onSignedOut(): void }) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <header className="flex items-center justify-between border-b border-line px-4 py-2">
      <span className="font-mono text-label uppercase tracking-wider text-muted">
        {t("app.name")} · {username}
      </span>
      <div className="flex items-center gap-2">
        {message ? <span role="status" className="text-ui text-muted">{message}</span> : null}
        {passkeysAvailable ? (
          <Button onClick={() => void registerPasskey().then((result) => setMessage(result.ok ? t("account.passkeyAdded") : t(errorKey(result.code))))}>
            {t("account.addPasskey")}
          </Button>
        ) : null}
        <Button onClick={() => void logout().then(onSignedOut)}>{t("account.logout")}</Button>
      </div>
    </header>
  );
}
```

- [ ] **Step 9: Write the sessions feature**

`apps/web/src/features/sessions/SessionListScreen.tsx`:

```tsx
import type { SessionSummary } from "@pap/contracts";
import { Button, TextField } from "@pap/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { errorKey, t } from "../../i18n/index.ts";
import { getRuntime, RpcError, useConnectionState } from "../../runtime/index.ts";

export function SessionListScreen() {
  const runtime = getRuntime();
  const connection = useConnectionState(runtime.connection);
  const navigate = useNavigate();
  const [cwd, setCwd] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (connection !== "open") return;
    runtime.rpc.call("sessions.list", {}).then((result) => setSessions(result.sessions), () => undefined);
  }, [connection, runtime]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const { sessionId } = await runtime.rpc.call("sessions.create", { cwd: cwd.trim() });
      await navigate({ to: "/s/$sessionId", params: { sessionId } });
    } catch (failure) {
      setError(t(errorKey(failure instanceof RpcError ? failure.code : "internal")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
      <h1 className="text-xl font-extrabold text-fg">{t("sessions.title")}</h1>
      <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <TextField label={t("sessions.cwd")} hint={t("sessions.cwdHint")} value={cwd} onChange={setCwd} error={error} name="cwd" />
        <div>
          <Button type="submit" variant="primary" disabled={busy || connection !== "open" || cwd.trim() === ""}>
            {t("sessions.create")}
          </Button>
        </div>
      </form>
      {sessions.length === 0 ? (
        <p className="text-muted">{t("sessions.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {sessions.map((session) => (
            <li key={session.id} className="flex items-center gap-2">
              <Link to="/s/$sessionId" params={{ sessionId: session.id }} className="text-agent underline">
                {session.cwd}
              </Link>
              <span className="font-mono text-label uppercase text-muted">{t(`session.status.${session.status}`)}</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
```

`apps/web/src/features/sessions/SessionScreen.tsx`:

```tsx
import type { DialogResponse } from "@pap/contracts";
import { ApprovalCard, Button, Message, TextField } from "@pap/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { errorKey, t } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { feedSession } from "../../stores/session-feed.ts";
import { EMPTY_VIEW } from "../../stores/session-reducer.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { transcriptItems } from "./transcript.vm.ts";

export function SessionScreen({ sessionId }: { sessionId: string }) {
  const runtime = getRuntime();
  const view = useSessionStore((state) => state.views[sessionId]) ?? EMPTY_VIEW;
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => feedSession(runtime.subscriptions, sessionId), [runtime, sessionId]);

  const fail = (failure: unknown) => setError(t(errorKey(failure instanceof RpcError ? failure.code : "internal")));
  const send = () => {
    const message = text.trim();
    if (!message) return;
    setText("");
    setError(null);
    runtime.rpc
      .call("sessions.prompt", { sessionId, text: message, ...(view.status === "running" ? { streamingBehavior: "followUp" as const } : {}) })
      .catch(fail);
  };
  const answer = (dialogId: string, response: DialogResponse) => {
    runtime.rpc.call("sessions.respondDialog", { sessionId, dialogId, response }).catch(fail);
  };

  return (
    <main className="mx-auto flex h-full w-full max-w-4xl flex-col gap-3 p-4">
      <header className="flex items-center justify-between">
        <Link to="/" className="text-agent underline">
          {t("sessions.title")}
        </Link>
        <span className="font-mono text-label uppercase tracking-wider text-muted">{t(`session.status.${view.status}`)}</span>
      </header>
      <ol className="flex flex-1 flex-col gap-2 overflow-y-auto">
        {transcriptItems(view).map((item) => (
          <li key={item.key}>
            <Message author={item.author} label={t(`author.${item.author}`)}>
              {item.text}
            </Message>
          </li>
        ))}
      </ol>
      {view.dialogs.map((dialog) =>
        dialog.method === "confirm" ? (
          <ApprovalCard
            key={dialog.id}
            title={t("approval.title")}
            detail={[dialog.title, dialog.message].filter(Boolean).join("\n")}
            allowLabel={t("approval.allow")}
            denyLabel={t("approval.deny")}
            onAnswer={(confirmed) => answer(dialog.id, { confirmed })}
          />
        ) : (
          <div key={dialog.id} role="alert" className="flex flex-col gap-2 rounded-sm border border-attention p-3">
            <p className="text-ui text-fg">{t("dialog.unsupported")}</p>
            <div>
              <Button onClick={() => answer(dialog.id, { cancelled: true })}>{t("dialog.cancel")}</Button>
            </div>
          </div>
        ),
      )}
      {view.notices.map((notice, index) => (
        <p key={`${index}:${notice.text}`} className="text-ui text-muted">
          {notice.text}
        </p>
      ))}
      {error ? (
        <p role="alert" className="text-ui text-attention">
          {error}
        </p>
      ) : null}
      <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); send(); }}>
        <TextField label={t("session.composer")} value={text} onChange={setText} multiline name="message" onSubmitShortcut={send} />
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={text.trim() === ""}>
            {t("session.send")}
          </Button>
          {view.status === "running" ? (
            <Button variant="danger" onClick={() => { runtime.rpc.call("sessions.abort", { sessionId }).catch(fail); }}>
              {t("session.stop")}
            </Button>
          ) : null}
        </div>
      </form>
    </main>
  );
}
```

- [ ] **Step 10: Write the routes and the entry**

`apps/web/src/routes/RootLayout.tsx`:

```tsx
import { Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { AccountBar } from "../features/auth/AccountBar.tsx";
import { LoginScreen } from "../features/auth/LoginScreen.tsx";
import { SetupScreen } from "../features/auth/SetupScreen.tsx";
import { useAuthGate } from "../features/auth/use-auth-gate.ts";
import { t } from "../i18n/index.ts";
import { getRuntime, useConnectionState } from "../runtime/index.ts";

export function RootLayout() {
  const { state, refresh } = useAuthGate();
  const runtime = getRuntime();
  const connection = useConnectionState(runtime.connection);

  useEffect(() => {
    if (state.phase === "ready") runtime.connection.start();
    else runtime.connection.stop();
  }, [state.phase, runtime]);
  useEffect(() => {
    if (connection === "signed-out") refresh();
  }, [connection, refresh]);

  if (state.phase === "loading") return <main className="p-6 text-muted">{t("app.loading")}</main>;
  if (state.phase === "error") return <main role="alert" className="p-6 text-attention">{t("error.offline")}</main>;
  if (state.phase === "setup") return <SetupScreen onDone={refresh} />;
  if (state.phase === "login") return <LoginScreen passkeysAvailable={state.passkeysAvailable} onDone={refresh} />;
  return (
    <div className="flex h-full flex-col">
      <AccountBar username={state.username} passkeysAvailable={state.passkeysAvailable} onSignedOut={refresh} />
      {connection === "outdated" ? <p role="alert" className="px-4 py-2 text-ui text-attention">{t("connection.outdated")}</p> : null}
      {connection === "waiting" ? <p role="status" className="px-4 py-2 text-ui text-muted">{t("connection.reconnecting")}</p> : null}
      <Outlet />
    </div>
  );
}
```

`apps/web/src/routes/router.tsx`:

```tsx
import { createRootRoute, createRoute, createRouter, Navigate } from "@tanstack/react-router";
import { SessionListScreen } from "../features/sessions/SessionListScreen.tsx";
import { SessionScreen } from "../features/sessions/SessionScreen.tsx";
import { RootLayout } from "./RootLayout.tsx";

const rootRoute = createRootRoute({ component: RootLayout, notFoundComponent: () => <Navigate to="/" /> });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: SessionListScreen });
const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$sessionId",
  component: function SessionRoute() {
    const { sessionId } = sessionRoute.useParams();
    return <SessionScreen key={sessionId} sessionId={sessionId} />;
  },
});

export const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute, sessionRoute]) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
```

`apps/web/src/main.tsx`:

```tsx
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { pickLocale, setLocale } from "./i18n/index.ts";
import { router } from "./routes/router.tsx";
import "./styles.css";

const locale = pickLocale(navigator.languages, localStorage.getItem("pap.locale"));
setLocale(locale);
document.documentElement.lang = locale;
const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");
createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
```

- [ ] **Step 11: Build and run every gate**

Run: `pnpm test:unit && pnpm typecheck && pnpm lint && pnpm knip && pnpm build && ls apps/web/dist/index.html`
Expected: PASS; the build writes `apps/web/dist/index.html` and hashed assets under `apps/web/dist/assets/`. (Use the recursive `pnpm build`: the production web bundle resolves `@pap/contracts` to its `dist/`, which must be built first.)

- [ ] **Step 12: Commit**

```bash
git add apps/web knip.json AGENTS.md pnpm-lock.yaml
git commit -m "feat(web): en/fr session screens with approval card on the typed runtime"
```

---

### Task 27: Playwright journey on Chromium + WebKit, bundle budget, CI e2e and budget jobs

**Files:**
- Create: `playwright.config.ts`, `e2e/state.ts`, `e2e/global-setup.ts`, `e2e/global-teardown.ts`, `e2e/journey.spec.ts`, `e2e/fixtures/approval-script.json`
- Create: `scripts/check-budgets.ts`
- Modify: `.github/workflows/ci.yml` (jobs `e2e`, `budgets`)
- Test: `scripts/check-budgets.test.ts`, `e2e/journey.spec.ts`

**Interfaces:**
- Consumes: the built daemon `apps/daemon/dist/main.js` (Task 23) and its log lines `setup_url` / `listening`; the SPA names listed in Task 26; `budgets.json` (Task 23).
- Produces: `pnpm e2e` (needs `pnpm build` first), `pnpm budgets`, `initialAssets(indexHtml): string[]`, `initialBundleGzipKb(distDir): number`.

The journey runs over plain `http://localhost:<port>`, the default exposure, on purpose: if WebKit drops the always-`Secure` session cookie there, the reload step fails and that is a real defect for local Safari users (Review Focus 1), not a test to work around. Record it, then decide with the owner between `localhost`-only `Secure` relaxation (spec deviation, ADR) and requiring HTTPS.

- [ ] **Step 1: Install Playwright and its browsers**

Run: `pnpm add -Dw -E @playwright/test && pnpm exec playwright install chromium webkit`

- [ ] **Step 2: Write the failing budget test**

`scripts/check-budgets.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialAssets, initialBundleGzipKb } from "./check-budgets.ts";

let dist: string;
beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), "pap-budget-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(
    join(dist, "index.html"),
    '<script type="module" crossorigin src="/assets/index-a1.js"></script><link rel="modulepreload" crossorigin href="/assets/vendor-b2.js"><link rel="stylesheet" crossorigin href="/assets/index-c3.css">',
  );
  writeFileSync(join(dist, "assets/index-a1.js"), "console.log(1);".repeat(100));
  writeFileSync(join(dist, "assets/vendor-b2.js"), "export const v = 1;".repeat(100));
  writeFileSync(join(dist, "assets/index-c3.css"), "body{color:red}".repeat(100));
  writeFileSync(join(dist, "assets/lazy-d4.js"), "x".repeat(500_000));
});
afterEach(() => rmSync(dist, { recursive: true, force: true }));

describe("bundle budget", () => {
  it("counts only the scripts, preloads and styles index.html loads first", () => {
    const html = '<script type="module" src="/assets/index-a1.js"></script><link rel="modulepreload" href="/assets/vendor-b2.js">';
    expect(initialAssets(html)).toEqual(["/assets/index-a1.js", "/assets/vendor-b2.js"]);
    const kb = initialBundleGzipKb(dist);
    expect(kb).toBeGreaterThan(0);
    expect(kb).toBeLessThan(5);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm test:unit scripts/check-budgets.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Write the budget script**

`scripts/check-budgets.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export function initialAssets(indexHtml: string): string[] {
  const assets = new Set<string>();
  for (const match of indexHtml.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)) {
    if (match[1]) assets.add(match[1]);
  }
  return [...assets];
}

export function initialBundleGzipKb(distDir: string): number {
  const html = readFileSync(join(distDir, "index.html"), "utf8");
  const bytes = initialAssets(html).reduce((sum, asset) => sum + gzipSync(readFileSync(join(distDir, asset)), { level: 9 }).length, 0);
  return Math.round((bytes / 1024) * 10) / 10;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const budgets = JSON.parse(readFileSync("budgets.json", "utf8")) as { initialBundleGzipKb: number };
  const measured = initialBundleGzipKb("apps/web/dist");
  console.log(`initial bundle: ${measured} KB gzip (budget ${budgets.initialBundleGzipKb} KB)`);
  if (measured > budgets.initialBundleGzipKb) process.exitCode = 1;
}
```

Run: `pnpm test:unit scripts/check-budgets.test.ts && pnpm budgets`
Expected: PASS, then a line `initial bundle: <n> KB gzip (budget 180 KB)` with exit code 0 (the web build from Task 26 must exist).

- [ ] **Step 5: Write the e2e fixture, state helper and global setup/teardown**

`e2e/fixtures/approval-script.json`:

```json
{
  "modelId": "scripted",
  "steps": [
    { "toolCalls": [{ "name": "bash", "args": { "command": "echo pap-e2e-ok" }, "id": "call-1" }] },
    { "text": "The command printed pap-e2e-ok." }
  ]
}
```

`e2e/state.ts`:

```ts
import { readFileSync } from "node:fs";

export const E2E_PORTS = { chromium: 7791, webkit: 7792 } as const;

export interface DaemonState {
  readonly setupUrl: string;
  readonly cwd: string;
  readonly pid: number;
  readonly root: string;
}

export const statePath = (project: string): URL => new URL(`./.state/${project}.json`, import.meta.url);
export const readState = (project: string): DaemonState => JSON.parse(readFileSync(statePath(project), "utf8")) as DaemonState;
```

`e2e/global-setup.ts`:

```ts
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { E2E_PORTS, statePath, type DaemonState } from "./state.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./fixtures/approval-script.json", import.meta.url));

async function startDaemon(port: number): Promise<DaemonState> {
  const root = mkdtempSync(join(tmpdir(), "pap-e2e-"));
  const cwd = join(root, "work");
  mkdirSync(cwd);
  mkdirSync(join(root, "agent"));
  const child = spawn(process.execPath, [join(REPO, "apps/daemon/dist/main.js"), "serve", "--port", String(port)], {
    env: { ...process.env, PAP_HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent"), PAP_TEST_PROVIDER_SCRIPT: SCRIPT, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    stdio: ["ignore", "pipe", "inherit"],
    detached: true,
  });
  let setupUrl: string | null = null;
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`daemon on port ${port} did not start within 20 s`)), 20_000);
    child.once("exit", (code) => reject(new Error(`daemon exited early with code ${code}`)));
    createInterface({ input: child.stdout }).on("line", (line) => {
      let entry: { msg?: string; url?: string };
      try {
        entry = JSON.parse(line) as { msg?: string; url?: string };
      } catch {
        return;
      }
      if (entry.msg === "setup_url") setupUrl = entry.url ?? null;
      if (entry.msg === "listening") {
        clearTimeout(deadline);
        resolve();
      }
    });
  });
  if (!setupUrl) throw new Error("the daemon did not log a setup URL");
  child.unref();
  return { setupUrl, cwd, pid: child.pid ?? 0, root };
}

export default async function globalSetup(): Promise<void> {
  mkdirSync(new URL("./.state/", import.meta.url), { recursive: true });
  for (const [project, port] of Object.entries(E2E_PORTS)) writeFileSync(statePath(project), JSON.stringify(await startDaemon(port)));
}
```

`e2e/global-teardown.ts`:

```ts
import { rmSync } from "node:fs";
import { E2E_PORTS, readState } from "./state.ts";

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export default async function globalTeardown(): Promise<void> {
  for (const project of Object.keys(E2E_PORTS)) {
    let state;
    try {
      state = readState(project);
    } catch {
      continue;
    }
    try {
      process.kill(-state.pid, "SIGTERM");
    } catch {
      // already stopped
    }
    await waitForExit(state.pid, 10_000);
    rmSync(state.root, { recursive: true, force: true });
  }
}
```

`playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";
import { E2E_PORTS } from "./e2e/state.ts";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${E2E_PORTS.chromium}` } },
    { name: "webkit", use: { ...devices["Desktop Safari"], baseURL: `http://localhost:${E2E_PORTS.webkit}` } },
  ],
});
```

- [ ] **Step 6: Write the journey**

`e2e/journey.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { readState } from "./state.ts";

const OWNER = { username: "owner", password: "correct horse battery staple" };

test.describe.serial("owner journey", () => {
  test("setup → login → prompt → approval → result", async ({ page }, testInfo) => {
    const state = readState(testInfo.project.name);
    await page.goto(state.setupUrl);
    await expect(page.getByRole("heading", { name: "Create the owner account" })).toBeVisible();
    await page.getByLabel("Username").fill(OWNER.username);
    await page.getByLabel("Password").fill(OWNER.password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await page.getByLabel("Username").fill(OWNER.username);
    await page.getByLabel("Password").fill(OWNER.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    await page.getByLabel("Working directory").fill(state.cwd);
    await page.getByRole("button", { name: "New session" }).click();
    await page.getByLabel("Message").fill("Run the check");
    await page.getByRole("button", { name: "Send" }).click();

    const card = page.getByRole("alertdialog", { name: "Approval needed" });
    await expect(card).toContainText("echo pap-e2e-ok");
    await card.getByRole("button", { name: "Allow once" }).dblclick();
    await expect(page.getByText("The command printed pap-e2e-ok.")).toBeVisible();
    await expect(card).toBeHidden();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("passkey registration and sign-in (Chromium virtual authenticator)", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "the virtual authenticator is a Chromium DevTools feature");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
    });
    await page.goto("/");
    await page.getByLabel("Username").fill(OWNER.username);
    await page.getByLabel("Password").fill(OWNER.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Add a passkey" }).click();
    await expect(page.getByText("Passkey added.")).toBeVisible();
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  });
});
```

- [ ] **Step 7: Run the journey on both engines**

Run: `pnpm build && pnpm e2e`
Expected: 3 passed, 1 skipped (the passkey test on WebKit). If the WebKit reload step fails because the cookie was not stored, stop and record it as described above; do not weaken the test.

- [ ] **Step 8: Add the e2e and budget jobs to CI**

Append to `jobs:` in `.github/workflows/ci.yml`:

```yaml
  e2e:
    needs: build
    runs-on: ubuntu-24.04
    env:
      PI_TELEMETRY: "0"
    steps:
      - uses: actions/checkout@v5
      - uses: ./.github/actions/setup
      - uses: actions/download-artifact@v4
        with:
          name: dist
          path: .
      - run: pnpm exec playwright install --with-deps chromium webkit
      - run: pnpm e2e
      - if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: playwright-report
          retention-days: 7
  budgets:
    needs: build
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v5
      - uses: ./.github/actions/setup
      - uses: actions/download-artifact@v4
        with:
          name: dist
          path: .
      - run: pnpm budgets
```

- [ ] **Step 9: Run every gate one last time**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit && pnpm test:int && pnpm build && pnpm e2e && pnpm budgets`
Expected: all PASS. This is the M1 exit criterion.

- [ ] **Step 10: Commit**

```bash
git add playwright.config.ts e2e scripts/check-budgets.ts scripts/check-budgets.test.ts .github/workflows/ci.yml package.json pnpm-lock.yaml
git commit -m "test(e2e): owner journey on chromium and webkit with bundle budget gate"
```

---

## Coverage map (brief and spec C → tasks)

| Requirement | Task |
|---|---|
| Spikes S1–S8 with time-boxes and go/fallback notes | 1–8 |
| pnpm monorepo, strict TS, Prettier, Vitest | 9 |
| ESLint `max-lines: 400`, `eslint-plugin-boundaries`, reasoned disables, design-system lint, knip | 10 |
| GitHub Actions gates of C §8 (install → checks → unit → integration → build → e2e → budgets), nightly Pi-compat, Renovate, `minimumReleaseAge` | 9, 11, 27 |
| `defineMethod` + permission + exhaustive handler table | 12, 16, 23 |
| Kernel config, clock, logger, `node:sqlite`, per-module forward-only migrations + pre-migration snapshot, read-only when newer | 13, 14 |
| Auth: one-time setup URL, scrypt, passkeys, hashed HttpOnly/Secure/SameSite=Strict cookie, Origin check, throttle | 15, 17, 18 |
| Hono + `@hono/node-server`, `ws` `/ws`, request/response, `?proto=1` gate, subscription with cursor resume | 15, 16, 25 |
| pi-host fork + IPC, Pi SDK session, prompt/abort/get_state, `agent_settled` + get_state probe, kill ladder, ppid watchdog, OOM score | 20, 21, 22 |
| Minimal pap-policy: exec asks via `ctx.ui.confirm` → `extension_ui_request` → web card, fail closed | 19, 20, 22, 26 |
| Sessions module: create in a cwd, prompt, stream, index row | 22, 23 |
| Web runtime, one store, minimal session screen, E1 tokens (DESIGN.md subset), en + fr, Safari 16.4 floor | 24, 25, 26 |
| Integration test with the scripted provider | 20, 21, 23 |
| Playwright journey setup → login → prompt → approval → result on Chromium + WebKit | 27 |
| Default bind `127.0.0.1:7777`, zero telemetry (`PI_TELEMETRY=0` for workers) | 13, 21, 23 |

