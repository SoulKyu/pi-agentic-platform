# pi-agentic-platform docs

Self-hosted agentic platform built on the Pi harness. Successor of the pi-web fork.
Status: design phase (specs not yet written). HTML pages open directly in a browser.

## Decisions
- [research/decisions-log.md](research/decisions-log.md): every decision taken during brainstorming, numbered.

## Architecture (spec C, validated section by section)
- [architecture/01-overview.html](architecture/01-overview.html): process view, repo layout, anti-sprawl rules, the `pap` binary.
- [architecture/02-session-lifecycle.html](architecture/02-session-lifecycle.html): worker states, daemon ⇄ pi-host protocol, run and containment rules, platform calls, failure cases.

## Design (DESIGN.md in progress)
- [design/explorations/01-brand-directions.html](design/explorations/01-brand-directions.html): round 1, four directions (Graphite, Paper & Ink, Mission Control, Aurora).
- [design/explorations/02-night-control-variants.html](design/explorations/02-night-control-variants.html): round 1b, Mission Control × Aurora without gradients. **E1 (strict) chosen.**
- [design/explorations/03-night-control-light.html](design/explorations/03-night-control-light.html): round 2, light mode. **Day · Papier chosen** (dark = E1 Night).

## Research
- [research/pi-web-inventory.md](research/pi-web-inventory.md): every pi-web feature (D01–D22), source of the matrix rows.
- [research/feature-matrix.md](research/feature-matrix.md): pi-web vs T3 Code vs Orca, verdict per domain.
- [research/t3code.md](research/t3code.md), [research/orca.md](research/orca.md): codebase maps of the two references.
