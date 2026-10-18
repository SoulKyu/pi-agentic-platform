# pi-agentic-platform docs

Self-hosted agentic platform built on the Pi harness. Successor of the pi-web fork.
Status: v1 in hardening (M13); specs A and C implemented; spec D: clean start and coexistence (no cutover, M13R56). HTML pages open directly in a browser.

## Specs
- [specs/2026-10-10-A-product-scope.md](specs/2026-10-10-A-product-scope.md): product, audience, success criteria, v1 scope, defaults, non-goals, roadmap.
- [specs/2026-10-10-C-architecture.md](specs/2026-10-10-C-architecture.md): consolidated architecture (sections 1–9) + spikes S1–S8.
- [specs/2026-10-10-D-clean-start.md](specs/2026-10-10-D-clean-start.md): clean start, cutover, risks. Implemented: the import ban and coexistence with pi-web; the cutover steps are out of scope (M13R56).
- [../DESIGN.md](../DESIGN.md): spec B, the Night Control design system (tokens, type, density, logo, layout, components, screens, voice, a11y, customization).

## Plans
- [plans/roadmap.md](plans/roadmap.md): milestones M2–M13 covering D01–D22 and the v1 additions.
- [plans/2026-10-10-m0-m1-spikes-skeleton.md](plans/2026-10-10-m0-m1-spikes-skeleton.md): pap M0 + M1: architecture spikes and walking skeleton — Implementation Plan.
- [plans/2026-10-11-m2-sessions-core.md](plans/2026-10-11-m2-sessions-core.md): pap M2: sessions core and extension UI — Implementation Plan.
- [plans/2026-10-11-m3-design-system.md](plans/2026-10-11-m3-design-system.md): pap M3: design system and app shell — Implementation Plan.
- [plans/2026-10-12-m4-projects-search.md](plans/2026-10-12-m4-projects-search.md): pap M4: sidebar, projects and search — Implementation Plan.
- [plans/2026-10-12-m5-policy-access.md](plans/2026-10-12-m5-policy-access.md): pap M5: policy pipeline and access control — Implementation Plan.
- [plans/2026-10-13-m7-models-tools.md](plans/2026-10-13-m7-models-tools.md): pap M7: models, tools and Pi extensions — Implementation Plan.
- [plans/2026-10-13-m8-files-git-terminal.md](plans/2026-10-13-m8-files-git-terminal.md): pap M8: files, git and terminal — Implementation Plan.
- [plans/2026-10-14-m10-outbox-automation-finops.md](plans/2026-10-14-m10-outbox-automation-finops.md): pap M10: outbox, automation and FinOps — Implementation Plan.
- [plans/2026-10-14-m9-worktrees-lanes.md](plans/2026-10-14-m9-worktrees-lanes.md): pap M9: worktrees and lanes — Implementation Plan.
- [plans/2026-10-15-m11-agents-subagents-memory.md](plans/2026-10-15-m11-agents-subagents-memory.md): pap M11: long-term agents, subagents and memory — Implementation Plan.
- [plans/2026-10-15-m6-install.md](plans/2026-10-15-m6-install.md): pap M6: install (KISS) — Implementation Plan.
- [plans/2026-10-15-project-home.md](plans/2026-10-15-project-home.md): Project home — Implementation Plan.
- [plans/2026-10-17-m12-notifications-pwa.md](plans/2026-10-17-m12-notifications-pwa.md): pap M12: Notifications and PWA - Implementation Plan.
- [plans/2026-10-17-m6b-update-backup-release.md](plans/2026-10-17-m6b-update-backup-release.md): pap M6b: update, backup and release (rest of D21) — Implementation Plan.
- [plans/2026-10-17-models-picker-providers.md](plans/2026-10-17-models-picker-providers.md): pap models batch: one picker fed by Pi's model list, providers and availability from Settings - Implementation Plan.
- [plans/2026-10-18-m13-v1-hardening.md](plans/2026-10-18-m13-v1-hardening.md): pap M13: v1 hardening and release — Implementation Plan.

## Decisions
- [adr/README.md](adr/README.md): the ADR index (number, title, status, date) and the next free number.
- [research/decisions-log.md](research/decisions-log.md): every decision taken during brainstorming, numbered.
- [research/m0-m1-rulings.md](research/m0-m1-rulings.md): the rulings (R1–R130) taken while implementing M0 + M1, incl. backlog items for later milestones.
- Later rulings: `research/m*-rulings.md` and `research/*-rulings.md` (one file per milestone or batch).

## Architecture (spec C, validated section by section)
- [architecture/01-overview.html](architecture/01-overview.html): process view, repo layout, anti-sprawl rules, the `pap` binary.
- [architecture/02-session-lifecycle.html](architecture/02-session-lifecycle.html): worker states, daemon ⇄ pi-host protocol, run and containment rules, platform calls, failure cases.
- [architecture/03-persistence.html](architecture/03-persistence.html): data owners (Pi / SQLite / files), SQLite rules, transcripts never duplicated, retention and backup.
- [architecture/04-protocol-auth.html](architecture/04-protocol-auth.html): typed contracts, the /ws socket, cursor resume, auth (setup URL, passkeys, tokens), network exposure, remaining HTTP routes (Hono).
- [architecture/05-policy-pipeline.html](architecture/05-policy-pipeline.html): the tool-call pipeline (denylist, egress, approval, taint, guards, sandbox, redaction, fencing, audit), approval categories, policy profiles, platform ops.
- [architecture/06-automation-outbox.html](architecture/06-automation-outbox.html): trigger → gates → one transaction → runner → end, the outbox and its replay classes, boot recovery, webhook / precheck / feed / quota details.
- [architecture/07-frontend.html](architecture/07-frontend.html): front layers, library choices (tiptap composer, CodeMirror, TanStack Router, zustand, Radix), what is kept from pi-web, web folder layout.
- [architecture/08-testing-quality.html](architecture/08-testing-quality.html): test levels, the scripted Pi provider, security tests, blocking quality gates, CI pipeline, dev isolation and repo conventions.
- [architecture/09-packaging-release.html](architecture/09-packaging-release.html): three channels (archive, OCI image, npm), platform tiers, fail-closed sandbox rule, update with auto-rollback, release process.

## Migration (spec D)
- [migration/01-clean-start.html](migration/01-clean-start.html): clean start (decision 24): no pi-web import, Pi shared, sessions indexed from pap install date, cutover steps.

## Design explorations (history behind DESIGN.md)
- [design/explorations/01-brand-directions.html](design/explorations/01-brand-directions.html): round 1, four directions (Graphite, Paper & Ink, Mission Control, Aurora).
- [design/explorations/02-night-control-variants.html](design/explorations/02-night-control-variants.html): round 1b, Mission Control × Aurora without gradients. **E1 (strict) chosen.**
- [design/explorations/03-night-control-light.html](design/explorations/03-night-control-light.html): round 2, light mode. **Day · Papier chosen** (dark = E1 Night).
- [design/explorations/04-shell-layouts.html](design/explorations/04-shell-layouts.html): round 3, three app layouts (rail + tabs, project tree, cockpit).
- [design/explorations/05-shell-mix-ac.html](design/explorations/05-shell-mix-ac.html): round 3b, A×C mixes. **A×C · 2 chosen** (rail + cockpit, sidebar drawer).
- [design/explorations/06-logo-wordmark.html](design/explorations/06-logo-wordmark.html): round 4, four marks. **L4 two legs + name `pap` chosen.**
- [design/explorations/07-type-density.html](design/explorations/07-type-density.html): round 5, type scale and two densities. **Compact default, density user-selectable.**
- [design/explorations/08-settings-appearance.html](design/explorations/08-settings-appearance.html): round 6, Settings › Appearance (per account vs per device, role-token theme editor with AA check).
- [design/explorations/09-agent-space-inbox.html](design/explorations/09-agent-space-inbox.html): round 7, agent thread + status panel + Inbox drawer. **Validated as shown.**
- [design/explorations/10-lanes.html](design/explorations/10-lanes.html): round 8, lane cockpit + review, fan-out compare, new lane from issue. **Validated as shown.**
- [design/explorations/11-automation.html](design/explorations/11-automation.html): round 9, trigger editor + dry-run + fire journal, global tasks board. **Validated as shown.**
- [design/explorations/12-mobile-system.html](design/explorations/12-mobile-system.html): round 10, mobile PWA screens + setup, login, ⌘K, states. **Validated as shown.**

## Research
- [research/pi-web-inventory.md](research/pi-web-inventory.md): every pi-web feature (D01–D22), source of the matrix rows.
- [research/feature-matrix.md](research/feature-matrix.md): pi-web vs T3 Code vs Orca, verdict per domain.
- [research/t3code.md](research/t3code.md), [research/orca.md](research/orca.md): codebase maps of the two references.
- Final reviews: `research/*-final-review.md` (and `*-final-rereview.md`), one per milestone or batch. SDD ledgers: `research/*-sdd-ledger*.md`.
