# Agents in microVMs, sub-project 2: final reviews


---

<!-- final-A-verdict.md -->
# Final review, Part A (c1729e89..9f5046f0): VM network, refused-host card, ADR 0079

Reviewer: Opus, final review of Part A (A1-A5). A2 had a task review. A1, A3, A4 and A5 get their first review here (AVM2-E3).

Method:
- Read the whole package diff, plus the code around it that the diff relies on but does not show: `sessions/agent-rules.ts`, `vm-rules.ts`, `policy-link.ts`, `vm-launch.ts`, `agent-vm/vm-init.ts`, `pi-host/open-session.ts`, `tool-kind.ts`, `egress.ts`, `agents/reach.ts`, `agents/stream.ts`, the relay auth and the seccomp filter.
- Checked contract behaviour with a Node type-stripping script against `packages/contracts/src`: `PolicyRules` with port and IP entries, `entryFor` for IPv6, the grammar, and `widensReach`.
- Ran the new migration on a populated SQLite DB with `node:sqlite`, foreign keys on, inside a transaction.
- Ran the focused unit tests: host-entry, egress-refusals, vm-judge and agent-stage, 55/55 green. Both Critical defects sit in integration paths that no test exercises.

## Strengths

- **The proxy itself is solid on every security point checked.**
  - Identity comes from the source address only, and the launch is checked again at each request by `launchId`. An unknown source gets a 403 before any parse and makes no card.
  - The address policy is ordered to fail closed: host addresses, then the pap0 subnet, then private ranges (exact or IP entries only), then `blockedStrict` for everything else. The IPv4-mapped form is unwrapped first. NAT64, IPv4-compatible and SIIT/6to4 forms that carry private or loopback addresses fall to `blockedStrict`.
  - IP literals are compared canonically. The WHATWG parser canonicalises plain-HTTP hosts (`0x7f.1`, `2130706433`). Non-canonical CONNECT names become `ip_literal`.
  - For plain HTTP the absolute URI is judged, and `Host` is rewritten from it. Origin-form requests are refused.
  - CONNECT connects only to the judged port. Ports are enforced for both name entries and IP entries.
  - DNS is pinned: the answers checked are the answers dialled, and one refused answer refuses the whole name.
  - Mixed answers report `blocked_address` first.
  - Not-listed names are refused before any DNS lookup, so an unlisted name never triggers a lookup.
- **The proxy is unreachable from the host side.** In the nft input chain, `iifname != pap0` is dropped for 7843. Local users and other netns cannot reach it, and the R22 bridge guard pins each VM's address.
- **Launch add and remove are ordered safely.**
  - The address is added after `backend.start` and before any worker exists. It is removed right after `backend.stop`, with no await between.
  - A reused address retires the old core, and a late removal leaves the new launch alone.
- **The extraction is clean.** `proxy-core.ts` and `lookup.ts` keep host mode byte-for-byte (A2 review). The approval change is gated on `deps.vm`, and host-mode callers keep the `inVm = false` default.
- **The step-up is enforced on the server.** The dialog writes through `agents.update`, which runs `stepUpIfWider` with the owner's list, so a client cannot skip it. `agents:admin` is browser-only.
- **The refusal sink is bounded where it matters.**
  - One card, one Inbox item and one push per agent and host:port per hour.
  - At most 20 new cards per agent per hour.
  - The push carries the registry name only, never the host.
  - Usage logs hash the hosts the agent chose (W5-R54).
- **The migration is safe on an existing DB.** I verified this on a populated DB: rows and ids are kept, `ON DELETE CASCADE` and the index survive, `foreign_key_check` is empty, and the migration runs in a transaction with foreign keys on.
- **i18n is complete.** EN and FR are typed (`Record<keyof typeof en, string>`), tokens are used, and the copy follows "what happened / what is intact / what to do" where it matters (conflict, vmOnly).
- **The Kata test is not vacuous.** It asserts concrete status, header and body lines. Run as is, it would fail on both Critical items below, which is the right outcome.

## Issues

### Critical

**C1. A VM agent with a port or IP entry can never start a session; the permissions sheet breaks too.** Plan defect: A1's file list never named the schemas that carry `allowHosts` beyond `AgentInput`.
- Where:
  - `packages/contracts/src/policy.ts:273` (`PolicyRules.allowHosts: z.array(HostPattern)`) and `:293` (`autonomy.hosts`);
  - `packages/contracts/src/agents-safety.ts:79` (`PermissionsView.hosts`);
  - fed by `apps/daemon/src/modules/sessions/agent-rules.ts:108,113`.
- What: the agent's `allowHosts` (`k8s.lan:6443`, `192.168.1.40`, and any entry the refusal dialog adds on a port other than 80 or 443) goes into the session rules unchanged. `HostPattern` refuses them. I checked this directly: `PolicyRules.safeParse({..., allowHosts: ["k8s.lan:6443"]})` and `["192.168.1.40"]` both give `false`.
- What follows:
  - `policy-link.ts:156-179` logs `policy_rules_invalid` and returns the fallback `{profile: "interactive", approvalMode: "read-only", taint}`, which has no `sandbox`.
  - `vm-launch.ts:98-104` then runs `vmInitOf`. `vm-init.ts:23` throws `internal` because `sandbox.required !== true`, and `agent_vm_init_refused` is logged.
  - Every thread, task and child start of that agent fails with a bare `internal`.
  - `use-agent-permissions.ts:26` fails to parse `PermissionsView`, so the Permissions sheet shows "failed".
- Why Critical: Review Focus 1 (the kubeconfig `192.168.1.40:6443`) and the spec's own example (`prometheus.lan:9090`) are the headline use cases. One click on "ADD TO LIST" for a port that is not 80 or 443 bricks the agent.
- How to fix:
  - (a) Let `PolicyRules.allowHosts`, `autonomy.hosts` and `PermissionsView.hosts` take `AgentHostEntry`.
  - (b) Decide what pi-host's URL-tool stage does with such entries in a VM. `judgeUrl` (`packages/pi-host/src/policy/egress.ts:76-98`) matches names only and refuses IP URLs, so `web_fetch http://prometheus.lan:9090` would be blocked before it reaches the proxy. The simplest consistent rule is that in a VM the URL-tool stage defers to the proxy (`skip: "egress proxy"`), as the networked shell already does (M11R231). In host mode it keeps today's names-only rule.
  - (c) Add an int test on the process backend: a VM agent with `allowHosts: ["k8s.lan:6443", "192.168.1.40"]` opens its thread, and `agents.permissions` parses.

**C2. The VM shell never gets network.** `sandbox.network` is unwired end to end, so the A3 deliverable is dead code in production. Plan defect: A3's file list missed R15's pins.
- Where:
  - `apps/daemon/src/modules/sessions/vm-rules.ts:23` always sets `sandbox: { required: true, network: false }` (R15).
  - `apps/daemon/src/modules/agent-vm/vm-init.ts:23` throws `internal` if `sandbox.network` is true.
  - In the worker, `packages/pi-host/src/open-session.ts:181-183` pins the policy config to `{ vm, sandbox: { network: false } }`, and `:136` gives the prompt `network: vm ? false : …`.
  - The A3 change reads `deps.rules()?.sandbox?.network === true` (`open-session.ts:226`), which is therefore always `false` in a VM.
- Effect:
  - `--unshare-net` is always passed, and the shell never gets the proxy variables. "With `sandbox.network` on, the shell shares the VM's network" (spec §3) never happens.
  - The agent's system prompt still says it has no network.
  - Once network is wired, taint will not be recorded: `tool-kind.ts:166-169` takes `external` from the policy config's `sandboxNetwork`, which is pinned `false`. Spec §5 requires "taint is still recorded and shown".
- Why the tests missed it: `agent-stage.test.ts:28-34,56-68` builds VM rules with `sandbox.network: true` and tools with `sandboxNetwork: true`, a configuration production cannot produce. The ops and argv tests check the flag in isolation. The Kata test would catch it (its first two cases dial the proxy from the shell), but it has never run.
- How to fix:
  - Carry the agent's network switch into the VM explicitly. Either add a `VmInit` field (e.g. `shellNetwork`) set in `vm-launch.ts` from `launch.input.sandbox.network`, or relax R15 to keep `network` while still requiring `required: true`, and update `vmRulesOf`.
  - Use that one value for the shell tool, the policy config's `sandboxNetwork` (so a networked shell's result taints) and the prompt facts.
  - Keep A3's `inVm` judgement so that no card is asked.
  - Add a process-backend int test: a VM agent with `sandbox.network: true` runs bash with the proxy variables and without `--unshare-net`. The same agent with `false` keeps `--unshare-net`.

### Important

**I1. A private_wildcard "Add" opens LAN addresses without the step-up.** Plan defect: brief A1 Step 1 asks for this exact non-widening.
- Where: `packages/contracts/src/agents.ts:140-151` (the wildcard branch of `covers`), pinned by `packages/contracts/src/agents.test.ts:223-227`.
- What: `widensReach(["*.home.lan"] → ["*.home.lan", "nas.home.lan"])` is `false` (checked). The same holds for an owner list `["*.home.lan"]` copied into the agent's list.
- Why it widens: in VM mode an exact entry reaches private addresses that the wildcard never reaches (spec §3: "private ranges allowed only for an exact entry"). Adding it is exactly the widening the `private_wildcard` dialog exists for, and spec §6 says "Adding widens the agent's reach, so it asks the step-up". The same gap applies in the agent form.
- How to fix: a wildcard never covers an exact name, so a new exact entry always widens. Update the A1 test case, and add a dialog test: a private_wildcard add goes through `stepUp`.

**I2. Every refusal after the first is an unthrottled DB write plus a UI refetch, and the card cap logs one line per refusal.**
- Where:
  - `apps/daemon/src/modules/agent-vm/egress-refusals.ts:63-73` calls `events.update` for each refusal of an open card.
  - `events.ts:274-288` does a SELECT and an UPDATE, then `told`. That calls `stream.eventWritten` (`stream.ts:185-187`), which publishes "at once", and the open agent tab reads the events page again (M11R72).
  - `egress-refusals.ts:78,83` logs `egress_refusal_unknown_agent` and `egress_refusal_card_cap` once per refusal.
- What: a `not_listed` refusal needs no DNS lookup and answers at once, so a VM that loops `curl` (32 parallel connections) produces refusals at hundreds per second. Each one costs a synchronous SQLite write, a WS hint, a browser refetch of the events page, and two `hostsOf` profile reads. Past the 20-card cap, each one also costs a journal line.
- Why: the brief asks that the sink cannot be flooded. Review Focus 3 (200 refusals a minute) already means 200 writes, 200 hints and 200 refetches, and a tight loop takes the same path at request rate.
- How to fix:
  - Keep the count in memory and write it at most every N seconds per open card, through a `Clock` timer or at the next refusal after N.
  - Throttle the cap and unknown-agent log lines, once per agent per window.
  - Optionally, add a per-VM refusal token bucket in `vm-listener` so a VM over the bucket gets a 403 without being judged.
  - Test: 1,000 refusals in 1 s give at most k `update` calls and one cap line.

**I3. The IPv6 grammar refuses the bare form, so the dialog's add fails for IPv6 on ports 80 and 443.**
- Where: `packages/contracts/src/host-entry.ts:25-31,78-83`. `egress-refusals.test.ts:47` pins the invalid output.
- What:
  - `split` refuses any unbracketed entry with more than one colon. A bare `fd00::1` is invalid, while the spec says "IPv6 in brackets when a port follows" and the docs repeat it.
  - `entryFor("fd00::5", 443)` returns `fd00::5`, which `AgentHostEntry` refuses. A refused IPv6 target on 80 or 443 therefore gives a dialog add that fails with a generic `bad_request`.
  - The bracketed regex (`:16`) also accepts non-addresses (`[::::]`, `[1:2:3:4:5:6:7:8:9]`). They are stored and never match (fail-closed), but the owner gets no error.
- How to fix:
  - Accept an unbracketed entry that is a valid IPv6 literal with no port, or make `entryFor` always bracket IPv6. Spec grammar is better served by doing both.
  - Validate the bracketed host as a real IPv6 address. contracts runs in the browser too, so use `new URL("http://[" + h + "]/").hostname`, not `node:net`.
  - Fix the test at `:47`.

**I4. The Kata test does not check the relay credential, and with network on the shell can now reach the relay port.**
- Where: `apps/daemon/src/modules/agent-vm/egress.kata.int.test.ts:141-183`.
- What: spec §3 says "The builder verifies that the shell still cannot read the gateway token **or the relay credential**". Only the launch token is searched.
- Why it matters now: with network on, the shell can open 10.213.0.1:7842, which it could not do under `--unshare-net`. The relay key (`relay/server.ts:226`, key plus source address) is now the only barrier. The guard is code, `applyRelayKey` keeps the key in the worker's memory, and the spec asks for proof.
- How to fix: expose the launch's relay key to the bed, search files and `/proc/*/{environ,cmdline}` for it as for the token, and add a dial to `:7842` with no key that is refused. Also see M6.

### Minor

- **M1.** The migration resets the AUTOINCREMENT high-water mark. On a populated DB, `sqlite_sequence` fell from 8 to 5 when the newest rows belonged to a deleted agent, so ids 6-8 are reused. Separately, the test "keeps the cards that were there before the migration rebuilt the table" (`events.egress.test.ts:65`) writes after the migration and asserts nothing about the upgrade.
  - Fix: carry `seq` over before the DROP.
  - Fix: add a test that applies migration N-1, inserts rows, then applies N.
- **M2.** The dialog copies the owner's list (up to 256 entries, `MAX_ALLOW_HOSTS`) into an agent list capped at 100 (`AGENT_LIMITS.hosts`). An agent already at 100 hits the same cap. Either way the owner gets a generic `bad_request`. Check client-side and say what happened, what is intact and what to do.
- **M3.** `compose-agents-vm.ts:255-256` uses `(relay?.grant(g), proxy.launched(g))` and `(relay?.revoke(id), proxy.ended(id))`. A throw in `relay.revoke` skips `proxy.ended`, which leaves a stale address-to-launch mapping until the address is reused. Call each in its own try.
- **M4.** The `unknown_source` 403 (`vm-listener.ts:26-27`) has no body line. Spec §3 asks for "a one-line reason the client prints".
- **M5.** The dialog's time is `hh:mm` only (`EgressRefusalDialog.tsx:53`), so a card from yesterday reads as today. The count is not refreshed while the dialog is open.
- **M6.** The Kata test dials `1.1.1.1` (`egress.kata.int.test.ts:120,136`), and AGENTS.md says "Tests never name a public host or address". Use `192.0.2.1` (TEST-NET-1): the result is the same `ENETUNREACH`.
- **M7.** Doc drift in `docs/agents/agents-vm.md`:
  - `:36` still says "the shell has no route, so the INET families reach nothing", next to the new "with it on, it shares the VM's network".
  - `:55` says "IPv6 in brackets when a port follows", which is not what the code does (I3).
  - Usage is "per agent", but the code logs per launch (deferred A2).
  - After C2, check again `:59` "Taint is still recorded" and `:66` "`git clone`, `npm` … work", plus the same claim in AGENTS.md. As of this head they overclaim.
- **M8.** With network on, the shell shares the VM's loopback and abstract-socket namespace with the worker, Pi and MCP servers. Any local listener there becomes reachable from the shell. pap has none today, but an MCP server with an HTTP transport would. Say so in ADR 0079 "Consequences" or the agents-vm limits.
- **M9.** Files at the limit: `compose-agents-vm.ts` 399, `compose-m11.ts` 399, `packages/contracts/src/agents.ts` 399, `AgentScreen.tsx` 396 (all within the 400 rule). C1 and C2 will need splits first.

## Deferred minors triage (Part A ledger)

| Item | Triage |
|---|---|
| A1: `covers` falls back to name-only when the list holds an invalid entry | Keep deferred. I checked that it stays conservative: a port suffix always breaks `endsWith`, and wildcards cannot be numeric, so it over-asks, never under-asks. |
| A1: no RED captured | Keep deferred (process). |
| A2: SIIT/6to4 spellings of a public host address not refused | Keep deferred. Not routable on Linux without a translator. |
| A2: usage logged per launch, not per agent | Keep deferred, and fix the doc wording (M7). |
| A2: VM DNS limiter doubles the W5-R43 cap (2 + 2) | Keep deferred, and record the W5-R43 amendment. The docs already say "beside host mode's own". |
| A2: host idle/life limits on VM tunnels (`kubectl -w` cut at 120 s idle) | Keep deferred. It is the owner's call and is documented in the ADR limits. |
| A2: 3 mutants named but not run | Keep deferred (process). |
| A2: small duplications (`addressOf`, `targetOf`) | Keep deferred. |
| A2: `compose-m11.ts` 399/400 | Keep deferred, but the C1/C2 fix must split first (M9). |
| A2 → A4: `scopeOf` try/catch | Done (`vm-listener.ts:153-158`). |
| A2 → A4: source-mapping test | Done. |
| A2 → A4: DNS failure answers 403 | Done (502 `(resolve)`). |
| A2 → A4: vanished-launch copy | Done. |
| A2 → A4: refusal log lines unthrottled until the sink | Superseded by **I2**: fix before merge. |
| A3: `PAP_GUEST_PROXY` is `host:port` | Fine as is (vmd env-file validator). |
| A3: shell network fixed at session open | Keep deferred (documented). It only becomes real after C2. |
| A4: migration (back up the preview DB before deploy) | Safe as verified. Fix M1 before merge (one line plus a test). |
| A4: migration-list tests re-run alone after the gate | Fine. |
| A4: tests written after code | Keep deferred (process). |
| AVM2-E10: the 20-cards-per-hour cap | Keep the cap, but throttle its log line (I2). |
| A5: `x-pap-deny: blocked_ip` for both VM reasons | Keep deferred. The body carries the specific reason. A `vm` header value would be nicer. |
| A5: doc figures (20 cards/hour, 2 DNS lookups) | Verified in code (`NEW_CARDS_PER_AGENT_HOUR = 20`, `LOOKUPS_TOTAL = 2` per judge instance). No action. |

## Declined to judge

- Part B (files, B1-B3) and lane B's deferred minors: outside Part A.
- Domain fronting and SNI or inner `Host` different from the CONNECT target: spec §2/§3 say the proxy filters hosts and ports, reads no content and does no TLS inspection, and the docs say it "guarantees hosts, not content".
- DNS exfiltration through the daemon's resolver for subdomains of a listed wildcard: inherent to wildcard entries, identical in host mode, and the spec keeps wildcards.
- Established tunnels outliving the removal of a host until idle (120 s) or life (30 min): spec §6 frames list changes as "from its next request". A tunnel is not a new request.
- One request per connection for plain-HTTP keep-alive (`used` flag): pre-existing host-mode behaviour that the extraction keeps on purpose.
- The VM shell's capability set (`CAP_SETUID` and the others) and the AF_NETLINK allowance: sub-project 1 decisions, not changed here. I checked that without `CAP_NET_ADMIN` or `CAP_NET_RAW` netlink cannot change routes and raw sockets are unavailable.
- Process-backend identity (every launch at 127.0.0.1): test-only (`PAP_TEST_AGENT_RUNTIME=process`).
- Provider-side tools as an egress path through the relay: already a documented known limit (ADR 0078).
- No CI job for Kata: owner ruling AVM2-E2 and the existing backlog.
- Host-mode proxy behaviour after the `proxy-core`/`lookup` extraction: the A2 task review verified it line by line. I only spot-checked `rawRefusal` and `relayHttp` defaults.
- The 20-cards-per-hour cap value and the `notify` push class: controller rulings AVM2-E10 and AVM2-E5.

## Assessment

**Ready to merge:** No

**Reasoning:** The proxy is sound, but the feature does not work end to end. An entry with a port or an IP (Review Focus 1, and any dialog add on a port other than 80 or 443) makes every start of that agent fail on the unchanged `HostPattern` in `PolicyRules`. The VM shell never gets network, because R15 still pins `sandbox.network: false` on both sides. Fix C1 and C2 with process-backend int tests, then I1-I4, and run the Kata file once, before merging.

---

<!-- final-A-reverify.md -->
# Part A final-review fix wave: re-verification (9f5046f0..633051b1)

Reviewer: Opus, re-verification. Inputs: final-A-verdict.md (Issues), final-A-fix-brief.md (AVM2-E11, E12), E13 and E14 rulings, final-A-fix-report.md, final-A-fix-package.diff. Code read in the read-only checkout around the diff: `agent-rules.ts`, `egress-link.ts`, `permissions.ts`, `resources-check.ts`, `host.ts`, `vm-shell/{argv,ops,tool,proxy-env}.ts`, `guest.ts`, `policy/{agent-stage,agent-decide,stage-approval,results,evaluate-once,tool-kind,extension}.ts`, `kernel/clock.ts`, `kernel/db/migrate.ts`, `agents/events.ts`, `vm-listener.ts`, `compose-agents-vm-proxy.ts`, `runtime.ts`, `kata-bed.ts`, `EventCard.tsx`. RED/GREEN logs checked in the scratchpad (`avm2-fix-*.log`; gate log 19058 passed, the 1 failure is the E12 expectation, re-run alone). No test was re-run: no doubt needed one.

### Finding Verdicts

- **C1: ADDRESSED.** `PolicyRules.allowHosts` and `autonomy.hosts` take `AgentHostEntry` (`packages/contracts/src/policy.ts:259,279`). `PermissionsView.hosts` takes it too (`agents-safety.ts:80`). Every `PolicyRules` parse site goes through these schemas: `policy-link.ts:156`, `vm-init.ts:13`, `pi-host host.ts:143`, `dispatch.ts:154`. `autonomy.hosts` is read only for its length (`agent-stage.ts:20`). The worker's URL stage matches by port and by IP (`pi-host/src/policy/egress.ts:96-126`). Production wiring is tested end to end: `vm-network.int.test.ts:21-29` runs on `startVmBed`, the process backend. It goes through the real `agent-rules` → `vmRuleParts` → `policy-link` → `vmInitOf` → worker path, the thread answers, and `agents.permissions` parses. The RED in `avm2-fix-C1C2-red.log` is `call failed: internal`.
- **C2: ADDRESSED.** The fix changes these points:
  - `vmRuleParts` keeps the agent's switch (`vm-rules.ts:24`).
  - `vmRulesOf` requires only `required: true` (`vm-init.ts:23-26`).
  - The worker reads one `vmNetwork` at open, from the `first.data` rules (`open-session.ts:156`). The same value feeds:
    - the policy config (`:183`), and so the tool kind's `sandboxNetwork` (`extension.ts:87-88`) and `kind.external`;
    - the shell tool (`:228`), which drops only `--unshare-net` (`vm-shell/argv.ts:53`) and adds only the proxy variables (`tool.ts:32`, `ops.ts:45`);
    - the prompt (`:262`).

  Under AVM2-E11, the taint is recorded and the card is not asked:
  - **Taint:** `results.ts:163-171`. In a VM there is no egress client, so `check` is undefined, and the networked sandboxed shell taints and stays tainted.
  - **No card:** the approval path still uses `judgedAs(call, inVm)` (`stage-approval.ts:166`, `agent-stage.ts:41-47,173-181`), so the call stays `edit` and not external.

  Tests:
  - `host.vm.network.int.test.ts`: a fake bwrap records argv and env. The prompt shows the switch. Taint only when on. No approval.
  - `vm-network.int.test.ts:33-48`: on the daemon's process backend, taint when on and clean when off.

  Together they cover the production chain. The daemon test proves that `rules.sandbox.network` reaches the worker, because the taint depends on `vmNetwork`. The pi-host test proves `vmNetwork` → argv and env, and one variable drives both. This differs from the brief's wording, which asked for the argv check on the daemon's process backend, but the end-to-end chain is still covered. `agent-stage.test.ts` now pairs rules and tool facts the way production does.
- **I1: ADDRESSED.** `covers`: a wildcard covers only a wildcard (`packages/contracts/src/host-covers.ts:13-16`). Tests: `agents.test.ts:240-247`, `agents.autonomy.test.ts`, the dialog test (a `private_wildcard` add calls `stepUp`), and `agent-autonomy.int.test.ts:59-62` on the server. One residual is listed below (`coversByName`).
- **I2: ADDRESSED.**
  - Each card keeps its count in memory and gets at most one `events.update` (and so one hint) per 60 s, through the kernel `Clock` (`egress-refusals.ts:83-106`).
  - The cap and unknown-agent log lines come once per agent per minute, with `suppressed` (`:69-80`).
  - The final count is not lost:
    - Every refusal either flushes at once or leaves a timer pending.
    - A timer that `prune` leaves behind on a card replaced at the hour boundary still writes the old card. It never deletes the new entry (`open.get(key) === entry`).
    - After an agent is deleted, the one pending timer fires within 60 s. `events.update` finds no row (the cascade removed it) and returns false (`events.ts:274-281`), the entry is dropped, and no row is written. Nothing leaks.
  - Tests: `egress-refusals.test.ts:701-736,760-773`. One new Minor is listed below (the throw on the timer path).
- **I3: ADDRESSED.**
  - A bare IPv6 entry is accepted only without a port, and brackets only with a port (`host-entry.ts:17,33`).
  - Both forms are validated with the WHATWG parser, which also works in the browser (`:15-24`). `[::::]` and `[1:2:...:9]` are refused.
  - `entryFor` gives the bare form for 80 and 443 (`:91-95`), and that output now parses (`host-entry.test.ts:578-584`).
  - In host mode, `entryNeedsVm` still refuses a bare IPv6 (`parsed.ip`).
- **I4: ADDRESSED (not run, AVM2-E2).**
  - The relay key is searched for in files and in `/proc/*/{environ,cmdline}`.
  - A new case dials `10.213.0.1:7842` with no key, with a wrong key and as Claude, and expects 403.
  - The kata bed's default agent has `network: true` (`kata-bed.ts:213`), so the dial really leaves the shell.
  - The key comes from `observe.granted`, which is a no-op in production (`compose-agents-vm.ts:263`).
- **M1: ADDRESSED.** The migration copies the `sqlite_sequence` row before the DROP, and the RENAME carries it over (`202610211200_agent_events_egress.sql:13-15`). The migration runs in the runner's transaction (`migrate.ts:146`). The test applies migration N-1, adds rows (the newest ones from an agent then deleted), applies N, and checks the ids and that the next id is 9 (`events.egress.migration.test.ts`).
- **M2: ADDRESSED.** The cap is checked on the client before the copy or the append (`EgressRefusalDialog.tsx:59-63,125`). The message says what happened, what is intact and what to do, in EN and FR (`agent-egress.ts`), and the button is disabled.
- **M3: ADDRESSED.** `eachOwnTry` runs each hook in its own try for the launch end (`compose-agents-vm.ts:265-269`). It now also wraps the launch start; see the new Minor below.
- **M4: ADDRESSED.** The 403 has a one-line text body (`vm-listener.ts:26-27`), and the int test asserts it.
- **M5: ADDRESSED.** A card that is not from today shows the day (`EgressRefusalDialog.tsx:64-71`). On the count:
  - The dialog reads the live `data` of its card (`EventCard.tsx:130`), so it follows the card's refetches, now at most one a minute.
  - The brief scoped M5 to the date only.
- **M6: ADDRESSED.** The Kata test uses `192.0.2.1`.
- **M7: ADDRESSED.** All the drift listed in M7 is fixed:
  - `agents-vm.md:36`: route wording;
  - the Host list line: IPv6 grammar and the E12 rule;
  - usage counted per launch, and refusal throttling documented;
  - taint and the `sandbox.network` condition;
  - `git`/`npm`: they need the switch and must follow the proxy variables;
  - AGENTS.md: both the M11 line and the VM section.

  No VM "no network" claim is left in `docs/agents/` or the catalogs.
- **M8: ADDRESSED.** ADR 0079 Consequences and the agents-vm limits now cover the shared loopback and abstract sockets, and the relay key as the only barrier.
- **M9: ADDRESSED.** The files were split with no behaviour change. The largest touched file is now `compose-agents-vm.ts` at 388 lines. The new files import only allowed paths: the root `compose-*` files and modules' `index.ts`, and inside contracts the cycle through `host-pattern.ts` is broken.
- **E13: ADDRESSED.** In VM mode, `AgentForm.tsx:186-199` shows the network `Switch`, which writes `draft.network`, with the hint `agentVm.network.hint`. `agentVm.sandboxNote` is replaced in EN and FR (`agent-vm.ts:32-34,88-90`). Turning it on asks the step-up on both sides: `widensReach` (`agents.ts:160`) and the server's `stepUpIfWider`. Test: `AgentResources.test.tsx`.
- **E14 (not a defect; safety check): safe.**
  - In a VM, the only route out is the bridge ports. The worker's fetch goes through the proxy (`NODE_USE_ENV_PROXY`), and the proxy judges ports.
  - The `NO_PROXY` destinations (relay, gateway, loopback) are reachable by the worker anyway, and each is gated by its own key. The URL stage was never the barrier there.
  - In host mode, the "any port" reading for a name with no port is the old rule, unchanged.

### New Breakage in the Fix Diff

No Critical or Important issue was found.

Host mode is unchanged for name-only lists:
- **Rules:** `hostRules` is unchanged, and `vmRuleParts` runs only with a layout.
- **Sandbox:** the host branch of `open-session.ts` is unchanged.
- **Approvals:** the `inVm` gating is unchanged.
- **URL stage:** checked case by case:
  - a `HostPattern` entry always parses as a name entry with `DEFAULT_ENTRY_PORTS`, so it matches any port, as before;
  - the wildcard and exact matching rules give the same results as before (`entryAllows` against the old `endsWith`/length rule, with `HOST_ALPHABET` refusing the empty first label);
  - an IP URL against a list of names still gets "IP address".

The networked shell keeps every other protection: `argv.test.ts:160-166` pins `open == closed minus --unshare-net`, and the seccomp filter, capabilities, binds and fixed environment are unchanged.

- **Minor, `apps/daemon/src/modules/agent-vm/egress-refusals.ts:83-90,105`.** A flush from the timer can throw, and nothing catches it.
  - `flush` runs from the clock's timer and calls `events.update` without a try. A SQLite throw kills the daemon: the database closed during a stop, or `SQLITE_FULL`.
  - The kernel clock calls `fn()` bare, and the daemon has no `uncaughtException` handler.
  - The synchronous path is still guarded by `vm-listener.ts:121-133`, but the sink's "never throws" no longer holds on the timer path.
  - Fix: wrap `flush` in a try and log.
- **Minor, `apps/daemon/src/compose-agents-vm.ts:259-264`.** The launch now goes on after a start hook throws.
  - `onLaunch` now swallows a throw of `relay.grant` or `proxy.launched`. Before, the throw went to `runtime.ts:200`, and the launch was torn down with a visible error.
  - It still fails closed: the relay answers 403, and the proxy answers `unknown_source`. But the agent starts half-wired and fails later, with a less clear error.
  - Suggest: keep `eachOwnTry` for the launch end; for the start, run all steps, then rethrow the first error.
- **Minor, `packages/contracts/src/host-covers.ts:4-10`.** The `coversByName` fallback still lets `*.x` cover the exact `a.x`, which contradicts AVM2-E12. It runs only when an entry does not parse as a host entry. `AgentInput`, `PolicySettings` and the server validate every entry, so no real input reaches it today.
- **Minor, `egress-refusals.ts:69-80`.** The `suppressed` total is written only on the next line logged for the same agent and event. A burst that stops never logs its total. The in-memory count not yet flushed (up to 60 s) is also lost on a daemon restart.
- **Minor, `policy.ts:259` and `pi-host/src/policy/egress.ts:96-126`.** The host-mode schemas are wider now.
  - Case: an agent saved in VM mode with an IP or `host:port` entry, then run with `PAP_AGENTS_RUNTIME=host`. `checkHostEntries` runs only at save.
  - Before, its rules failed `PolicyRules`, and the session fell back to read-only.
  - Now the rules load, and the host-mode URL stage lets URL tools fetch that IP, or that `host:port`, directly from the host worker.
  - The host-mode proxy still refuses both (IP literal, and a port entry never equals a name), so the shell is unaffected.
  - The owner listed the entry under step-up, so the risk is low. A one-line doc note or a host-mode filter would close it.
- **Minor (process), `202610211200_agent_events_egress.sql`.** The file was edited after its first version. The runner refuses a DB whose applied checksum differs (`migrate.ts:110-113`). Part A is unreleased, so only dev `PAP_HOME`s of this branch are affected; reset them before running it.

### Out-of-Scope Observations

- `apps/daemon/src/modules/agents/permissions.ts:74,101`: the sheet's `egress` is "proxied" only if `input.sandbox.required` is on and the host's `sandboxUsable()` passes. A VM agent stored with `required: false`, or a host without bwrap, reads "off" while its VM shell has network. The exfiltration flag still turns on (`effective !== "on"`), but the egress line is wrong. The sheet was never VM-aware; C2 makes the gap visible.
- A VM agent whose stored `sandbox.network: true` was ignored under SP1/R15 gets shell network at upgrade, with no new step-up. This covers API-created agents and test beds; the form's default is `false`. The owner did approve "network on" when it was set. List the preview's VM agents with network on before deploying.
- The shell's network is fixed when the session opens (A3, deferred and documented), and that is now live. Turning the network off does not reach the running worker's shell until a new session, and its results keep tainting.
- `packages/pi-host/src/policy/stage-approval.ts:175`: the AVM-E20 comment still says the VM shell runs "with no network".
- `vm-listener` `scopeOf` still reads the profile (`hostsOf`) once per refusal. The verdict's optional per-VM token bucket was not built. These are reads, not writes, and the brief did not require it.
- `agentVm.sandboxNote` says "the hosts on this agent's list". For an agent on the owner's list, these are the owner's hosts. This is a copy nit only.

### Verdict: all findings addressed and no new Critical/Important — yes

---

<!-- final-B-verdict.md -->
# Final review, Part B (agent files): 1d20746f..ab4302e5

Reviewer: Opus, final review of Part B (B1-B4, after the rebase on main with Part A). Primary view: `final-B-review-package.diff`; checkout `.worktrees/feat-avm2-b` read-only. Focused runs: 8 unit files (agent-files, deliver-files, home-files, egress-refusals, host-covers, agents.autonomy, trash, AgentFiles): 109 passed. Purge misparse reproduced with a scratch script against `createAgentFiles` (temp dir only).

### Strengths

- **The guest writer is right** (`packages/pi-host/src/home-files.ts`).
  - The home is opened with O_NOFOLLOW. Each folder is then opened from its parent's descriptor (`openDirAt`, O_NOFOLLOW | O_DIRECTORY, made 0700).
  - The part file is created with O_EXCL | O_NOFOLLOW (plus O_NONBLOCK and an `fstat` isFile check).
  - The rename happens inside the opened folder, and `unlinkAt` removes a link, never its target.
  - The path is checked again against `AgentFilePath`.
  - The mutants H1-H3 were killed for real.
  - The two doubts left open at B2 are now settled from the code:
    - The VM shell sees `/agent` as a tmpfs with only the home bind-mounted (`vm-shell/argv.ts:70-72`), so the agent cannot swap `/agent/home` itself.
    - The shell runs as guest root like the worker (`agents-vm.md:36`), so "owned by the agent's user" holds. The Kata test's `head -n 1` from the shell checks it.
- **The host store** (`agent-files.ts`, `kernel/fs/private-write.ts`):
  - every entry point validates `AgentId` and `AgentFilePath`;
  - folders are checked level by level, and a link is refused;
  - writes go to a temporary file (O_EXCL | O_NOFOLLOW), are fsynced, then renamed;
  - the count and size caps are checked synchronously, so two in-flight imports cannot race past them;
  - pending removals are kept 0600 and survive a restart;
  - logs carry only the error code (`errorClass`), never a path or a byte.
  - The `claude-token.ts` refactor onto the shared helper keeps its behaviour.
- **The HTTP route** (`agent-files-http.ts`) works like `PUT /files/raw`:
  - it is cookie-only, and a bearer gets 401;
  - it needs `agents:admin`, and the app's Origin guard covers CSRF;
  - owner, query and declared length are all checked before a byte is read;
  - the body is counted as it streams, an early refusal closes the connection, and 2 imports may be in flight per owner;
  - every refusal has an int test.
- **Delivery** (`deliver-files.ts`) after the B2 fix round:
  - removals go first;
  - a refused frame is only counted;
  - one per-agent queue serialises start and live delivery, and each run reads the store when it runs;
  - only removals the thread VM answered `ok` are confirmed;
  - the timeout runs on the Clock.
  - The process-backend int tests cover the brief's four scenarios. "Removal while stopped" plants a stale copy, so it proves a real delete.
- **Backup.** The plain backup excludes the files, and the test asserts that the content bytes are absent. An encrypted backup with secrets included carries them.
- **Delete.** A delete moves the files to their trash, in host mode too, and a failed move leaves the agent whole for a retry (tested).
- **The rebase is clean.** In all six conflict files (compose-m11 + types, daemon.ts, agent-vm/index.ts, AgentScreen.tsx, the i18n registration) the diff against 1d20746f only adds lines. Part A's `bindLate({...m11.vmLate})`, `AgentScreenParts` and the egress catalog are intact. `compose-agents-vm.ts` only moves one import and adds its own lines.
- **The Part A carries (a)-(d) are done with RED/GREEN.** AVM2-E12 now holds in both branches of `covers` (parsed entries and the name-only fallback), and `widensReach` and the refusal dialog both go through it.
- **UI.**
  - It uses tokens and primitives (`variant`/`size`), and the FR catalog is typed against EN, so a missing key fails the build.
  - File content is never read; a file over 1 MiB is refused before upload, and a stale list answer is dropped.
  - REMOVE asks first, with "Keep" not styled as danger.
- **The docs are honest** about what matters:
  - the agent can read and send its files, so scope the credential at its source;
  - a restore leaves the VM's copy in place;
  - there is no step-up.
- No AI attribution in any commit. Every file is 400 lines or fewer (largest: `compose-agents-vm.ts` and `daemon.ts`, 396).

### Issues

#### Critical

None.

#### Important

1. **A change made while the thread VM runs with no worker is never applied, and the next worker in that VM does not get it.**
   - **Where:** `deliver-files.ts:139-148` (`live`: `if (handle === undefined) return;`), `runtime.ts:263` (`entry.files ??= deliver(...)`, once per VM entry), `runtime.ts:257` (an exiting worker leaves the set) and `runtime.ts:272-276` (`threadWorker`).
   - **Why:** the VM's idle stop uses `workerIdleMs` (`compose-agents-vm.ts:260`). After every last worker exits, the VM stays `running` with no worker for 30 minutes by default, and for ever with `PAP_WORKER_IDLE_MINUTES=0`. A worker can also be released and restarted before the next prompt.
   - **Result in that window:**
     - A remove or import finds no thread worker, so it is skipped and stays pending.
     - The next prompt spawns a worker in the same running VM. `entry.files` is already settled, so nothing is delivered.
     - The revoked kubeconfig stays in the home and the agent uses it. Likewise, a newly imported file is missing for that run.
     - Only a later VM restart heals it. Meanwhile the Files tab shows the file as removed, and the docs (`agents-vm.md:104`) and the tab hint say a change "reaches a running thread VM at once".
     - A failed live delivery (the worker left mid-exchange) has the same fate.
   - **Fix:** keep a per-agent "dirty" mark in `createFilesDelivery`. Set it when `live` finds no worker or fails. Have the runtime offer every new worker of a VM to the delivery: deliver when the VM has not had its start delivery yet, or when the agent is dirty, and clear the mark on success. This also covers the deferred "failed start delivery retried only on a new worker".
   - **Test:** worker 1 is delivered and exits; `remove`; worker 2 spawns in the same running VM; the removal is sent and confirmed.

2. **Quarantine never shows the file paths to the owner (plan defect).**
   - **Where:** `apps/web/src/features/agents/QuarantineDialog.tsx:118-150`. `Outcome` renders `vaultNames` but not `filePaths`. The intro step list (`STEPS`, line 16) also does not mention the files.
   - **Why:** spec §7 says "its report lists the file paths, the way it lists vault names, so the owner can revoke at the source". The daemon fills `filePaths`, but the owner never sees it, at exactly the moment they need to rotate credentials. `agents-vm.md:104` claims the paths are listed. No task owned the dialog: B1 added the field and B3 the tab.
   - **Fix:**
     - Render `result.filePaths` like the vault names: an EN/FR line in the spirit of "Revoke these at their source: {paths}", in mono.
     - Add an `agentSafety.q.step.files` intro line.
     - Add a QuarantineDialog test.

3. **"Purge now" misparses some agents' files trash.**
   - **Where:** `agent-files.ts:26`, `TRASH_ENTRY = /^(.+?-[0-9a-f]{4})-(\d+)(?:-\d+)?$/` (used at :292 and :305).
   - **How it fails:** with a lazy prefix and `\d+`, an id whose slug ends in a 4-hex segment and whose random suffix is all digits is split wrongly. For example, `release-2024-1234` (an agent named "Release 2024", about 15% of suffixes) splits as id `release-2024`, stamp `1234`. Reproduced:
     - `purgeTrash("release-2024-1234")` deletes nothing, so the kubeconfig stays on disk until the next daily sweep, which then deletes it at once because "1234" looks ancient;
     - `purgeTrash("release-2024")` deletes the other agent's trashed files too.
   - Years and hex-looking words make this realistic. `trash.ts:12/83` already uses the robust form.
   - **Fix:**
     - Use `/^(.+)-(\d{10,16})(?:-\d+)?$/`.
     - In `purgeTrash`, also require `AgentId.safeParse(match[1])` and an exact match.
     - Add a test with both ids above.

4. **The Kata test's removal leg cannot fail for the reason it claims.**
   - **Where:** `egress.kata.int.test.ts:259-293`, and the header lines 14-16.
   - **Why:** `agents.files.remove` is called right after `look()`, while the thread VM and its worker are live. The live path deletes the file and confirms it, and then `restart()` finds nothing pending.
   - **Effect:**
     - The mutant "the pending removal not kept for a stopped VM" survives.
     - Review Focus 5 (removal while stopped, on the real persistent disk, which is the case that matters on Kata) is not exercised.
     - The test has never run, and its single run needs a root window, so this should be fixed before that window.
   - **Fix:**
     - Stop the VM first, then remove, then `sessions.reopen` and look for "FILE gone".
     - Optionally keep a separate live leg: remove while running, look without a restart.

#### Minor

1. **`remove()` unlinks before it persists the pending removal** (`agent-files.ts:218-231`). If writing `.removals/<id>.json` fails (disk full, EIO), the store copy is gone, the VM never hears of it and no audit row is written. The UI then says the files "are as they were", but the list no longer shows the file. Fix: save the pending removal first, then unlink. If the unlink fails, a pending removal with the file still present is harmless: a start removes the file, then puts it again.
2. **In host mode the files trash is never purged or swept.**
   - `composeAgentsLink` and `startTrashSweep` exist only in vm mode (`compose-agents-vm.ts:154`, `:317`), and `trash-purge.ts:28` answers `sandbox_unavailable` in host mode.
   - Yet `PUT /agent-files` and `deleteVmStep(..., files)` work in host mode, for example with files left after a switch back from vm, or imported through the API.
   - Trashed credentials then stay for ever, while the docs say 7 days.
   - Fix: sweep and purge the files trash from the agents module's own path, or refuse imports in host mode (see "Declined to judge").
3. **The first frame's 30 s timeout includes the worker's session open.**
   - The start delivery sends its first frame before the worker's `ready`; the frames wait in the early buffer (`host.ts:280`). Its 30 s timer (`deliver-files.ts:46`) therefore includes `openSession`.
   - If an open takes longer, the VM's delivery fails and is retried only by a later worker. A webhook task VM has one worker, so it never gets its files.
   - Fix: start the delivery on the worker's `ready`. This fixes the deferred race "first prompt before files land" as well.
4. **The removal copy promises more than it does.**
   - `agentFiles.remove.ask` says "the file leaves the VM", and `agentFiles.hint` says "at once while the VM runs". In fact a stopped VM gets the removal at its next start, a task VM at the next task, a parent link the agent planted makes it fail for ever, and a copy the agent made stays.
   - Suggested copy: "pap deletes its copy and removes the file from the VM's home (at once in a running thread VM, else at its next start). A copy the agent made stays: revoke the credential at its source." Update `agents-vm.md:104` with Important 1.
5. **`PUT /agent-files` ignores read-only mode** (`agent-files-http.ts:23-46`). In read-only mode the file is written and the live delivery fires; only then does the audit append throw, and the route answers 503 `read_only` while the UI says nothing changed. `/files/raw` refuses first (`upload-http.ts:48`); do the same here, with `core.readOnly`.
6. **Host-side consistency.**
   - `remove()` lstats and unlinks through the joined path (`agent-files.ts:210-219`), so a link planted as the agent's folder is followed there, while `put` refuses it.
   - A raw `rmSync` error from `purgeTrash`, whose message holds the file's path, reaches `agent_trash_purge_failed` (`trash-purge.ts:35`). That contradicts "nothing here logs a path".
   - Only a same-user process could plant such a link, so this is hygiene: check the agent folder with `lstat` in `remove`, and wrap `purgeTrash`'s `rmSync` the way `sweepTrash` is wrapped.
7. **A test name promises a case it does not test.** `agent-files-http.int.test.ts:162` is titled "... and 409 when a folder is in the way", but it tests only the 32-file cap.
8. **`refuse()` has no `internal` entry** (`upload-http.ts:13-30`), so a refused planted link answers HTTP 400 with code `internal`. Map it to 500.
9. **Docs nits.**
   - `agents-vm.md:111` says "Purge now" removes "the disk and mirrors". It removes the files trash too, as the Files section says (line 105).
   - Line 102 says each audit row carries "path and size", but a removal row has no size.
10. **A put racing a delete leaves a live orphan folder.** The window is between `files.dispose` (`vm-steps.ts:18`) and the removal of the row. `owns` still passes, so `agent-files/<id>/` is created again live, and nothing sweeps it. This is rare. Check `inTrash`, or take the agent's lock in the service.
11. **a11y nit.** The actions column header is `<td />` inside `<thead>` (`AgentFiles.tsx:140`), and an `h3` is styled `text-h2`.

### Deferred minors triage (ledger)

| Item | Decision |
|---|---|
| B1: quarantine only lists paths, no removal | Keep (spec §7) |
| B1/B3: no step-up on import or remove | Keep deferred: documented known limit (see Declined) |
| B1: `filePaths` not shown in the dialog | **Fix before merge** (Important 2) |
| B1: full gate not re-run after the last edits | Closed: superseded by B4's gate at head |
| B2: first prompt may run before files land (fire-and-forget) | Keep deferred and documented; best fixed with Minor 3 (deliver on `ready`) |
| B2: `finish` `closeSync` outside the try (`home-files.ts:113`) | Keep deferred (a regular-file close practically never throws); fold in at the next home-files touch |
| B2: a live change reads every file's bytes | Keep deferred (bounded: 32 MiB per change) |
| B2: `exited.then` closures pile up per delivery | Keep deferred (tiny, bounded by worker lifetime) |
| B2: a failed start delivery is retried only by a new worker | **Fix with Important 1** (same mechanism) |
| B2: test weaknesses (int :61 early assert, microtask negative, `runtime.files.test.ts` "is logged" never checks the log) | Keep deferred |
| B2: process gaps (no RED for two files) | Closed (B2 review) |
| B2: `compose-agents-vm.ts` at 394, now 396/400 | Keep deferred; the Important 1 fix belongs in `deliver-files.ts`/`runtime.ts`, not there |
| B2: multi-chunk path unreachable; a stale `.part` never swept | Keep deferred |
| B2 fix1: `run()` finally lets a throwing `delivered` mask the error | Keep deferred |
| B2 fix1: a task VM start shares the per-agent queue (up to 30 s per frame) | Keep deferred |
| B2 "cannot verify": agent's user, and `/agent` writable by the agent | Closed: the shell runs as guest root, and its `/agent` is a tmpfs (`argv.ts:70-72`) |
| AVM2-E9: live apply reaches the thread VM only | Ruling; keep |
| B3: `AgentScreen.tsx` 397/400 | Closed: 311 after the rebase |
| B3: VM status read once per mount | Keep deferred (documented) |
| B3: never seen in a browser | Keep deferred; one look on the preview after merge (podman Playwright or the owner) |
| B4: E12 fallback behaviour change | Closed: intended by AVM2-E12, confirmed consistent |
| B4: Kata file unrun | **Fix Important 4 first**, then run it in the root window (AVM2-E2) |
| B4: suppressed totals now logged by the timer | Closed (correct; double counting ruled out) |
| Part A carried to B4, (a) to (d) (ledger line 79) | Closed: verified in `egress-refusals.ts`, `host-covers.ts`, `stage-approval.ts:175` |
| Part A deferred (ledger line 80) | Keep deferred: Part A scope, already merged |

### Declined to judge

- No step-up on import or remove: spec §7 asks only for `agents:admin` and browser-only. The plan gives none, the docs list it as a known limit, and the owner's "simple and fast" applies. (The Claude token setter does ask for a step-up; whether files should too is the owner's call.)
- Live apply to a running task VM: settled by ruling AVM2-E9.
- Whether the daemon should refuse imports for host-mode agents: the spec only says the tab is VM-only. Minor 2 covers what follows from accepting them.
- Records named `home_put`/`home_remove` instead of the spec's `file_put` target and `file_remove`, and a separate route instead of "the existing attachment path": both are builder latitude (§10). The route reuses that path's body, cap and in-flight helpers.
- An agent copying a credential before its removal: inherent to "credentials live in the VM"; the docs say to scope at the source.
- Kata behaviour itself: never run, per AVM2-E2. I judged the test only by reading it.
- Full `test:unit`/`test:int`: not run, per AVM2-E1; only focused files.
- Visual fidelity of the Files tab: headless host, not rendered.

### Assessment

**Ready to merge:** With fixes

**Reasoning:** The security core holds:
- the guest writer never follows a link;
- the host store is validated and private;
- the import route has the same auth, CSRF and cap as `PUT /files/raw`;
- the plain backup excludes the files;
- the rebase kept every Part A behaviour.

Four small, contained Important fixes remain:
- a change made while the VM has no worker is lost until a restart;
- quarantine never shows the file paths;
- the purge regex misparses some ids;
- the Kata removal leg is vacuous.

They should land, with one scoped re-review, before the Kata root window and the merge.

---

<!-- final-B-reverify.md -->
### Finding Verdicts
- I1 ADDRESSED: deliver-files.ts:~139-170 (dirty set, `again`, live marks dirty on no worker / failure), runtime.ts:~263-272 (deliverAgain for later workers), compose-agents-vm.ts:126. RED/GREEN named (4 failed, then 21 passed).
- I2 ADDRESSED: QuarantineDialog.tsx (STEPS "files", filePaths line), catalog EN+FR. RED 1 / GREEN 18.
- I3 ADDRESSED: agent-files.ts:285 regex `^(.+)-(\d{10,16})(?:-\d+)?$` (same as trash.ts), purge also AgentId.safeParse; tests release-2024 vs release-2024-1234. RED/GREEN named.
- I4 ADDRESSED (not run, kata forbidden): egress.kata.int.test.ts stops the VM before remove, then reopens.
- Minor remove() order ADDRESSED: agent-files.ts:~307-310 savePending before unlink; test with read-only .removals.
- Minor host-mode sweep ADDRESSED: files-sweep.ts, wired compose-agents-vm-rpc.ts:96, closer daemon.ts:152.

### New Breakage in the Fix Diff
- None Critical/Important.
- Minor: `dirty` entries for deleted agents are never cleared (tiny leak). A failed `start` marks dirty, but the runtime also resets entry.files and retries via start, so no loop; `again` fires once per spawned worker only.
- Checked: stamps are written as `${agentId}-${stamp}` from the clock ms (13 digits), so 13-digit test stamps match disk reality; old small stamps were test-only. Greedy regex resolves `<id>-<stamp>-<n>` correctly. Host-mode sweep only removes matching entries in agent-files/.trash older than 7 days; non-matching names are kept.

### Out-of-Scope Observations
- Kata test not run; Part A/other Minors deferred as stated in the report.

### Verdict: all findings addressed and no new Critical/Important — yes
