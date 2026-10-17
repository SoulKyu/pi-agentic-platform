# notifications — agent notes (M12)

Web Push (`apps/daemon/src/modules/push/`) and the PWA shell (`apps/web/sw/`, `features/pwa/`, `features/notifications/`). ADRs 0058 to 0062; rulings `docs/research/m12-rulings.md` (M12R1 to M12R39, W6-R1 to W6-R16). Env: `PAP_PUSH_SUBJECT`, `PAP_PUSH_EXTRA_HOSTS`, and the tests-only `PAP_TEST_PUSH_LOOPBACK`.

## Classes and defaults

- On: `approval` (a waiting session; Inbox `agent_approve`, `secret_request`), `failed` (`task_failed`, `task_interrupted`), `budget` (daily owner-wide or per-agent budget reached, once per scope per zone day), `notify` (`agent_notify`). Off: `done`, `reply`, `review`. Each is a toggle in Settings > Notifications (document `notifications`; a token cannot write it). A suppressed push keeps its Inbox item: the Inbox is the record.
- One push per waiting session (`push:approval:session:<id>`), even when the attention feed and the Inbox's `task_needs_input` both report it. A child's dialog pushes the parent's card (M12R24 as amended).

## Delivery

- Order (`decide()`): class off, muted (`muteUntil > now`; `MAX_SAFE_INTEGER` means until turned on), a present device, 5 s cooldown per key, 20 pushes an hour per owner (approvals and the digest exempt), quiet hours (hold). Present = a fresh heartbeat (45 s) with `focused: true` (focused, visible, input in the last 2 minutes).
- Approvals are enqueued at +60 s and re-judged at send time: answered or withdrawn means no push. One suppressed by focus is re-checked after 60 s, at most 3 times, then settles `suppressed:focused`.
- Per device (`push_deliveries`): up to 5 attempts, backoff 5 s doubling or `Retry-After` (at most 1 h); 400/401/403/413/3xx are final; 404/410 delete the row; a signed-out session's row is deleted unsent. The effect is never marked sent: a crash can send twice, collapsed by `Topic` (the event id) and the notification `tag`. After a restart a pending session approval is cancelled and `failed` and `budget` are sent once. A pending Inbox approval (`agent_approve`, `secret_request`) is kept and judged at +60 s by the push module itself (W6-R11), but in production M11 expires every pending agent request at boot, before push is wired, so that push is cancelled there too.
- Sources: Inbox (per-kind table in `delivery/source-inbox.ts`), sessions (attention feed, `source-sessions.ts`), budgets (`source-budget.ts`, at run end and once at boot). No source reads `detail` or any agent text.

## Payload

- Wire: `{ v: 1, id, cls, title: "pap", body, ts }`, `id` = 22 base64url characters. Body = one fixed sentence per class (fr with vous, en). Never an agent or task name, command, path, secret, error text or free title.
- Option `titles: "names"` (off): appends a name, only from the trigger registry or the agent registry, controls/Cf/Zl/Zp stripped, 60 code points. No registered name, no suffix. A budget push carries the agent name, never an amount.
- Details come after the click: `push.open { id }` returns a target (session, agent, Inbox, Settings > Automation or Notifications); an unknown id is `not_found`.

## Keys

- `$PAP_HOME/secrets/push/vapid.json` (dir 0700, file 0600, owned by pap's user), P-256, created once and never overwritten. Damaged, linked, foreign or too open: push is `off`, reason `keys_unreadable`, the file is not touched. Subscriptions store the key id.
- Recovery: `rm $PAP_HOME/secrets/push/vapid.json`, restart. A new pair is minted, rows with another key id are purged, the count is logged and shown in Settings (`keysReset`) until a device subscribes again. **Notifications: each device re-enables when it next opens pap.** The client compares its `applicationServerKey` with `push.config.publicKey`, shows "Réactiver les notifications" when it differs, and re-binds after a re-login.
- `secrets/push/` is excluded from plain backups by M6b's plan, on purpose: with `state.db` the key would let the holder push arbitrary text to the owner's devices. M6b's `--secrets include --encrypt` is meant to restore it at 0600/0700 (that is M6b's behaviour, not tested in this branch).
- `sub`: `PAP_PUSH_SUBJECT` (https or mailto), else an https `PAP_PUBLIC_ORIGIN`, else the project URL. JWT valid 12 h, cached 6 h per audience.

## Endpoints

- https only, port 443, no credentials, fragment or IP literal, at most 2048 characters, and the host must be Apple `*.push.apple.com`, `fcm.googleapis.com`, Mozilla `*.push.services.mozilla.com`, Microsoft `*.notify.windows.com`, or one of at most 8 names in `PAP_PUSH_EXTRA_HOSTS` (comma separated, exact). There is no switch to turn the list off.
- At send time the connection uses a guarded lookup (every answer public by `blockedForPush`), no redirects, a 12 s total deadline, a capped drain of the response; rules are re-checked then. Logs carry `h:<12 hex>` of the endpoint, never a body, key or payload.
- Caps: 10 devices per owner (refused, never evicted), 64 presence entries, `push.subscribe` one call per 6 s, `push.test` one per 10 s. Every `push.*` method is for a browser session; a token gets `forbidden`.

## #https

Push and install need a secure origin. `kernel/push-readiness.ts` is the only place that classifies it: `ready`, `localhost_only` (works on that machine only), `insecure_http`, `origin_mismatch` (including TLS served with an http origin). Plain HTTP shows the one-line message and a disabled button; presence still runs. pap reads no `X-Forwarded-*` and has no `trustProxy` setting, so the public origin is always set by hand. Routes, in order:

1. ngrok, the origin the owner already runs (decision 75): `PAP_PUBLIC_ORIGIN=https://<your ngrok host>`.
2. Tailscale: `tailscale serve --https=443 localhost:7777`, then `PAP_PUBLIC_ORIGIN=https://<host>.<tailnet>.ts.net`.
3. A reverse proxy that terminates TLS: set `PAP_PUBLIC_ORIGIN` to its https origin.
4. pap itself: `--tls-cert <file> --tls-key <file>` with `PAP_PUBLIC_ORIGIN` set to the https origin.

## #keys

- `push.config`: `status` on/off; `reason` `keys_unreadable`, `insecure_http` or `read_only` (database written by a newer pap; subscribe answers `read_only`); `readiness`; `subscribed`/`max`; `lastFailure { at, reason }` per owner (`retry_exhausted`, `rejected`, `refused`, `no_target`; never a response body); `keysReset`.
- `pap doctor` (M6b, `docs/agents/doctor.md`) registers both: an `https` check mapped from `pushReadiness`, and a `push` check that applies the daemon's key-file predicate (absent ok, 0600 file in a 0700 folder owned by pap's user ok, else warn). Push is never a doctor failure.
- Containers: outbound HTTPS and DNS to the push services, and `$PAP_HOME` on a volume so `secrets/push/` survives.
- `PAP_TEST_PUSH_LOOPBACK=1` needs `PAP_TEST_PROVIDER_SCRIPT` and lets the validator and sender accept `127.0.0.1`. Tests only; never set it elsewhere.

## Quiet hours and the digest

- Quiet hours and the zone are the Automation settings (`automation.quietHours`, `timezone`); Notifications points to them. Held events become one `digest` push at the first minute outside the window: "N éléments vous attendent." plus "M demandes ont expiré pendant les heures calmes." when needed. A digest suppressed by mute or focus is dropped (the items stay in the Inbox).
- An isolated task's question asked in quiet hours is denied after 10 minutes (decision 90) and counted as expired in the digest.
- A digest whose enqueue keeps failing (`digest_busy`) retries at the next window.

## Service worker and update flow

- `/sw.js`, scope `/`, built from `apps/web/sw/sw.ts` (3.7 KB of a 6 KB budget). Registered only in production on a secure context. It precaches the whole build (index, every asset and chunk, icons, manifest); the build id hashes every shell file and the worker code. Hashed assets install with the HTTP cache; a redirect fails the install.
- It intercepts same-origin GET only and never caches `/auth`, `/api`, `/files`, `/upload`, `/hooks`, `/metrics`, `/healthz`, `/ws`, `/sw.js`, `no-store`/`private` responses, redirects or non-200s. Navigations are network-first (8 s) with the cached index as fallback.
- A new worker waits. The page shows "La page a une mise à jour" (the web shell; not a pap release banner), and Reload posts `skip-waiting`, waits for `controllerchange` and reloads once. The page checks for updates on every reconnect and when it becomes visible, and a failed lazy chunk shows the banner or reloads once. "Later" hides the banner for the page load, including a later stale-chunk signal.
- Click: the worker opens only `/n/<id>` with a 22-character id, else `/`. A push with an empty or malformed payload still shows a generic notification.
- Known limits: bfcache `pageshow` is not covered by resume; a mid-day zone change can give a second budget push; `keys_reset` is instance-wide (one user in v1); no push for a failed feed poll or a trigger-level effect failure (M12-RT-32, no Inbox kind or landing target exists); "release ok, logout failed" leaves a device unsubscribed locally.

## FinOps

- First install of the worker downloads the whole shell: about 162 files, 5.0 MB raw and 1.5 MB gzip per device (the static handler does not compress, so the wire size is nearer the raw figure). An update downloads only changed chunks. `sw.js` has a 6 KB gzip budget.
- A failure shown in Settings (`lastFailure`) clears at the next successful push; when push is off, queued events settle `cancelled:push_off` without deliveries.

## Troubleshooting

- Apple answers 403 `BadJwtToken`: the `sub` is invalid; set `PAP_PUSH_SUBJECT`.
- 410 or 404: the device's row is dropped. It re-subscribes when it next opens pap only if the browser still holds its subscription; if the browser removed it, press Enable again.
- Revoke (Settings > Notifications > devices) sticks: the daemon keeps a hash of the revoked endpoint (newest 50 per owner, table `push_revoked`) and refuses a refresh of it with `push_revoked`. The device then drops its browser subscription and shows "Réactiver les notifications"; Enable makes a new endpoint, which is accepted. Signing the device out in Account & devices also ends it.
- iOS: push needs the Home Screen install (Share, Add to Home Screen) and a tap on Enable; the prompt is never shown at load.
- A notification that opens the login page: the session expired; sign in, then the device re-binds by itself.
- Nothing arrives: Settings > Notifications shows the status, `lastFailure` and the devices; "Envoyer une notification de test" tests one device.
- iOS standalone: `pt-safe` is inert until a status-bar style is chosen (open owner question).

## Manual checks (the owner, on real devices)

1. Over the ngrok origin: add pap to the Home Screen, open it, Settings > Notifications > Activer, accept, send the test. Then trigger a real approval with the phone locked and wait 60 s.
2. Lock the phone for a minute and unlock: the reconnect banner appears and clears, drafts are kept.
3. Chrome/Android shows its own install UI (pap has no install button and does not cancel `beforeinstallprompt`, W6-R16); the iOS icon is the L4 logo.
4. On `http://<LAN IP>:7777` the section shows the HTTPS message and a disabled button.
5. Rebuild and restart: the open PWA shows the update banner and reloads once.
6. Sign out and in on the phone, open the PWA: sign-out revoked the row and unsubscribed the browser, so press Enable, then send the test. Also revoke a device from another one: opening pap on the revoked device shows "Réactiver les notifications" and no push arrives until it is enabled.
7. Safari/iOS only (carry from T14): confirm that `fetch(navigationRequest, { signal })` works on your Safari. `sw.ts` falls back to the cached index silently if it throws, so a failure shows as stale pages while online, not as an error. Check: close the installed PWA fully, then reopen it online after a deploy and see that the new page loads (not the cached one) without the update banner being the only way.
