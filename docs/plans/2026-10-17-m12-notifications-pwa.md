# pap M12: Notifications and PWA - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status (2026-10-17):** fixed from the Opus red-team (`.superpowers/redteam-m12.md`: 0 Critical, 12 Important, 22 Minor) and the owner's answers (question page `m12m6b-q1`, every answer the recommendation, decision 93). 23 tasks in three chains. Next: execution by SDD (merge order: M12 first, then M6b rebases).

**Goal:** the owner gets self-hosted Web Push (VAPID, no third-party relay) for what needs them (an approval or question waiting, a failed task, a budget reached, an agent's notify), delivered by Orca's rules (nothing while the owner is looking at a pap tab, mute, burst cooldown) with a quiet-hours digest, and pap installs as a PWA (manifest, PNG icons, hand-written service worker, update flow) on Safari 16.4+/Chrome/Firefox, with the connection supervisor and the phone screens of decision 32 finished.

**Architecture:**
- A new daemon module `push` in two disjoint halves behind one `PushTransport` port: **transport** (VAPID keys, subscriptions, RFC 8291 encryption on `node:crypto`, the guarded HTTPS sender; the transport owns the encryption) and **delivery** (events, per-target deliveries, presence, rules, outbox handlers `push.send` / `digest.send`, sources). Everything that can notify goes through one `PushNotifier.notify(event)`; the rules decide send / suppress / hold; the outbox (spec C 6.2) carries the delay (60 s for approvals), the replay safety, the per-target retry and the digest.
- The composition is split by chain: `compose-push-transport.ts` (chain A only), `compose-push-delivery.ts` (chain B only) and `compose-push.ts` (written by task 1 and the join only; it calls the two).
- The web side adds a hand-written service worker (`apps/web/sw/sw.ts`, one classic-script file with its own tsconfig and size line), a manifest with PNG icons rendered from the L4 logo sources by the controller, a lazy client push runtime, Settings > Notifications, the `/n/<id>` landing route, a small eager presence heartbeat, and the supervisor gaps. Phone screens already exist (`MobileShell`, `BottomNav`, `ConnectionBanner`, `LaneScreen.phone`); M12 audits them against decision 32 and fills only the gaps.
- Three chains after a two-task base, **one join** (task 20) and a docs/ADR sweep (task 21).

**Tech Stack:** Node 24 (`node:crypto` ECDH/HKDF/AES-GCM/ES256, `node:https`, `node:sqlite`), zod 4.6.5 (existing), Hono (static routes, existing), React 19 + Vite 8 (existing), vitest. **No new dependency of any kind** (owner n3: no `web-push`; owner n8: no icon rasteriser).

**Specs and rulings:**
- `docs/specs/2026-10-10-A-product-scope.md` D17, D19 (and the success criteria); `docs/specs/2026-10-10-C-architecture.md` 3 (HTTPS, public `/sw.js`), 4.5 (routes), 6.2 (outbox: `push.send`, `digest.send` replay-safe), 6.4 (quiet hours batch pushes), 7.3 and 7.4 (Safari 16.4 floor, hand-written service worker, feedback timing), 8, 8.1, 9.
- `DESIGN.md`; board `docs/design/explorations/12-mobile-system.html` (captions "1 - Mobile (PWA)": Approbation depuis un push, Thread d'agent, Review d'une lane, Inbox; "2 - Ecrans systeme", including the reconnecting state "Le daemon ne répond plus. Nouvelle tentative dans 8 s ... Réessayer"); decisions 3, 14, 32, 42, 75, 87, 90 to 93.
- Rulings carried: M3R44 and M3 E2 (PNG favicons, Apple touch and PWA icons, the 44 px rule moved to M12), M10R6 (`inQuietHours`, "M12 uses it for pushes"), M10 Settings note (`settings-automation.ts:18`, "Coming soon: notifications that wait for the end of the window": replaced in task 17), M11R100 ("M12 adds the push from the same item" as `agent.notify`), M11R137 / M11b (child approvals answered in the parent), decision 90 a3/a4 (an isolated task's question waits 10 minutes in the Inbox, then is denied; `agent.notify` and `agent.approve` run without asking after external content), M11a I1 (a browser-only action unreachable by a token), M11a I2 (trace the production wiring), M11b M3 (a token-readable result carries no content), MC34 (sign-out resets every store), MC57 (no raw remote responses in logs), W5-R57 (French with vous).
- References read: pi-web `lib/web-push.ts` (read-only; its trap: Apple answers 403 `BadJwtToken` to an invalid VAPID `sub`; `urgency: high` because iOS defers lower urgencies), pi-web `public/sw.js` (an 8 s navigation timeout: a reachable port backed by a dead upstream never answers), Orca `src/shared/notification-burst-cooldown.ts` (5 s per dedupe key, 50 keys max) and `src/main/notifications/notification-delivery-service.ts` (suppress when focused, mute), T3 `packages/client-runtime/src/connection/supervisor.ts` (backoff reset after a stable period, an immediate reconnect after a mobile resume, a manual retry).

**Carried items absorbed:** M3R44 + E2 (icons), M10R6 (quiet hours), M10 Settings copy (task 17), M11R100 (agent.notify push), the M10 Inbox push sources, decision 32 (mobile and system screens), T3 supervisor rules (D19), Safari floor pin (`browser-floor.test.ts` stays green), the project-home final review's "composer auto-focus raising the phone keyboard (§3.1, M12)" and its ledger's T9 "phone logo / '+' touch-target sizing unverified" (both named rows of task 19's audit).

**Explicitly deferred (with reason):**
- Inline actions in a push (decision 32: none). Answering happens in the opened card.
- Offline use beyond the shell (no offline data, no background sync): pap is a live-connection app; the cache holds shell assets only.
- Push for other users (pap has one owner in v1; the tables carry `owner_id` so a second user needs no migration).
- A `pap push` CLI and rotating the VAPID key from the UI (recovery: delete the key file, restart; every device re-enables when it next opens pap, M12R4, M12R12).
- Browser e2e of the install and the push (decision 42: M13). Replaced by int + Node unit tests; the owner checks by hand (see "Exit criteria").
- Badging API / app-icon badge count, notification sounds beyond the OS default.
- A push for a failed trigger-level effect (a feed poll failing, a `task.start` effect failing through `outbox.onFailed`): no Inbox item and no landing target exist for it. Recorded in "Deferred minors" (M12-RT-32) and in `docs/agents/notifications.md` as a known limit.
- Hardening `egress`'s `blockedAddress` with the documentation and Teredo ranges: M11's egress tests use `198.51.100.x` and `203.0.113.x` as their "public" fixtures, so the push module gets its own stricter check (M12R20) and the egress change is an M13 sweep item (ADR 0059).
- Dedupe of `kernel/net/address.ts` with `automation/net-guard.ts` (two blocklists remain; M13 sweep, noted in ADR 0059).

## Global Constraints

Binding ones from M10 and M11, restated, then this milestone's:
- 400 lines per file at most, test files included, no baseline. Plan the splits (`methods.ts` is at 386: the push methods live in the new `push-methods.ts`, spread by two lines; `sessions/service.ts` at 400 and `live-session.ts` at 396 are NOT edited by M12; `daemon.ts` at 387, `config.ts` at 353, `outbox/store.ts` at 348, `inbox/service.ts` at 218: grow none of them past 395; extract instead; `config.ts` gets about +15 lines and above 395 `config-push.ts` is extracted, as `config-otlp.ts` was).
- A daemon module imports only `@pap/contracts`, `kernel/` and other modules' `index.ts`. Every RPC method declares a permission in `packages/contracts/src/methods.ts` (here through `push-methods.ts`). RPC handlers decode, call one service method, map typed errors; the browser-only check lives in the service, not the handler (M12R10).
- TypeScript: erasable syntax only; relative imports keep `.ts`. Tests never touch `~/.pi/agent` or `~/.pap`, never use the network, never sleep; timers go through the kernel `Clock`; the outbox is drained with `outbox.drain()`. Tests never name a public host or address.
- UI: tokens from `packages/ui/src/tokens.css` only; no raw colours, no `[...]` arbitrary values, no restyling of `@pap/ui` primitives. Everything visual is customisable in Settings (owner rule). The only ESLint directive is `eslint-disable-next-line <rule> -- <reason>`.
- Every write has a read path; every UI state has a contract field; every new client store is reset at sign-out (MC34); every cap that an outside party can fill refuses when full and never evicts.
- Logs never carry a raw push endpoint (log `h:<12 hex of sha-256>`), a push-service response body, a key, a payload or an event title. A push handler never lets an exception reach the outbox (`outbox_handler_error` would log it, and `ERR_INVALID_URL` carries the raw endpoint): it catches everything and logs an error class only (M12-RT-20). Confirmation and notice copy never claims more than the code does.
- A token never subscribes, lists or revokes subscriptions, reports presence, opens a push, reads `push.config` or writes the `notifications` document (`caller.kind === "session"` only, M12R10). A token-readable result carries no content.
- Browser floor: Safari 16.4 (`browserslist`, `browser-floor.test.ts`). Web Push on iOS works only for a Home Screen install. French copy uses vous.
- Initial bundle: 227.4 KB gzip today, 300 KB CI ceiling until M13. Every M12 screen is lazy. Eager additions: at most +3 KB gzip in total, budgeted per task: 15a 0.7, 15b 0.8, 16 0.4, 17 0.2, 18 0.6, 19 0.3. The service worker is its own file with its own line in `budgets.json`.
- No literal bidi, zero-width or line-separator characters in source or this plan (backslash-u escapes only).
- Conventional Commits; no AI trailer, no Co-Authored-By.
- **Heavy gate rule** (two slots shared by every lane of M12, M6b and the models batch): a slot is held for `pnpm build`, any `test:int` (the `build-output` filters included) and a full `test:unit`. Filtered unit runs, lint and typecheck run without it. J1's full gate and M6b's join gate are the only long holds and never run at the same time; a join never holds both slots. Web-only tasks run the filtered unit gate, build and budgets; `test:int` runs only for runtime tasks and at joins (the web chain's `build-output.pwa` filter is the one exception, a short hold).

## Review Focus

Input classes the spec implies but the tasks' main tests would not exercise; each is pinned by a named test in the owning task:
1. **A push with a malformed or empty payload must still show a notification** (iOS revokes a subscription whose push shows nothing): task 14, `push.malformed.shows-generic`.
2. **An approval answered or withdrawn inside the 60 s must never push; one answered between enqueue and send must not either; a worker that dies with an open approval must not push either:** tasks 9a, 10, 11, `approval.answered-in-window`, `approval.worker-exit-cancels` (cancel by key AND re-check at send).
3. **A signed-out, revoked or expired device keeps a subscription row:** tasks 5 and 9a, `send.skips-dead-session` plus a mutation proving `sessionLive` is consulted.
4. **The VAPID file is present but damaged, a link or group-readable:** task 3, never regenerate over it (that orphans every subscription); push goes off with a visible reason. A file that is simply missing is the owner's deliberate reset or a plain restore: a new pair is minted and the old rows are purged and reported (tasks 3, 5).
5. **Quiet hours across midnight and a DST change; the digest of items resolved or expired meanwhile:** task 9b, `digest.skips-resolved`, `digest.counts-expired`, `quiet.end.dst`.
6. **A task asking a second question, and marking an item read:** tasks 8 and 10, `second-question-pushes-again`, `mark-read-pushes-nothing` (the dedup keys of the outbox, the events and the Inbox must not collide).
7. **A stale or idle focus must not silence an approval for good:** tasks 9a, 15b, `focused.recheck`, `presence.idle-is-not-looking`.
8. **After a re-login or a key reset, pushes must come back by themselves:** task 15b, `rebind.refreshes-credential`, `rebind.key-changed-reenables`.

## Conflict scan

**Between M12 tasks** (pairs that share a file or an interface; the chains touch disjoint files except where named here):

| Shared file or interface | Tasks | Resolution |
|---|---|---|
| `packages/contracts/src/{push.ts,push-methods.ts,methods.ts,settings.ts,errors.ts,index.ts}`, web `error.*` copy | 1 only | Complete contracts in task 1; no later task edits contracts. A need found later is a fix commit on the base before the chains continue. |
| `apps/daemon/src/modules/push/{index.ts,rpc.ts,service.ts}` (the ports) | 1 only | Two sub-directories with their own barrels (`transport/index.ts` is chain A's, `delivery/index.ts` is chain B's) and their own rpc files; `push/index.ts` and `push/rpc.ts` only merge them (task 1). |
| `compose-push.ts` | 1 and 20 only | Chain files `compose-push-transport.ts` (A) and `compose-push-delivery.ts` (B) are written by the chains; `compose-push.ts` calls both with the stubs of task 1 and is edited again only at the join. Chain A int tests boot the real transport side with the stub delivery side; chain B int tests boot the real delivery side with `createFakeTransport` and `createMemorySubscriptions` through the daemon test-bed's `push` seam (task 1). |
| `push_meta` table | A reads (`last_failure`, `keys_reset`), B writes `last_failure`, A writes `keys_reset` | One table, disjoint keys, created by task 1. |
| `migrations/202610172000_push.sql` | 1 | Four tables, one migration, full SQL below. |
| `kernel/outbox/store.ts` (kinds) | 1 | Additive: `push.send`, `digest.send`. |
| `modules/inbox/{service.ts,agent-items.ts}`, `automation/index.ts` (one additive field) | 10 | One task. |
| `modules/auth/index.ts` (`sessionLive`) | 5 | One task. |
| `runs/index.ts` (additive spend read) | 12 | One task. |
| `apps/web/src/i18n/{en.ts,fr.ts}` (eager) | 16 only (chain A) | Every other task adds a lazy catalog with its own register file: 15a `pwa.*`, 15b `push.*`, 17 `notifications.*`, 18 `landing.*`, 19 `mobile.*`. |
| `apps/web/src/routes/shell/use-shell-effects.ts` | 15b then 18 | Same chain, sequential. Presence starts here, never in `runtime/index.ts`. |
| `apps/web/src/runtime/{connection.ts,index.ts}`, `ConnectionBanner.tsx` | 16 only | Task 15 stays out of them; task 19's audit reads them but does not edit them. |
| The approval card (`ApprovalCardFor`) | 18 only | Task 19's audit does not edit it. |
| `budgets.json`, `scripts/check-budgets.ts`, `knip.json`, `apps/web/package.json` (`typecheck` line), `vite.config.ts`, `apps/web/sw/tsconfig.json` | 14 | Chain C only. |
| `apps/web/src/build-output.pwa.int.test.ts` (new; split out of the 279-line `build-output.int.test.ts` now) | 13 creates, 14, 15a, 15b, 17, 18 append | Chain C, sequential. `build-output.int.test.ts` itself is not edited. |

**With M6b (planned in parallel; additive edits only, whole lines; agreements of 2026-10-17):**

| File or interface | M12 touches | M6b touches | Rule |
|---|---|---|---|
| `apps/daemon/src/cli/*`, `cli/usage.ts` | nothing | `doctor`, `backup`, `restore`, `update`, and `cli/doctor/checks-push.ts` (T11, after rebasing on M12) | M12 adds no CLI file. |
| `package.json` (root scripts) | nothing (owner n8: no icon script) | `build:image`, `build:npm`, `release:assets`, `release:check` | whole lines. |
| `knip.json` | one entry for `sw/sw.ts` | `ignoreBinaries` | whole lines. |
| `pnpm-lock.yaml` | nothing (no dependency, owner n3 and n8) | nothing | never hand-merged. |
| `.gitignore` | nothing | whole lines | |
| `AGENTS.md` (150 lines at most in total) | task 21 adds at most 6 lines | at most 6 lines | M12 merges first; the second one recounts. |
| `docs/agents/daemon.md` | task 21: one pointer line to `notifications.md` | install/doctor lines | different sections. |
| `docs/agents/install.md`, `run-cli.ts`, `usage.ts` | nothing | M6b only | |
| `apps/daemon/src/kernel/config.ts` | `PAP_PUSH_SUBJECT`, `PAP_PUSH_EXTRA_HOSTS`, fenced `PAP_TEST_PUSH_LOOPBACK` (about +15 lines; above 395 extract `config-push.ts`) | nothing: `piAgentDirFrom` goes in M6b's new `kernel/pi-dir.ts` | |
| `apps/daemon/src/kernel/push-readiness.ts` (task 2) | creates the pure `pushReadiness(facts)`, re-exported by `push/index.ts` | **consumes** it in `pap doctor` through `listenFacts(unit, env)` (`cli/doctor/`), which produces `{ publicOrigin, tls, insecureHttp }` like `loadConfig` | one HTTPS truth; the CLI imports the kernel file, not the push module. |
| `$PAP_HOME/secrets/push/vapid.json` (0600, dir 0700) | creates | doctor `push` check; **excluded from plain backups like the rest of `secrets/`** (owner c5, b1); with `--secrets include --encrypt` it is restored at 0600 | M12 strikes its old "backup must include it" and "NOT sensitive" claims: `state.db` plus this key lets the holder push arbitrary text to the owner's devices. |
| `state.db` table `push_subs` | creates | backup copies via `VACUUM INTO` | nothing to do. |
| `packages/contracts/src/{methods,permissions,errors,streams,index}.ts`, `methods-idempotent.ts`, `daemon.ts`, `compose*.ts`, `eslint.config.js`, `budgets.json` | additive lines | M6b touches none of these | |
| ADR numbers | 0058 to 0062 | 0063 to 0067 (models batch 0068 to 0070) | disjoint. |
| Migrations | `202610172000_push.sql` | none | M6b has no migration; M12 re-stamps only if a later stamp has landed before it merges. |
| Decisions log | the plan fix appended **93** (M12 + M6b owner answers and both plans); the models batch's plan fix appends 94 | none | |
| i18n catalogs | M12's only | none | M6b adds no i18n. |
| Error codes | adds `push_unavailable` | adds no contract code (CLI exit codes are a separate space) | |
| OCI image (M6b docs) | push needs outbound HTTPS and DNS from the container and the `$PAP_HOME` volume for `secrets/push/` | documents it | task 3 fixes the temp-file collision under a fixed PID. |
| Service worker and updates | the SW precaches every build asset and passes `/healthz` and every API path through; the client calls `registration.update()` after a reconnect | `pap update apply` and its rollback replace `dist` under an open PWA; changes nothing in the web code | M12's "La page a une mise à jour" banner is about the web shell; M6b's release banner is after v1. The copy keeps the two apart. |

**The doctor status table (one source, M12's statuses; M6b writes the doctor files):**

| Status | Doctor result |
|---|---|
| `ready` | ok |
| `localhost_only` | ok (info) |
| `insecure_http` | warn |
| `origin_mismatch` | warn |
| `keys_unreadable` | warn |

Push is never `fail`. The check ids are `https` (from `pushReadiness`) and `push` (from the key file): `secrets/push/vapid.json` absent is ok ("created at the first start"); a regular file with mode 0600 in a folder with mode 0700 is ok; anything else warns "push is off (keys_unreadable)" with the fix "chmod 600 ..., or delete the file to start over (each device re-enables)". The anchors `docs/agents/notifications.md#https` and `#keys` come from task 21.

**`pushReadiness` interface (agreed with M6b's doctor):**
```ts
// apps/daemon/src/kernel/push-readiness.ts (pure, no I/O; re-exported by push/index.ts)
export type PushReadiness =
  | { status: "ready"; origin: string }
  | { status: "localhost_only"; origin: string; hint: string } // http://localhost: secure context, push works on this machine only
  | { status: "insecure_http"; origin: string; hint: string }  // --insecure-http on a LAN address: push and install are off
  | { status: "origin_mismatch"; origin: string; hint: string }; // TLS served but PAP_PUBLIC_ORIGIN is http
export function pushReadiness(facts: { publicOrigin: string; tls: boolean; insecureHttp: boolean }): PushReadiness;
```
The hint names the routes in this order: the ngrok HTTPS origin the owner already runs (decision 75, `PAP_PUBLIC_ORIGIN`), Tailscale serve, a reverse proxy through `PAP_PUBLIC_ORIGIN` (no `X-Forwarded-*` is read, R72: there is no `trustProxy`), then `--tls-cert/--tls-key`. The same function feeds the Settings banner (task 17) through `push.config`.

## The lane graph

```
 B1 contracts + migration + stubs + compose split (1) --> B2 net-address move, readiness, test kit (2)
                                                              |
        +-----------------------------------------------------+------------------------------------------+
        |                                                     |                                          |
 Chain A  transport (daemon + one web task)            Chain B  delivery (daemon + one web task)     Chain C  web (PWA)
 3  VAPID keys                                         8   events, presence, rules, copy             13 manifest, icons, static
 4  endpoint + key validation                          9a  push.send per target (retry, dead dev.)   14 service worker
 5  store + rpc (subscribe/list/revoke/config)         9b  quiet hours, digest, housekeeping, test    15a SW registration, update flow, pwa store
 6  RFC 8291 encryption                                10  sources I: Inbox                          15b push client, support, presence, rebind
 7  guarded sender + fake push service                 11  sources II: sessions, presence, open      17 Settings > Notifications
 16 supervisor gaps (web, after 7)                     12  sources III: budgets                      18 /n/<id> landing + approval card
                                                       19  mobile conformance (web, after 12)
        |                                                     |                                          |
        +-----------------------------------------------------+------------------------------------------+
                                                              |
                                    JOIN J1: 20 integration (production wiring, decrypt e2e, restart, keys, full gate)
                                                              |
                                          21 docs, ADRs, rulings, sweep (lint and docs only)
```

- **Moves (owner c4):** task 16 (supervisor) moves to chain A after task 7 (its files are `runtime/connection.ts`, `runtime/index.ts`, `ConnectionBanner.tsx` and the eager `i18n/en.ts` and `fr.ts`, shared with nobody once task 15 starts presence from `use-shell-effects.ts`); task 19 (mobile fills) moves to chain B after task 12 (its files are disjoint from 13 to 18).
- **One join** (J1 = task 20): the production compose wiring (M11a I2), the decrypt end to end through the real HTTPS sender and the fake push service, token-cannot, restart recovery, the keys boot cases, cursor resume, the built `dist` and the full gate. Chains A and B meet only through the `PushTransport` and `SubscriptionsPort` ports, chains B and C only through the contracts of task 1, so no mid-chain join is needed. The int flows that need only one chain live in that chain's own int test.
- **Files the chains share:** none that two chains edit. They share read-only the contracts (task 1), the ports (`push/service.ts`), the `push_meta` and `push_subs` tables (A writes `push_subs`, B reads through the port), and the test kit of task 2. The named hot files are in the conflict scan above.
- **ETA** (1.25 h per task with its reviews; 1 h for small ones, 1.5 h for security, runtime and large ones): base 2.5 h (tasks 1 and 2); chain A 8 h (3, 4, 5, 6, 7, 16); chain B 9.5 h (8, 9a, 9b, 10, 11, 12, 19); chain C 8 h (13, 14, 15a, 15b, 17, 18); J1 = 1.5 h + a 45 min full gate; task 21 = 1 h.
- **Critical path:** B1 -> B2 -> chain B (the longest, 9.5 h) -> J1 -> 21 = 2.5 + 9.5 + 2.25 + 1 = about 15.3 h nominal. Chains A and C finish about 1.5 h earlier and wait. The honest figure is **16 to 18 h**, about 2 days of wall clock with M6b's two lanes sharing the two heavy slots (add 10 to 15 percent for gate queueing). Task 19 is the elastic piece: if chain B runs long, the controller may start its audit step (read-only) earlier.

## Pre-dispatch rulings (shared by several tasks)

- **M12R1** [D17, C 6.2; M12-RT-01] **One notifier, outbox for time.** Every source calls `PushNotifier.notify({ ownerId, cls, refKind, refId, name?, at? })`. The event id is `randomToken(16)` (22 base64url characters; `newId()` is a UUID, which the wire regex, the SW and `/n/` all refuse). `notify` inserts the `push_events` row and `enqueueEffect({ kind: "push.send", dedupKey: "push.send:" + eventId })` in ONE transaction and rolls both back when the insert hits the live-key index (a live event for the same ref: no-op) or when `enqueueEffect` returns null. The event's own `dedup_key` is `push:<cls>:<refKind>:<refId>` and is unique only while the event is `pending` or `held` (partial index); the outbox key never carries it, so the outbox's global `UNIQUE dedup_key` (7 days of history) cannot swallow a later push. `cancel(refKey, reason)` finds the live **pending** event and calls `outbox.cancel("push.send:" + id)`; a `held` event is judged at digest time (M12R17). `onItem` fires only where an Inbox row is inserted, re-opened or resolved, never from `markRead` (M12R22). Approval-class events are enqueued with `at = now + 60 000`; every other class with `at = now`. The handler re-decides at send time. Cost if wrong: a push lost for good, or repeated.
- **M12R2** [D17; owner n4] **Classes and defaults** (on by default marked ON): `approval` (an interactive approval or question: a waiting session, and the Inbox kinds `agent_approve`, `secret_request`) ON, 60 s; `failed` (`task_failed`, `task_interrupted`) ON, immediate; `budget` (owner-wide daily budget reached, per-agent budget reached) ON, immediate, once per scope per day; `notify` (`agent_notify`, M11R100, already rate-limited 30 an hour per agent) ON; `done` (`task_done`, `task_limited`) OFF; `reply` (`agent_reply`, `delegation_done`) OFF; `review` (`memory_review`) OFF. Each class is a toggle in Settings > Notifications. **One key per waiting session** (M12-RT-02): a task session's question reaches push twice (the attention feed and the Inbox's `task_needs_input` item); both map to `push:approval:session:<sessionId>`, so one push is sent. Cost if wrong: noise or silence; the toggles make it cheap to change.
- **M12R3** [D17, Orca; owner n5, n9] **Delivery order** (`decide()`, pure, task 8): class off -> `suppress:class_off`; muted (`muteUntil > now`) -> `suppress:muted`; a present device of this owner -> `focused` (M12R11); cooldown on the dedupe key (5 s, Orca; map of 256 keys, refuse when full of fresh keys = suppress) -> `suppress:cooldown`; the hourly cap of 20 pushes an owner, which **approvals are exempt from** (a flood of `failed` pushes from a looping trigger must not hide a real approval; real dialogs bound approvals) -> `suppress:rate_cap`; quiet hours (`inQuietHours` on `settings.automation(ownerId).quietHours` in the owner's `timezone`) -> `hold`. A suppressed event keeps its Inbox item (the Inbox is always the record). An approval suppressed by `focused` is not final: the handler defers a re-check by 60 s while the approval still waits, at most 3 times (`rechecks` column), then settles `suppressed:focused`. Cost if wrong: a missed or duplicated push.
- **M12R4** [D17; M12-RT-06, M12-RT-17; owner c5] **VAPID identity**: one P-256 key pair per `$PAP_HOME`, in `$PAP_HOME/secrets/push/vapid.json` (dir 0700, file 0600), created with `O_CREAT|O_EXCL|O_NOFOLLOW` through a random-suffix temporary file and `link()` (never overwriting a concurrent writer; the `known-device.ts` pattern, copied not imported), never logged. Every subscription row stores `key_id` (first 8 bytes of SHA-256 of the public key, hex). A damaged, linked or too-open file does NOT regenerate: push is `off` with reason `keys_unreadable` (visible in Settings and `push.config`), and any error while creating the file also means push off with a reason, never a boot crash. A missing file is a first boot, the owner's deliberate reset or a plain M6b restore (`secrets/` is excluded from plain backups, owner c5, b1; with `--secrets include --encrypt` it comes back at 0600 and push continues): a new pair is minted, the rows whose `key_id` differs are purged at boot, the count is logged and kept in `push_meta` (`keys_reset`) so Settings shows "Les notifications ont été réinitialisées" until a device subscribes again. Devices re-enable when they next open pap (M12R12). Cost if wrong: silently orphaned subscriptions.
- **M12R5** [D17, pi-web; M12-RT-18] **VAPID `sub`**: `PAP_PUSH_SUBJECT` if set (`https:` or `mailto:` URL, validated in `config.ts`), else `PAP_PUBLIC_ORIGIN` when it is `https:`, else the fixed project URL `https://github.com/soulkyu/pi-agentic-platform` (the `localhost_only` case: an `http://localhost` origin is not a valid VAPID subject). Never a made-up `mailto:`; Apple rejects invalid subjects with 403. JWT `exp` = now + 12 h (under the 24 h limit), cached per audience for 6 h.
- **M12R6** [D17; owner n3] **Encryption on `node:crypto`**, about 150 lines in `transport/encrypt.ts`, pinned by the RFC 8291 test vector, no `web-push` dependency (the tree for ECE/JWT/HTTP would have to be wrapped anyway to enforce the guarded DNS lookup, the deadline and the no-redirect rule). **The transport owns the encryption**: `PushTransport.send(target, plaintext, ...)` encrypts inside; no caller seals. Cost if wrong (crypto bug): every push is undecryptable; mitigated by the vector and a round-trip decryptor in the test kit.
- **M12R7** [D17; owner n2; M12-RT-09] **Payload content**: by default the wire payload is `{ v: 1, id, cls, title, body, ts }` with `title` = "pap" and `body` a fixed generic sentence per class (French with vous, English), plus an opaque 22-char id; no agent name, task name, command or path. With the Settings option `titles: "names"` (off by default) the body adds a NAME that comes only from the trigger registry (`trigger_name`, written by the owner) or the agent registry (the agent's name), stripped of controls/Cf/Zl/Zp and cut to 60 code points. It never comes from a task `title`, an Inbox `triggerName` fallback, a payload, a model output or a remind/delegate title (those can be agent- or webhook-chosen); when no registered name exists the text stays generic. Never a command, argument, file path, secret, error text or free title. The Settings helper says exactly that. The details are fetched after the click (`push.open`). Cost if wrong: untrusted text on a lock screen. Board 12's push mock shows the agent and the question text; the owner chose the generic default with this one option (n2), so the board differs on purpose.
- **M12R8** [C 3; owner n1; M12-RT-19, M12-RT-25] **Endpoint rules** (task 4): `https:` only, no credentials, port 443 or none, no fragment (an empty `#` included), no IP literal in any spelling, no empty host label, at least one dot, at most 2048 chars, and the host must match the built-in push-service list (Apple `*.push.apple.com`, Google `fcm.googleapis.com`, Mozilla `*.push.services.mozilla.com`, Microsoft `*.notify.windows.com`) plus the exact names of `PAP_PUSH_EXTRA_HOSTS` (parsed in `config.ts` with the other env: at most 8, each validated with the same shape rules). There is no "list off" switch. At send time the connection goes through a guarded lookup (every DNS answer must be public by `blockedForPush`, one private answer refuses the name; the socket connects to the address that was checked). Cost if wrong: SSRF with a browser-chosen URL.
- **M12R9** [D17; owner n7, n9; M12-RT-16] **Caps**: 10 subscriptions per owner (owner n7; refuse with `capacity`, never evict; re-subscribing the same endpoint refreshes the row and does not count), 64 presence entries in total (refuse `capacity`), `push.subscribe` one call per 6 s per owner (10 a minute, the shape `kernel/rate-limit.ts` allows: one call per window) and `push.test` one per 10 s per owner, both in the service. Hourly push cap: M12R3.
- **M12R10** [M11a I1, M11b M3; M12-RT-16] **Browser only**: the service's `requireBrowser(caller)` throws `forbidden` when `caller.kind !== "session"`, before any read, for every `push.*` method (`push.config` included). The handlers only decode and call. `push.list` never returns an endpoint, a key or a payload; it returns the push-service host only. The `notifications` settings document is not writable by a token (M10R162 pattern). Cost if wrong: a token enrols its own relay, mutes every push, or learns when the owner is away.
- **M12R11** [C 4.x; owner n5; M12-RT-08] **Presence is heartbeat, not connection tracking** (no kernel ws change): a browser tab calls `push.presence { focused }` every 20 s while the connection is open, on focus/blur and on visibility change, and best-effort `focused: false` on `pagehide` and `visibilitychange` to hidden. `focused` is true only when the tab is focused, visible and had user input in the last 2 minutes; an idle focused desktop tab does not silence the phone. An entry is fresh for 45 s (Clock). A tab that dies or an iOS-killed PWA lapses by itself. "No tab open" = no fresh entry; "looking" = a fresh entry with `focused: true`. Cost if wrong: pushes while the owner is looking, or none when a dead or idle tab "holds" presence.
- **M12R12** [D17; M12-RT-06] **Nothing is sent to a dead session, and live devices re-bind themselves**: a subscription row keeps the `credential_id` (browser session public id) that created it. At send time the handler asks the auth port whether that credential is still live (`sessionLive(ownerId, credentialId)`); if not, the row is deleted and nothing is sent. 404 / 410 from the push service delete the row. Sign-out also unsubscribes this device client-side (task 15b). At each start with permission granted the client calls `getSubscription()`: when its `applicationServerKey` differs from `push.config.publicKey` it unsubscribes and shows a one-tap "Réactiver les notifications" (gesture-safe on iOS); otherwise it calls `push.subscribe` (a refresh that binds the row to the current credential). So a re-login, a VAPID reset or a plain restore recovers when the device next opens pap. Cost if wrong: pushes that stop silently.
- **M12R13** [C 6.2; M12-RT-04] **Per-target delivery, retried, never marked sent** (the recommended option of RT-04; it replaces the old "at-most-once"): `push.send` keeps one `push_deliveries` row per event and subscription. It never calls `markSent`: a duplicate after a crash is collapsed by the `Topic` header at the push service (RFC 8030 5.4, the event id) and by `tag` on the device, and is better than a lost approval. Each delivery has up to 5 attempts: `retry` outcomes (429, 5xx, connect error, timeout) wait the outbox's backoff (5 s doubling) or the push service's `Retry-After`, whichever is longer (clamped to 1 h); `rejected` (400, 401, 403, 413, 3xx) and `refused` are final for that delivery with a reason class. The handler `defer`s the effect to the earliest pending delivery and settles `done` when every delivery is final, so a dead phone never fills the owner's failures banner (`outbox.onFailed`). The event is `sent` if any target succeeded, else `failed` with a reason class kept in `push_meta` (`last_failure`) and shown by `push.config.lastFailure` (M12-RT-31); never the response body.
- **M12R14** [D19; M12-RT-07, M12-RT-27] **Service worker rules** (security contract, task 14): scope `/`, `updateViaCache: "none"`; intercept only same-origin GET; **precache every emitted `/assets/*` file (lazy chunks included, from the bundle) plus `/index.html`, `/`, `/favicon.svg`, `/manifest.webmanifest` and the icons**, so an old shell keeps its lazy chunks after `pap update` replaces `dist`; the build id is the hash of the content hashes of every shell file (a manifest or icon change updates the worker); never cache `/auth`, `/api`, `/files`, `/upload`, `/hooks`, `/metrics`, `/healthz`, `/ws`, `/sw.js`, any other API path, or any response with `Cache-Control: no-store|private`, a redirect, a non-200 or a non-basic type; navigations are network-first with an 8 s timeout (a 5xx also counts as down) and the cached `/index.html` as the fallback; no `skipWaiting` unless the page asks (after the owner accepts "La page a une mise à jour"); on activate (of the new worker only) every other `pap-shell-*` cache is deleted. The worker has its own tsconfig (`WebWorker` lib conflicts with `DOM`). Cost if wrong: an authenticated response served to the wrong person, a stranded shell, or a white screen on launch.
- **M12R15** [D17] **notificationclick** opens only `new URL("/n/" + id, self.location.origin)` where `id` matches `^[A-Za-z0-9_-]{22}$`; a payload without a valid id opens `/`. An existing pap window is focused and told (`postMessage({ type: "open", path })`); otherwise `clients.openWindow`. No URL ever comes from the payload.
- **M12R16** [D19, decision 32] **Plain HTTP**: Settings > Notifications shows "Les notifications et l'installation demandent HTTPS." plus one line from `push.config.readiness.hint`; the enable button is disabled; presence still runs. Over `http://localhost` (secure context) push works for that machine. The service worker is registered only when `window.isSecureContext` and in production builds.
- **M12R17** [D17, C 6.4; owner n6; M12-RT-10, M12-RT-12, M12-RT-23] **Quiet hours and the digest**: events with decision `hold` are stored `held`; one `digest.send` is enqueued (dedup key `digest:<owner>:<endMinute>`) at the first minute outside the quiet window (`nextQuietEnd`, task 9b: scan of at most 1440 minutes with `inQuietHours`, DST-safe). At digest time each held event is judged: waiting still (the Inbox item unresolved, the session still waiting) stays counted; gone is dropped (`cancelled`); gone because the Inbox item **timed out** (decision 90 a3: an isolated task's question is denied after 10 minutes, so in quiet hours it is denied with no push) is counted as expired. ONE generic push is sent: "N éléments vous attendent." and, if any expired, "M demandes ont expiré pendant les heures calmes." (class `digest`, subject to mute and focus, not to quiet hours or cooldown). The digest and every test push get their own `push_events` row (ref kinds `digest` and `test`) so a click lands on the Inbox or Settings > Notifications instead of "n'existe plus". After a restart, a pending approval-class push is `cancelled` and sends nothing (workers died, dialogs closed, requests expired); a pending `failed` or `budget` push is sent once; a `sent` row is not sent again. Cost if wrong: a stale digest, or night-time denials nobody hears of.
- **M12R18** [D17] **Settings document** `notifications` (compare-and-set like `automation`, one document per owner): `{ classes: {approval,failed,budget,notify,done,reply,review: boolean}, muteUntil: number|null, titles: "generic"|"names" }` with the full defaults written out (zod 4: `.default({})` on an object yields `{}`; use `.prefault({})` over the inner defaults, as `AgentsSettings` writes them out). Quiet hours are NOT duplicated: they stay in `automation.quietHours` and `automation.timezone` (M10), with the note in Settings > Notifications pointing to them. A token cannot write it (M10R162).
- **M12R19** [tests] **Fenced test switch**: `PAP_TEST_PUSH_LOOPBACK=1` needs `PAP_TEST_PROVIDER_SCRIPT` (task 1); it only lets the endpoint validator accept `http://127.0.0.1:<port>/...` and the sender's address guard accept loopback.
- **M12R20** [M12-RT-19] **One address check for push, in the kernel**: `modules/egress/address.ts` moves to `kernel/net/address.ts` unchanged (the push module may import only `kernel/`), and the push sender uses `blockedForPush(ip) = blockedAddress(ip) || extraReserved(ip)` where `extraReserved` adds what `automation/net-guard.ts` blocks and `blockedAddress` does not: IPv6 Teredo `2001::/32`, documentation `2001:db8::/32`, discard `100::/64`; IPv4 `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `192.88.99.0/24`. `blockedAddress` itself is not widened because M11's egress tests use `198.51.100.x` and `203.0.113.x` as their public fixtures (hardening the proxy is the M13 sweep, ADR 0059). The older `automation/net-guard.ts` stays untouched. Cost if wrong: an endpoint resolving to a reserved range is reached.
- **M12R21** [C 6.2] **Replay**: `push.send` and `digest.send` are replay-safe kinds (deadline 30 000 ms). Replaying a `push.send` after a crash resumes the pending deliveries only (M12R13).
- **M12R22** [D17; M12-RT-01, M12-RT-02, M12-RT-09] **The Inbox is the single source for everything except interactive approvals and budgets**, so a new Inbox kind needs one line in task 10's table. `onItem(listener)` reports `created`, `reopened` and `resolved` from the call sites that insert, re-open or resolve a row, never from `markRead` or a re-announce. Push never reads `detail` (the untrusted agent text) in v1: not even with `names`.
- **M12R23** [D17, decision 32; M12-RT-02, M12-RT-03] **Interactive approvals come from the attention feed**: `SessionsAutomationPort.onAttention(sessionId, needsInput)` (the shell publisher's flush, already parent-aware: `needsInput` is true for a session whose own dialog or whose child's dialog waits) -> `notify({ cls: "approval", refKind: "session", refId: sessionId })`; false -> `cancel(key, "answered")`. This needs no edit to `live-ui.ts`, `live-session.ts`, `children.ts` or `service.ts` (the last two are at or near 400 lines). `stillWaiting` for a session ref is "the source's own waiting set (fed by the attention feed) contains the session and the session row still exists, unarchived" (a worker exit closes its dialogs through `ui.clear()` and the next flush reports `needsInput: false`; a test pins it). The question text is never in the payload. Every approval-class target with a session opens that session's card (decision 32: "push -> full-width approval card"); Inbox targets stay for `agent_approve` and `secret_request`, whose `AgentInboxRow` has answer buttons.
- **M12R24** [M11b; M12-RT-03] **Child approvals**: the old assumption (the child's dialog is published on the parent's thread) is verified FALSE: `children.ts` publishes a child's dialogs on the child's own session and the parent only receives a `subagents` event. What holds: `children.published` marks the parent changed, so the shell publisher's `needsInput` for the parent includes `child.waiting(parentId)` (`sessions/service.ts:80`) and the attention feed reports the PARENT. Recorded as verified; task 11 pins it with a test (a child's open approval produces one push whose target is the parent session).
- **M12R25** [owner n10] **Budgets push on reached, not on 80 percent**: KISS, and the budget gate already stops runs at the limit; an 80 percent warning is a follow-up if the owner asks.
- **M12R26** The budget check runs at run end, plus once at boot for the current day so a daemon restart after the budget was reached cannot lose it; a budget of 0 pushes nothing because "no run could start" is not news.
- **M12R27** [M3R44; owner n8] **Manifest and icons** are public static files like `/favicon.svg`; they carry nothing user-specific, so no auth route change; the daemon's static handler already types `.webmanifest` and `.png` and answers `no-cache` for non-assets. The PNG icons are rendered ONCE by the controller from the three SVG sources in `apps/web/icons-src/` with the Playwright podman image (the headless host has no graphics) and committed; the repository has no icon script and no new dependency.
- **M12R28** [D19] **Service worker build**: one classic script produced by type stripping; see task 14.
- **M12R29** [D19] **iOS**: `needs_install_ios` when `isIos && !standalone` with the copy "Ajoutez pap à l'écran d'accueil (Partager, puis Sur l'écran d'accueil), puis activez les notifications ici."; the permission request is made only from the enable button's click handler, never at load.
- **M12R30** [D19; M12-RT-07] **Update flow**: `updatefound` -> new worker `installed` with a controller present -> `pwa` store `updateReady = true` -> the lazy banner "La page a une mise à jour" with a Reload button that posts `skip-waiting`, waits for `controllerchange`, reloads once (guard against loops with a `sessionStorage` flag). The page calls `registration.update()` on every reconnect and on `visibilitychange` to visible (an open PWA never navigates, so the browser would never check), and on `vite:preloadError` (a lazy chunk 404 after a rebuild) shows the banner or reloads once. The old shell keeps working until the owner accepts. This banner is about the web shell, not a pap release (M6b's release banner is after v1).
- **M12R31** [D19] **Supervisor polish is client-only** (no change to the wire or the daemon); proven by unit tests with fake sockets and timers plus the existing daemon cursor int tests, run again at J1.
- **M12R32** Every Settings state has a contract field (`status`, `reason`, `readiness`, `subscribed`, `max`, `lastFailure`, `keysReset` from `push.config`; `current` from `push.list`); no client-side guessing.
- **M12R33** The id of `/n/<id>` is never used as a path outside `push.open`; target ids come from the daemon and are passed to the router as data; an id that fails `^[A-Za-z0-9_-]{22}$` is a `not_found` without an RPC.
- **M12R34** Mobile fills: fill only what the audit proves missing, at most three beyond the two named carries, with the board element named in each commit; where the board and the specs disagree the task stops and the controller raises an owner question, never picking silently; every fill goes through tokens and the existing primitives; new strings are lazy-catalog entries.
- **M12R35** [owner c1; agreements 1 to 12] **Merge order**: M12 merges first, M6b rebases (M6b has no migration). If the order ever flips, M12 re-stamps `202610172000_push.sql` only if a later stamp has landed. Shared files are edited as whole lines only (conflict scan).
- **M12R36** [owner c2] **Opus escalation at fix rounds 4 and 5 is pre-approved** for this wave (M12, M6b, models batch): the controller may use an Opus implementer there without asking again. Nothing else changes in the model table.
- **M12R37** [owner c4] **Lanes**: task 16 is in chain A (after 7) and task 19 in chain B (after 12); the compose is split by chain and the port is complete in task 1 (M12-RT-05).
- **M12R38** [agreements 2, 3] **One HTTPS truth**: `kernel/push-readiness.ts` is the only place that classifies origin, TLS and `--insecure-http`; M6b's doctor maps its statuses with the table above.
- **M12R39** [M12-RT-30, M12-RT-31] **Read-only database**: when the database is read-only (written by a newer pap) the sources do not listen, `push.config` says `reason: "read_only"` with `status: "off"`, and `push.subscribe` answers `read_only` (the Inbox's rule). `push.config.lastFailure` is the read path for delivery failures.

---

## Task 1: Contracts, migration, module skeleton, compose split (base)

**Chain:** base. **Model:** Sonnet implementer; Sonnet reviewer. **Gate:** unit + int + build.

**Files:**
- Create: `packages/contracts/src/push.ts`, `push.test.ts`, `push-methods.ts`, `push-methods.test.ts`.
- Modify (additive): `packages/contracts/src/{methods.ts (import and `...pushMethods`, two lines),settings.ts,errors.ts,index.ts,methods-idempotent.ts,methods.test.ts}`, the web `error.*` copy for the new code in en and fr (find with `rg sandbox_unavailable apps/web/src/i18n`).
- Modify: `apps/daemon/src/kernel/outbox/store.ts` (kinds), `apps/daemon/src/kernel/config.ts` (+ `config.m12.test.ts`; extract `config-push.ts` if it would pass 395 lines), `apps/daemon/src/modules/settings/service.ts` (`notifications(ownerId)` read, token write refused).
- Create: `apps/daemon/src/modules/push/{index.ts,rpc.ts,service.ts}`, `push/transport/{index.ts,rpc.ts}`, `push/delivery/{index.ts,rpc.ts}`, `push/migrations/202610172000_push.sql`, `apps/daemon/src/compose-push.ts`, `compose-push-transport.ts`, `compose-push-delivery.ts`.
- Modify: `apps/daemon/src/daemon.ts` (3 lines: build and register the module, add its migration source and handlers; plus the test-bed option `push?: PushSeams` passed to `compose-push.ts`, never set by `main.ts`).

**Interfaces (produces):**
```ts
// contracts/push.ts
export const PUSH_CLASSES = ["approval","failed","budget","notify","done","reply","review"] as const;
export const WIRE_CLASSES = [...PUSH_CLASSES, "digest", "test"] as const;
export const PushWire = z.object({ v: z.literal(1), id: z.string().regex(/^[A-Za-z0-9_-]{22}$/), cls: z.enum(WIRE_CLASSES),
  title: z.string().max(80), body: z.string().max(200), ts: z.number().int() }).strict();
const Classes = z.object({ approval: z.boolean().default(true), failed: z.boolean().default(true), budget: z.boolean().default(true),
  notify: z.boolean().default(true), done: z.boolean().default(false), reply: z.boolean().default(false), review: z.boolean().default(false) }).strict();
// zod 4: `.default({})` over an object with defaults yields {} (run against the repo's zod); .prefault({}) feeds {} through the inner defaults.
export const NotificationsSettings = z.object({ classes: Classes.prefault({}), muteUntil: z.number().int().nonnegative().nullable().default(null),
  titles: z.enum(["generic","names"]).default("generic") }).strict();
export const PUSH_LIMITS = { subscriptionsPerOwner: 10, endpointMax: 2048, labelMax: 80, presenceTtlMs: 45_000, presenceEntries: 64 } as const;
export const PushSubscriptionInput = z.object({ endpoint: z.string().min(16).max(PUSH_LIMITS.endpointMax),
  keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/) }).strict(),
  locale: z.enum(["en","fr"]), label: z.string().trim().min(1).max(PUSH_LIMITS.labelMax) }).strict();
export const PushTarget = z.object({ kind: z.enum(["inbox","session","agent","settings"]), id: z.string().max(128).nullable() }).strict();
// push-methods.ts (permission, idempotent): mutations are idempotent:false with a command id (M1 checklist; auth.devices.revoke is false)
//  "push.config"    (settings:read, true)  {} -> { publicKey: string|null; status: "on"|"off"; reason: "keys_unreadable"|"insecure_http"|"read_only"|null;
//                    readiness: { status: "ready"|"localhost_only"|"insecure_http"|"origin_mismatch"; hint?: string }; subscribed: number; max: number;
//                    lastFailure: { at: number; reason: "retry_exhausted"|"rejected"|"refused"|"no_target" } | null; keysReset: { at: number; purged: number } | null }
//  "push.subscribe" (settings:operate, false) { subscription: PushSubscriptionInput } -> { id }  errors: bad_request, capacity, conflict, forbidden, rate_limited, push_unavailable, read_only
//  "push.list"      (settings:read, true)  {} -> { items: { id, label, host, createdAt, lastOkAt: number|null, current: boolean }[] }
//  "push.revoke"    (settings:operate, false) { id } -> { ok: true }  errors: not_found, forbidden
//  "push.test"      (settings:operate, false) {} -> { delivered: number, dropped: number }  errors: rate_limited, push_unavailable, forbidden
//  "push.presence"  (settings:read, true)  { focused: boolean } -> { ok: true }  errors: capacity, forbidden
//  "push.open"      (settings:read, true)  { id } -> { target: PushTarget }  errors: not_found, forbidden
```
`errors.ts` gains `push_unavailable` (the pattern of `sandbox_unavailable`: `ERROR_CODES`, `ERROR_MESSAGES`, and the web `error.*` copy in en and fr; `unavailable` is NOT an `ErrorCode`). The settings fields are `quietHours` and `timezone` of `AutomationSettings`. `settings` gets key `notifications` (`SettingKey` additive). Outbox kinds: `"push.send": "replay-safe"` (deadline 30 000 ms, payload `{ eventId: z.string().regex(/^[A-Za-z0-9_-]{22}$/) }`), `"digest.send": "replay-safe"` (deadline 30 000, payload `{ ownerId: Id, endMinute: z.number().int() }`).
```ts
// push/service.ts (the ports the chains share; the only file both chains import, edited by this task only)
export type SendOutcome = { kind: "ok" } | { kind: "gone" } | { kind: "retry"; afterMs?: number } | { kind: "rejected"; status: number } | { kind: "refused"; reason: string };
export interface SubscriptionTarget { readonly id: string; readonly endpoint: string; readonly p256dh: string; readonly auth: string;
  readonly credentialId: string; readonly locale: "en" | "fr" }
export interface PushTransport { status(): { on: boolean; reason: null | "keys_unreadable" | "insecure_http"; publicKey: string | null };
  /** Encrypts (RFC 8291) and sends; never throws: every failure is an outcome. */
  send(target: SubscriptionTarget, plaintext: Uint8Array, opts: { ttlSeconds: number; urgency: "normal" | "high"; topic: string }, signal: AbortSignal): Promise<SendOutcome>; }
export interface SubscriptionsPort {
  targets(ownerId: string, credentialId?: string): SubscriptionTarget[];  // all of the owner's, or only one credential's (push.test); no side effects
  drop(id: string, why: "gone" | "dead_session" | "foreign_key"): void;
  markOk(id: string, at: number): void;
}
export interface SessionLive { sessionLive(ownerId: string, credentialId: string): boolean }
export type PushRef = { refKind: "inbox" | "session" | "agent" | "budget" | "digest" | "test"; refId: string };
export interface PushNotifier {
  notify(event: { ownerId: string; cls: PushClass | "digest" | "test" } & PushRef & { name?: string; at?: number }): { id: string } | null; // null: a live event for this ref exists
  cancel(refKey: string, reason: "answered" | "expired" | "gone"): void;                    // pending events only
  keyOf(cls: PushClass, refKind: string, refId: string): string;
}
export interface PushPresence { report(ownerId: string, connectionId: string, focused: boolean): void; looking(ownerId: string): boolean; }
export interface PushSeams { transport?: PushTransport; subscriptions?: SubscriptionsPort; sessionLive?: SessionLive } // test bed only
```
Handlers in this task are stubs that first call a shared `requireBrowser(caller)` (in `push/service.ts`: `forbidden` for a token, so the token tests hold before any chain lands) and then answer `push_unavailable` (`push.config` answers `status: "off"`), so `HandlerTable` stays exhaustive and typecheck green; chains replace them. The three compose files exist now: `compose-push-transport.ts` exports `composeTransportSide(deps, seams?)` (stub: transport off, empty subscriptions), `compose-push-delivery.ts` exports `composeDeliverySide(deps, ports)` (stub: notifier that returns null, presence that is never looking), and `compose-push.ts` calls the first, then the second with the first's ports, and returns the rpc table and the boot hooks. After this task chain A edits only the first, chain B only the second.

**Migration (full SQL, `push/migrations/202610172000_push.sql`):**
```sql
CREATE TABLE push_subs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  endpoint_hash TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('en', 'fr')),
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  UNIQUE (owner_id, endpoint_hash)
) STRICT;
CREATE INDEX push_subs_owner ON push_subs (owner_id);
CREATE TABLE push_events (
  id TEXT PRIMARY KEY,                -- randomToken(16): 22 base64url characters, also the wire id and the Topic
  owner_id TEXT NOT NULL,
  cls TEXT NOT NULL,
  ref_kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  name TEXT,                          -- a registry name (trigger_name or agent name) only, used only when titles = names
  dedup_key TEXT NOT NULL,            -- push:<cls>:<ref_kind>:<ref_id>; unique only while live (below); NEVER the outbox key
  state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'suppressed', 'held', 'digested', 'cancelled', 'failed')),
  reason TEXT,
  rechecks INTEGER NOT NULL DEFAULT 0, -- focus re-checks of an approval (at most 3)
  created_at INTEGER NOT NULL,
  settled_at INTEGER
) STRICT;
CREATE INDEX push_events_owner_state ON push_events (owner_id, state);
CREATE INDEX push_events_ref ON push_events (owner_id, ref_kind, ref_id);
CREATE UNIQUE INDEX push_events_dedup ON push_events (dedup_key) WHERE state IN ('pending', 'held');
CREATE TABLE push_deliveries (
  event_id TEXT NOT NULL,
  sub_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'gone', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  reason TEXT,                        -- a reason class: retry_exhausted, rejected, refused; never a response body
  PRIMARY KEY (event_id, sub_id)
) STRICT;
CREATE TABLE push_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;  -- keys_reset (A), last_failure (B)
```
The outbox key of an event is `push.send:<id>`, so it never collides with the Inbox's reuse of an item id or with a settled row kept 7 days. Retention: `push_events` older than 14 days (and their `push_deliveries`) are purged by the daemon's existing housekeeping cadence (task 9b registers the purge). Rows hold no payload text.

**Config (fenced and new env, `config.ts`):** `PAP_PUSH_SUBJECT` (`https:` or `mailto:`, validated; else `ConfigError`); `PAP_PUSH_EXTRA_HOSTS` (comma-separated exact host names, at most 8, each passing the same shape rules as task 4 and not an IP or a URL; else `ConfigError`), exposed as `config.pushExtraHosts`; `PAP_TEST_PUSH_LOOPBACK=1` needs `PAP_TEST_PROVIDER_SCRIPT` (else `ConfigError("PAP_TEST_PUSH_LOOPBACK needs PAP_TEST_PROVIDER_SCRIPT")`), sets `config.testPushLoopback`, boot logs one warning, and lets the endpoint validator accept `http://127.0.0.1:<port>/...` and the sender's address guard accept loopback. Nothing else. Never set outside tests (doc line in `docs/agents/notifications.md`, task 21).

- [ ] **Step 1 (RED):** `push.test.ts`: `PushSubscriptionInput` refuses `p256dh` of 86/88 chars, `auth` of 21/23, an extra key, a 2049-char endpoint, an empty label; **`NotificationsSettings.parse({})` equals the M12R2 defaults with every class present** (the zod 4 `.default({})` trap, M12-RT-14) and `parse({ classes: { done: true } })` keeps the other defaults; `PushWire` refuses `v: 2`, an id of 21 chars, a UUID id, and an unknown `cls`. `push-methods.test.ts`: the seven names exist with the permissions above, `push.subscribe`, `push.revoke` and `push.test` are `idempotent: false`, every declared error is an `ErrorCode`. `config.m12.test.ts`: the switch without `PAP_TEST_PROVIDER_SCRIPT` throws; with it `testPushLoopback` is true; `PAP_PUSH_SUBJECT` refuses `http:`; `PAP_PUSH_EXTRA_HOSTS` refuses an IP, a scheme and a ninth host. A daemon unit test: every push stub answers `push_unavailable` except `push.config` (`status: "off"`); the `outbox` registers both kinds (a second registration throws). **Settings:** a token cannot `settings.set` the `notifications` document and a session can (with a mutation check: drop the caller check -> the token test fails; M12-RT-29).
- [ ] **Step 2:** run `pnpm --filter @pap/contracts test -- push` and `pnpm --filter @pap/daemon test:unit -- config.m12` and see them fail.
- [ ] **Step 3:** implement the contracts, the migration, the stubs, the kinds, the switch and env, the compose split, the 3 lines in `daemon.ts`. `pnpm typecheck` green (the exhaustive `HandlerTable` forces every handler).
- [ ] **Step 4:** `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:int -- daemon.boot daemon.migrations && pnpm build && pnpm budgets` pass (boot applies the migration on a fresh and an existing temp home; `knip` has no unused export: stubs are used by compose).
- [ ] **Step 5:** `git commit -m "feat(push): contracts, migration, module skeleton and compose split for web push (M12)"`

---

## Task 2: Net-address move, readiness, shared test kit (base)

**Chain:** base. **Model:** Sonnet; Sonnet reviewer. **Gate:** unit + build.

**Files:**
- Move (`git mv`): `modules/egress/address.ts` and `address.test.ts` -> `kernel/net/address.ts`, `kernel/net/address.test.ts`; update the importers in `modules/egress/` (`index.ts:9` and four test files). `blockedAddress(ip)` is unchanged.
- Create: `kernel/net/address-push.ts` + test (`blockedForPush`), `kernel/push-readiness.ts` + test, `modules/push/testing/fake-transport.ts` and `memory-subscriptions.ts` (the in-memory `SubscriptionsPort` for chain B, with a switchable `sessionLive`) (`decrypt.ts` is created by task 6, `fake-push-service.ts` by task 7).
- Modify: `modules/push/index.ts` (re-export `pushReadiness`).

**Interfaces:**
- Produces: `kernel/net/address.ts` `blockedAddress(ip: string): boolean`; `kernel/net/address-push.ts` `blockedForPush(ip: string): boolean` (M12R20: `blockedAddress(ip)` plus IPv6 `2001::/32`, `2001:db8::/32`, `100::/64` and IPv4 `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `192.88.99.0/24`, including IPv4-mapped spellings of the IPv4 ranges); `pushReadiness` (above); `createFakeTransport(): PushTransport & { sent: Array<{ target: SubscriptionTarget; plaintext: Uint8Array; opts: ... }>; next(outcome: SendOutcome): void; setStatus(on: boolean): void; hold(): { release(): void } }` (chain B's only transport; records calls, answers `{kind:"ok"}` unless `next()` queued another outcome; `hold()` makes the next send wait on a promise the test releases).
- Rulings: **M12R20** (move, do not copy; the push check is stricter than the proxy's; ADR 0059), **M12R38**.

**Tests (key assertions):** the moved address tests pass unchanged; `blockedForPush` refuses every added range (one address each, plus `::ffff:198.51.100.1`) and agrees with `blockedAddress` everywhere else (a table of 20 addresses); `pushReadiness({ publicOrigin: "https://x.example", tls: false, insecureHttp: false })` is `ready` (TLS may end at a proxy); `http://localhost:7777` -> `localhost_only`; `http://192.168.1.182:7777` with `insecureHttp` -> `insecure_http` with a hint naming the routes in the agreed order (ngrok origin, Tailscale serve, `PAP_PUBLIC_ORIGIN` behind a reverse proxy, `--tls-cert`) and no `trustProxy`; `tls: true` with an `http:` origin -> `origin_mismatch`; the CLI can import `kernel/push-readiness.ts` without the push module (a lint-level test: the file imports nothing from `modules/`); the fake transport returns the queued outcomes in order and records plaintext without copying keys; the memory subscriptions refuse nothing and implement `targets(owner, credentialId?)` for both forms.

- [ ] Steps: RED (readiness, blockedForPush, fake transport tests), `git mv`, implement, `pnpm lint && pnpm typecheck && pnpm test:unit -- egress net push-readiness fake-transport && pnpm knip`, commit `refactor(net): move the blocked-address check to the kernel; push readiness and test transport (M12)`.

---

# Chain A: transport (tasks 3 to 7, then 16)

Chain A edits `compose-push-transport.ts`, `push/transport/*`, `modules/auth/index.ts` (one additive read) and, for task 16, the supervisor files of the web app. Its int tests use `daemon.push.transport.int.test.ts` and the real transport side with task 1's stub delivery side.

## Task 3: VAPID keys (security)

**Model:** Sonnet implementer; **Opus reviewer** (a signing key file and the ES256 JWT: the brief lists the VAPID JWT among the security contracts). **Gate:** unit.

**Files:** Create `push/transport/vapid.ts`, `vapid.test.ts`, `secret-file.ts`, `secret-file.test.ts`; modify `push/transport/index.ts`.

**Interfaces:** consumes `home` paths (kernel `home.ts`: `secrets` dir exists, `HOME_DIRS`), `Clock`, `Logger`. Produces:
```ts
export interface VapidIdentity { readonly publicKey: string /* b64url of the 65-byte point */; readonly keyId: string; sign(audience: string, subject: string, nowMs: number): string /* "t=<jwt>,k=<pub>" */ }
export type VapidState = { kind: "ready"; identity: VapidIdentity; minted: boolean } | { kind: "off"; reason: "keys_unreadable" };
export function loadVapid(secretsDir: string /* $PAP_HOME/secrets */, logger: Logger): VapidState; // never throws
// secret-file.ts
export function writeExclusive(path: string, content: string): boolean; // true: this call created the file; false: it already existed (EEXIST), untouched
```
**Rulings:** M12R4, M12R5.

**Full code (the file contract; run in a scratch directory against Node 24 by the plan fixer: a stale temporary file, a concurrent writer and a symlink behave as the tests below say):**
```ts
// secret-file.ts - the known-device.ts pattern (O_EXCL, O_NOFOLLOW, fchmod), copied: a module may not import auth's internals
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fsyncSync, linkSync, openSync, unlinkSync, writeSync } from "node:fs";

export function writeExclusive(path: string, content: string): boolean {
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`; // random: a stale file of a crashed process (same PID in a container) can never collide
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600); // the umask cannot widen it
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, path); // fails with EEXIST when another writer (or a link) is already there: nothing is overwritten
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    unlinkSync(tmp);
  }
}
```
```ts
// vapid.ts
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../../../kernel/logger.ts";
import { writeExclusive } from "./secret-file.ts";

const b64u = (b: Buffer) => b.toString("base64url");
const FILE = "vapid.json";
const STALE_TMP = /^vapid\.json\.[0-9a-f]{16}\.tmp$/;
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code ?? "unknown";

/** null: damaged, a link, not a regular file, or open to group/other. It never "fixes" anything. */
function readKey(path: string): KeyObject | null {
  let fd = -1;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); // a symlink at the path fails here
    const stats = fstatSync(fd);
    if (!stats.isFile() || (stats.mode & 0o077) !== 0) return null;
    const parsed = JSON.parse(readFileSync(fd, "utf8")) as { v?: number; privateJwk?: unknown };
    if (parsed.v !== 1 || typeof parsed.privateJwk !== "object" || parsed.privateJwk === null) return null;
    const key = createPrivateKey({ key: parsed.privateJwk as never, format: "jwk" });
    return key.asymmetricKeyDetails?.namedCurve === "prime256v1" ? key : null;
  } catch {
    return null;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

export function loadVapid(secretsDir: string, logger: Logger): VapidState {
  const dir = join(secretsDir, "push");
  const path = join(dir, FILE);
  try {
    let dirStats = lstatOrNull(dir);
    if (dirStats === null) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700); // we just made it: the umask cannot leave it wider
      dirStats = lstatSync(dir);
    }
    if (!dirStats.isDirectory() || (dirStats.mode & 0o077) !== 0) return off(logger, "dir_open_or_link"); // an existing folder is never "fixed"
    const fileStats = lstatOrNull(path);
    if (fileStats !== null) {
      const existing = readKey(path); // lstat above is only for "does it exist"; readKey refuses links, non-files and open modes
      return existing === null ? off(logger, "damaged_or_open") : ready(existing, false); // never mint over a file that exists
    }
    for (const name of readdirSync(dir)) if (STALE_TMP.test(name)) tryUnlink(join(dir, name)); // leftovers of a crash
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const created = writeExclusive(path, JSON.stringify({ v: 1, privateJwk: privateKey.export({ format: "jwk" }) }));
    if (created) return ready(privateKey, true);
    const winner = readKey(path); // another process created it between our check and our link: use its key
    return winner === null ? off(logger, "damaged_or_open") : ready(winner, false);
  } catch (error) {
    return off(logger, `io_${codeOf(error)}`); // push is off with a reason; the daemon still boots
  }
}
function lstatOrNull(path: string) { try { return lstatSync(path); } catch (error) { if (codeOf(error) === "ENOENT") return null; throw error; } }
function tryUnlink(path: string) { try { if (lstatSync(path).isFile()) unlinkSync(path); } catch { /* best effort */ } }
function off(logger: Logger, reason: string): VapidState {
  logger.warn("push_vapid_unreadable", { reason }); // the reason class only, never the content
  return { kind: "off", reason: "keys_unreadable" };
}
function ready(key: KeyObject, minted: boolean): VapidState {
  const jwk = createPublicKey(key).export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
  const publicKey = b64u(point);
  const keyId = createHash("sha256").update(point).digest("hex").slice(0, 16);
  return { kind: "ready", minted, identity: { publicKey, keyId, sign: (audience, subject, nowMs) => signVapid(key, publicKey, audience, subject, nowMs) } };
}
function signVapid(key: KeyObject, pub: string, aud: string, sub: string, nowMs: number): string {
  const head = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub })));
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" });
  return `t=${head}.${body}.${b64u(sig)},k=${pub}`;
}
```
(`VapidIdentity` and `VapidState` types as above.) Only a missing file mints a key. Recovery (task 21): `rm $PAP_HOME/secrets/push/vapid.json`, restart; the new pair has a new `key_id` and task 5's `purgeForeignKeys` deletes the rows of the old one; each device re-enables when it next opens pap (M12R12).

**Tests (RED first; real temp dir):**
- `creates-0600-in-0700`: first load makes `push/` 0700, `vapid.json` 0600, no `.tmp` left, the file never contains the string `BEGIN`; the public key decodes to 65 bytes starting `0x04`; `minted` is true.
- `stable-across-loads`: second load returns the same `publicKey`/`keyId`, `minted` false.
- `refuses-group-readable`: chmod 0640 -> `off keys_unreadable`, file untouched (same bytes), no new key.
- `refuses-damaged`: truncated JSON, wrong curve (`secp256k1` JWK), `v: 2` -> off, file untouched, one warning without the file content.
- `refuses-symlink-file` and `refuses-symlink-dir`: `vapid.json` a symlink to a valid key file, and `push/` a symlink -> off, the target untouched (`lstat`/`O_NOFOLLOW`, M12-RT-17); `refuses-open-dir`: `push/` at 0755 -> off.
- `stale-tmp-does-not-block`: a leftover `vapid.json.<16 hex>.tmp` and a file literally named `vapid.json.<current pid>.tmp` (the old collision) in `push/` -> the load succeeds, the matching leftover is removed.
- `create-failure-is-off-not-a-throw`: `push/` is a regular file, or the secrets dir is read-only -> `off`, no exception.
- `missing-mints`: delete the file -> a new key (different `keyId`); `never-mints-over-existing`: the damaged and group-readable cases leave the file byte-identical.
- `secret-file.test.ts` `exclusive-never-overwrites`: `writeExclusive` twice on one path -> true then false, and the content is the first call's; the file is 0600 whatever the umask (set `process.umask(0)` in the test). Mutation: replace `linkSync` by `renameSync` -> this test fails (it was the vacuous `wx` -> `w` mutation of the old plan).
- `logs-no-key`: capture the logger; no entry contains `privateJwk`, `d":` or the public key.
- `jwt-verifies`: `sign(aud, sub, now)` verifies with `crypto.verify('sha256', data, {key: publicKey, dsaEncoding: 'ieee-p1363'}, sig)`; `exp` is 12 h ahead; `aud` and `sub` as given.
- Mutation checks: drop the `& 0o077` test -> `refuses-group-readable` fails; drop `O_NOFOLLOW` -> `refuses-symlink-file` fails.

- [ ] Steps: RED, implement, `pnpm lint && pnpm typecheck && pnpm test:unit -- vapid secret-file`, commit `feat(push): VAPID identity stored under secrets/push with mode 0600 (M12)`.

## Task 4: Subscription validation (security)

**Model:** Sonnet implementer; **Opus reviewer** (SSRF at a trust boundary). **Gate:** unit.

**Files:** Create `push/transport/endpoint.ts`, `endpoint.test.ts`, `point.ts`, `point.test.ts`.

**Interfaces:** consumes `PushSubscriptionInput` (task 1), `config.pushExtraHosts`, `config.testPushLoopback`. Produces:
```ts
export interface HostRule { readonly exact?: string; readonly suffix?: string }
export const PUSH_SERVICE_HOSTS: readonly HostRule[];
export function hostRules(extraHosts: readonly string[]): readonly HostRule[];  // built-ins plus exact extras; no way to turn the list off (owner n1)
export function endpointRefusal(raw: string, options: { hosts: readonly HostRule[]; loopbackForTests: boolean }): { ok: true; href: string; host: string } | { ok: false; reason: string };
export function validPublicPoint(p256dh: string): boolean;   // 65 bytes, 0x04, on the curve
export function authSecretOf(auth: string): Buffer | null;   // 16 bytes
```
**Rulings:** M12R8.

**Full code (the `validPublicPoint` of the first plan always returned false: `createECDH().computeSecret()` without a private key throws "Invalid key pair" for every input. This version was run in scratch against 100 real keys, an off-curve point, a compressed key, a wrong prefix and an all-zero point):**
```ts
import { createPublicKey } from "node:crypto";
import { isIP } from "node:net";

export const PUSH_SERVICE_HOSTS: readonly HostRule[] = [
  { suffix: ".push.apple.com" },
  { exact: "fcm.googleapis.com" },
  { suffix: ".push.services.mozilla.com" },
  { exact: "updates.push.services.mozilla.com" },
  { suffix: ".notify.windows.com" },
];
export const hostRules = (extra: readonly string[]): readonly HostRule[] => [...PUSH_SERVICE_HOSTS, ...extra.map((exact) => ({ exact }))];
const hostAllowed = (host: string, rules: readonly HostRule[]) =>
  rules.some((r) => (r.exact !== undefined && host === r.exact) || (r.suffix !== undefined && host.endsWith(r.suffix) && host.length > r.suffix.length));

export function endpointRefusal(raw: string, o: { hosts: readonly HostRule[]; loopbackForTests: boolean }) {
  if (raw.length > 2048) return { ok: false as const, reason: "too_long" };
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false as const, reason: "malformed" }; }
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (o.loopbackForTests && url.protocol === "http:" && host === "127.0.0.1") return { ok: true as const, href: url.href, host };
  if (url.protocol !== "https:") return { ok: false as const, reason: "not_https" };
  if (url.username !== "" || url.password !== "") return { ok: false as const, reason: "credentials" };
  if (url.port !== "") return { ok: false as const, reason: "port" }; // WHATWG drops :443 for https, so any port left is not 443
  if (url.hash !== "" || raw.includes("#")) return { ok: false as const, reason: "fragment" }; // an empty "#" leaves url.hash empty
  if (isIP(host) !== 0) return { ok: false as const, reason: "ip_literal" };
  if (!host.includes(".") || host.endsWith(".") || host.split(".").some((label) => label === "")) return { ok: false as const, reason: "host" };
  if (!hostAllowed(host, o.hosts)) return { ok: false as const, reason: "host_not_allowed" };
  return { ok: true as const, href: url.href, host };
}
export function validPublicPoint(p256dh: string): boolean {
  if (!/^[A-Za-z0-9_-]{87}$/.test(p256dh)) return false;
  const point = Buffer.from(p256dh, "base64url");
  if (point.length !== 65 || point[0] !== 4) return false;
  try {
    // OpenSSL checks that (x, y) is on P-256 when the JWK is imported. Do not drop this check to "fix" a test: an off-curve point must be refused here.
    createPublicKey({ key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") }, format: "jwk" });
    return true;
  } catch { return false; }
}
export const authSecretOf = (auth: string): Buffer | null => { const b = Buffer.from(auth, "base64url"); return b.length === 16 ? b : null; };
```
The stored endpoint is `href` (the canonical form), never the raw string.

**Tests (RED):** table-driven, each `ok:false` with its reason: `http://fcm.googleapis.com/x` (not_https); `https://user:pw@fcm.googleapis.com/x` (credentials); `https://fcm.googleapis.com:8443/x` (port); `https://fcm.googleapis.com/x#a` and `https://fcm.googleapis.com/x#` (fragment); every IP spelling: `https://127.0.0.1/`, `https://0x7f.1/`, `https://2130706433/`, `https://017700000001/`, `https://[::1]/`, `https://[::ffff:7f00:1]/`, `https://169.254.169.254/`; `https://localhost/`; `https://fcm.googleapis.com.evil.example/x`, `https://evil.example/fcm.googleapis.com`, `https://fcm.googleapis.com@evil.example/`, `https://evilpush.apple.com/` (suffix needs the dot: `x.push.apple.com` matches), `https://push.apple.com/` (suffix with nothing before it is refused), `https://a..push.apple.com/x` (empty label), trailing-dot host, `https://evil.example\@fcm.googleapis.com/`, `https://evil.example%2Efcm.googleapis.com/`, `https://fcm.googleapis.com%2Eevil.example/`, a 2049-char URL, a punycode lookalike `https://xn--fcm-googleapis-xyz.com/`; canonicalised to the allowed host (the WHATWG parser reads `\` as `/` and decodes `%2E`; the stored href is the canonical one and the socket only ever goes to that host): `https://fcm.googleapis.com\@evil.example/` -> `https://fcm.googleapis.com/@evil.example/`, `https://fcm%2Egoogleapis.com/x` -> `https://fcm.googleapis.com/x`; uppercase host variants are lowered; ok: `https://web.push.apple.com/abc`, `https://fcm.googleapis.com/fcm/send/abc`, `https://updates.push.services.mozilla.com/wpush/v2/abc`. `hostRules(["push.example.net"])` accepts exactly that name and not `a.push.example.net`; there is no input that disables the list (the type has no `null`). With `loopbackForTests` only `http://127.0.0.1:PORT` passes, `http://127.0.0.2/` and `http://localhost/` do not. `validPublicPoint`: **100 real generated keys all pass**; 65 random bytes with a 4 prefix (off curve) fail; the all-zero point fails; a 33-byte compressed key fails; wrong prefix fails; an 86- and an 88-char string fail. Mutation checks: remove the `isIP` line -> the IP table fails; make suffix match without the leading dot -> `evilpush.apple.com` test fails; replace the JWK import by a length check only -> the off-curve test fails.

- [ ] Steps: RED, implement, `pnpm lint && pnpm typecheck && pnpm test:unit -- endpoint point`, commit `feat(push): endpoint and key validation at the subscription boundary (M12)`.

## Task 5: Subscription store, service and RPC (security)

**Model:** Sonnet implementer; **Opus reviewer** (browser-only, caps, no-content results, the production wiring). **Gate:** unit + int (one daemon test).

**Files:** Create `push/transport/{store.ts,store.test.ts,rpc.ts,rpc.test.ts,service.ts,service.test.ts,boot.ts,boot.test.ts}`, `apps/daemon/src/daemon.push.transport.int.test.ts` (grows in 7); modify `push/transport/index.ts`, `compose-push-transport.ts` (wire `sessionLive`, audit, rate limits, the boot), `modules/auth/index.ts` (one additive read `sessionLive(ownerId, credentialId): boolean` over the auth module's device list, if the index lacks it; the implementer checks how a browser session's public id reaches `ctx.caller` before coding).

**Interfaces:** consumes task 3 (`VapidState`), task 4, the ports of task 1, `kernel/rate-limit.ts`, `audit`, `Clock`, `push_meta`. Produces (the real implementations of `SubscriptionsPort` and the chain A RPC methods `push.config`, `push.subscribe`, `push.list`, `push.revoke`):
```ts
export interface Subscriptions extends SubscriptionsPort {
  add(owner: string, credentialId: string, input: PushSubscriptionInput): { id: string }; // throws PapError bad_request|capacity|conflict
  list(owner: string, credentialId: string): ListItem[];
  revoke(owner: string, id: string): boolean;
  markOk(id: string, at: number): void;
  purgeForeignKeys(keyId: string): number;                  // boot, after loadVapid
  countFor(owner: string): number;
}
```
**Rulings:** M12R9, M12R10, M12R12, M12R4, M12R39. `endpoint_hash` = SHA-256 hex of the canonical href; logs use `h:<first 12 hex>`.

**Behaviour:**
- `service.ts` owns `requireBrowser(caller)` (first line of every method, `forbidden` when `caller.kind !== "session"`, `push.config` included), the rate limits (`push.subscribe`: `createRateLimiter(clock, 6_000)` keyed by owner = 10 a minute; `push.test` is task 9b's: 10 s) and the audit rows; the handlers only decode, call one service method and map errors (the CI rule). In read-only mode `push.subscribe` answers `read_only` and `push.config` says `reason: "read_only"`.
- `add`: refuse when `countFor >= 10` unless the endpoint hash already exists for this owner (then refresh keys, label, locale **and credential** in place, the id stays, no count change: this is how a re-login re-binds a device, M12R12); the same hash under another owner -> `conflict`; `bad_request` for an endpoint or point refusal (reason class only, never the endpoint text); labels are stripped of controls/Cf/Zl/Zp (same pattern as `inbox/service.ts` HIDDEN) and clipped. Audit rows `push.subscribe`, `push.revoke` carry the endpoint hash and the host, never the endpoint. `push.list` returns `host` only.
- `boot.ts`: `loadVapid` -> `purgeForeignKeys(keyId)`; when it purged rows (the file was missing: a reset or a plain restore) it logs `push_keys_reset { purged }` (count only) and writes `push_meta.keys_reset = { at, purged }`; the next `add` clears it. `push.config` reads it as `keysReset`, and `lastFailure` from `push_meta.last_failure` (written by chain B, task 9a). A damaged file keeps push off and purges nothing.
- `push.test` stays task 1's stub until task 9b.

**Tests (RED, incl. full code for the boundary test):**
```ts
it("a token can neither subscribe, list, revoke nor see the key", async () => {
  const { call, tokenCaller, browserCaller } = rpcBed();
  for (const method of ["push.config", "push.subscribe", "push.list", "push.revoke", "push.presence", "push.open", "push.test"] as const)
    await expect(call(method, validParamsFor(method), tokenCaller)).rejects.toMatchObject({ code: "forbidden" });
  expect(subscriptions.countFor(owner)).toBe(0);
  await expect(call("push.list", {}, browserCaller)).resolves.toMatchObject({ items: [] });
});
```
Others: `cap-refuses-11th-never-evicts` (10 distinct endpoints stored, 11th -> `capacity`, the first ten unchanged); `same-endpoint-refreshes-at-cap` (10 stored, re-add one of them -> ok, still 10); `relogin-rebinds-credential` (re-add under a new credential id -> the row's `credential_id` is the new one, `targets(owner, newCred)` returns it); `other-owner-conflict`; `list-has-no-endpoint-or-keys` (JSON of the result contains neither the endpoint path nor `p256dh`/`auth` strings); `list-current-flag` (true only for the creating `credentialId`); `revoke-other-owners-row-not_found`; `rate-limit-subscribe` (the 2nd call within 6 s -> `rate_limited`, the 3rd after 6 s on the Clock passes; M12-RT-16); `bad-endpoint-reasons-not-echoed`; `audit-has-hash-not-endpoint`; `purge-foreign-keys` and `boot.reports-reset` (missing file on a populated table: rows purged, `keysReset` shown by `push.config`, one log line with a count and no endpoint; a damaged file: nothing purged); `drop-logs-hash-only` (logger capture has `h:` + 12 hex and no `https://`); `read-only-subscribe` -> `read_only`. Int test `daemon.push.transport.int.test.ts`: boot a daemon with a temp home, sign in as browser, `push.subscribe` an endpoint on `https://web.push.apple.com/x`, `push.list` shows it, `push.revoke` removes it; the same calls with a token -> `forbidden` (production wiring, M11a I2). Mutation checks: delete the `requireBrowser` call in one method -> the token test fails; change `>= 10` to `> 10` -> the cap test fails; skip the credential refresh -> `relogin-rebinds-credential` fails.

- [ ] Steps: RED, implement, `pnpm lint && pnpm typecheck && pnpm test:unit -- push/transport && pnpm test:int -- daemon.push.transport`, commit `feat(push): per-device subscriptions, browser-only, capped, listed and revocable (M12)`.

## Task 6: RFC 8291 encryption and the VAPID header (security)

**Model:** Sonnet implementer; **Opus reviewer** (hand-written crypto). **Gate:** unit. The function is consumed only by the transport (task 7): nothing else seals a payload (M12R6; the first plan's second `seal` at the join would have encrypted twice).

**Files:** Create `push/transport/encrypt.ts`, `encrypt.test.ts`, `push/testing/decrypt.ts` (the test-side decryptor used by the fake service and the int tests).

**Interfaces:** produces `encryptPayload(plaintext: Uint8Array, uaPublic: Buffer /*65*/, authSecret: Buffer /*16*/, injected?: { asPrivate?: Buffer; salt?: Buffer }): Buffer` (the complete `aes128gcm` body: header + record) and, in testing, `decryptPayload(body: Buffer, uaPrivateEcdh: ECDH, authSecret: Buffer): Buffer`. Plaintext limit: 3993 bytes (4096 record - 16 tag - 1 delimiter - 86 header); larger throws `RangeError`.

**Full code:**
```ts
import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

const RS = 4096;
const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, len: number) => Buffer.from(hkdfSync("sha256", ikm, salt, info, len));

export function encryptPayload(plaintext: Uint8Array, uaPublic: Buffer, authSecret: Buffer, injected: { asPrivate?: Buffer; salt?: Buffer } = {}): Buffer {
  if (plaintext.length > RS - 16 - 1 - 86) throw new RangeError("payload_too_large");
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new RangeError("bad_keys");
  const as = createECDH("prime256v1");
  if (injected.asPrivate) as.setPrivateKey(injected.asPrivate); else as.generateKeys();
  const asPublic = as.getPublicKey(); // 65 bytes uncompressed
  const shared = as.computeSecret(uaPublic);
  const salt = injected.salt ?? randomBytes(16);
  const prkKey = hkdf(shared, authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32);
  const cek = hkdf(prkKey, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(prkKey, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RS, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, record]);
}
```
(Delimiter `0x02` marks the last record, RFC 8188 2.)

**Tests (RED):**
- `rfc8291-appendix-a-vector`: the test copies the example values from RFC 8291 section 5 / Appendix A (plaintext "When I grow up, I want to be a watermelon", the as_private, as_public, ua_public, auth_secret, salt, and the expected `aes128gcm` body) **from the RFC text, not from memory**, with the RFC section cited in the test; `encryptPayload(..., { asPrivate, salt })` equals the expected bytes exactly.
- `roundtrip`: random plaintexts of 0, 1, 100, 3993 bytes encrypt and decrypt through `decryptPayload` with a fresh UA key; 3994 bytes throws `RangeError`.
- `fresh-key-and-salt-each-call`: two encryptions of the same plaintext differ in header salt and server key.
- `rejects-bad-keys`: 64-byte key, wrong prefix, 15-byte auth throw `RangeError`.
- `tamper`: flipping one byte of the record makes `decryptPayload` throw (GCM tag).
- Mutation checks: drop the `0x02` delimiter -> the vector test fails; swap `uaPublic`/`asPublic` order in `info` -> fails.

- [ ] Steps: RED, implement, `pnpm lint && pnpm typecheck && pnpm test:unit -- encrypt`, commit `feat(push): RFC 8291 aes128gcm payload encryption on node:crypto (M12)`.


## Task 7: The guarded sender and the fake push service (security)

**Model:** Sonnet implementer; **Opus reviewer** (outbound request to a user-chosen host). **Gate:** unit + int (extends `daemon.push.transport.int.test.ts`).

**Files:** Create `push/transport/sender.ts`, `sender.test.ts`, `sender.guard.test.ts`, `sender.tls.test.ts`, `push/testing/fake-push-service.ts`; modify `push/transport/index.ts` (`createHttpsTransport`), `compose-push-transport.ts` (the real transport), `daemon.push.transport.int.test.ts`.

**Interfaces:** consumes tasks 3, 4, 6, `kernel/net/address-push.ts` (`blockedForPush`), `Clock`, and `apps/daemon/src/testing/self-signed.ts` (an existing test certificate helper). Produces `createHttpsTransport(deps: { vapid: VapidState; subject: string; readiness: PushReadiness; clock: Clock; logger: Logger; loopbackForTests: boolean; allowAddress?: (ip: string) => boolean; lookup?: Resolver }): PushTransport` (**it encrypts**: `send(target, plaintext, opts, signal)` calls `encryptPayload` with the target's keys, so no caller seals) and the test service `startFakePushService(options?: { tls?: boolean }): Promise<{ url: string; requests: Array<{ path: string; headers: Record<string,string>; body: Buffer }>; respondNext(status: number, headers?: Record<string,string>, body?: string): void; close(): Promise<void> }>` (HTTP on `127.0.0.1`, or HTTPS with the self-signed certificate for the TLS test; only used with the fenced switch or an injected `allowAddress`).

**Full code (the send contract; the implementer fills the VAPID header from task 3; unlike the first plan the sender never throws: an `http:` URL with loopback off, an invalid URL and a synchronous `request()` error are all outcomes, M12-RT-20):**
```ts
import { request, type ClientRequest } from "node:https";
import { request as httpRequest } from "node:http"; // used only when loopbackForTests and the URL is http://127.0.0.1
import { lookup as dnsLookup, type LookupAddress } from "node:dns";

const CONNECT_AND_RESPONSE_MS = 15_000;
const DRAIN_MAX_BYTES = 8 * 1024;

function guardedLookup(allow: (ip: string) => boolean) {
  return (host: string, opts: { all?: boolean; family?: number }, cb: (e: NodeJS.ErrnoException | null, a: string | LookupAddress[], f?: number) => void) => {
    dnsLookup(host, { all: true }, (error, addresses) => {
      if (error) return cb(error, "");
      if (addresses.length === 0 || addresses.some((entry) => !allow(entry.address))) return cb(Object.assign(new Error("address refused"), { code: "EPUSHADDR" }), ""); // one private answer refuses the name
      const first = addresses[0]!;
      return opts.all ? cb(null, addresses) : cb(null, first.address, first.family); // the socket connects to an address that was checked
    });
  };
}

export type SendResult = { status: number; retryAfter: string | null } | { error: "address" | "timeout" | "network" };
export function sendOnce(args: { href: string; body: Buffer; headers: Record<string, string>; signal: AbortSignal; allowLoopback: boolean; allowAddress: (ip: string) => boolean }): Promise<SendResult> {
  let url: URL;
  try { url = new URL(args.href); } catch { return Promise.resolve({ error: "address" }); }
  const http = args.allowLoopback && url.protocol === "http:" && url.hostname === "127.0.0.1";
  if (!http && url.protocol !== "https:") return Promise.resolve({ error: "address" }); // node:https.request would throw ERR_INVALID_PROTOCOL
  return new Promise((resolve) => {
    let req: ClientRequest;
    try {
      req = (http ? httpRequest : request)(url, {
        method: "POST",
        headers: { ...args.headers, "content-length": String(args.body.length) },
        agent: false, // no pooled sockets between pushes
        timeout: CONNECT_AND_RESPONSE_MS,
        signal: args.signal,
        lookup: http ? undefined : (guardedLookup(args.allowAddress) as never), // rejectUnauthorized stays at its default: TLS is verified
      }, (res) => {
        let seen = 0;
        res.on("data", (chunk: Buffer) => { seen += chunk.length; if (seen > DRAIN_MAX_BYTES) res.destroy(); }); // drained, never kept or logged
        const done = () => resolve({ status: res.statusCode ?? 0, retryAfter: res.headers["retry-after"]?.toString() ?? null });
        res.on("end", done); res.on("close", done);
      });
    } catch { resolve({ error: "network" }); return; } // a synchronous throw never reaches the outbox (its log would carry the endpoint)
    req.on("timeout", () => { req.destroy(); resolve({ error: "timeout" }); });
    req.on("error", (e: NodeJS.ErrnoException) => resolve({ error: e.code === "EPUSHADDR" ? "address" : args.signal.aborted ? "timeout" : "network" }));
    req.end(args.body);
  });
}
```
`createHttpsTransport.send` is one `try { ... } catch { log the error class (`err.name`) and the endpoint hash; return { kind: "refused", reason: "internal" } }`. It calls `authSecretOf` / `validPublicPoint` on the target first (a bad stored key is `refused: "bad_keys"`, not a throw), then `encryptPayload`, then `sendOnce` with `allowAddress = deps.allowAddress ?? ((ip) => !blockedForPush(ip))`, and `allowLoopback = deps.loopbackForTests`. Status mapping: 200/201/202 -> `ok`; 404/410 -> `gone`; 429 and 5xx -> `retry` (`afterMs` = `Retry-After` seconds clamped to 1 h, ignored if not an integer); 400, 401, 403, 413 and any 3xx (no redirects are followed: Node does not follow, and a 3xx is `rejected`) -> `rejected` with the status; `address` -> `refused: "address"`; `timeout`/`network` -> `retry`. Headers: `content-encoding: aes128gcm`, `content-type: application/octet-stream`, `ttl` and `urgency` from `opts` (set by the caller: M12R13), `topic` (`opts.topic`, the event id: at most 32 url-safe characters, RFC 8030 5.4), `authorization: vapid t=<jwt>, k=<pub>` with the JWT audience = `url.origin` (VAPID tokens cached per audience for 6 h on the Clock). A 403 or 401 increments a counter `push_key_rejected` (logged once a day with the host hash; M12R4: a changed key shows up here). The log line on any outcome has `{ h: <12 hex of the endpoint hash>, outcome, status }` and nothing else. `status()` is `on` only when the VAPID state is ready and `readiness` is not `insecure_http` (then reason `insecure_http`).

**Tests (RED, local fake service, no sleeps; no test names a public host or address):**
- `sends-encrypted-request`: the fake receives `content-encoding: aes128gcm`, a body that `decryptPayload` opens with the test UA key to the exact plaintext (so a double encryption would fail here), an `authorization` that verifies against the VAPID public key with `aud` equal to the fake's origin, and `ttl`/`urgency`/`topic` exactly as passed.
- `status-mapping`: table 201, 202, 404, 410, 429 with `Retry-After: 30` (afterMs 30000), `Retry-After: 99999` (clamped 3 600 000), `Retry-After: x` (undefined), 500, 502, 400, 401, 403, 413, 301 and 307 with a `Location` pointing at the fake itself (the fake records that no second request arrived: no redirect followed; Node never follows, so the assertion is on the recorded requests, not on a mutation).
- `guard.refuses-private-dns` (`sender.guard.test.ts`, injected resolver): answers `["10.0.0.1","127.0.0.2"]` (mixed with a private one) -> `refused: address`, nothing connected; `["127.0.0.1"]`, `["169.254.169.254"]`, `["::1"]`, `["fd00::1"]`, `["::ffff:10.0.0.1"]`, `["198.51.100.7"]`, `["2001:db8::1"]` all refused by the default check; **the "public answer connects to exactly the address checked" test points the injected resolver at the local fake with `allowAddress: () => true`** and asserts the socket's remote address is the first answer even if a second resolution would return a private one (no public address is named).
- `tls.verification-is-on` (`sender.tls.test.ts`): a self-signed HTTPS fake (the existing `testing/self-signed.ts`) is refused (outcome `retry`, no request body reached the fake); a mutation that sets `rejectUnauthorized: false` makes it fail.
- `deadline`: a fake that never answers; the `AbortSignal` (outbox deadline) aborts -> `retry`, the request is destroyed (the fake sees the close).
- `big-or-endless-body`: a 10 MiB response is cut at 8 KiB and discarded; the logger capture contains none of it.
- `no-body-in-logs`: the fake answers 400 with a body `SECRET-BODY-123`; no log line contains it.
- `never-throws`: `http://127.0.0.1:1/x` with `loopbackForTests: false`, an invalid URL, a target with a damaged `p256dh` and an `encryptPayload` that throws (injected) each resolve to an outcome and log no endpoint text (the logger capture has no `http`).
- `sessionLive-is-not-this-layer`: nothing here consults a session (the check is task 9a's; its mutation test is there).
- Int (`daemon.push.transport.int.test.ts`): with `PAP_TEST_PUSH_LOOPBACK=1` + `PAP_TEST_PROVIDER_SCRIPT`, a daemon subscribes an endpoint on the fake service and the real transport sends to it; without the switch the same subscription is `bad_request`.
- Mutation checks: `some` -> `every` in the lookup check -> the mixed-answer test fails; log `res` body -> `no-body-in-logs` fails; drop the protocol check -> `never-throws` fails.

- [ ] Steps: RED, implement, `pnpm lint && pnpm typecheck && pnpm test:unit -- push/transport && pnpm test:int -- daemon.push.transport`, commit `feat(push): guarded HTTPS sender with deadline, no redirects and a fake push service (M12)`.

## Task 16: Connection-supervisor gaps (D19) - chain A, after task 7

**Model:** Sonnet; Sonnet reviewer. **Gate:** unit + build. **Eager delta estimate: +0.4 KB.**

**Files:** Modify `apps/web/src/runtime/connection.ts` (353 lines: keep under 400; extract `connection-timing.ts` if needed), `runtime/index.ts`, `routes/shell/ConnectionBanner.tsx`, the eager `i18n/en.ts` and `i18n/fr.ts` (the only eager catalog edit of the milestone); create `runtime/connection.resume.test.ts`, `runtime/connection.retry.test.ts`. Nothing else in `apps/web` (task 15 starts presence from `use-shell-effects.ts` and never touches these files).

**Board and copy (M12-RT-34):** board 12 caption "2 - Ecrans systeme", the reconnecting state: "Le daemon ne répond plus. Nouvelle tentative dans 8 s" with a "Réessayer" button. The banner uses the board's wording (`Le daemon ne répond plus. Nouvelle tentative dans {seconds} s`, button `Réessayer`); the existing "Vos brouillons sont conservés" line (`connection.draftsStay`) stays. The first plan's "Reconnexion dans {n} s" is dropped.

**Audit first (the task's step 1):** compare `connection.ts` with T3's `client-runtime/connection/supervisor.ts` (backoff with jitter capped, reset after a stable period, an immediate reconnect after a mobile resume, a manual retry skipping the ladder, cursor resume). Already present in pap: jittered exponential backoff capped at 30 s, 15 s dead detection, a probe (`ok`/`outdated`/`signed-out`/`offline`), `nudge()` on `online` and `visible`, subscription cursors kept 5 minutes after the last listener, the banner, drafts in `stores/drafts`. The gaps to close (tests first, each only if the audit confirms it is missing):
1. **Resume after a long background**: when the tab becomes visible after at least 30 s hidden, treat the socket as suspect: close it and reconnect at once (iOS keeps a zombie socket for up to the 15 s dead window); a short hide (under 30 s) only nudges. (T3: long mobile resume replaces the session.)
2. **Manual "Réessayer"**: the banner's button calls `nudge()` and resets the attempt to the first rung; disabled while `connecting`.
3. **Retry visibility**: `Connection` exposes `retryAt: number | null` (clock ms of the next attempt) and `attempt`; the banner text updates each second from the shared timers (no per-second re-render of the whole shell: a small component with its own tick, only while `waiting`).
4. **Backoff reset after a stable period** is 10 s (`STABLE_AFTER_MS`) in pap against 30 s in T3: keep 10 s (a pap session opens a heavy snapshot; reconnect storms are bounded by the cap); documented as a deliberate difference in ADR 0062, not changed.
5. **Cursor resume proof**: a unit test that a session subscription resumes from its cursor after a drop with no duplicate and no gap events (fake socket and fake server frames), and that after the 5 minute cursor life the resubscribe asks for a fresh snapshot.
6. **Drafts kept**: a test pinning that the composer draft survives `waiting` -> `open` and a full reload (existing store).

**Rulings:** M12R31. **Tests (RED):** `resume.long-hidden-reconnects-now` (hidden 31 s on the fake clock -> socket closed and a new one created without waiting for the dead timer), `resume.short-hidden-nudges-only`, `retry.manual-skips-ladder` (attempt back to 0, the next delay is the first rung), `retry.exposes-retryAt` (equal to `now + delay`, null when open), `banner.countdown` (renders the board's seconds line, the "Réessayer" button calls nudge, the button is disabled while connecting; strings in French with vous), `cursor.resume-no-gap-no-dup`, `cursor.expired-asks-snapshot`, `drafts.survive-reconnect`, `signed-out.stops-retrying`.

- [ ] Steps: RED, audit note in the commit body, implement, `pnpm lint && pnpm typecheck && pnpm test:unit -- runtime ConnectionBanner && pnpm build && pnpm budgets`, commit `feat(web): supervisor resume after long background, manual retry and a retry countdown (M12)`.

---

# Chain B: delivery (tasks 8 to 12, then 19)

Chain B edits `compose-push-delivery.ts`, `push/delivery/*`, `modules/inbox/{service.ts,agent-items.ts}`, `automation/index.ts` (one additive field), `runs/index.ts` (additive) and, for task 19, the phone screens. All of chain B's tests use `createFakeTransport` and `createMemorySubscriptions` (task 2) through the daemon test bed's `push` seam. None needs a key, a socket or the network. Its int tests live in `daemon.push.delivery.int.test.ts` (task 9a), `daemon.push.quiet.int.test.ts` (9b), `daemon.push.sessions.int.test.ts` (11) and `daemon.push.budget.int.test.ts` (12).

## Task 8: Events, presence, rules, copy

**Model:** Sonnet; Sonnet reviewer. **Gate:** unit.

**Files:** Create `push/delivery/{events.ts,events.test.ts,presence.ts,presence.test.ts,decide.ts,decide.test.ts,cooldown.ts,cooldown.test.ts,copy.ts,copy.test.ts,notifier.ts,notifier.test.ts,meta.ts}`; modify `push/delivery/index.ts`, `compose-push-delivery.ts` (build the notifier and presence).

**Interfaces:** consumes the task 1 types and `settings.notifications(ownerId)` / `settings.automation(ownerId).quietHours` + `timezone` (`SettingsPort`), `inQuietHours` (contracts), `Clock`, `Db`, `enqueueEffect`, `randomToken` (kernel `ids.ts`). Produces:
```ts
export type Decision = { action: "send" } | { action: "suppress"; reason: "class_off"|"muted"|"focused"|"cooldown"|"rate_cap" } | { action: "hold" } | { action: "recheck"; afterMs: 60_000 };
export function decide(input: { cls: PushClass | "digest" | "test"; now: number; settings: NotificationsSettings; quiet: boolean; looking: boolean; cooldownFree: boolean; hourCount: number; rechecks: number }): Decision;
export function createPresence(clock: Clock): PushPresence;   // M12R11, cap 64 -> throws PapError("capacity")
export function createCooldown(clock: Clock): { reserve(key: string): boolean };  // 5 s per key, 256 keys, full of fresh keys -> false (refuse, never evict)
export function copyFor(cls: WireClass, locale: "en"|"fr", extra?: { name?: string; n?: number; expired?: number }): { title: string; body: string };
export function createNotifier(deps): PushNotifier;  // M12R1
```
**Rulings:** M12R1, M12R2, M12R3, M12R7, M12R9, M12R11, M12R18.

**Behaviour:**
- `notify`: `id = randomToken(16)`; `dedupKey = "push:" + cls + ":" + refKind + ":" + refId`; **inside one `db.transaction`**: insert the event (`state pending`; the partial unique index on live keys refuses a second live event: return null) and `enqueueEffect(db, { kind: "push.send", ownerId, payload: { eventId: id }, dedupKey: "push.send:" + id, at })`; when `enqueueEffect` returns null the transaction is rolled back (throw a sentinel inside, catch outside) and `notify` returns null, so a `pending` row can never stay without its effect. Approval-class `at = now + 60_000`; others `now`; then `outbox.poke()`. In read-only mode `notify` is a no-op.
- `cancel(refKey, reason)`: finds the live `pending` event for the key, calls `outbox.cancel("push.send:" + id)` and marks the event `cancelled` with the reason (a leased row gets the durable cancel mark the handler reads before its next send). A `held` event is not touched: the digest judges it (M12R17).
- `copyFor` generic copy (en/fr vous; accents in the source file): approval "A request is waiting for your answer." / "Une demande attend votre réponse."; failed "A task did not finish." / "Une tâche ne s'est pas terminée."; budget "A budget is reached." / "Un budget est atteint."; notify "An agent has a message for you." / "Un agent a un message pour vous."; digest "{n} items are waiting for you." / "{n} éléments vous attendent." plus, when `expired > 0`, " {m} requests expired during quiet hours." / " {m} demandes ont expiré pendant les heures calmes." (with `n = 0` only the expired sentence); test "Test notification." / "Notification de test."; done/reply/review have their own short generic sentences; title always "pap". With `names`, the body appends ` - <name>` where the name is stripped (controls, Cf, Zl, Zp) and cut to 60 code points; never for `digest`/`test`.
- `decide` order (every branch tested): class off -> muted -> looking (an approval: `recheck` while `rechecks < 3`, else `suppress:focused`; any other class: `suppress:focused`) -> cooldown -> hourly cap (approvals exempt: `hourCount` counts the owner's `sent` non-approval events of the last hour, read from the table, so it survives a restart) -> quiet hold. `digest` ignores class toggles, quiet hours and cooldown; `test` ignores everything and still sends.

**Tests (RED):** the `decide` table (each branch and its order: class off beats muted beats looking beats cooldown beats rate cap beats quiet; an approval is never rate-capped even at `hourCount` 500; `failed` is at 20; approval `recheck` 3 times then `suppress:focused`); presence: fresh within 45 s, stale after 45 s on the test Clock, `looking` false for an unfocused-only entry, the 65th live entry -> `capacity` while expired entries are swept first, entries per owner isolated, one entry per connection id; cooldown: second `reserve` within 5 s false, after 5 s true, 256 fresh keys then a new key -> false (and the old ones are not evicted); notifier: one event + one outbox row (`dedup_key` is `push.send:<id>`, never the event's key) in one transaction; **`second-question-pushes-again`** (Review Focus 6: notify, mark the event `sent`, settle the outbox row, notify the same ref again -> a new event and a second outbox row, `second` returned non-null); a live duplicate returns null and adds no row; **a null `enqueueEffect` (pre-insert an outbox row with that key) rolls the event back** (no `pending` row left); ids are 22 base64url characters; approval `next_at = now + 60000`, failed `next_at = now`; `cancel` retires the pending outbox row and marks the event, leaves a `held` one alone; `names` strips `\u202e` and `\u200b` and cuts at 60; copy: no output contains an `{` placeholder, fr uses "vous"/"votre" (a regex over fr strings rejects "tu ", "ton ", "ta "), the digest line with `expired` reads right in both locales.

- [ ] Steps: RED, implement, `pnpm lint && pnpm typecheck && pnpm test:unit -- push/delivery`, commit `feat(push): notification events, presence and the delivery rules (M12)`.

## Task 9a: push.send per target (retry, dead devices, payload)

**Model:** Sonnet implementer; **Opus reviewer** (it decides delivery to revoked devices, assembles the lock-screen payload and owns the retry semantics: Review Focus 2, 3, 7). **Gate:** unit + int.

**Files:** Create `push/delivery/{send.ts,send.test.ts,send.retry.test.ts,deliveries.ts,deliveries.test.ts}`, `daemon.push.delivery.int.test.ts`; modify `push/delivery/index.ts` (`registerPushEffects`), `compose-push-delivery.ts`.

**Interfaces:** consumes `PushTransport` and `SubscriptionsPort` (`targets`, `drop`, `markOk`), the outbox (`register`, `cancel`, `cancelRequested`), auth `SessionLive`, the injected `stillWaiting(event)` (chains' sources provide it: M12R23), `push_meta`. Produces `registerPushEffects(outbox, deps)` for `push.send`.

**`push.send` handler (order matters; it never calls `markSent` and never throws; M12R13):**
1. Load the event; gone or not `pending` -> settle `done`.
2. If `ctx.cancelRequested()` or `!stillWaiting(event)` (approval and inbox-based classes; budget: always waiting) -> event `cancelled`, settle `done`.
3. First run (no `push_deliveries` rows): `decide` with live inputs. `suppress` -> event `suppressed` + reason, `done`. `hold` -> event `held`, enqueue `digest.send` at `nextQuietEnd` (task 9b), `done`. `recheck` -> increment `rechecks`, return `defer` to now + 60 s (an approval looked at on a focused tab may be left unseen: Review Focus 7). `send` -> build the targets: `subscriptions.targets(owner)`; for each, `sessionLive(owner, target.credentialId)` else `drop(dead_session)`; no target left -> event `cancelled` reason `no_target`, `push_meta.last_failure` `no_target`, `done`; else insert one `push_deliveries` row per target (`pending`, `next_at = now`).
4. Every run: for each `pending` delivery due now, build the wire payload (`id` = event id, `copyFor` per target locale; with `titles: names` the event's registry `name`), `transport.send(target, plaintext, { ttlSeconds, urgency, topic: eventId }, ctx.signal)` where urgency is `high` for approval, failed and budget (iOS defers lower urgencies) and TTL is 3600 for approval, 14 400 for failed, budget and notify, 3600 for done/reply/review: no longer than the item's useful life (M12-RT-22). `sessionLive` is asked again before each send. Outcomes: `ok` -> `markOk`, delivery `done`; `gone` -> `drop(gone)`, delivery `gone`; `retry` -> `attempts + 1`, `next_at = now + max(5 s * 2^(attempts-1), afterMs)` (at most 5 attempts, then delivery `failed` `retry_exhausted`); `rejected` / `refused` -> delivery `failed` with the reason class (`rejected`, `refused`). One slow target never blocks the others (all due targets are sent in one pass under the effect's deadline signal).
5. After the pass: any delivery still `pending` -> return `defer` to the earliest `next_at` (the outbox keeps the row; no attempt is consumed, so the outbox's own five-attempt `failed` banner never fires). None pending -> event `sent` if any delivery is `done`, else `failed` with the first reason class, written to `push_meta.last_failure = { at, reason }` (a class, never a body or an endpoint); settle `done` in every case.
Replaying after a crash resumes the `pending` deliveries only; a duplicate of an already-sent target is collapsed by `Topic` and `tag`.

**Tests (RED):**
- `send.fans-out`: two subscriptions, both receive one call each with the same `topic` (the event id), `urgency: high` for an approval, the TTLs above; event `sent`; no `markSent` row is ever set (`sent_at` stays null).
- `send.skips-dead-session` (Review Focus 3): `sessionLive` false -> row dropped, zero transport calls, event `cancelled:no_target`; **mutation: remove the `sessionLive` call -> this test fails** (M12-RT-21).
- `send.gone-drops-row`: `gone` -> row deleted; others continue.
- `send.retry-then-ok` (flow 5 of the old plan, now true): the fake answers `retry` once then `ok` -> after `outbox.drain()` and a Clock advance of the backoff the second attempt succeeds, the event is `sent`; `Retry-After` of 30 s makes the next attempt wait 30 s, not 5 s.
- `send.retry-exhausted`: five `retry` outcomes -> delivery `failed:retry_exhausted`, event `failed`, `push_meta.last_failure` set, the effect settles `done` (not `failed`: `outbox.failures(owner)` is empty), the log line has the endpoint hash and no endpoint.
- `send.partial`: two targets, one `ok` one `rejected` -> event `sent`, the rejected delivery `failed:rejected`.
- `send.crash-resumes-pending-only`: stop between targets (the fake's `hold()`), recover the outbox, drain -> only the unsent target is sent; a `sent` event is not sent again.
- `approval.answered-in-window` (Review Focus 2): enqueue an approval, answer it at +59 s, advance the Clock to +60 s, `outbox.drain()` -> transport never called, event `cancelled`; the cancel-by-key path leaves the row retired. **Mutation: drop the `stillWaiting` check -> fails.**
- `focused.recheck` (Review Focus 7): a `looking` entry at +60 s -> the effect is deferred and the event stays `pending` with `rechecks 1`; the entry goes stale -> the next re-check sends; after three re-checks with a still-looking tab the event settles `suppressed:focused`.
- `muted-suppresses`, `class-off-suppresses`, `cooldown-suppresses`: transport never called, event `suppressed:<reason>`, the Inbox untouched. `rate-cap.exempts-approval`: 20 `failed` events sent in an hour, the 21st `suppressed:rate_cap`, an approval in the same hour is sent.
- `payload.is-generic`: the decrypted-shape plaintext is a `PushWire` with the generic body in the target's locale; with `titles: "names"` and a registry `name` the body appends it; an event with no `name` stays generic even in `names` mode.
- Int `daemon.push.delivery.int.test.ts` (fake transport injected through the compose seam): a `failed` event end to end through the real outbox drain with a restart in between (the pending row survives; a `sent` row is not re-sent after recovery); a sign-out of the subscribing session drops its row and sends nothing; a 410 drops the row.

- [ ] Steps: RED, implement, `pnpm lint && pnpm typecheck && pnpm test:unit -- push/delivery && pnpm test:int -- daemon.push`, commit `feat(push): push.send with per-device deliveries, retry and dead-session checks (M12)`.

## Task 9b: Quiet hours, the digest, housekeeping, push.test

**Model:** Sonnet; Sonnet reviewer (Review Focus 5 lives here). **Gate:** unit + int (its own file, `daemon.push.quiet.int.test.ts`: no int test file passes 400 lines).

**Files:** Create `push/delivery/{digest.ts,digest.test.ts,quiet.ts,quiet.test.ts,housekeeping.ts,housekeeping.test.ts,test-push.ts,test-push.test.ts}`, `apps/daemon/src/daemon.push.quiet.int.test.ts`; modify `push/delivery/rpc.ts` (`push.test` is implemented here; chain A does not touch it: task 1's `push/rpc.ts` routes it to this file), `push/delivery/index.ts`.

**Interfaces:** produces the `digest.send` handler, `nextQuietEnd(quietHours, timezone, now): number | null`, the 14-day purge (`push_events` and their `push_deliveries`) registered on the daemon's housekeeping cadence, and `push.test`.

**`nextQuietEnd`:** scans minute by minute from `now` up to 1440 steps with `inQuietHours(quietHours, timezone, t)` and returns the first minute where it is false (`null` when `now` is not inside a window; when `quietHours` is null or `from === to`, null).

**`digest.send`** (handler for `{ ownerId, endMinute }`): select the owner's `held` events; judge each (M12R17): `stillWaiting` (Inbox item unresolved, or the session still waiting) keeps it counted; gone -> `cancelled`; gone because the Inbox item's `resolution` is `timed_out` -> counted as expired (`cancelled`, reason `expired`). If nothing is counted and nothing expired, settle `done`. Else insert a `digest` event row (`ref_kind "digest"`, `ref_id` = owner, so a click lands on the Inbox) and send ONE wire to every live target through the same per-target machinery as task 9a (so it retries too), body `copyFor("digest", locale, { n, expired })`; the counted events become `digested`. The digest is subject to mute and focus, not to quiet hours, cooldown or the hourly cap.

**`push.test`:** the service method (browser-only, M12R10): 1 per 10 s per owner (`rate_limited`, `createRateLimiter(clock, 10_000)`); inserts a `test` event row (`ref_kind "test"`, so the click opens Settings > Notifications); sends the `test` class wire straight through the transport (not the outbox) to `subscriptions.targets(owner, caller.credentialId)` (the caller's current-credential subscriptions only); result `{ delivered, dropped }`; `push_unavailable` when the transport is off.

**Tests (RED):**
- `quiet.holds-then-digest`: Clock inside 22:00-07:00 (zone Europe/Paris), three `failed` events -> three `held`, one `digest.send` row at 07:00; advance the Clock to 07:00, drain -> ONE transport call per target with class `digest` and `n` = 3 in the French body "3 éléments vous attendent."; events `digested`.
- `digest.skips-resolved` (Review Focus 5): one of three items resolved before 07:00 -> body says 2; all resolved -> no transport call.
- `digest.counts-expired` (M12-RT-12): a held `agent_approve` item whose resolution became `timed_out` and a held task question denied after 10 minutes -> the body ends "2 demandes ont expiré pendant les heures calmes." and the digest is sent even with `n = 0`; an item the owner answered is not counted as expired.
- `quiet.end.dst`: windows across the spring-forward and autumn-back nights (Europe/Paris 2026-03-29 and 2026-10-25): `nextQuietEnd` returns the real wall-clock 07:00 instant (not +9 h of elapsed time); `from === to` -> null; the window starting now returns its end.
- `digest-not-held-by-quiet`: the digest itself is not re-held; `digest.has-its-own-event`: the digest wire's id resolves through `push.open` (task 11) to the Inbox target.
- `restart.cancels-approvals-keeps-others` (M12-RT-10): a pending approval-class event, a pending `failed` and a pending `budget` event, restart (workers die, dialogs close), drain -> the approval is `cancelled` and sends nothing, the other two are sent once; a `sent` row is not sent again.
- `push.test.rate-limited-and-own-devices`: a second call within 10 s -> `rate_limited`; another credential's subscription is not messaged; the test event row exists.
- `housekeeping.purges-14-days`: old settled events and their deliveries removed, held/pending kept.
- Int: quiet hours hold three events and one digest arrives at the window end through the real outbox (flow 3 of the old plan).
- Mutation checks: skip the `stillWaiting` judgement in the digest -> `digest.skips-resolved` fails; count every cancelled event as expired -> `digest.counts-expired` fails.

- [ ] Steps: RED, implement, `pnpm lint && pnpm typecheck && pnpm test:unit -- push/delivery && pnpm test:int -- daemon.push`, commit `feat(push): quiet-hours digest with expired requests, housekeeping and a test push (M12)`.

## Task 10: Sources I - the Inbox (needs input, failed, notify)

**Model:** Sonnet; Sonnet reviewer. **Gate:** unit.

**Files:** Modify `modules/inbox/service.ts` (+`onItem`, `get`; about 14 lines; 218 -> 232), `inbox/agent-items.ts` (pass the change kind at its announce sites), `inbox/index.ts` (types), `automation/index.ts` (one additive field on `InboxTaskInfo`: `registeredName: string | null`, the `trigger_name` only, null for a deleted trigger; next to line 320 where `triggerName` falls back to the task title); create `push/delivery/source-inbox.ts`, `source-inbox.test.ts`; `inbox/service.listeners.test.ts` (new).

**Interfaces:** produces on the Inbox: `onItem(listener: (event: { item: InboxItem; change: "created" | "reopened" | "resolved" }) => void): () => void` and `get(ownerId, id): InboxItem | null`. **`announce` stays as it is** (it is also called by `markRead`); the sites that insert (`insertInfo`), re-open (`openQuestion` returning the same row for a task's next question, `upsertRef`) or resolve a row report the change to the listeners; `markRead` and any re-announce report nothing (M12-RT-01 scenario 2). A throwing listener is logged and ignored, as `AutomationEvents`. In push: `wireInboxSource({ inbox, notifier, stillWaiting })` mapping per M12R2: `task_needs_input` -> `approval` with **`refKind: "session"`, `refId: item.sessionId`** (the key `push:approval:session:<sessionId>` that task 11's attention source uses too; one push per waiting session, M12R2; an item without a `sessionId` is Inbox-only); `agent_approve`, `secret_request` -> `approval` with `refKind: "inbox"`, `refId: item.id`; `task_failed`, `task_interrupted` -> `failed`; `agent_notify` -> `notify`; `task_done`, `task_limited` -> `done`; `agent_reply`, `delegation_done` -> `reply`; `memory_review` -> `review`; an unknown kind (a newer daemon) -> no push. `change: "resolved"` for an approval-class item calls `notifier.cancel(key, item.resolution === "timed_out" ? "expired" : "answered")`. `name` is the registry name only: `registeredName` for task items, the agent's name from the agents port for agent items; never `item.triggerName` (it falls back to the task title, which can come from a webhook payload) and never `detail`.

**Rulings:** **M12R22** (the Inbox is the single source for everything except interactive approvals and budgets, so a new Inbox kind needs one line here; push never reads `detail`, the untrusted agent text, in v1). Cost if wrong: an agent's untrusted text on the lock screen; a lost second question.

**Tests (RED):** each kind -> class table (above); `second-question-pushes-again` (Review Focus 6, with the real Inbox store): a task asks, the push is sent (event `sent`), the same task asks again -> `openQuestion` re-opens the same row id, `onItem` reports `reopened`, and a **new** push is enqueued and sent; `mark-read-pushes-nothing`: `markRead` on an approval item produces no listener call and no event; `agent_notify` with a `detail` containing `<script>` and `\u202e`: the notifier receives no `detail` and the wire payload contains neither; `names` from a task whose trigger was deleted (title from a payload `"IGNORE PREVIOUS"`) stays generic; `resolved` of a pending approval cancels (outbox row `retired`, event `cancelled:answered`); `timed_out` resolution of an isolated task's question cancels with `expired` (decision 90 a3: at 10 minutes the question is denied; the push must not arrive afterwards); a created item for an owner with a disabled class is stored as `suppressed:class_off` by the send handler (not here); unknown kind -> nothing; listener throws -> Inbox still announces (Inbox tests unchanged); `get` returns null for another owner's item. Mutation: call the listener from `announce` -> `mark-read-pushes-nothing` fails.

- [ ] Steps: RED, implement, `pnpm lint && pnpm typecheck && pnpm test:unit -- inbox push/delivery/source-inbox`, commit `feat(push): Inbox items become pushes by class (M12)`.

## Task 11: Sources II - interactive approvals (attention feed), push.presence and push.open

**Model:** Sonnet; Sonnet reviewer (content-leak test included). **Gate:** unit + int (it reads the sessions runtime).

**Files:** Create `push/delivery/{source-sessions.ts,source-sessions.test.ts,open.ts,open.test.ts}`; modify `push/delivery/rpc.ts` (`push.presence`, `push.open`), `compose-push-delivery.ts` (wire the source); create `apps/daemon/src/daemon.push.sessions.int.test.ts`. **No edit to `modules/sessions/`** (M12-RT-03: `live-ui.ts` has five `dialog_closed` sites, `live-session.ts` is at 396 lines, `service.ts` at 400): the source reads the existing `SessionsAutomationPort` (`onAttention(listener)`, `state(ownerId, sessionId)`) and `sessions.ownerOf(sessionId)` through `sessions/index.ts`. If the int test shows that a worker exit does not produce an attention report, the fix is an additive line inside `sessions/automation-port.ts` (355 lines), recorded in the task report.

**Interfaces:** consumes `SessionsAutomationPort.onAttention`, `ownerOf`, the agents port (registry name of the agent that owns the session, `names` only), notifier, presence. Produces `wireSessionSource(deps)`: `onAttention(sessionId, true)` -> `waiting.add(sessionId)` and `notify({ cls: "approval", refKind: "session", refId: sessionId, name? })` (the shell's `needsInput` is parent-aware, M12R24: a child's open dialog reports the PARENT, and the push opens the parent's card); `false` -> `waiting.delete` and `cancel(key, "answered")`. `stillWaiting(event)` for a session ref = the `waiting` set contains it and `state(owner, sessionId)` is not null and not archived (a dead worker no longer pushes). `push.presence` (browser-only; `presence.report(owner, ctx.connectionId, focused)`), `push.open { id }` -> resolves the event the caller owns to `{ target }`: an approval-class event with a session ref -> `{ kind: "session", id: sessionId }` (decision 32: the full-width card of that session); an `inbox` ref -> `{ kind: "inbox", id: item.id }` (for `agent_approve` and `secret_request`, whose rows have answer buttons, and for done/failed/notify/reply/review); `budget` -> `{ kind: "settings", id: "automation" }` for owner-wide or `{ kind: "agent", id: agentId }`; `digest` -> `{ kind: "inbox", id: null }`; `test` -> `{ kind: "settings", id: "notifications" }`; another owner's or an unknown id -> `not_found` (the same error, no oracle); a closed/answered target still resolves (the landing page then shows "Déjà traité").

**Rulings:** **M12R23**, **M12R24** (verified false as first written; corrected). Cost if wrong: a push whose click opens a session where nothing waits, or two pushes for one question.

**Tests (RED):** unit: an attention report `true` notifies once with the 60 s delay and the key `push:approval:session:<id>`; `false` cancels; the Inbox's `task_needs_input` for the same session (task 10) joins the same key: **one push, not two** (M12-RT-02), with the Inbox source's `sessionId` mapped to that key; a child's approval reported on the parent notifies for the parent; two sessions waiting produce two events; `push.open` resolves each ref kind above (session -> session card, inbox, budget owner/agent, digest, test), refuses another owner's id and a token (`forbidden`) and an unknown id (`not_found`, identical message); `push.presence` from a token -> `forbidden`, entries from one connection overwrite (one entry per connection id), the 65th connection -> `capacity`. Int: a worker session with the scripted provider asks for approval; with no presence entry and the Clock advanced 60 s, `outbox.drain()` makes the fake transport receive one `approval` wire whose body contains no part of the command text; answering within 59 s sends nothing; a focused presence entry sends nothing and the re-check sends once it lapses; `approval.worker-exit-cancels`: the worker exits with the approval open -> no push at +60 s (M12-RT-03); a subagent child's approval -> one push, target the parent session (the verified M12R24); an isolated task's question -> one push (attention and Inbox joined).

- [ ] Steps: RED, implement, `pnpm lint && pnpm typecheck && pnpm test:unit -- push/delivery && pnpm test:int -- daemon.push`, commit `feat(push): approvals waiting 60 s push once per session, with presence and push.open (M12)`.

## Task 12: Sources III - budgets

**Model:** Sonnet; Sonnet reviewer. **Gate:** unit + int (its own file, `apps/daemon/src/daemon.push.budget.int.test.ts`).

**Files:** Create `push/delivery/{source-budget.ts,source-budget.test.ts}`; modify the minimal port in `runs/index.ts` or `automation/index.ts` if the spend lookup is not already exported (additive export only).

**Interfaces:** consumes `RunsPort.onRunEnd(listener)` (exists, M11R137), the owner-wide daily spend and budget (`settings.automation(ownerId).dailyBudgetUsd` and `runs` day totals, M10; the day is the owner's zone day, `runs/days.ts`), the per-agent spend and budget (`automation/agent-budget.ts`, M11R74: `spent` vs `budget.usdPerDay`/`tokensPerDay`; the agent's budget lives in the registry). Produces `wireBudgetSource(deps)`: at each run end, check the owner-wide daily total and, for a run of an agent, the agent's day total; when a limit is reached or crossed and no event exists for `(scope, day)` -> `notify({ cls: "budget", refKind: "budget", refId: "owner:<yyyy-mm-dd>" | "agent:<agentId>:<yyyy-mm-dd>", name? })`. An `events.exists(dedupKey, sinceDayStart)` check on the table (any state) gives once per scope per day, restart-safe.

**Rulings:** **M12R25** (owner n10: on reached only), **M12R26**.

**Tests (RED):** owner-wide: spend crosses the limit at a run end -> one event; the next run end the same day -> none (`once-per-day`); a new zone day -> another; DST day length (a 25 h day) stays one event; per-agent: agent A reaches its own limit -> event with `name` = agent name, agent B unaffected; both reached by one run -> two events; token budget (`tokensPerDay`) counts; no budget set -> nothing; restart: after a reboot with the day's event stored, no second push (the dedupe reads the table, not memory); `names` only adds the agent name, never amounts (the wire has no number: "A budget is reached."). Int `budget-once-per-day`: the owner-wide budget crossing pushes once, the per-agent once, nothing on the next run.

- [ ] Steps: RED, implement, `pnpm lint && pnpm typecheck && pnpm test:unit -- push/delivery/source-budget runs && pnpm test:int -- daemon.push`, commit `feat(push): daily and per-agent budget reached pushes (M12)`.

## Task 19: Mobile conformance (decision 32) - audit and fill the gaps (chain B, after task 12)

**Model:** Sonnet; Sonnet reviewer. **Gate:** unit + build + budgets. Eager delta: at most +0.3 KB (anything larger moves lazy or is cut).

**Files:** only those the audit finds; likely `routes/shell/MobileShell.tsx`, `features/lanes/LaneScreen.tsx`/`LaneBody.tsx`, `features/inbox/InboxPanel.tsx`, the agent thread header and composer; each with its test; a lazy `mobile.*` catalog with its own register file; the audit table is written into the task's commit body. **Not edited here:** `ConnectionBanner.tsx` and `runtime/*` (task 16), the approval card (task 18), `use-shell-effects.ts` (tasks 15b and 18).

**Audit (step 1, the deliverable before any code):** a table of every element of board 12's "1 - Mobile (PWA)" and decision 32 against the code, each row `present / missing / differs` with the file. The two carried rows come first, then the rest:
- **Carry (project-home final review §3.1, M12):** the composer must not auto-focus on a phone (a coarse pointer): auto-focus raises the keyboard over the thread.
- **Carry (project-home ledger T9):** phone logo and "+" touch-target sizing (44 px on coarse pointers), unverified.
- Bottom nav Agents / Work / Lists / Inbox with badges: present (`BottomNav.tsx`; verify the Inbox badge counts waiting items first).
- Agent thread: cost today chip, external chip, cancellable reminder, prompt chips, composer (`features/agents`; the `cost today` status exists in `status.vm.ts`).
- Lane review with a Chat / Review / Term segmented switch, the Seen list, the diff and "Send to agent" (`LaneScreen.phone.test.tsx`, `SendBar.tsx`, `ReviewPane.tsx`): audit the segmented switch and the Seen list.
- Inbox with waiting items first (`inbox.vm.ts`): verify ordering on the phone.
- System states: OOM crash banner, capacity reached, reconnecting with drafts kept (task 16), empty state, toast with Undo: verify presence; only fill what is missing.
- 44 px touch targets on coarse pointers (M3 E2 rule), `viewport-fit=cover` and safe-area padding in standalone display (`pb-safe` exists), `interactive-widget=resizes-content` keyboard handling (`use-viewport-height.ts` exists), `display: standalone` top-bar inset (`env(safe-area-inset-top)` on the top bar).
- Standalone-only polish: no text selection callout on controls, `overscroll-behavior: none` on the app root, pull-to-refresh not hijacking the transcript.

**Bound (red-team sizing, section 6):** the audit plus the two carried rows (if the audit proves them missing) plus **at most three other fills**; everything else goes into a list in the final commit body and the task report, for the owner's visual check (the controller raises it as a question, never decided silently).

**Rulings:** **M12R34.** Cost if wrong: invented UI, or a decision-32 element silently absent.

**Tests (RED, per fill):** headless viewport tests at 390x844 (the happy-dom class-name approach of `LaneScreen.phone.test.tsx` and `MobileShell.phone.test.tsx`): the composer does not take focus on mount under a coarse pointer; the segmented switch shows three segments and the active one has `aria-current`; the Seen list renders the seen files; the top bar carries the safe-area top class in standalone; the Inbox puts waiting items before the rest; every interactive control in the mobile shell has the coarse 44 px class (a DOM scan over rendered `MobileShell`: any `button, [role=button], a` without the control class fails, minus an explicit allow-list).

- [ ] Steps: audit table first (commit message body), RED per gap, implement, `pnpm lint && pnpm typecheck && pnpm test:unit -- shell lanes inbox agents && pnpm build && pnpm budgets`, one commit per gap `feat(web): <element> on the phone per the round 10 board (M12)`.

---

# Chain C: web (tasks 13, 14, 15a, 15b, 17, 18)

Chain C is web-only (unit + build + budgets; each task also runs the short `test:int -- build-output.pwa` filter). It owns `build-output.pwa.int.test.ts`, `budgets.json`, `scripts/check-budgets.ts`, `knip.json`, `vite.config.ts`, `apps/web/package.json` (`typecheck` line) and `use-shell-effects.ts`. Each task adds a lazy i18n catalog with its own register file; none edits the eager `en.ts`/`fr.ts`.

## Task 13: Manifest, PNG icons, static serving

**Model:** Sonnet; Sonnet reviewer. **Gate:** unit + build + budgets. Eager delta: 0 KB JS (about 0.2 KB of HTML).

**Controller step before dispatch (owner n8, M12R27):** render the PNGs once with the Playwright podman image (the headless host has no graphics; see the memory note) from the three SVGs in `apps/web/icons-src/` (`favicon-tile.svg` -> `icon-192.png`, `icon-512.png`, `badge-96.png`; `pwa-maskable.svg` -> `icon-maskable-512.png`; `apple-touch.svg` -> `apple-touch-icon.png` at 180 px) and commit them to `apps/web/public/icons/`. The repository gets **no icon script, no devDependency and no package.json line**; the implementer does not render anything.

**Files:** Create `apps/web/public/manifest.webmanifest`, `apps/web/src/pwa-assets.test.ts`, `apps/web/src/build-output.pwa.int.test.ts` (split out of the 279-line `build-output.int.test.ts` now; M12-RT-28); modify `apps/web/index.html`. The controller's PNGs: `apps/web/public/icons/{icon-192.png,icon-512.png,icon-maskable-512.png,apple-touch-icon.png,badge-96.png}`.

**Interfaces:** produces the manifest and the icon paths consumed by task 14 (precache) and the SW (`icon`, `badge`). Manifest: `{ "id": "/", "name": "pap", "short_name": "pap", "start_url": "/", "scope": "/", "display": "standalone", "background_color": "#14111d", "theme_color": "#14111d", "icons": [{src,192,"any"},{src,512,"any"},{src:"/icons/icon-maskable-512.png",sizes:"512x512",type:"image/png",purpose:"maskable"}] }` (colours equal the existing `<meta name="theme-color">` and the night `bg-side` token; a test reads both and compares). `index.html` gains `<link rel="manifest" href="/manifest.webmanifest">`, `<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">`, `<meta name="apple-mobile-web-app-capable" content="yes">`, `<meta name="apple-mobile-web-app-title" content="pap">`, `<meta name="mobile-web-app-capable" content="yes">`.

**Rulings:** **M12R27.** Cost if wrong: a stale manifest after a rebrand (low).

**Tests (RED):** `pwa-assets.test.ts`: the manifest parses against a local zod schema (name, start_url `/`, scope `/`, display `standalone`, at least 192 any, 512 any, one maskable); every `icons[].src` exists in `public/icons` and its PNG IHDR width/height equal `sizes` (parse the 24 first bytes, no library); the badge is 96x96; the apple icon is 180x180; `theme_color` equals the HTML meta; `index.html` has the five tags; the maskable icon is square. `build-output.pwa.int.test.ts` (built `dist`): `dist/manifest.webmanifest` and all icons exist; `index.html` references the manifest; the initial assets list is unchanged in size class (no new `/assets` chunk in `index.html`). Daemon static test (existing `static` tests): `/manifest.webmanifest` -> `application/manifest+json`, `/icons/icon-192.png` -> `image/png`, both without a cookie, both `no-cache`. `browser-floor.test.ts` stays green.

- [ ] Steps: RED, implement, `pnpm lint && pnpm typecheck && pnpm test:unit -- pwa-assets static && pnpm build && pnpm budgets && pnpm test:int -- build-output.pwa`, commit `feat(web): web app manifest and icons from the L4 logo (M12)`.

## Task 14: The service worker (security: fetch and cache rules, push, click)

**Model:** Sonnet implementer; **Opus reviewer** (cache rules decide whether authenticated data can leak; click opens only same-origin). **Gate:** unit + build + budgets. Eager delta: 0 (separate file).

**Files:** Create `apps/web/sw/sw.ts`, `apps/web/sw/tsconfig.json` (lib `es2023` + `webworker`, `types: []`, includes `sw.ts` only), `apps/web/sw/sw.test.ts`, `sw.push.test.ts`, `sw.fetch.test.ts`, `sw.update.test.ts`, `apps/web/sw/harness.ts` (a fake scope: event emitter, a `Map`-backed `caches`, `clients`, `registration.showNotification` recorder, `skipWaiting` spy, fake timers), `apps/web/vite/service-worker.ts` (a Vite plugin); modify `apps/web/vite.config.ts` (add the plugin), `apps/web/tsconfig.json` (add `"sw"` to `include`, a whole line: the tests and harness are typechecked with the DOM lib), `apps/web/package.json` (`typecheck`: `tsc --noEmit -p tsconfig.json && tsc --noEmit -p sw/tsconfig.json`, M12-RT-27), `budgets.json` (`"serviceWorkerGzipKb": 4`), `scripts/check-budgets.ts` (measure `dist/sw.js`), `apps/web/src/build-output.pwa.int.test.ts`, `knip.json` (`apps/web` entry `sw/sw.ts`).

**Build design (M12R28, M12R14):** `sw/sw.ts` is a single erasable-TypeScript file whose top level declares pure functions and one `registerServiceWorker(scope: SwScope)`, where `SwScope` is a structural interface of the members used (so the file typechecks under both the DOM and the WebWorker lib); at the bottom `if (typeof ServiceWorkerGlobalScope !== "undefined" && self instanceof ServiceWorkerGlobalScope) registerServiceWorker(self as unknown as SwScope)`. The plugin strips types with `node:module` `stripTypeScriptTypes`, removes the line-leading `export ` keywords (a classic script has no modules, so the test files import the same source through Node), and in `generateBundle` computes `__SHELL__` = `["/", "/index.html", every emitted /assets/* file (lazy chunks included, source maps excluded), plus the public files: /favicon.svg, /manifest.webmanifest and the icons (read from the public dir, which Vite copies after generateBundle)]` and `__BUILD_ID__` = the first 16 hex of the sha-256 over the sorted `path:content-sha256` lines of every shell file (so a manifest or icon change updates the worker: they are served cache-first), then emits `sw.js` at the dist root unhashed. A build-output test asserts `sw.js` contains no `import`/`export` token, no `__BUILD_ID__` or `__SHELL__` left, the shell list equals the emitted assets plus the public list, and `/index.html` is in it. Cost: the first install downloads the whole `dist` (about the size of the app, 1 to 2 MB); the old shell stays usable meanwhile. Cost if wrong: the SW does not parse on Safari (caught by the build test and by `new Function(sw)` in a unit test).

**Full code (cache and routing rules, push, click; the file's remaining glue is the install/activate/message handlers shown):**
```ts
declare const __BUILD_ID__: string;
declare const __SHELL__: readonly string[];

const PREFIX = "pap-shell-";
const ID = /^[A-Za-z0-9_-]{22}$/;
const CLASS_NAMES = ["approval", "failed", "budget", "notify", "done", "reply", "review", "digest", "test"];
const NAV_TIMEOUT_MS = 8_000; // pi-web learned it: a reachable port backed by a dead upstream never answers
// Anything the daemon serves that is not the SPA: never intercepted, never cached.
const NOT_SPA = ["/auth", "/api", "/files", "/upload", "/hooks", "/metrics", "/healthz", "/ws", "/sw.js"];

export function isNotSpa(pathname: string): boolean {
  return NOT_SPA.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
export function isShellPath(pathname: string): boolean {
  return (
    pathname === "/" || pathname === "/index.html" || pathname === "/favicon.svg" || pathname === "/manifest.webmanifest" ||
    pathname.startsWith("/assets/") || pathname.startsWith("/icons/")
  );
}
export type Route = "shell" | "navigation" | "pass";
export function routeOf(request: { method: string; url: string; mode: string }, origin: string): Route {
  if (request.method !== "GET") return "pass";
  let url: URL;
  try { url = new URL(request.url); } catch { return "pass"; }
  if (url.origin !== origin || isNotSpa(url.pathname)) return "pass";
  if (request.mode === "navigate") return "navigation";
  return isShellPath(url.pathname) ? "shell" : "pass";
}
export function cacheable(res: { status: number; type: string; redirected: boolean; headers: { get(name: string): string | null } }): boolean {
  if (res.status !== 200 || res.type !== "basic" || res.redirected) return false;
  const control = (res.headers.get("cache-control") ?? "").toLowerCase();
  return !control.includes("no-store") && !control.includes("private");
}
/** Network first with a deadline; the cached static shell when the network fails, times out or a proxy answers 5xx. Never data. */
export async function navigate(request: Request, shell: () => Promise<Response | undefined>, timeoutMs = NAV_TIMEOUT_MS): Promise<Response> {
  const fallback = async () => (await shell()) ?? Response.error();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(request, { signal: controller.signal });
    return res.status >= 500 ? await fallback() : res;
  } catch {
    return await fallback();
  } finally {
    clearTimeout(timer);
  }
}
export function notificationOf(raw: string | null): { title: string; options: { body: string; tag?: string; icon: string; badge: string; data: { id: string | null } } } {
  const base = { icon: "/icons/icon-192.png", badge: "/icons/badge-96.png" };
  try {
    if (raw === null || raw.length > 2048) throw new Error("size");
    const p = JSON.parse(raw) as Record<string, unknown>;
    const idOk = typeof p.id === "string" && ID.test(p.id);
    if (p.v !== 1 || !idOk || typeof p.cls !== "string" || !CLASS_NAMES.includes(p.cls)) throw new Error("shape");
    const clip = (v: unknown, n: number) => (typeof v === "string" ? Array.from(v).slice(0, n).join("") : "");
    return { title: clip(p.title, 80) || "pap", options: { ...base, body: clip(p.body, 200), tag: p.id as string, data: { id: p.id as string } } };
  } catch {
    return { title: "pap", options: { ...base, body: "", data: { id: null } } }; // iOS needs a notification for every push
  }
}
export function clickPath(id: unknown): string {
  return typeof id === "string" && ID.test(id) ? `/n/${id}` : "/";
}

export function registerServiceWorker(scope: SwScope): void {
  const current = `${PREFIX}${__BUILD_ID__}`;
  scope.addEventListener("install", (event) => {
    event.waitUntil(caches.open(current).then((cache) => cache.addAll(__SHELL__.map((u) => new Request(u, { cache: "reload" })))));
  }); // a failed precache fails the install: the old worker stays in charge, nothing is stranded
  scope.addEventListener("activate", (event) => {
    // Only the NEW worker's activate deletes the old shell caches: until then the old shell still has its own lazy chunks.
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== current).map((k) => caches.delete(k)))).then(() => scope.clients.claim()),
    );
  });
  scope.addEventListener("message", (event) => {
    if ((event.data as { type?: unknown } | null)?.type === "skip-waiting") void scope.skipWaiting(); // only after the owner accepted the update banner
  });
  scope.addEventListener("fetch", (event) => {
    const route = routeOf(event.request, scope.location.origin);
    if (route === "pass") return; // network only, the worker never sees the response
    if (route === "shell") {
      event.respondWith(
        caches.open(current).then(async (cache) => { // this worker's own versioned cache, never caches.match (that searches a newer waiting worker's cache too)
          const hit = await cache.match(event.request);
          if (hit) return hit;
          const res = await fetch(event.request);
          const path = new URL(event.request.url).pathname;
          if ((path.startsWith("/assets/") || path.startsWith("/icons/")) && cacheable(res)) await cache.put(event.request, res.clone());
          return res;
        }),
      );
      return;
    }
    event.respondWith(navigate(event.request, () => caches.open(current).then((cache) => cache.match("/index.html"))));
  });
  scope.addEventListener("push", (event) => {
    const { title, options } = notificationOf(event.data ? event.data.text() : null);
    event.waitUntil(scope.registration.showNotification(title, options));
  });
  scope.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const target = new URL(clickPath((event.notification.data as { id?: unknown } | null)?.id), scope.location.origin);
    if (target.origin !== scope.location.origin) return; // cannot happen by construction; kept as the last line of defence
    event.waitUntil(
      scope.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (all) => {
        const open = all.find((c) => new URL(c.url).origin === scope.location.origin);
        if (open) { await open.focus(); open.postMessage({ type: "open", path: target.pathname }); return; }
        await scope.clients.openWindow(target.href);
      }),
    );
  });
  scope.addEventListener("pushsubscriptionchange", (event) => {
    event.waitUntil(scope.clients.matchAll({ type: "window" }).then((all) => all.forEach((c) => c.postMessage({ type: "resubscribe" })))); // the page re-subscribes with its cookie; the worker holds no credential
  });
}
```
The navigation route is network-first with an 8 s deadline; only static assets and icons are written to the cache at runtime; `index.html` is stored at install (from `__SHELL__`) and never updated from a runtime response (so a runtime response with user data can never enter the cache). The page opens the path from the `open` message through its router (task 18).

**Tests (RED, run in Node with the harness):**
- `route.table`: `GET /` navigate -> navigation; `GET /assets/a.js` -> shell; `GET /icons/icon-192.png` -> shell; `POST /` -> pass; `GET /auth/session`, `/auth/passkeys`, `/api/x`, `/files/x`, `/upload`, `/hooks/t`, `/metrics`, `/healthz`, `/ws`, `/sw.js` -> pass (also as navigations); cross-origin `https://evil.example/assets/a.js` -> pass; `GET /anything.json` non-navigate -> pass; `GET /n/abc` navigate -> navigation.
- `no-authenticated-response-cached`: drive the fetch handler for `/auth/session`, `/files/x`, `/api/x`, `/healthz` with the harness: `respondWith` never called, `caches` stays empty.
- `cacheable.rules`: 200 basic ok; 404, 206, `opaque`, `redirected`, `Cache-Control: no-store`, `private, max-age=0` -> false.
- `shell.cache-first-and-put-assets-only`: a miss on `/assets/x.js` fetches and puts; a miss on `/manifest.webmanifest` fetches and does NOT put; a hit is served without fetch.
- `navigation.network-first-with-deadline`: network ok -> response returned and nothing written; network error -> cached `/index.html`; **a fetch that never answers falls back after 8 s on the fake timers**; a 502 from a proxy falls back; no cached shell -> `Response.error()`. The harness seeds the cache only through the real `install` handler (the first plan's test seeded `/index.html` by hand and hid that the precache list lacked it).
- `install.precaches-shell-and-fails-closed`: `__SHELL__` contains `/index.html` and every lazy chunk; `addAll` rejection rejects `waitUntil` (install fails); no `skipWaiting` call at install.
- `update.old-shell-keeps-its-lazy-chunks` (M12-RT-07): worker v1 installed and active with `/assets/lazy-a.js` and `/index.html` cached; worker v2 installed (waiting) with a different build id and set -> v1's fetch of `/assets/lazy-a.js` and its navigation fallback are still served from v1's own cache (not v2's `/index.html`); v1's cache is deleted only when v2's `activate` runs.
- `update.waits-for-message`: after install the worker does not skip waiting; a `message {type:"skip-waiting"}` does; any other message does not.
- `activate.prunes-other-builds`: caches `pap-shell-old`, `pap-shell-<current>`, `other-cache` -> only the first is deleted.
- `push.shows-notification` and `push.malformed.shows-generic` (Review Focus 1): valid payload -> `showNotification(title, {body, tag: id, data: {id}})`; invalid JSON, `v: 2`, bad id, unknown `cls`, a 5 KB body, `null` data, an `id` with `/` or `..` -> still exactly one `showNotification("pap", { body: "", data: { id: null } })`, no `tag`; a `title` of 1000 chars is cut to 80; `showNotification` is awaited through `waitUntil`.
- `click.opens-only-same-origin-by-id`: id valid -> `focus` on an existing same-origin window and `postMessage({type:"open", path:"/n/<id>"})`; none open -> `openWindow("<origin>/n/<id>")`; `data.id` = `https://evil.example`, `//evil.example`, `/../x`, `javascript:alert(1)`, a number, null -> opens `/` (never anything else); a window of another origin in `matchAll` is not focused; the payload's own `url` field is ignored.
- `parses-as-classic-script`: `new Function(builtSw)` does not throw and has no `import `/`export ` tokens (build-output int); `size`: `dist/sw.js` gzip within the new budget line (4 KB); `build-id-covers-manifest-and-icons`: changing the manifest or one icon byte changes `__BUILD_ID__` (two builds in the int test, or the plugin function on a fixture).
- Mutation checks: add `/auth` to the shell list -> `no-authenticated-response-cached` fails; skip the `cacheable` call -> `cacheable.rules`/`shell.cache-first...` fail; use `payload.url` in click -> `click.opens-only...` fails; use `caches.match` instead of the versioned cache -> `update.old-shell-keeps-its-lazy-chunks` fails; drop the timeout -> the 8 s test fails.

- [ ] Steps: RED, implement, `pnpm lint && pnpm typecheck && pnpm test:unit -- sw && pnpm build && pnpm budgets && pnpm test:int -- build-output.pwa`, commit `feat(web): hand-written service worker with a precached versioned shell, push and a same-origin click (M12)`.

## Task 15a: Service worker registration, the update flow and the pwa store

**Model:** Sonnet; Sonnet reviewer. **Gate:** unit + build + budgets. **Eager delta estimate: +0.7 KB gzip** (registration, update triggers, flag store); the banner is lazy.

**Files:** Create `apps/web/src/runtime/sw-register.ts` + test (eager, tiny), `apps/web/src/stores/pwa.ts` (update-ready flag, install prompt, handlers for the worker's `open` and `resubscribe` messages, reset at sign-out) + test, `apps/web/src/routes/shell/UpdateBanner.tsx` + test (lazy, uses `Banner`), `i18n/catalog/pwa.{en,fr}.ts` and `register-pwa.ts`; modify `apps/web/src/main.tsx` (call `registerServiceWorker()` on idle), `routes/shell/AppShell.tsx` (one lazy slot line for the banner). It does not edit `runtime/connection.ts` or `runtime/index.ts`: it subscribes to the connection store's public state.

**Interfaces:** consumes `Connection` state (read-only). Produces:
```ts
// sw-register.ts
export function registerServiceWorker(env): void; // production + secure context only; scope "/", updateViaCache "none"
// stores/pwa.ts
export const pwa: { updateReady: boolean; needsReenable: boolean; onOpen(handler: (path: string) => void): void; onResubscribe(handler: () => void): void; ... };
```
**Rulings:** M12R14, M12R16, M12R30. Board: no board 12 element exists for this banner; it is composed from the existing `Banner` primitive (decision 32 / DESIGN.md) and shown in the owner's visual check. The copy is "La page a une mise à jour" with a "Recharger" button: it is about the web shell, never a pap release.

**Behaviour:** `updatefound` -> new worker `installed` with a controller present -> `pwa.updateReady = true` -> the banner posts `skip-waiting`, waits for `controllerchange`, reloads once (a `sessionStorage` flag guards against loops; every storage access is in try/catch). **`registration.update()` is called on every connection `waiting` -> `open` transition and on `visibilitychange` to visible** (an open or resumed PWA never navigates, so the browser would never check; M12-RT-07), at most once a minute. `vite:preloadError` (a lazy chunk 404 after a rebuild) sets `updateReady` so the banner shows, and reloads once if the flag allows.

**Tests (RED):** `sw-register`: never registers in dev, over http, or when `serviceWorker` is absent; registers with `{scope:"/", updateViaCache:"none"}`; the `updatefound` flow sets the flag only when there was a controller (first install is silent); `update()` is called after a reconnect and on visible, throttled to once a minute on the fake Clock; `vite:preloadError` sets the flag and reloads once, not twice; `message {type:"open"}` from the worker calls the registered handler with the path (task 18 provides it); `message {type:"resubscribe"}` calls the registered handler (task 15b); the banner renders in French, its button posts `skip-waiting` and reloads once; MC34: sign-out resets the store; the bundle: `build-output.pwa.int.test.ts` asserts `UpdateBanner` is not in the initial chunk.

- [ ] Steps: RED, implement, `pnpm lint && pnpm typecheck && pnpm test:unit -- runtime pwa UpdateBanner && pnpm build && pnpm budgets && pnpm test:int -- build-output.pwa`, commit `feat(web): service worker registration, update checks and the update banner (M12)`.

## Task 15b: Push client, support, presence, rebind

**Model:** Sonnet; Sonnet reviewer. **Gate:** unit + build + budgets. **Eager delta estimate: +0.8 KB gzip** (presence with input tracking 0.6, the lazy-import trigger 0.2); `push-client` and `bind` are lazy.

**Files:** Create `apps/web/src/runtime/presence.ts` + test (eager, tiny), `apps/web/src/features/notifications/push-client.ts` + test (lazy), `features/notifications/bind.ts` + test (lazy), `features/notifications/support.ts` + test (pure capability classification), `i18n/catalog/push.{en,fr}.ts` and `register-push.ts`; modify `apps/web/src/routes/shell/use-shell-effects.ts` (start presence with the connection; trigger the lazy rebind; **not `runtime/index.ts`**, which is task 16's), `routes/shell/sign-out.ts` (reset the store, unsubscribe this device), `stores/pwa.ts` (`needsReenable`).

**Interfaces:** consumes the contracts (task 1; `rpc.call("push.*")`), `Connection` state. Produces:
```ts
// features/notifications/support.ts
export type PushSupport = "supported" | "insecure" | "needs_install_ios" | "no_service_worker" | "no_push_api" | "denied" | "unsupported";
export function pushSupport(env: { isSecureContext: boolean; hasServiceWorker: boolean; hasPushManager: boolean; hasNotification: boolean; permission: NotificationPermission | undefined; isIos: boolean; standalone: boolean }): PushSupport;
// push-client.ts
export function enablePush(deps): Promise<{ ok: true; id: string } | { ok: false; reason: PushSupport | "refused" | "capacity" | "rpc" }>;  // must run from a click
export function disablePush(deps, id: string): Promise<void>; // push.revoke then subscription.unsubscribe()
// bind.ts: at each start with permission granted (M12R12)
export function bindPush(deps): Promise<"none" | "refreshed" | "needs_reenable">;
// presence.ts (eager)
export function startPresence(deps: { rpc; connection; timers; doc: Pick<Document, "visibilityState" | "hasFocus" | "addEventListener" | "removeEventListener">; win }): () => void;
```
**Rulings:** M12R11, M12R12, M12R16, **M12R29**. Board: Settings > Notifications and this client have no board 12 element; they are composed from existing primitives.

**Behaviour:**
- Presence (M12R11): `focused = hasFocus() && visibilityState === "visible" && now - lastInputAt < 120 000` (`lastInputAt` from `pointerdown`, `keydown`, `touchstart`, `wheel`); sent on start, on `focus`/`blur`/`visibilitychange`, every 20 s while the connection is open, and best-effort `focused: false` on `pagehide` and on hidden.
- `bindPush` (M12-RT-06): when `Notification.permission === "granted"`, call `registration.pushManager.getSubscription()`. None -> `none`. Its `options.applicationServerKey` differs from `push.config.publicKey` (a VAPID reset or a plain restore) -> `unsubscribe()` and set `pwa.needsReenable` (Settings and the lazy banner slot show a one-tap "Réactiver les notifications": the permission prompt needs a gesture on iOS) -> `needs_reenable`. Otherwise call `push.subscribe` with the current keys (a refresh that binds the row to the current credential, which is how a re-login recovers) -> `refreshed`. The trigger is a tiny eager line in `use-shell-effects.ts` that dynamic-imports `bind.ts` only when `Notification.permission === "granted"`.
- A `resubscribe` message from the worker (`pushsubscriptionchange`) runs `enablePush` silently if permission is already granted.
- Sign-out unsubscribes this device (revoke first, then `unsubscribe`, even if revoke fails) and resets every store (MC34).

**Tests (RED):** `pushSupport` table (every combination: http -> insecure; https iOS Safari tab -> needs_install_ios; standalone iOS with PushManager -> supported; denied permission -> denied; no SW -> no_service_worker); `enablePush` happy path with fakes (permission granted -> `pushManager.subscribe({userVisibleOnly: true, applicationServerKey})` -> `push.subscribe` with `keys` from `toJSON()`, `locale`, a label from the user agent class "iPhone"/"Chrome on Linux" without the full UA string); denied permission makes no RPC; `capacity` from the server unsubscribes the browser subscription again (no orphan); `disablePush` order (revoke first, then unsubscribe; unsubscribe even if revoke fails); `presence`: sends on start, on `focus`/`blur`/`visibilitychange`, every 20 s on the fake timers, stops when the connection is not open, `pagehide` sends `focused: false`, **`presence.idle-is-not-looking`: a focused visible tab with no input for 2 minutes reports `focused: false` (Review Focus 7)**, `stop()` removes all listeners (leak check), no RPC while `signed-out`; `rebind.refreshes-credential` (same key -> `push.subscribe` called, result `refreshed`), `rebind.key-changed-reenables` (different key -> `unsubscribe` called, `needsReenable` set, no `push.subscribe`), `rebind.none-without-permission` (no `getSubscription`, no RPC); a `resubscribe` message with granted permission re-enables silently; sign-out unsubscribes this device and resets the stores (the `AppShell.signout` test pattern); the bundle: `build-output.pwa.int.test.ts` asserts `push-client` and `bind` are not in the initial chunk (lazy-only through a barrel is the trap: import them only by path from the lazy entries).

- [ ] Steps: RED, implement, `pnpm lint && pnpm typecheck && pnpm test:unit -- runtime notifications pwa sign-out && pnpm build && pnpm budgets && pnpm test:int -- build-output.pwa`, commit `feat(web): push client, presence by real activity and subscription rebind (M12)`.

## Task 17: Settings > Notifications

**Model:** Sonnet; Sonnet reviewer. **Gate:** unit + build + budgets. Eager delta: +0.2 KB (one section id, one lazy import line).

**Files:** Create `apps/web/src/routes/settings/NotificationsSettings.tsx` + test, `apps/web/src/features/notifications/{NotificationsPanel.tsx,DevicesList.tsx,ClassToggles.tsx,MuteControl.tsx,use-notifications.ts,notifications.vm.ts}` + tests, `i18n/catalog/notifications.en.ts`, `notifications.fr.ts`, `register-notifications.ts`; modify `features/workspace/model.ts` (`SETTINGS_SECTIONS` + `"notifications"`), `routes/settings/sections.tsx` (lazy renderer), `routes/settings/register-settings-catalog.ts`, the settings navigation list (the file that renders section names; found with `rg SETTINGS_SECTIONS`), **`i18n/catalog/settings-automation.ts:18` and its French line (M12-RT-33)** and the assertion in `AutomationForm.test.tsx:255`: "Coming soon: notifications that wait for the end of the window." becomes "Runs still execute during quiet hours. Notifications wait for the end of the window and arrive as one summary." (and its French counterpart with vous).

**Interfaces:** consumes `push.config`, `push.list`, `push.subscribe`, `push.revoke`, `push.test`, the `notifications` settings document through `lib/account-setting.ts` (compare-and-set with merge, as `AutomationSettings.tsx` does), the `automation` quiet-hours read (link only), `pushSupport`/`enablePush`/`bindPush` (task 15b), `pwa.needsReenable`. Board: Settings > Notifications has no board 12 element; it is composed from `Switch`, `Button` and the settings layout primitives (decision 32 / DESIGN.md) and shown in the owner's visual check. Screen (owner rule: everything customisable here):
1. Status line from `push.config`: "Notifications actives" / off with reason; on plain HTTP: "Les notifications et l'installation demandent HTTPS." + the `readiness.hint`; the enable button disabled (M12R16). On iOS in a tab: the install instruction (M12R29). When `keysReset` is set: "Les notifications ont été réinitialisées: chaque appareil les réactive à sa prochaine ouverture de pap." When `lastFailure` is set: "Dernier échec d'envoi: {reason}" (a class, localised; never a body). When the browser holds a subscription but `push.list` has no `current` row, or `pwa.needsReenable`: a one-tap "Réactiver les notifications" button.
2. "Activer sur cet appareil" button (a click handler) / "Désactiver"; the devices list (label, host, created, last ok, "Cet appareil" chip from `current`), Revoke per device (a confirm sentence that names the device), "Envoyer une notification de test".
3. Class toggles (M12R2 defaults; one line each saying when it fires and that approvals wait 60 s), the Mute control (Off / 1 h / 8 h / Until I turn it on; writes `muteUntil`), the names option "Afficher le nom du déclencheur ou de l'agent" (`titles: "names"`, off by default) with the helper: "Seul le nom que vous avez donné au déclencheur ou à l'agent s'affiche. Jamais le contenu: ni commande, ni chemin, ni message, ni titre de tâche." (M12-RT-09; the old "Jamais le contenu" line overstated what the code did), and a read-only line "Heures calmes: ..." linking to Settings > Automation (quiet hours stay there, M12R18; the text states that pushes held in quiet hours arrive as one summary, which also counts requests that expired meanwhile).
4. Counts at cap: "10 appareils au maximum" when `subscribed === max`; the enable button turns into an explanation.

**Rulings:** M12R32. Cost if wrong: a screen that says "on" while the daemon refuses.

**Tests (RED):** view-model unit tests for each state (on, off keys_unreadable, off read_only, insecure_http, cap reached, iOS needs install, denied permission, no subscription, 3 devices, keysReset shown, lastFailure shown, needs re-enable); component tests: toggling a class writes the whole document with `baseRevision` and merges on `conflict` (the `AutomationSettings` pattern); Mute presets compute `muteUntil` from the Clock and "Off" writes null; the revoke confirm text names the device label; the test button disables while pending and shows "delivered/dropped"; no endpoint or key is ever rendered (a snapshot over the DOM of a `push.list` with hostile labels `<img onerror>` and `\u202e`: React text only); the section is lazy (`build-output.pwa.int.test.ts`: not in the initial chunk); French catalog keys use vous (a test scanning `notifications.fr.ts` for the singular pronoun forms " tu ", " ton ", " ta ") and `catalog-keys.test.ts` stays green; the automation quiet-hours note no longer says "Coming soon"; 44 px coarse-pointer rule: the controls use the shared `Button` and `Switch` primitives (no new raw sizes); a phone-width render (390 px class) shows the list stacked.

- [ ] Steps: RED, implement, `pnpm lint && pnpm typecheck && pnpm test:unit -- notifications settings i18n AutomationForm && pnpm build && pnpm budgets && pnpm test:int -- build-output.pwa`, commit `feat(web): Settings > Notifications with devices, classes, mute and test push (M12)`.

## Task 18: The `/n/<id>` landing and the full-width approval card

**Model:** Sonnet; Sonnet reviewer. **Gate:** unit + build + budgets. Eager delta: +0.6 KB (route entry, the `open` message handler).

**Files:** Create `apps/web/src/features/notifications/{Landing.tsx,Landing.test.tsx,landing.vm.ts,landing.vm.test.ts}`, `i18n/catalog/landing.{en,fr}.ts`, `register-landing.ts`; modify the router file that declares routes (`apps/web/src/routes/` router definition; the implementer finds it with `rg createRoute`), `routes/shell/use-shell-effects.ts` (register the `pwa.onOpen` handler that navigates), the approval card (`ApprovalCardFor` and its phone classes: this task owns it), `routes/shell/pane-renderers.tsx` only if a pane kind is needed (prefer not: the landing redirects).

**Behaviour:** `/n/$id` is a lazy route: shows a full-width skeleton, calls `push.open {id}` (after the auth gate: a signed-out visitor sees the normal login, then lands here), then replaces the history entry with the target: `session` -> the session item (**the card the person answers is that session's approval card**, decision 32: "push -> full-width approval card with context and 44 px Refuse / Allow (+ for session)"; board 12 caption "Approbation depuis un push"; on the phone viewport the pending approval card is rendered full width above the thread with 44 px actions); `inbox` -> the Inbox section on that item (phone: Inbox tab with the item scrolled in; desktop: the Inbox drawer item), used for agent and secret requests and for the informational classes; `agent` -> the agent thread; `settings` -> Settings > Automation or Settings > Notifications (`id`). If the item is already answered or withdrawn: a calm notice "Déjà traité" with a button to the Inbox. `not_found`: "Cette notification n'existe plus" with a button home. No inline actions anywhere in the notification itself (decision 32).

**Rulings:** **M12R33** (the id is never used as a path outside `push.open`; the target ids come from the daemon and are passed to the router as data, never concatenated into a URL by the client from the payload; an id that fails `^[A-Za-z0-9_-]{22}$` is a `not_found` without an RPC). Cost if wrong: an open redirect through the landing.

**Tests (RED):** `landing.vm` maps each target kind to an item ref (session, inbox, agent, settings automation, settings notifications); an invalid id makes no RPC; `not_found` and already-answered render their notices (French vous, strings in the catalog); a signed-out user is sent to the login and returned (the existing auth-gate redirect test pattern); the worker message `{type:"open", path:"/n/<valid id>"}` navigates, while `path: "https://evil.example"`, `"//evil"`, `"/auth/x"`, `"/n/short"` do nothing (the handler accepts only `^/n/[A-Za-z0-9_-]{22}$`); phone-width render: the approval card has the full-width class and its action buttons carry the 44 px control class (assert the class names, as M3 E2 does headless); the landing chunk is lazy (`build-output.pwa.int.test.ts`).

- [ ] Steps: RED, implement, `pnpm lint && pnpm typecheck && pnpm test:unit -- notifications shell && pnpm build && pnpm budgets && pnpm test:int -- build-output.pwa`, commit `feat(web): notification landing route and the full-width approval card (M12)`.

---

# The join and the sweep

## Task 20: J1 - integration, production wiring, full gate

**Model:** Sonnet implementer; Sonnet reviewer. **Gate:** unit + int + build + budgets + smoke (the full gate, once; 45 min, one heavy slot, never beside M6b's join).

**Files:** Modify `apps/daemon/src/compose-push.ts` (the real wiring: `composeTransportSide` with `loadVapid` -> `createHttpsTransport`, `Subscriptions`, `sessionLive` from auth; `composeDeliverySide` with `registerPushEffects`, `SessionsAutomationPort.onAttention`, `Inbox.onItem`, `RunsPort.onRunEnd`; the boot order: after migrations and outbox `recover()`, before `start()`), `apps/daemon/src/daemon.ts` only if the call site changed; create `apps/daemon/src/daemon.push.e2e.int.test.ts`, `apps/daemon/src/compose-push.test.ts` (the production-wiring trace), `scripts/smoke-dist.ts` additions (manifest, icons and `sw.js` served and public; `/n/<id>` answers the SPA; `/healthz` is not touched by the worker). There is no encryption wiring here: the transport already encrypts (M12-RT-05).

**The integration flows (real daemon, real outbox drain, `PAP_TEST_PUSH_LOOPBACK=1`, fake push service; no sleeps, kernel Clock).** Flows 2 to 5 of the first plan moved into the chains' own int tests (approval after 60 s, with presence, in tasks 9a and 11; focus, mute, cooldown and quiet in tasks 9a and 9b; the budget in task 12; the revoked device and the retries in task 9a). J1 keeps what needs both chains and the production wiring:
1. `subscribe-send-decrypt`: a browser caller subscribes an endpoint on the fake service with a test UA key pair; an `agent_notify` item is created; `outbox.drain()`; the fake service received one request; `decryptPayload` yields a `PushWire` (zod-parsed) with `cls: "notify"`, the generic French body, a 22-char id (exactly one encryption layer: it decrypts once); `push.open` of that id returns the inbox target. A second request from the same flow with a 500 then a 201 shows the retry end to end through the real sender.
2. `token-cannot`: the seven `push.*` methods are `forbidden` for a token on the real daemon; the token's `inbox.list` shows an item but never gives a way to learn presence; a token cannot `settings.set` `notifications`.
3. `restart-recovery` (M12-RT-10, corrected): stop the daemon with a pending approval push (60 s), a pending `failed` push and a pending `budget` push; start it, advance the Clock, drain -> the approval is `cancelled` and sends nothing, the `failed` and `budget` pushes are sent once; a `sent` event is not sent again.
4. `reconnect-resume` (D19 exit, daemon side): a ws client with a session cursor drops, events happen, the client resubscribes `after` the cursor and receives exactly the missed events once (the existing cursor int test pattern, extended to the `inbox` stream).
5. `keys`: a first boot creates `secrets/push/vapid.json` 0600 in 0700; a second boot keeps the key; a damaged file keeps push `off` and `push.config` says `keys_unreadable` and nothing is purged; when the file is missing (a plain restore) the rows of the old key are purged, `push.config.keysReset` says how many, and a device subscribing again clears it.
6. `production-wiring` (`compose-push.test.ts`): build the daemon the way `main.ts` does (not a test bed) and assert the notifier, the Inbox listener, the attention listener, the run-end listener and the effects are all registered (a push cannot silently not wire; M11a I2), and that with `PAP_TEST_PUSH_LOOPBACK` unset the validator refuses `http://127.0.0.1` endpoints and the sender refuses loopback addresses.

**Full gate and checks (once):** `pnpm lint && pnpm format:check && pnpm typecheck && pnpm knip && pnpm test:unit && pnpm test:int && pnpm build && pnpm budgets && pnpm smoke`. Expected: all green; `pnpm budgets` shows the initial bundle at about 230 KB gzip (227.4 + at most 3) and the service worker line under 4 KB; `knip` no unused exports; every file at most 400 lines (the CI rule script). If a file is over the line, split it in this task.

- [ ] Steps: RED (the six flows), wire, fix what the join finds (fix commits named `fix(push): ...`), full gate, commit `feat(push): production wiring and end-to-end flows for web push (M12)`.

## Task 21: Docs, ADRs, rulings, sweep

**Model:** Sonnet; Sonnet reviewer. **Gate:** `pnpm lint && pnpm format:check` (docs only).

**Files:** Create `docs/agents/notifications.md`, `docs/adr/0058-web-push-on-node-crypto.md`, `0059-push-endpoints-and-subscriptions.md`, `0060-delivery-rules-and-payload-content.md`, `0061-service-worker-and-shell-cache.md`, `0062-presence-install-and-https.md`, `docs/research/m12-rulings.md` (the rulings M12R1 to M12R39 with the owner's answers from the question page, W5-style); modify `AGENTS.md` (at most 6 lines: the `PAP_PUSH_SUBJECT`, `PAP_PUSH_EXTRA_HOSTS` and the fenced `PAP_TEST_PUSH_LOOPBACK` env; a pointer to `docs/agents/notifications.md` and the ADR range; keep the file at or under 150 lines with M6b's lines counted), `docs/agents/daemon.md` (one pointer line), `docs/agents/web.md` (service worker, presence, update flow, Settings section), `docs/plans/roadmap.md` (M12 status).

**`docs/agents/notifications.md` content:** the classes and defaults; the delivery order and the 60 s re-check of an approval hidden by focus; the payload shape and what is never in it (the `names` option and its registry-only source); the key file and its recovery (`rm $PAP_HOME/secrets/push/vapid.json`, restart: a new pair, old subscriptions purged and reported, each device re-enables when it next opens pap); **the backup sentence shared with M6b: "Notifications: each device re-enables when it next opens pap."** and the reason `secrets/push/` is excluded from plain backups (with `state.db` the key would let the holder push arbitrary text to the owner's devices); the endpoint rules and the host list (`PAP_PUSH_EXTRA_HOSTS`, no way to turn the list off); **`#https`:** the HTTPS routes in the agreed order with the exact commands (the ngrok origin the owner already runs, decision 75; `tailscale serve --https=443 localhost:7777` with `PAP_PUBLIC_ORIGIN`; a reverse proxy through `PAP_PUBLIC_ORIGIN` - pap reads no `X-Forwarded-*` and has no `trustProxy` setting (R72); `--tls-cert/--tls-key`); **`#keys`:** what `pap doctor` checks (the `https` check from `pushReadiness`, the `push` check of the key file modes, written by M6b's T11), the status table; the container note (outbound HTTPS and DNS, the `$PAP_HOME` volume for `secrets/push/`); the test switch (`PAP_TEST_PUSH_LOOPBACK`, tests only); the service worker cache rules, the precache of the whole build and the update flow (the web-shell banner is not a pap release banner); quiet hours and the digest, including that isolated-task questions asked in quiet hours are denied after 10 minutes and counted as expired in the digest; the known limit of M12-RT-32 (no push for a failed feed poll or a trigger-level effect); troubleshooting (Apple 403 `BadJwtToken` means a bad `sub`; 410 drops the device; iOS needs the Home Screen install; a pushed notification that opens the login page means the session expired; `push.config.lastFailure` names the last failing class); the manual checks list.

**ADRs (one paragraph of decision, alternatives, consequences each):** 0058 own RFC 8291 on `node:crypto` rather than `web-push` (and the VAPID key under `secrets/push`, excluded from plain backups; M12R4 to M12R6, owner n3, c5); 0059 endpoint validation, the host list and per-device browser-only subscriptions with caps (M12R8 to M12R10, M12R12, M12R20; `blockedForPush` against the unchanged `blockedAddress`, the second blocklist left for M13); 0060 delivery rules, classes, 60 s, the per-target delivery and retry, quiet hours and digest, generic payloads and the names option (M12R1 to M12R3, M12R7, M12R13, M12R17, M12R22, M12R23); 0061 the service worker: precached versioned shell, no `skipWaiting` without the owner, same-origin click, update checks (M12R14, M12R15, M12R28, M12R30); 0062 presence by real activity, HTTPS gating and the supervisor differences from T3 (M12R11, M12R16, M12R31, M12R38).

**Decisions log:** the plan fix appended decision 93 (both milestones); the models batch's plan fix appends 94. This task appends nothing.

- [ ] Steps: write docs, run the link/format checks, commit `docs: M12 notes, ADRs 0058 to 0062 and rulings`.

---

## Model table

Implementers are Sonnet, never Haiku. Reviewers are Sonnet unless marked Opus. The final review is Opus. **Opus escalation at fix rounds 4 to 5 is pre-approved for this wave (owner c2, M12R36).**

| Task | Chain | Implementer | Reviewer | Why the Opus lines |
|---|---|---|---|---|
| 1 Contracts, migration, skeleton, compose split | base | Sonnet | Sonnet | |
| 2 Net-address move, readiness, kit | base | Sonnet | Sonnet | |
| 3 VAPID keys | A | Sonnet | **Opus** | a signing key file (modes, links, no overwrite) and the ES256 JWT: a security contract |
| 4 Subscription validation | A | Sonnet | **Opus** | SSRF at a trust boundary |
| 5 Store, service and RPC | A | Sonnet | **Opus** | browser-only vs tokens, caps, no content (M11a I1, M11b M3), the re-bind |
| 6 RFC 8291 | A | Sonnet | **Opus** | hand-written crypto |
| 7 Guarded sender | A | Sonnet | **Opus** | outbound request to a user-chosen host, TLS, never throws |
| 16 Supervisor gaps | A | Sonnet | Sonnet | |
| 8 Events, presence, rules, copy | B | Sonnet | Sonnet | |
| 9a push.send per target | B | Sonnet | **Opus** | decides delivery to revoked devices, assembles the lock-screen payload, owns the retry semantics |
| 9b Quiet hours, digest, test push | B | Sonnet | Sonnet | |
| 10 Sources: Inbox | B | Sonnet | Sonnet | |
| 11 Sources: sessions, presence, open | B | Sonnet | Sonnet | reads the sessions runtime; content-leak test included |
| 12 Sources: budgets | B | Sonnet | Sonnet | |
| 19 Mobile conformance | B | Sonnet | Sonnet | |
| 13 Manifest, icons | C | Sonnet | Sonnet | |
| 14 Service worker | C | Sonnet | **Opus** | cache rules and the click target decide data exposure |
| 15a SW registration, update flow | C | Sonnet | Sonnet | |
| 15b Push client, presence, rebind | C | Sonnet | Sonnet | |
| 17 Settings > Notifications | C | Sonnet | Sonnet | |
| 18 Landing and approval card | C | Sonnet | Sonnet | |
| 20 J1 integration | join | Sonnet | Sonnet | |
| 21 Docs and ADRs | sweep | Sonnet | Sonnet | |
| Final review of the branch | | | **Opus** | whole-branch security and wiring |

**Gate tiers (owner-approved):** web-only tasks run the filtered unit gate, build and budgets (chain C adds the short `test:int -- build-output.pwa` filter); `test:int` runs in the runtime tasks 1, 5, 7, 9a, 9b, 11, 12 and 20 (not in 3, 4, 6, 8, 10, 13 to 19, 21); the full gate runs at J1 only. Heavy gate slots: the rule in the Global Constraints.

## Coverage map

| Requirement | Task |
|---|---|
| Self-hosted Web Push with VAPID | 3, 6, 7, 9a, 20 |
| Needs-input push after 60 s with no tab open | 1 (M12R1), 8, 9a, 10, 11, 20 |
| Budget push, owner-wide and per agent | 12 |
| Quiet-hours digest (with the expired line) | 9b |
| Orca rules: suppress when looking, mute, burst cooldown | 8, 9a, 15b, 17 |
| Push sources: approvals (incl. child), `agent.notify`, budget, task failed or needs input, Inbox generally | 10, 11, 12 (trigger-level effect failures: deferred, M12-RT-32) |
| Defaults per source | M12R2, 8, 17 |
| VAPID key storage, 0600, never logged; excluded from plain backups | 3, conflict scan, 21 |
| Subscription zod schema at the trust boundary | 1, 4 |
| Endpoint validation (https, no IP, no private after DNS, bounded, host list) | 2, 4, 7 |
| Per user, per device; browser only; listed and revocable; dropped on 404/410; capped; re-bound after re-login | 5, 9a, 15b, 17 |
| Payload content generic + opaque id, registry-only names option, details after the click | M12R7, 8, 9a, 11, 18 |
| RFC 8291 and the `web-push` question | M12R6, 6, owner n3 |
| Outbound send: deadline, no redirects, no body logged, hashed endpoint in logs, TLS verified, never throws | 7 |
| Service worker: scope, no authenticated caching, versioned precache, update checks, CSP | 14, 15a (CSP: `default-src 'self'` covers `worker-src` and `manifest-src`; no change, asserted in task 13/14 tests) |
| `notificationclick` same-origin id URL only | 14, 18 |
| HTTPS gating, plain-HTTP UI, `pap doctor` check (M6b writes it), HTTPS route to document first | M12R16, M12R38, 2, 17, 21 |
| Installable PWA (manifest, PNG icons from L4, hand-written SW) | 13, 14, 15a |
| Supervisor polish (backoff, resume from cursors, drafts, reconnecting banner) | 16 |
| Mobile screens of decision 32, with the project-home carries | 18, 19 (existing: `MobileShell`, `BottomNav`, `ConnectionBanner`) |
| M10 Settings copy "Coming soon: notifications ..." | 17 |
| Bundle: SW own size line, lazy screens, +3 KB eager | 14 (line), 15a to 19 (deltas), 20 (check) |
| Tests without network; fenced test switch | 1 (switch), 7 (fake service), 20 |
| M3R44 icons, M10R6 quiet hours, M11R100 notify | 13, 9b, 10 |
| MC34 sign-out resets stores | 15a, 15b |

## Exit criteria

Roadmap M12 exit: "reconnect-and-resume and mobile-viewport journeys pass; push arrives over HTTPS on iOS 16.4+". Decision 42: no browser e2e before M13. What replaces each now, and what the owner checks by hand:

| Exit | Replaced now by | Owner checks by hand |
|---|---|---|
| Reconnect-and-resume | task 16 unit tests (fake socket + timers: long background resume, manual retry, cursor resume without gap or duplicate, drafts kept) + task 20 flow 4 (daemon cursor resume) | on the phone: lock the screen for a minute, unlock: the banner appears and clears, the draft is still there |
| Mobile-viewport journeys | tasks 18 and 19 headless viewport tests at 390x844 (classes, 44 px rule, safe areas) | open the PWA on an iPhone: the four sections, an approval card from a push, the lane Chat / Review / Term switch |
| Push arrives over HTTPS on iOS 16.4+ | task 20 flow 1 with a fake push service and a real decryptor, tasks 9a to 11 delivery tests; `pushReadiness` | **only this**: over the ngrok HTTPS origin, add pap to the Home Screen (Share, Add to Home Screen), open it, Settings > Notifications > Activer, accept the prompt, press "Envoyer une notification de test"; then trigger a real approval with the phone locked and wait 60 s |
| Installable PWA | task 13/14 build-output tests (manifest, icons, `sw.js` parse, precache list) | Chrome/Android: the install prompt appears; iOS: the Home Screen icon is the L4 logo |
| Plain HTTP shows push off | task 17 view-model tests | on the LAN preview `http://192.168.1.182:7777`: Settings > Notifications shows the one-line HTTPS message and a disabled button |
| Update flow | tasks 14 and 15a unit tests (an old shell keeps its lazy chunks; the update check after a reconnect) | rebuild and restart the preview: the open PWA shows "La page a une mise à jour" and reloads once; open Settings > Notifications for the first time after the update: it loads |
| Re-login and key reset recover | tasks 5 and 15b tests | sign out and in on the phone, open the PWA: a test push arrives without pressing Activer |

## Owner answers (2026-10-17)

Page `m12m6b-q1` (archived as `docs/design/questions/2026-10-17-m12-m6b.html` and `-answers.json`), answered 2026-10-17T07:08Z; **every answer is the recommendation, with no notes** (decision 93). The red-team's question edits are in the options (Q2 rewritten; Q6, Q7, Q9, Q11 changed; Q4 and Q10 dropped as questions; Qa added).
- **c1 m12first:** M12 merges first, M6b rebases (M12R35).
- **c2 yes:** Opus escalation at fix rounds 4 and 5 is pre-approved for this wave (M12R36).
- **c3 lanes3:** M6b in three lanes (its own plan; no M12 change).
- **c4 move:** task 16 to chain A, task 19 to chain B (M12R37).
- **c5 excluded:** the VAPID key is excluded from plain backups like `secrets/`; devices re-enable on open (M12R4, M12R12).
- **n1 list:** the built-in push host list plus `PAP_PUSH_EXTRA_HOSTS`, no "list off" switch (M12R8).
- **n2 names:** generic lock-screen text; an off-by-default option shows the trigger or agent registry name, never a free title (M12R7).
- **n3 crypto:** RFC 8291 on `node:crypto`, no `web-push` dependency (M12R6).
- **n4 keep:** the default-on classes: approvals, failed, budget, notify (M12R2).
- **n5 active:** present means focused, visible and active in the last 2 minutes; approvals suppressed by focus are re-checked (M12R3, M12R11).
- **n6 digest:** spec C quiet hours plus a morning digest line for requests that expired (M12R17).
- **n7 ten:** 10 devices per user (M12R9).
- **n8 podman:** PNG icons rendered by the controller with the Playwright podman image, no new dependency (M12R27, task 13).
- **n9 exempt:** 5 s cooldown per key, 20 an hour, approvals exempt from the hourly cap (M12R3, M12R9).
- **n10 reached:** budget push when reached only (M12R25).
- **b1 to b10:** the M6b questions (backup secrets, restore, update, image, npm name, release, doctor unit, update check); applied in the M6b plan, recorded in decision 93. Relevant here: b1 (`secrets/` excluded from plain backups) is why M12R4 mints a new pair after a plain restore.

## Deferred minors

One line each (all other minors of the red-team are fixed in the tasks above):
- **M12-RT-32** A push for a failed trigger-level effect (a feed poll failing, a `task.start` effect failing through `outbox.onFailed`): no Inbox item and no landing target exist for it; wire it with a future Inbox kind, and state the limit in `docs/agents/notifications.md`.
- **M12-RT-19 (egress half)** Widening `blockedAddress` itself would harden the egress proxy with the documentation and Teredo ranges, but M11's egress tests use `198.51.100.x` and `203.0.113.x` as public fixtures; the push module has its own `blockedForPush` now (M12R20), and the proxy change is an M13 sweep item (ADR 0059).

## Risks

- **Attention-feed source (task 11):** it depends on the shell publisher reporting `needsInput: false` when a worker exits with an open dialog, and on the parent's `needsInput` including a waiting child. Both are pinned by int tests; if the first does not hold, the fix is an additive line in `sessions/automation-port.ts` (355 lines), not in `live-ui.ts`, `live-session.ts` or `service.ts`.
- **Service worker build (M12R28):** a single-file classic script produced by type stripping is simple but unusual; the build test parses it as a script. If Vite 8's bundler API offers a safer one-file build, the implementer may use it with the same tests. Precaching the whole build costs one full download at install.
- **iOS specifics:** push needs the Home Screen install and a user-gesture permission prompt; only the owner can verify this. The fake service proves the wire (aes128gcm, VAPID, Topic, urgency), not Apple's acceptance (an invalid `sub` gives 403 there; M12R5).
- **Duplicates after a crash (M12R13):** with no `markSent`, a crash between a successful send and its bookkeeping can deliver one push twice; `Topic` and `tag` collapse it on the device. A lost approval is worse.
- **Two address checks** (`blockedAddress` and `blockedForPush`, plus `automation/net-guard.ts`) until M13; recorded in ADR 0059.
- **Presence by heartbeat** costs one small RPC per 20 s per open tab; a quiet tab in the background throttles timers (browsers clamp to 1 min), so the 45 s freshness can lapse for a hidden desktop tab: acceptable, it means "not looking".
- **Gate contention:** two heavy slots shared with M6b and the models batch; chain C is web-only and cheap; the rule in the Global Constraints applies.

## Merge order and conflict notes

- **Order: M12 first, then M6b** (owner c1, M12R35). M12 adds files and additive lines in shared places that M6b only needs to rebase over; `pap doctor` consumes `kernel/push-readiness.ts` and the `secrets/push/` layout, and M6b's T11 writes the doctor push check after rebasing on M12. If the order ever flips, M12 re-stamps `202610172000_push.sql` only if a later stamp has landed.
- **Hot-spot edits by M12:** `AGENTS.md` (at most 6 lines), `docs/agents/daemon.md` (1 line), `kernel/config.ts` (the three env, about +15 lines; `config-push.ts` above 395), `budgets.json` + `scripts/check-budgets.ts` (the SW line), `knip.json` (one entry), `apps/web/package.json` (the `typecheck` line), `daemon.ts` (3 lines plus the test-bed `push` option), `contracts` shared files (task 1 only, additive lines), `eslint.config.js` (none expected). No root `package.json` script and no `pnpm-lock.yaml` change.
- **Rebase rules:** `pnpm-lock.yaml` is untouched by both plans; the second branch to merge recounts `AGENTS.md`; both plans add whole lines in the shared files.
- **Decisions log:** decision 93 (the M12 + M6b owner answers and both plans) was appended by this plan fix; ADR numbers 0058 to 0062 are M12's.
- **After merge:** rebuild and restart the preview (`pap-preview`); push still shows "off" on `http://192.168.1.182:7777` by design, and works on the ngrok HTTPS origin (decision 75).
