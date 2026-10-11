# ADR 0008 — pap records added to the daemon ⇄ pi-host protocol in M2

Status: accepted · Date: 2026-10-11 · Spec: C §2.3 (records), as extended by ADR 0001

## Context
Spec C §2.3 lists the records of the protocol. M2 needs a few it does not list: the policy's own approval question
(spec C §5.3 wants four answers, and an extension's `ctx.ui.confirm` must not be able to look like the policy), a
way to cancel a custom panel the daemon will not show, naming through the session's model, the leaf and name of a
session at start, and the processes a worker's agent left running.

## Decision
- daemon → worker: `auto_name{id}`, `custom_cancel{id}`, `approval_response{id, answer: once|session|always|deny,
  cancelled?}` (alongside the Pi RPC shapes `clear_queue`, `compact`, `navigate_tree`, `set_session_name`,
  `export_html` and the spec's `custom_input`). `cancelled: true` means the daemon could not show the question:
  the policy fails closed and audits `dialog closed`, it never tells the model a person refused.
- worker → daemon: `approval_request{id, category, title, message, answers, tool, key}` (sent by pap-policy through
  the worker's approvals channel), `ready{…, leafId, sessionName}` (both default to null) and, from Task 20,
  `health{rssMb, descendants}`. `extension_ui_closed{id}` also closes an approval the worker withdrew.
- `toWireEvent` slims two Pi events: `entry_appended` keeps the entry's identity (and a summary's text), and
  `queue_update` carries previews plus the full count and byte size.
- `PROTOCOL_VERSION` (the client protocol) goes to 2 with the snapshot's new shape.

## Consequences
- `PAP_TYPES` is derived from `PapRecord` (R67): the new worker records can never be forwarded as Pi events.
- No extension can raise a policy card **through the extension API**: `ctx.ui` has no approval method and only
  pap-policy holds the approvals object. Code running inside the worker process can still call
  `process.send({ type: "approval_request", … })` and read the answer: that is R101's residual (in-process code is
  as trusted as the worker); the per-command sandbox (M5) is where it narrows.
- A worker older than the daemon refuses the new commands with `malformed record` (its `DaemonToWorker` schema does
  not know them): an answer, never silence. The dispatch switch of this version is exhaustive over `DaemonToWorker`
  from Task 15, so its `default` branch is a compile-time guard, not a runtime path.
