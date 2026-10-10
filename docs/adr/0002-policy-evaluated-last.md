# ADR 0002 — pap-policy evaluates the final tool input

Status: accepted · Date: 2026-10-10 · Spec: C §5.1 · Decision: 34

Spec C §5.1 (as amended by decision 34) says `pap-policy` is evaluated **last** in `pi-host`, after user extensions, so that it judges the final tool input, and that it still cannot be bypassed because a single `block` from any handler blocks. This ADR records why the order is that way and what the code does to keep it.

## Why

Pi passes a `tool_call` event to the extension handlers in extension order, and `event.input` is mutable: a later handler sees, and can change, what earlier handlers saw (Pi `ToolCallEvent` docs). S1 measured it (`docs/spikes/s1.md`): a mutating extension appended `# mutated-by-s1` to a bash command.

- Policy first: the policy saw `echo probe`. The mutation ran after it, so the command that executed was never judged.
- Policy after the mutator (listed last, or moved last with `extensionsOverride`): the policy saw `echo probe # mutated-by-s1`.

Only a handler that runs after a mutating extension sees the modified call. A policy that runs first could approve `echo hi` and a user extension could then rewrite it.

## Decision

- `pap-policy` is always present and runs last in the `tool_call` chain, so it judges the final tool input: what the model asked for once every earlier extension has had its say. Pi settings can still change how a `bash` call runs (`shellCommandPrefix`, `shellPath`); the approval does not show them (see Residual risks). `movePolicyLast` reorders the loaded extensions and throws when the policy is missing: a session refuses to start without it.
- The policy is found by equality on the path Pi reports for an inline extension, `<inline:pap-policy>` (`POLICY_EXTENSION_PATH`). It is never found by a substring: the SDK's built-ins carry no name and appear as `<inline:1>`, `<inline:2>`, and a user extension whose path mentions `pap-policy` is an ordinary extension that stays where it is.
- "Cannot be bypassed" holds: Pi stops at the first handler that returns `block`, so nothing can undo a block, and nothing runs after the policy that could change the input once the policy has approved it.
- Fail closed: missing rules, an error while evaluating, a dialog that throws, no UI to ask, a failed audit line, a closed or timed-out request, all block.

## Consequences

- Calls another tool makes (a codemode script, `parentToolCallId` set) go through the same handler and are judged one by one.
- The audit line records the tool name, its category, the decision and a short reason. It carries no arguments yet; what the user saw is the approval message, not the journal.
- In M1 only stage 03 exists (approval, interactive profile, auto-accept edits). Tools with no known category (extension and MCP tools) ask, and so does a built-in name that an extension has taken over (the category is trusted only for the tool whose registered source is `builtin:<name>`). An unattended profile blocks both until roadmap M5.
- An edit is auto-accepted only when the file Pi would write, symlinks followed, is inside the session directory, is not a protected path, and the session directory is not too broad. Pi's own path rewrites (`~`, a leading `@`, `file://`) are applied first, and the approval names the file Pi writes, never the literal spelling. Protected paths ask even inside the session directory, because writing them runs code later with no approval: any segment `.git`, `.pi`, `.agents`, `.husky` or `.vscode` (NFC, case-folded) anywhere in the absolute path, so a session directory that sits inside one of them is covered, a file named `.envrc`, and everything under the agent directory, compared as spelled and as resolved. No edit is auto-accepted when the session directory is the home directory, a parent of it, or a parent of the agent directory. The approval then names where the write lands and why it asks.
- The approval shows the complete payload under a header with its size, its line count and the number of hidden characters. Bidi controls, zero-width, default-ignorable (Hangul fillers, variation selectors) and other invisible characters appear as `\u{XXXX}`, long runs of blanks as a marker. The 32 KiB review cap applies to the final dialog text, escapes included; above it the call is blocked without a dialog, because a clipped view would let a long benign prefix hide the tail and an escaped view must stay readable. Only a shell tool that Pi registered as `builtin:<name>` is shown as its command alone; any other tool shows every field.
- The approval dialog receives the run's abort signal: Stop dismisses it and the call is blocked.
- A handler of an earlier extension that throws makes Pi return an error result for the call without running it, so the policy is never reached for it and nothing executes.

## Residual risks

Until the stage-05 sandbox exists these stay open:

- Time of check to time of use: a symlink swapped between the target check and the write.
- Hardlinks inside the session directory to files outside it.
- Windows path forms are not modelled (pap targets Linux).
- `shellCommandPrefix` and `shellPath` from Pi settings change what a `bash` call runs; the approval text shows only the command.
- An approved `bash` command can do anything the user's account can; the policy asks, it does not confine.
- pap's own data directory is not in the protected set yet: the worker's init record carries the Pi agent directory only. Task 20 must pass the data directory too.
- `event.input` is mutable: code that kept a reference to it could change the input while the approval dialog is open.
- Protected locations that are symlinked into the session directory, for example `.git/hooks/x -> ../../scripts/x`, a `core.hooksPath` directory, or an agent-directory subfolder linked into a dotfiles repository: a write to the link's target, spelled through the target's own name (`scripts/x`), is auto-accepted although it changes what the protected location runs.
- Auto-run files that are not on the protected list: `mise.toml`, `.idea`, `.zed/tasks.json`, `lefthook.yml` and the like. They are for the stage-05 sandbox and the M5 policy.
- A dialog that is closed, times out or answers malformed is reported to the model as a denial, not as a fail-closed block, because `ctx.ui.confirm` returns a boolean.
