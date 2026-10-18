# ADR 0074: detection of outside writes to a live session

Status: accepted · Date: 2026-10-18 · Spec: `docs/specs/2026-10-10-D-clean-start.md` section 3 (risks: the same session open in both apps). Rulings: M13R13, M13R45, M13R16, M13R56.

## Context

pap and pi-web share `~/.pi/agent` (ADR 0075). Pi keeps no lock on a session file. Before M13 pap detected writes made outside it only for sessions without a live worker; a second app resuming a session that a pap worker holds went unnoticed.

## Decision

While a pap worker is live, a change to its Pi file that appears more than `LIVE_GRACE_MS` (10 000 ms, `scan-port.ts`) after the worker's last activity, and while the worker has nothing pending, counts as written outside pap. It sets `outsideWrite` (the existing snapshot field and notice).

- The last activity is `LiveIdle.quietSince()`: the time of the last `touch()` from worker events and from client commands; `null` while a run, a queued steer or a compaction is pending.
- **It does not taint.** Taint on outside tool results is decided for released sessions (M7R27), and a live worker never reads the file again.
- pap never reads or writes pi-web's own files (`pi-web-session-*.json`, `agent-ops/`, `agent-spaces/`, `agents-home/`, `agents-secrets/`); an integration test puts them beside the Pi sessions and proves no session, no search hit and no log error.
- The coexistence rule is written in `docs/agents/sessions.md`: never resume one session in both apps.

## Consequences

- Cost if the rule is wrong: a notice for two minutes that was not needed; no data effect.
- Limit: an append inside the grace is missed by design, and nothing stops a second writer. The warning is a notice, not a lock.
