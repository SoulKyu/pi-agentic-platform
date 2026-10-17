# ADR 0020 — Taint is sticky per session

Status: accepted, amended for agent sessions by ADR 0047 (decision 90) · Date: 2026-10-13 · Spec: C §5.2, §5.3 (deviation) · Decisions: owner Q2, Q15, MQ1, MQ3

## Context

Spec C §5.2 says a session is "tainted for the rest of the run" once external content enters its context. A run ends at `agent_settled`; the next prompt starts a clean run. But the injected text is still in the transcript, and Pi sends the whole transcript to the model again on the next turn. A worker released at idle, or restarted after a crash, reads the same file. A taint that ends with the run, or with the worker's memory, would let a session that read a hostile page exfiltrate on its next prompt.

## Decision

- An external result taints the session: an MCP tool result (every `builtin:mcp` tool, whatever its `openWorldHint`), `read_mcp_resource`, and an extension tool unless it declares `openWorldHint: false`. The taint lasts until the owner clears it in the session header (`policy.clearTaint`); nothing else lowers it.
- The taint survives a worker restart. The worker keeps `{ tainted, epoch }` and reports a change with a record of its own (`taint`, carrying the epoch it knows). The daemon stores it in `session_policy` and sends it back in `init` and in every `policy_update`.
- `epoch` only grows, and only an explicit clear makes it grow. A report is applied only when its epoch is not older than the stored one, so a push that was in flight during a clear never lowers the taint again, and never raises a cleared one on a stale epoch.
- A second path raises the taint without an epoch check: a worker `audit` entry with `kind: "result"` and `external: true`. It is the fallback for external content read between a clear and the new epoch reaching the worker. It must never get an epoch check: that would make it fail open. Its cost is a nuisance: a late entry after a clear taints again, and the owner clears twice.
- Forks and clones copy the mode and the taint (`inherit` runs inside `adopt`, never lowering an epoch). A session adopted by M4's scanner starts tainted (owner MQ3): its transcript was not written under pap's fences. M4's scan port calls `onAdopted(sessionId)` and the second merger wires it to `markTainted`.
- While a session is tainted, every call that can carry data out (`exec`, `network`, `external-write`, `unknown`) or reaches outside the machine (`external`) asks Deny / Allow once in supervised, auto-accept-edits and full access, past any session or always rule. Read-only blocks them. Built-in reads, `codemode`, `tool_search` and edits inside the session folder are unchanged. An MCP tool that declares `readOnlyHint` stays a read while the session is untainted (owner MQ1).
- The Clear action asks for no password: it lowers a guard the owner can see (a chip in the session header). It is audited.

## Consequences

- More cards after an injection, by design. A session that read the open world asks for each command until the owner clears it.
- Residuals, documented in `docs/agents/policy.md`: injected text that comes through `bash` output or through files the agent reads is not fenced and does not taint (spec C §5 "Known v1 limit"); the daemon can crash between a worker's `taint` send and its dispatch; a clone taken while the live leaf is null, or after a failed `markTainted` and before the next `agent_end`, can start untainted; inserting a clone and inheriting the taint are not one transaction; a stale audit entry after a clear taints again.
- M7 (Task 4) wires MCP, codemode and `tool_search` into the worker; the MCP and codemode rules are exercised through a real daemon worker by `apps/daemon/src/security/mcp-taint.int.test.ts` and `codemode-nested.int.test.ts` (before M7 they ran in-process).
