# M12 final review (Opus)

Whole-branch review of feat/m12-join (ff6766e1..99bbf74c), its scoped re-review after the first fix (4ac889ed..665e9bcc), and the scoped Sonnet check of the second fix (665e9bcc..cfd0e0b3: revoked check before the subscribe limiter, resubscribe only with a current row, neutral re-enable copy; approved). M12 merged as ae0e8acf.

## First review

**Verdict: Ready after fixes.** I found 0 Critical, 3 Important (one behaviour bug whose confirmation copy overclaims, one binding-rule violation, and docs that the code contradicts) and 12 Minor. The full gate is green on the tree as it will land (M12 merged with main, see Merge readiness).

### Spec Compliance
- ❌ Issues found:
  - **Revoke overclaims.** The confirmation says the device stops receiving notifications, but a still-signed-in device re-subscribes itself when it next opens pap (I1). This breaks the global rule that copy never claims more than the code does.
  - **Literal bidi character in source.** One test file holds a literal U+202E, against the global constraint (I2).
  - **Docs contradicted by code.** Four lines of `notifications.md` disagree with the code (I3).
  - **Eager bundle over plan.** It is 231.2 KB on the branch and 231.3 KB merged with main. The plan allowed 227.4 + 3 = 230.4 KB. The T15a (+1.2 KB) and T16 (+1.0 KB) overruns were accepted in the ledger, and the CI ceiling is 300 KB.
- Everything else matches the plan, M12R1–R39, W6-R1–R14 and the cross-plan agreements. The parts I traced:
  - The compose is split by chain, with one `PushDeps` widening (W6-R10).
  - The notifier's single transaction and its key scheme (M12R1).
  - `decide()`: the digest is exempt from cooldown, cap and quiet hours (W6-R4); approvals are exempt from the hourly cap.
  - Per-target deliveries with retries, never marked sent.
  - The digest is atomic and DST-safe.
  - One push per waiting session, and the child's question opens the parent's card (W6-R13).
  - Read-only mode (M12R39); the harness fakes the sender by default; the VAPID subject rules (M12R5).
- ⚠️ Cannot verify here:
  - Real iOS standalone push, Chrome install, and `fetch(navigationRequest, {signal})` on Safari 16.4 (the T14 carry; never checked in a browser).
  - That real push services accept the JWT and the encryption. Only the RFC 8291 test vector and the round-trip decryptor prove it.
  - Whether the ngrok free-domain interstitial interferes with fetching `/sw.js`.

### Owner flows, end to end
- **Enable on a phone.**
  - Plain HTTP shows "Les notifications et l'installation demandent HTTPS." and a disabled button (`notifications.vm.ts:39`).
  - An iOS Safari tab gets `needs_install_ios`.
  - In a standalone install: permission is the first thing awaited, then `push.config`, then `ready` (8 s cap), then subscribe, then `push.subscribe`. No dead end.
- **Approval after 60 s, once.** The attention feed is transition-only (`automation-port.ts:162`). The Inbox `task_needs_input` item shares the key `push:approval:session:<id>`. `stillWaiting` is checked again at send time. Children are skipped. No double push found.
- **Tap, landing, card, answer.** The service worker focuses an open window and posts `open`, or calls `openWindow('/n/<id>')`. The landing calls `push.open` (no oracle), waits at most 5 s for the stream, then goes to `/s/<id>`; on a phone the approvals sit above the transcript and the card is wide. Agent-thread approvals also open `/s/<id>` rather than the agent space; it should work, but no test covers it.
- **Quiet hours, one digest.** Held events and the digest are queued in one transaction, with key `digest:<owner>:<endMinute>`. **Dead end (Minor M3):** the digest's target is the Inbox (`open.ts:23-24`), but held session approvals and budgets, which the digest counts, are not Inbox items. This is owner question (c).
- **Mute** works as specified; the test push ignores it.
- **Revoke a device:** see I1.
- **Update with a new service worker.** The update is checked on reconnect and when the page becomes visible; installed with a controller sets `updateReady`. The banner's Reload posts `skip-waiting`, waits for `controllerchange` and reloads once. Old caches are deleted only when the new worker activates; a second tab is covered by the stale-chunk handler. Works.
- **Reconnect after a long background.** After 30 s or more hidden, `resume()` replaces the socket; presence beats again on `open`. Works.

### Privacy and security (all ✅ unless noted)
- **Payload:** generic text plus the 22-character id. A name is added only under `titles:"names"`, only from the trigger or agent registry, and only after `clipName` at insert and at copy. No agent can rename an agent, and reminders and delegations have no `trigger_name`.
- **VAPID key:** 0600 in 0700, opened with `O_NOFOLLOW|O_NONBLOCK`, owner and size checked, a signature probe confirms the private scalar matches. `keys_unreadable` keeps push off and never mints over the file.
- **Endpoint guard:** every DNS answer must pass `blockedForPush` (`sender.ts` `guardedLookup`). `endpointRefusal` runs again at send time. No redirects are followed, the response drain is capped at 8 KiB, limits are 10 s idle and 12 s total, under the outbox's 30 s.
- **Loopback switch:** production can only turn it on with an absolute `PAP_TEST_PROVIDER_SCRIPT` (the scripted provider, so no real model) and `=1`. Even then it accepts only `http://127.0.0.1`, and the boot log warns.
- **Callers:** `requireBrowser` runs in every service and handler. The presence connection id comes from the socket context. A token cannot write `notifications`.
- **Service worker scope:** `/` with `updateViaCache:"none"`. API paths, non-GET requests and navigations are never cached; only `/assets` and `/icons` are cached at runtime, and only when cacheable. The existing CSP covers the worker (`script-src 'self'`).

### Delivery correctness
- A crash between send and settle re-sends only the pending targets; `Topic` and the notification `tag` collapse the duplicate (by design, M12R13). A sent event is never sent again. Recovery requeues replay-safe effects.
- Cooldown, the hourly cap (approvals and digest exempt), DST via the minute scan, the 45 s presence entries, 410 and dead-session rows dropped, and the key reset purge at boot: all ✅.
- **W6-R11 note:** M11 expires every pending agent request at boot (`agents/requests.ts:136-141`), before push is wired. In production an `agent_approve` or `secret_request` push pending across a restart is therefore always cancelled. The restart int test seeds an Inbox row with no request row, a state production cannot reach (M10).

### Cross-chain seams
- `PUSH_ID` is shared by the daemon (`randomToken(16)`), the service worker regex, `landing-path` and `push.open`.
- Error codes are mapped in the UI, including `error.push_unavailable`.
- i18n: the catalogs are typed, so en/fr parity is enforced; the French uses vous, and the W6-R9 test refuses a glued colon.
- The service worker is 3.7 of 6 KB; `daemon.ts` is at 395 of 400 lines. knip is green, but some dead state remains (M6).

### Lessons checklist
| Item | Result | Evidence |
|---|---|---|
| Bounded resources | ✅ | presence 64, refused (`presence.ts:34-36`); cooldown 256, refused when full (`cooldown.ts`); 10 subscriptions (`store.ts:92-95`); JWT cache 32; `keyRejected` 64; drain 8 KiB; subscribe 6 s, test 10 s |
| Errors never silent | ⚠️ | push handlers catch everything and log a class (`send.ts` `createPushSend`, `digest.ts`, `https-transport.ts` `send`); bare `.catch(() => {})` at `use-cost-today.ts:19` and `presence.ts:37` (M7) |
| Unknown codes settle | ✅ | `send.ts` default branch becomes `refused`; `outcomeOf` sends anything else to `rejected` |
| Deadlines, timers cleared | ✅ | `sender.ts` (Clock total limit, cleared in `settle`); `test-push.ts` 15 s in `finally`; `readyWithin` 8 s; sign-out release 3 s; service worker navigation 8 s |
| Fail closed | ✅ | `vapid.ts` `readKey`/`off`; `endpoint.ts`; unknown `refKind` approval becomes `gone` (`compose-push-delivery.ts`); damaged settings document reads as defaults, logged |
| Untrusted text | ✅ | `cleanLabel`, `clipName`, `stripHidden`, the service worker `clip`; logs carry `endpointTag` only |
| Auth, owner, identity | ✅ | `requireBrowser` everywhere; `ctx.connectionId`; owner check in `open.ts`; tokens refused in `settings/service.ts` |
| Stale responses dropped | ✅ | `Landing.tsx` `current` flag; `use-notifications` `live`; `use-cost-today` matches the agent id |
| No await in check-then-act | ✅ | `notifier.ts` checks then writes inside one transaction; `store.add` runs in a transaction |
| Mutations `idempotent:false` + commandId | ✅ | `push-methods.ts`; the client adds the id (`rpc.ts:89`) |
| Keys unique by construction | ⚠️ | event, outbox and digest keys are fine; the budget key is not owner-scoped (M9) |
| RED, mutation checks, exact asserts, no sleeps | ✅ | per-task ledger and the J1 mutation list; spot-checked restart and e2e tests (exact `toEqual`, Clock-driven) |
| Test hygiene | ✅ | the harness fakes the push sender by default (`harness.ts`); the fake push service is on loopback |
| Repo rules | ❌ | ≤ 400 lines, the one ESLint directive form, no new dependency, conventional commits and no AI trailer (0 of 52) are all fine; literal U+202E (I2) breaks the rule |

### Strengths
- The chain split held: the J1 join found only the service worker plugin's library-build bug and one flaky test.
- The transport is careful: guarded DNS on every answer, send-time re-check, the RFC test vector plus an independent decryptor, no logged secrets.
- Per-target delivery state makes replay precise; the notifier's single transaction and live-only key index stop both lost and repeated pushes.
- Real-daemon int flows cover the important cases: token-cannot, restart, keys, quiet hours, names leak, resume.

### Issues
#### Critical
None.

#### Important
- **I1 – Revoke does not stick, and its confirmation copy says it does.**
  - `push.revoke` deletes only the row (`store.ts:145`). The revoked device keeps its browser subscription.
  - At its next open with permission granted, `bindPush` → `refresh` → `push.subscribe` (`bind.ts:58-63`) inserts a new row (`store.ts:88-99`). The device is silently enrolled again.
  - The copy says "Revoke {label}? It will stop receiving notifications." / "Il ne recevra plus de notifications." (`notifications.ts:37`, `:114`).
  - Minimum fix: honest copy plus one doc line, e.g. "…until it opens pap again while signed in; sign it out in Account & devices to stop it for good".
  - Better, while the migration is still unmerged: keep a mark on the revoked endpoint hash so a refresh of it is refused and the client drops its browser subscription; an explicit Enable makes a new endpoint and is accepted.
- **I2 – Literal U+202E** at `apps/daemon/src/modules/push/delivery/source-sessions.test.ts:320,333,338`, from commit 35585935. Replace with `\u202e`.
- **I3 – Docs contradicted by code.** These are owner manual checks that will fail; fold them into the T21 doc fix.
  - `notifications.md:82`: "sign out and in → a test push arrives without pressing Enable". Sign-out revokes the row and unsubscribes the browser, so Enable is needed after signing in.
  - `:79`: "Chrome/Android shows the install prompt". `sw-register.ts:191-192` calls `preventDefault()` on `beforeinstallprompt` and nothing ever calls `prompt()`, so Android's install bar is suppressed.
  - `:69`: "410 → re-subscribes when it next opens pap". True only if the browser still holds a subscription.
  - `:14`: "a pending durable Inbox approval is kept and judged at +60 s". In production M11's boot expiry always cancels it (see the W6-R11 note).

#### Minor
1. `lastFailure` is never cleared and is shown without its time (`NotificationsPanel.tsx:192-195`). Show the age, or clear it on the next success.
2. When push is off but old rows exist (keys unreadable, or back to plain HTTP), each event creates deliveries that fail `refused:off` (`https-transport.ts:103`). Settings then says "refused as unsafe" (`notifications.ts:17/93`), which overstates it. Settle such events in `begin()` without deliveries, and reword the copy.
3. The digest lands on an Inbox that lacks session approvals and budgets (owner question (c)).
4. `installPrompt` is stored but never read; drop the `preventDefault` or add the button.
5. The service worker's `CLASS_NAMES` (`sw.ts:10`) duplicates `WIRE_CLASSES` with no test tying them together.
6. Dead code: `refKind "agent"` (`open.ts:17`) and `drop(…, "foreign_key")`.
7. The two bare catches named in the checklist.
8. FinOps: the service worker precaches 162 files, about 5.0 MB raw (1.5 MB gzip), per device at first install; the static handler does not compress. Updates re-download only the changed chunks. Worth a docs line.
9. The budget dedup check is not owner-scoped (`source-budget.ts:55`). Latent until a second user exists.
10. The W6-R11 restart test pins a state production cannot reach.
11. `fetch(navigationRequest, {signal})` on Safari is still unverified. If it throws, navigations become cache-first, not a white screen.
12. The ledger's deferred minors for J1 and T21 remain (for example `NODE_OPTIONS` overwrite, stale pending test events).

### Merge readiness
- **Rebase first.** The branch sits on c518144b; main's ff6766e1 (models A0) is not in it. `git diff ff6766e1..99bbf74c` shows A0 reversed (`utilities.css` −21, `Select.tsx` −13, `FormFigures` −11); those are not M12 changes. The rebase has one conflict, `docs/research/decisions-log.md`: keep row 93, then 94. M12's acceptance row would be 95.
- **Gate, on M12 + main with that resolution, in a scratch clone** (deleted afterwards):

| Step | Result |
|---|---|
| lint, format, typecheck, knip | ✅ |
| unit | 1568 files, 18568 passed, 2 skipped; stderr is only the old pi-host and pap-helper lines |
| int (clean env, CI=1, maxWorkers 7) | 230 files, 1326 passed, 2 skipped |
| build | ✅ |
| budgets | initial 231.3 KB, service worker 3.7 KB |
| smoke | ✅, including the PWA step |

- **Conflicts that M12 causes** (trial merges against M12 + main):
  - **models A** (80f06f7d): `apps/web/src/i18n/index.ts` (catalog imports and the `MessageKey` union), `scripts/smoke-dist.ts` (import line), `docs/agents/web.md`, `decisions-log.md`. All resolve by keeping both sides. `AGENTS.md`, `contracts/src/index.ts` and `methods-idempotent.ts` auto-merge. The `Gallery.test.tsx` and `utilities.css` conflicts come from main's A0, not from M12.
  - **M6b** (7289d4ef): no textual conflict. `AGENTS.md` comes to about 67 of 150 lines; `daemon.md` auto-merges; `run-cli.ts` and `main.ts` are M6b only. One semantic step: its doctor registry must inject M12's `pushReadiness` at the rebase (`checks-push.ts` says so; the shapes match). The `#https` and `#keys` anchors it links to exist.
  - **models B** (3eed970d, contains A): the same set until A lands.
  - None of the three touches `daemon.ts` (395 of 400), and only M12 touches `methods.ts` and `knip.json` (M6b's knip edit was dropped).
- **Post-merge preview check (7777, plain HTTP on the LAN, so push reports `insecure_http`, status off):**
  - Before the restart: back up `state.db` (VACUUM INTO, then chmod 600), because the push migration lands on the real `~/.pap`. After the first boot: `secrets/push/vapid.json` exists at 0600 in 0700, and the log has no `push_vapid_unreadable`.
  - The owner can test:
    - Settings > Notifications: the HTTPS line, the hint, the disabled button.
    - Class toggles, the names option and mute presets save and survive a reload; the quiet-hours line and link.
    - `/n/<22 chars>` and `/n/bad` both show "n'existe plus".
    - The reconnect banner: countdown and Réessayer.
    - Phone fills: card above the thread, wide card, composer without auto-focus, 44 px logo, no pull-to-refresh.
    - Cost today in the agent header; no service worker registered.
  - The owner cannot test there: service worker install and update, enable, test push, delivery, tap → landing → card, the iOS install, presence suppression, re-enable after a key reset. Those need an HTTPS origin (ngrok drop-in back on, or Tailscale serve). Watch for ngrok's interstitial on `/sw.js`, the Safari navigation fetch, and Apple's 403 `BadJwtToken`.

Disclosures:
- **Excludes ignored, so the scope tests ran.** My `--exclude` for the two user-manager scope int tests did not take effect. `scope.int` and `descendants.scope.int` ran their transient `systemd-run --user --scope --collect` units in their own temporary slice, as every gate does; no service or persistent unit was touched.
- **merge-tree in the real worktree.** I ran `git merge-tree --write-tree` once there; it writes only unreachable loose objects. Its status and HEAD are unchanged.

### Assessment
**Task quality:** Needs fixes
**Reasoning:** The architecture, security and delivery logic are sound and the gate is green. Revoke does not do what its confirmation promises, and the docs would send the owner into failing manual checks.

**Merge recommendation: Ready after fixes:**
1. **I1:** make revoke stick (preferred), or at least make the copy and docs honest.
2. **I2:** escape the three U+202E characters.
3. **I3:** fix the four `notifications.md` lines.
4. **Rebase on main:** resolve `decisions-log.md` as 93 then 94, and re-run the gate on the rebased branch.

Minors 1 and 2 (they hit the same Settings line) are worth folding into the same fix round.

## Scoped re-review and post-merge preview checklist

**Scoped re-review of 4ac889ed..665e9bcc: Ready after one more fix.** Most of the fix holds, but in the revoke flow the first Enable tap after a refusal fails against the real daemon. All work ran in a scratch clone, since deleted; the worktree is unchanged at 665e9bcc.

### I1 – revoke sticks (W6-R15)
What holds:
- **The mark.** `push_revoked (owner_id, endpoint_hash, revoked_at)` is in the unmerged migration. `store.revoke` deletes the row and writes the mark in one transaction (`store.ts:151-176`). It keeps the newest 50 per owner, and the test shows the 51st oldest endpoint can enrol again.
- **The refusal.** `store.add` checks the mark first and refuses with `push_revoked` (`store.ts:84-91`). Marks are per owner, so a second owner is unaffected.
- **No leak.** The mark is the SHA-256 of the canonical URL only. No log line, no audit row, nothing in `push.list`.
- **Contract and copy.** `push_revoked` is in `ERROR_CODES`, `ERROR_MESSAGES`, the `push.subscribe` errors and `error.push_revoked` (en/fr, vous form). The English confirm is honest: "It stops receiving notifications until you enable them again on that device."
- **Client.** `bindPush` on `push_revoked` unsubscribes, sets `needsReenable` and does not retry (`bind.ts:612-618`). The daemon e2e test covers revoke, refused refresh, empty list, then a new endpoint accepted.

What fails:
- **Important – the refusal uses up the 6 s subscribe window, so the first Enable after it fails.**
  - `service.subscribe` calls `subscribeLimit.check()` before `store.add` (`transport/service.ts`), so a `push_revoked` refusal counts as that owner's one call per 6 s.
  - Path 1: `enablePush`'s fallback unsubscribes, subscribes a new endpoint and registers it at once (`push-client.ts:681-692`). That call gets `rate_limited`, and the owner sees "Notifications could not be enabled. Try again."
  - Path 2: a revoked device opens pap, `bindPush` is refused (which uses the window) and the Réactiver banner appears. A tap within 6 s gets `rate_limited` too.
  - A second tap after 6 s works, so it recovers, but the error is misleading.
  - I reproduced it with a scratch-only service test: revoke, refresh gives `push_revoked`, then an immediate new endpoint gives `rate_limited`. The test passes, which confirms the behaviour.
  - The repo's tests miss it: the client unit fakes have no limiter, and the e2e test calls `clock.advance(6_000)` between the two subscribes.
  - Fix: check the mark before `subscribeLimit.check()` (for example a `store.revoked(owner, endpoint)` lookup), or only use up the window on a stored write. Add a test with no clock advance between the refused refresh and the new endpoint.
- **Minor – one way around the mark.**
  - `resubscribeDevice`, called when the browser fires `pushsubscriptionchange`, goes through `enablePush` (`start.ts`). The fallback there makes a new endpoint "because Enable is the owner's word", but here nobody pressed Enable.
  - Even without the fallback, a browser-renewed endpoint carries no mark, so it would be accepted.
  - It only happens if a `pap` window is open on the revoked device when the browser renews, and before that device's next start (bind drops the subscription on start).
  - Fix: resubscribe only when `push.list` shows a `current` row, or pass an explicit flag from the click paths.
- **Minor – the banner gives the wrong cause.** After a revoke the Réactiver banner says the notification key changed (`push.ts:14-15`, `:34-35`). Make the cause neutral, e.g. "the key changed, or this device was removed from the list".
- **Nit.** The French confirm "…sur cet appareil." reads as the device you are holding. Use "sur cet appareil-là" or name `{label}`.

Not a bypass: a hand-crafted variant of the same endpoint, such as one with a query string. Only the signed-in owner can send it, and they can press Enable anyway.

### I2 – literal characters
The three U+202E are escaped. My scan of the 306 files the branch changes against main found 0 hits for Cf, Zl, Zp, U+00A0 or stray control characters.

### I3 and the T21 items
- The four `notifications.md` lines are fixed: line 14 now notes that M11's boot expiry cancels these pushes, 69 the 410 caveat, 79 W6-R16, 82 that Enable is needed after sign-out and sign-in.
- Manual check 7 (Workbox #1796) is present, the M6b sentence is now phrased as M6b's, and `encrypt.ts` really is 54 lines.
- Nits:
  - Check 7 should say to close the PWA fully, then reopen it; a resumed iOS PWA does not navigate.
  - "Signing the device out … also ends it" holds only until it signs in again, when it binds itself back.
  - The rulings header says the ruling texts are copied from the plan "except M12R24", but M12R6 now differs too ("54 lines").

### Minors
| # | Result |
|---|---|
| 1 | ✅ `finish()` clears `last_failure` on a sent event. Nit: a successful `push.test` does not clear it (`test-push.ts:84`), while the docs say "the next successful push". |
| 2 | ✅ `begin()` settles `cancelled:push_off` with no deliveries. The reworded copy fits what `refused` can really mean now. |
| 5 | ✅ `sw.classes.test.ts` ties the worker's list to `WIRE_CLASSES`. |
| 6 | ✅ `refKind "agent"` and `foreign_key` are gone. The budget agent target still uses kind `agent`, which is fine. |
| 7 | ⚠️ Comments only, no log line. Acceptable as a documented, deliberate swallow. |
| 9 | ✅ The once-a-day lookup is owner-scoped. Latent and not blocking: the live-key unique index and `liveEventExists` are still global. |
| 10 | ✅ The note is in the restart test. |

W6-R16 is done: the listener, the stored prompt and its type are removed, and the test asserts `beforeinstallprompt` is not cancelled.

### Final merge recommendation
**Ready after fixes:**
1. **Required:** a `push_revoked` refusal must not use up the per-owner subscribe window. Add a test with no clock advance between the refusal and the new endpoint.
2. **Same round, small:** `resubscribeDevice` must not re-enrol a device that has no row.
3. **Same round, one string:** a neutral cause in `push.reenable.body`, en and fr.
- The nits above are optional, before or after the merge.
- A scoped Sonnet re-review of these three is enough. The rest of the fix range is clean.

### Post-merge preview checklist (controller)
Port 7777 is plain HTTP on the LAN, so push will report `insecure_http`.
1. **Back up before restarting.** Use `node:sqlite` `VACUUM INTO ~/.pap/backups/manual-pre-m12-<ts>.db`, then `chmod 600` it. On that copy, run `SELECT id FROM schema_migrations WHERE id LIKE '202610172000%'` and expect no row. A row there means an older copy of the edited migration already ran, and boot will refuse with "migration file changed after it was applied".
2. **Build in the main checkout**, with the shim first on PATH: `pnpm install --frozen-lockfile && pnpm build && pnpm budgets`. Expect about 231.4 KB initial and 3.7 KB for the service worker.
3. **Restart and read the log:** `systemctl --user restart pap-preview`, then `journalctl --user -u pap-preview -n 100`.
   - Expect `migration_applied 202610172000_push`.
   - Expect no `push_vapid_unreadable`, no `push_test_loopback` and no `outbox_handler_error`.
4. **Key file modes:** `stat -c '%a %U %n' ~/.pap/secrets/push ~/.pap/secrets/push/vapid.json` should give 700 and 600, owned by the service user.
5. **Public files over HTTP:**
   - `curl -sI http://192.168.1.182:7777/sw.js`: 200, javascript, `no-cache`, not immutable.
   - `/manifest.webmanifest`: 200, manifest+json. `/icons/icon-192.png`: 200, image/png.
   - `/n/abcdefghijklmnopqrstuv`: 200 with the app's `index.html`. `/healthz`: 200 JSON.
6. **Owner on the LAN (testable):**
   - Settings > Notifications shows "Les notifications et l'installation demandent HTTPS.", the routes hint, a disabled Enable and an empty device list.
   - The class toggles, the name option and the mute presets save and survive a reload.
   - The quiet-hours line and the "Ouvrir Automatisation" link are there; the Automation hint has the new text.
   - The test button answers "La notification de test n'a pas pu être envoyée."
   - `/n/<22 characters>` shows "Cette notification n'existe plus"; `/n/bad` shows the same.
   - On the phone: approvals sit above the thread with a full-width card and 44 px answers, the composer does not raise the keyboard on open, the logo is 44 px, and there is no pull-to-refresh.
   - The agent header shows "· $x aujourd'hui".
   - DevTools shows no service worker registered and no update banner.
   - Stop the preview for about 15 s, then start it: the banner shows "Le daemon ne répond plus. Nouvelle tentative dans N s" and Réessayer, then clears, and drafts are kept.
7. **Not testable on 7777** (needs HTTPS): service worker install and update banner, Enable, test and real delivery, tap to landing to card, the iOS Home Screen, presence suppression, re-enable after a key reset, revoke sticking, and the Safari #1796 check.
   - Route: re-enable the ngrok drop-in, then `daemon-reload`, restart, and `enable --now ngrok-remote`. That is the owner's call: the LAN origin is then refused.
   - Watch for the ngrok free-domain interstitial on `/sw.js`. If it intercepts it, you get the "Le mode installé n'a pas pu démarrer" banner.
8. **Rollback:** a pre-M12 build will open the migrated database read-only. To go back, stop the preview, restore the backup from step 1, and rebuild the previous main.
