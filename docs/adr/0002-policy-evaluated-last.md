# ADR 0002 — pap-policy evaluates the final tool input

Status: accepted · Date: 2026-10-10 · Spec: C §5.1 · Decision: 34

Spec C §5.1 (as amended by decision 34) says `pap-policy` is evaluated **last** in `pi-host`, after user extensions, so that it judges the final tool input, and that it still cannot be bypassed because a single `block` from any handler blocks. This ADR records why the order is that way and what the code does to keep it.

## Why

Pi passes a `tool_call` event to the extension handlers in extension order, and `event.input` is mutable: a later handler sees, and can change, what earlier handlers saw (Pi `ToolCallEvent` docs). S1 measured it (`docs/spikes/s1.md`): a mutating extension appended `# mutated-by-s1` to a bash command.

- Policy first: the policy saw `echo probe`. The mutation ran after it, so the command that executed was never judged.
- Policy after the mutator (listed last, or moved last with `extensionsOverride`): the policy saw `echo probe # mutated-by-s1`.

Only a handler that runs after a mutating extension sees the modified call. A policy that runs first could approve `echo hi` and a user extension could then rewrite it.

## Decision

- `pap-policy` is always present and runs last in the `tool_call` chain, so it judges the exact input that will execute. `movePolicyLast` reorders the loaded extensions and throws when the policy is missing: a session refuses to start without it.
- The policy is found by equality on the path Pi reports for an inline extension, `<inline:pap-policy>` (`POLICY_EXTENSION_PATH`). It is never found by a substring: the SDK's built-ins carry no name and appear as `<inline:1>`, `<inline:2>`, and a user extension whose path mentions `pap-policy` is an ordinary extension that stays where it is.
- "Cannot be bypassed" holds: Pi stops at the first handler that returns `block`, so nothing can undo a block, and nothing runs after the policy that could change the input once the policy has approved it.
- Fail closed: missing rules, an error while evaluating, a dialog that throws, no UI to ask, a failed audit line, a closed or timed-out request, all block.

## Consequences

- Calls another tool makes (a codemode script, `parentToolCallId` set) go through the same handler and are judged one by one.
- The audit line records the input the policy judged, which is the input that ran.
- In M1 only stage 03 exists (approval, interactive profile, auto-accept edits). Edits are auto-accepted only when the resolved target, symlinks followed, is inside the session directory; tools with no known category (extension and MCP tools) ask, and an unattended profile blocks both until roadmap M5.
- A handler of an earlier extension that throws makes Pi return an error result for the call without running it, so the policy is never reached for it and nothing executes.
