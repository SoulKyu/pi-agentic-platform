# ADR 0022 — The audit row is the judged event, with its stage verdicts

Status: accepted · Date: 2026-10-13 · Spec: C §5.1, §3.4 · Decisions: owner Q4, Q5, MQ9

## Context

Spec C §5.1 says "Every stage writes an audit line: call, redacted arguments, decision and reason. Results are never recorded." Eight stages (00–07) times every tool call would be eight rows per call in a table that cannot be edited, and C §3.4 keeps it for twelve months. Stages 06 and 07 look at the result, not at the call, and a result that was clean has nothing to say.

## Decision

- One `call` row per judged call, carrying the verdicts of stages 01–04 (and 06 when `[SECRET:...]` markers were restored in its input). One `result` row only when stage 06 or 07 acted (a redaction, a fence, a withheld result), with `external` and the redaction counts, never the text (owner MQ9). One `session` row per worker start or tool-set change, carrying stages 00 (exposure) and 05 (containment, with the daemon's own fact of worker scope on or off) and the tool names as `{ count, truncated, names }`.
- So "every stage writes a line" means every stage that decided or acted. A call with no `result` row had nothing redacted and was not external.
- Arguments are redacted by the worker (stage 06) and scrubbed again by the daemon of well-known token formats (`scrub.ts`). NUL becomes U+FFFD, reasons are redacted before they are clipped. A malformed worker entry is stored as an `invalid` row, at most 100 per session. Valid worker rows are budgeted at 600 per session per minute; the excess is dropped and one marker row records where the gap starts.
- The table is append-only by SQL triggers: UPDATE and DELETE are refused, and so is an INSERT onto an existing id (REPLACE would skip the DELETE trigger). A whole month older than 12 months leaves only through `pap audit prune [--month YYYY-MM] [--dry-run]`, with the daemon stopped (owner Q5: `systemctl --user stop pap-preview` first; the CLI takes the instance lock). The prune leaves its own row in `audit_prunes`. At boot the daemon logs `audit_prunable` when months can go.
- The viewer (Settings › Approvals) renders rows as text, clipped, with a visible gap marker.

## Consequences

- About 0.5 KB per call row: 1 000 tool calls a day is about 180 MB a year, and nothing but the monthly prune removes it.
- There is no per-session volume cap beyond the 600 rows a minute: a compromised worker can already write arbitrary files under the same account, so an audit cap would not stop disk exhaustion. A hostile session can grow the table by about 10 MB a minute until the owner stops it.
- The triggers stop a bug, not a person: whoever can edit `state.db` can drop them. A row can be purged only by editing the file.
- The audit never records results, only the fact that a stage acted on one.
