# ADR 0074: detection of outside writes to a live session

Status: accepted · Date: 2026-10-18 · Spec: `docs/specs/2026-10-10-D-clean-start.md` section 3 (risks: the same session open in both apps). Rulings: M13R13, M13R45, M13R16, M13R56.

## Context

pap and pi-web share `~/.pi/agent` (ADR 0075). Pi keeps no lock on a session file. Before M13 pap detected writes made outside it only for sessions without a live worker; a second app resuming a session that a pap worker holds went unnoticed.

## Decision

While a pap worker is live, a change to its Pi file that appears more than `LIVE_GRACE_MS` (10 000 ms, `scan-port.ts`) after the worker's last activity, and while the worker has nothing pending, counts as written outside pap. It sets `outsideWrite` (the existing snapshot field and notice).

- The last activity is `LiveIdle.quietSince()`: the time of the last `touch()` from worker events and from client commands; `null` while a run, a queued steer or a compaction is pending.
- **Tool results taint at once** (amended 2026-10-18 by M13-C10). The first version said "no taint" on the premise that a live worker never reads the file again. That premise was wrong: the worker's exit stamp (`pap_wrote_at`, size) absorbs the outside bytes, and the next prompt loads them into a worker's context untainted. So when the scanner sees a `toolResult` (or an unreadable line) in a write that counts as outside for a live worker, it taints the session through the same path as the released-session rule (M7R27): one taint, one audit row. Taint only makes the policy stricter. A write inside the grace, or while work is pending, is pap's own and never taints.
- pap never reads or writes pi-web's own files (`pi-web-session-*.json`, `agent-ops/`, `agent-spaces/`, `agents-home/`, `agents-secrets/`); an integration test puts them beside the Pi sessions and proves no session, no search hit and no log error.
- The coexistence rule is written in `docs/agents/sessions.md`: never resume one session in both apps.

## Consequences

- Cost if the rule is wrong: a notice for two minutes that was not needed; no data effect.
- Limit: an append inside the grace is missed by design, and nothing stops a second writer. The warning is a notice, not a lock.
