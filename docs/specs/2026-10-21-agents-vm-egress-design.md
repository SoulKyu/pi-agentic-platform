# Agents in microVMs, sub-project 2: network for the VM and agent files

Date 2026-10-21. Status: design, brainstormed with the owner on 2026-10-21 (mockups `docs/architecture/agents-vm/06-egress-files-mockups.html`). Builds on sub-project 1 (spec `docs/specs/2026-10-19-agents-microvm-runtime-design.md`, ADR 0078, `docs/agents/agents-vm.md`). ADR to write with the plan: 0079, amending decision 106 (credentials in the VM, no injection). The owner wants this sub-project **simple and fast**: no new dependency, reuse what exists, no extra mechanism "for later".

Calls the controller made without the owner are marked *(controller's call)*.

## 1. Goal

A VM agent gets network through a simple filtering proxy, and the owner can put files (credentials, configs) in its home from pap. Target use cases, in the owner's words: error handling on a Kubernetes cluster through MCP, reading mail through the Google API, an Alertmanager webhook that the agent answers. The agent **diagnoses**; it does not fix. With this, a coding agent works on its own in its VM: it clones over https, installs dependencies, builds, tests, pushes with a token file the owner imported, without approval cards.

## 2. Decisions

From the owner:

- **A simple proxy, "comme tinyproxy"**: it filters by host and port, reads no content, decrypts no TLS, injects nothing. The earlier plan for sub-project 2 (vault values bound to hosts, credential injection, grants) is dropped.
- **Credentials live in the VM.** Each agent holds its own credentials, scoped at the source (a read-only Kubernetes RBAC service account, an OAuth `gmail.readonly` scope). pap does not re-implement the remote system's permissions. This amends decision 106's "zero credentials in the VM" for the agent's own credentials; provider keys and the Claude token stay with the relay, as in sub-project 1.
- **Files imported from pap into the agent's home**, in a **Files tab** of the agent screen (mockup option 3A).
- **A refused host shows a card in the agent's thread** (mockup option 2C). Its button opens a dialog that explains the refusal and adds the host to the agent's list in one action.
- Inbound: webhooks to agents already exist (M10 triggers, `secret` or `hmac`, format `alertmanager`); nothing changes.
- UI follows `DESIGN.md`.

Non-goals: credential injection; TLS inspection; per-method rules (read-only is the remote system's job); non-HTTP protocols (`git` over ssh, database ports); `apt install` at run time (the VM root is read-only; system packages stay in the agent config and its image, decision 108); any change to the image (the use cases' tools come from the agent's system packages, or the agent installs them in its home through the proxy: `npx`, `pip --user`, a static binary); any change to host mode; the default switch to VM mode (sub-project 3).

Anti-goals: an approval card for network inside the VM; a new proxy dependency (tinyproxy, Squid, Envoy) or a second proxy implementation when pap's M11 proxy already does the job.

## 3. The proxy

- **Implementation** *(controller's call)*: pap's existing egress proxy (`apps/daemon/src/modules/egress/`, ADR 0047), with its host matching, DNS pinning (the address it checked is the one it connects to) and per-agent counts, gets one TCP listener on `10.213.0.1:7843` on `pap0`. pap-vmd's nftables rules gain this port, next to 7841 and 7842 (sub-project 1 §network already says "sub-project 2 adds the proxy port"). It speaks HTTP `CONNECT` and plain HTTP forward requests, the way tinyproxy does.
- **Who is asking** *(controller's call)*: the VM's source address alone, mapped to its running launch. pap-vmd's per-VM anti-spoofing guard (R22, `apps/vmd/src/net.ts`) already pins each VM's bridge port to its address, so no credential rides in the proxy URL (the shell would inherit it, and many clients drop proxy userinfo). An address with no running launch is refused.
- **The rule**: the request's host and port must match the agent's host list (§4). A match opens the tunnel; anything else answers `403` with a one-line reason the client prints, plus a log line and a count.
- **Addresses always refused**, whatever the list says: loopback, link-local (including `169.254.169.254`), the `pap0` subnet, every address of the host itself, multicast and unspecified addresses. Private ranges (RFC 1918, ULA) are allowed only for an exact entry or an IP entry, never through a `*.` wildcard *(controller's call: a wildcard's subdomains can be pointed at the LAN by someone else's DNS)*.
- **Inside the VM** *(controller's call)*: the guest sets `HTTP_PROXY`, `HTTPS_PROXY` (and lower-case forms) to the proxy, and `NO_PROXY` to `llm.internal`, `claude.internal`, the gateway and loopback. These apply to the workers, Pi and its extensions (pi-web-access), MCP servers and the shell. Node's `fetch` follows them only with `NODE_USE_ENV_PROXY=1`; the builder checks this on the image's Node. The shell keeps bwrap and seccomp but gets the VM's network instead of `--unshare-net` when the agent's `sandbox.network` is on. The VM's nftables rules already limit that network to the gateway, the relay and the proxy. The builder verifies that the shell still cannot read the gateway token or the relay credential.
- **Counting and logs**: per agent, every 60 s, requests, bytes up and down and refusals, as the relay reports. Hosts in logs follow the existing rule: as written when the owner wrote them, else `h:<12 hex> (len N)` (W5-R54).

## 4. The host list

- One list per agent: the existing `allowHosts` (`null` means the owner's own list from Settings › Approvals, as today). The agent form is unchanged except for the hint text. Stored entries keep their meaning (no port: 80 and 443); no data migration.
- **Grammar** *(controller's call)*: an entry becomes `host[:port]`, where the host is a name (with an optional leading `*.`, as today) or an IPv4 or IPv6 literal (IPv6 in brackets when a port follows). No port means 80 and 443. Kubeconfigs often name the API server by IP (`https://192.168.1.40:6443`), so IP entries are needed.
- Host mode keeps its own proxy and its rules (80 and 443, public addresses only). While pap runs in host mode, the daemon refuses an entry with a port or an IP with a field error saying it needs VM mode *(controller's call: a silent no-match would mislead)*. The widening check (`widensReach`, step-up) applies to ports and IPs too.

## 5. Approvals in the VM

*(controller's call; it closes the CyberLooker report.)* Inside the VM, a shell command that uses the network is judged like an edit of the agent's own folder: no approval card, tainted or not. The host list is the only barrier at the exit. Taint is still recorded and shown (the "external content" chip), so the owner still sees that the run read outside content. Platform ops keep their own rules (callers, `whenTainted`).

## 6. A refused host

- **Card in the agent's thread**: an EventCard. It is a platform event, so it has a solid frame, with an attention chip `BLOCKED`. It reads: "@KubeDoc could not reach `prometheus.lan:9090`: it is not in its host list. Nothing left the VM." The card has one button, "Add…".
- **Also**: one Inbox item and one push notification. At most one card, Inbox item and push per agent and host:port per hour; later refusals in that hour only raise the card's count.
- **Dialog** (Dialog primitive, `--shadow-overlay`, Escape and focus trap). It shows:
  - the host and port in mono;
  - the attempts, with count, last time and the VM that made them: "thread" for the agent's VM (its thread, children and thread tasks share it), the task's name for a task VM. The proxy sees only the VM, so nothing finer *(controller's call)*;
  - when the address is private, a line with the address and "this name comes from the agent; add it only if you know it";
  - the scope, "for this agent only, from its next request".

  Buttons: `CLOSE` (secondary) and `ADD TO LIST` (primary). Adding widens the agent's reach, so it asks the step-up the agent form already asks. When the agent uses the owner's list (`allowHosts: null`), the add gives this agent its own list: a copy of the owner's list plus the new entry, and the dialog says so. The owner's shared list and the other agents are untouched *(controller's call: keeps "this agent only" true)*.
- After the add, the agent is not told and nothing is retried; the agent or the owner retries.

## 7. Agent files

- **Files tab**: Thread / Files / Settings on the agent screen. A table lists the path in the home (mono), the size (tabular figures) and the import date, with `REPLACE` (secondary) and `REMOVE` (danger: it is irreversible). Below the table: a path field, `CHOOSE FILE`, `IMPORT` (primary). With no file, an EmptyState: dashed frame, one sentence, one primary action. A file's content is never shown, only its path, size and date (DESIGN.md §11, secrets).
- **Rules**: the path is relative to `/agent/home`, has no `..`, and does not start with `/`. A file is at most 1 MiB. An agent has at most 32 files *(controller's call)*.
- **Storage**: pap keeps each file host-side, 0600, under `$PAP_HOME/secrets/`. A plain backup therefore excludes them, like the vault; an encrypted backup with `--secrets include` keeps them.
- **Delivery**: at every VM start (the thread's VM and every task VM, including the blank-disk VM of a webhook task), pap writes each file to its path, mode 0600, owned by the agent's user. It reuses sub-project 1's `file_put` channel and its rule of opening without following links. pap's copy wins: a file the agent changed is overwritten at the next start. Other files in the home are never touched.
- **Changes while the VM runs** *(controller's call)*: an import, replace or remove applies at once to a running VM, through its live worker, and otherwise at the next start. `file_put` already runs mid-run (attachments); it gains a target path under `/agent/home` beside `/agent/inbox`. One new record, `file_remove`, deletes a path, since revoking a credential must work. `REPLACE` is an import to the same path.
- **Agent deleted**: its files go to the agent trash with its disk and are purged with it. **Quarantine**: its report lists the file paths, the way it lists vault names, so the owner can revoke at the source.
- Methods: `agents:admin`, browser only (never a token), like the agent form. Uploads go through the existing attachment path with its size bound.

## 8. UI and copy

DESIGN.md applies: tokens only, the listed primitives (Tabs, Table rows, Button variants, Dialog, EventCard, Chip, EmptyState), mono uppercase button labels, English and French strings, and the error pattern "what happened, what is intact, what you can do". The mockups' colours are not Night Control; DESIGN.md's palette and components win.

## 9. Tests

- Unit and integration tests run on the process backend (`PAP_TEST_AGENT_RUNTIME=process`) with the egress test seams (`modules/egress/testing/`, loopback listeners only, no public host or address). They cover:
  - match and refusal by host, port, wildcard and IP;
  - the always-refused addresses;
  - private addresses allowed for an exact entry and refused through a wildcard;
  - the hourly dedupe;
  - the add-from-dialog flow with step-up;
  - the file rules (path, size, count, no following of links);
  - delivery to a task VM;
  - removal reaching a running VM.
- One Kata test, run locally (AVM-E66): from inside a VM, an allowed request passes through the proxy and a refused one gets the 403. Also: the shell reaches only the proxy, and an imported file is present with mode 0600 after a restart.

## 10. Left to the builder

Module layout, method names, the refusal event's record shape, the 403 body, the storage layout under `secrets/`, how the guest receives the proxy settings, and how the dedupe stores its state.

Docs to update: `docs/agents/agents-vm.md` ("What a VM agent cannot do yet" shrinks, plus new "Network" and "Files" sections), `docs/agents/agents.md` (the VM pointer), ADR 0079, and the decisions log.
