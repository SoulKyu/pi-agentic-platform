# Architecture decision records

One file per decision, numbered. A decision that deviates from a spec or changes a rule gets an ADR; the first line after the title is `Status:` and starts with `accepted` or `superseded by NNNN`.

Next free number: 0086

Dates come from the ADR's Date line; where it has none, the date of the file's first commit.

Numbers marked "not used" were skipped and stay empty.

| No.  | Title | Status | Date |
| ---- | ----- | ------ | ---- |
| 0001 | [the `init` and `extension_ui_closed` records of the daemon ⇄ pi-host protocol](0001-pi-host-boot-and-closed-records.md) | accepted | 2026-10-10 |
| 0002 | [pap-policy evaluates the final tool input](0002-policy-evaluated-last.md) | accepted | 2026-10-10 |
| 0003 | [event frames carry an epoch](0003-event-frames-carry-an-epoch.md) | accepted | 2026-10-10 |
| 0004 | [the session cookie omits Secure on plain-http loopback](0004-loopback-http-cookie-without-secure.md) | accepted | 2026-10-10 |
| 0005 | [a session has its own id; Pi's file is attached once it exists](0005-session-identity-before-pi-writes-its-file.md) | accepted | 2026-10-10 |
| 0006 | [exported transcripts are served by a download route](0006-session-export-download-route.md) | accepted | 2026-10-11 |
| 0007 | [a hot session's transcript is read from Pi's file with the worker's leaf](0007-hot-session-reads-from-the-pi-file.md) | accepted | 2026-10-11 |
| 0008 | [pap records added to the daemon ⇄ pi-host protocol in M2](0008-pap-records-added-in-m2.md) | accepted | 2026-10-11 |
| 0009 | [forks and clones are written by the daemon, as new files only](0009-daemon-side-fork-and-clone.md) | accepted | 2026-10-11 |
| 0010 | [Collapsible joins the primitives](0010-collapsible-primitive.md) | accepted | 2026-10-11 |
| 0011 | [/dev/ui is not shipped; unknown routes show the not-found screen](0011-dev-ui-not-shipped.md) | accepted | 2026-10-11 |
| 0012 | [contrast amendments to DESIGN.md (R120)](0012-r120-contrast-amendment.md) | accepted | 2026-10-11 |
| 0013 | [The search index is a cache file of its own, queried in a worker thread](0013-search-index-cache-file.md) | accepted | 2026-10-12 |
| 0014 | not used | n/a | n/a |
| 0015 | not used | n/a | n/a |
| 0016 | not used | n/a | n/a |
| 0017 | not used | n/a | n/a |
| 0018 | not used | n/a | n/a |
| 0019 | not used | n/a | n/a |
| 0020 | [Taint is sticky per session](0020-sticky-taint.md) | accepted (amended by 0047) | 2026-10-13 |
| 0021 | [Bearer tokens on `/ws` without Origin; step-up confirmation](0021-bearer-tokens-and-step-up.md) | accepted | 2026-10-13 |
| 0022 | [The audit row is the judged event, with its stage verdicts](0022-audit-trail-rows.md) | accepted | 2026-10-13 |
| 0023 | [Pi configuration work runs in a short-lived helper process](0023-pi-config-helper.md) | accepted | 2026-10-13 |
| 0024 | [Read-only shell commands run unasked, "always" rules can cover a prefix or a tool](0024-read-only-commands-and-pattern-rules.md) | accepted | 2026-10-13 |
| 0025 | [MCP settings without SDK internals](0025-mcp-settings-without-sdk-internals.md) | accepted | 2026-10-14 |
| 0026 | [a masked editor for models.json](0026-models-json-masked-editor.md) | accepted | 2026-10-14 |
| 0027 | [project trust from pap](0027-project-trust-from-pap.md) | accepted | 2026-10-14 |
| 0028 | [tool presets, Chat only and the read-only preset rule](0028-tool-presets.md) | accepted | 2026-10-14 |
| 0029 | [Some Pi settings are written by Pi's SettingsManager, behind pap's queue and guard](0029-settings-written-through-settingsmanager.md) | accepted | 2026-10-14 |
| 0030 | [The composer keeps plain text: `@` mentions are text, `$skill` is Pi's `/skill:name`](0030-composer-text-mentions.md) | accepted | 2026-10-14 |
| 0031 | [File routes by query path, cookie-only HTTP, uploads with reservations, attachments claimed per session](0031-file-routes-and-attachments.md) | accepted | 2026-10-14 |
| 0032 | [The `vcs` stream is keyed by project root and polls while somebody watches](0032-vcs-stream-by-root.md) | accepted | 2026-10-14 |
| 0033 | [Lane worktrees live under `$PAP_HOME/worktrees`, created in two phases](0033-lane-worktrees-under-pap-home.md) | accepted | 2026-10-14 |
| 0034 | [Lane scripts are trusted by the hash of their text, in pap's own table, and run from the browser only](0034-lane-scripts-trusted-by-hash.md) | accepted | 2026-10-14 |
| 0035 | [Lane effects are kept in their own rows until the outbox exists](0035-lane-effects-without-the-outbox.md) | accepted | 2026-10-14 |
| 0036 | [Forges are reached through their own CLIs, GitHub only in M9](0036-forges-through-their-clis.md) | accepted | 2026-10-14 |
| 0037 | not used | n/a | n/a |
| 0038 | not used | n/a | n/a |
| 0039 | not used | n/a | n/a |
| 0040 | [the outbox in the kernel, replay classes and recovery first](0040-outbox-in-the-kernel.md) | accepted | 2026-10-15 |
| 0041 | [automation runs before agents](0041-automation-before-agents.md) | accepted | 2026-10-15 |
| 0042 | [webhook authentication](0042-webhook-authentication.md) | accepted | 2026-10-15 |
| 0043 | [the runs registry and cost](0043-runs-registry-and-cost.md) | accepted | 2026-10-15 |
| 0044 | [observability](0044-observability.md) | accepted | 2026-10-15 |
| 0045 | [quota limits and auto-resume](0045-quota-limits-and-auto-resume.md) | accepted | 2026-10-15 |
| 0046 | [feeds and the precheck without a sandbox](0046-feeds-and-precheck-without-sandbox.md) | accepted | 2026-10-15 |
| 0047 | [platform calls and session types](0047-platform-calls-and-session-types.md) | accepted | 2026-10-16 |
| 0048 | [the agent sandbox](0048-the-agent-sandbox.md) | superseded by 0081 | 2026-10-16 |
| 0049 | [the vault and secret requests](0049-the-vault-and-secret-requests.md) | accepted | 2026-10-16 |
| 0050 | [agents](0050-agents.md) | accepted | 2026-10-16 |
| 0051 | [agents in the Inbox](0051-agents-in-the-inbox.md) | accepted | 2026-10-16 |
| 0052 | [memory through pi-mem0's file contract](0052-memory-through-pi-mem0-file-contract.md) | superseded by 0082 | 2026-10-17 |
| 0053 | [subagents as durable child sessions](0053-subagents-as-durable-child-sessions.md) | accepted | 2026-10-17 |
| 0054 | not used | n/a | n/a |
| 0055 | [two install methods, a git checkout and an offline archive](0055-two-install-methods.md) | accepted | 2026-10-15 |
| 0056 | [the service unit, readiness and the setup URL from the journal](0056-service-unit-and-setup-url-from-the-journal.md) | accepted | 2026-10-15 |
| 0057 | [archive integrity pinned in the installer](0057-archive-integrity-pinned-in-the-installer.md) | accepted | 2026-10-15 |
| 0058 | [Web Push on node:crypto, one VAPID key under secrets/push](0058-web-push-on-node-crypto.md) | accepted | 2026-10-17 |
| 0059 | [push endpoints, the host list and per-device browser-only subscriptions](0059-push-endpoints-and-subscriptions.md) | accepted | 2026-10-17 |
| 0060 | [delivery rules, quiet hours, the digest and generic payloads](0060-delivery-rules-and-payload-content.md) | accepted | 2026-10-17 |
| 0061 | [the service worker and the shell cache](0061-service-worker-and-shell-cache.md) | accepted | 2026-10-17 |
| 0062 | [presence by real activity, HTTPS gating and the supervisor](0062-presence-install-and-https.md) | accepted | 2026-10-17 |
| 0063 | [backup and restore](0063-backup-and-restore.md) | accepted | 2026-10-17 |
| 0064 | [update transaction and rollback](0064-update-transaction-and-rollback.md) | accepted | 2026-10-17 |
| 0065 | [the OCI image](0065-the-oci-image.md) | accepted | 2026-10-17 |
| 0066 | [release channels, the feed and `curl \| sh`](0066-release-channels-feed-and-curl-sh.md) | accepted | 2026-10-17 |
| 0067 | [`pap doctor` and the daily update check](0067-doctor-and-the-update-check.md) | accepted | 2026-10-17 |
| 0068 | [one source for the models a context may use](0068-one-source-for-available-models.md) | accepted | 2026-10-17 |
| 0069 | [the provider form writes models.json, field-preserving and strict](0069-provider-form-writes-models-json.md) | accepted | 2026-10-17 |
| 0070 | [the availability view, extension providers, and the policy hook](0070-availability-view-extensions-and-the-policy-hook.md) | accepted (amended 2026-10-18) | 2026-10-17 |
| 0071 | [e2e on the pinned Playwright image](0071-e2e-on-the-pinned-playwright-image.md) | accepted | 2026-10-18 |
| 0072 | [Pi-compat respects the release age](0072-pi-compat-respects-the-release-age.md) | accepted | 2026-10-18 |
| 0073 | [npm shrinkwrap from the lockfile](0073-npm-shrinkwrap-from-the-lockfile.md) | accepted | 2026-10-18 |
| 0074 | [detection of outside writes to a live session](0074-live-session-outside-write-detection.md) | accepted | 2026-10-18 |
| 0075 | [the spec D cutover is out of scope for v1](0075-spec-d-cutover-out-of-scope-for-v1.md) | accepted | 2026-10-18 |
| 0076 | [the v1 flip amends ADR 0066](0076-the-v1-flip-amends-adr-0066.md) | accepted | 2026-10-18 |
| 0077 | [the licence](0077-the-licence.md) | accepted | 2026-10-18 |
| 0078 | [agents run in microVMs](0078-agents-run-in-microvms.md) | accepted, sub-project 1 | 2026-10-19 |
| 0079 | [agents in microVMs: a simple egress proxy and the agent's own credentials](0079-agents-vm-egress-and-files.md) | accepted, sub-project 2 | 2026-10-21 |
| 0080 | [pap sets IS_SANDBOX=1 and CLAUDE_CONFIG_DIR for claude-bridge agents](0080-claude-code-env-for-claude-bridge-agents.md) | accepted | 2026-10-21 |
| 0081 | [agents run only in microVMs](0081-agents-run-only-in-microvms.md) | accepted, sub-project 3 | 2026-10-22 |
| 0082 | [OKF knowledge replaces pi-mem0](0082-okf-knowledge-replaces-pi-mem0.md) | accepted, sub-project 5 | 2026-10-23 |
| 0083 | [the host is an orchestrator, every component that runs code runs in a box](0083-the-host-is-an-orchestrator.md) | accepted, lot B1 | 2026-10-23 |
| 0084 | [GitHub through a pap GitHub App](0084-github-through-a-pap-github-app.md) | accepted, lot B2 | 2026-10-24 |
| 0085 | [owner and members](0085-owner-and-members.md) | accepted, M14 | 2026-10-24 |
