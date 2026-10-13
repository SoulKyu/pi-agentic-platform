# ADR 0002 — pap-policy evaluates the final tool input

Status: accepted · Date: 2026-10-10 (amended 2026-10-13, M5) · Spec: C §5.1 · Decision: 34

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
- M5: the audit row records the tool, its category, redacted arguments, the decision and each stage's verdict (ADR 0022). Results are never recorded; only the fact that a stage acted on one.
- Since M5 the pipeline has eight stages (`docs/agents/policy.md`) and stage 03 is the approval matrix by mode. Tools with no known category (extension tools) ask, and so does a built-in name that an extension has taken over (the category is trusted only for the tool whose registered source is `builtin:<name>`). An unattended profile blocks both until the unattended profiles (M10, M11).
- An edit is auto-accepted only when the file Pi would write, symlinks followed, is inside the session directory, is not a protected path, and the session directory is not too broad. Pi's own path rewrites (`~`, a leading `@`, `file://`) are applied first, and the approval names the file Pi writes, never the literal spelling. Protected paths ask even inside the session directory, because writing them runs code later with no approval: any segment `.git`, `.pi`, `.agents`, `.husky` or `.vscode` (NFC, case-folded) anywhere in the absolute path, so a session directory that sits inside one of them is covered, a file named `.envrc`, and everything under the Pi agent directory and under pap's data directory (both come from the worker's init record, ADR 0001), compared as spelled and as resolved. No edit is auto-accepted when the session directory is the home directory, a parent of it, or a parent of either of those two directories. The approval then names where the write lands and why it asks.
- The approval shows the complete payload under a header with its size, its line count and the number of hidden characters. Bidi controls, zero-width, default-ignorable (Hangul fillers, variation selectors) and other invisible characters appear as `\u{XXXX}`, long runs of blanks as a marker. The 32 KiB review cap applies to the final dialog text, escapes included; above it the call is blocked without a dialog, because a clipped view would let a long benign prefix hide the tail and an escaped view must stay readable. Only a shell tool that Pi registered as `builtin:<name>` is shown as its command alone; any other tool shows every field.
- The approval dialog receives the run's abort signal: Stop dismisses it and the call is blocked.
- A handler of an earlier extension that throws makes Pi return an error result for the call without running it, so the policy is never reached for it and nothing executes.

## Residual risks

Until the stage-05 sandbox exists (deferred to M11, owner Q11) these stay open:

- Time of check to time of use: a symlink swapped between the target check and the write.
- Hardlinks inside the session directory to files outside it.
- Windows path forms are not modelled (pap targets Linux).
- `shellCommandPrefix` and `shellPath` from Pi settings change what a `bash` call runs; the approval text shows only the command.
- An approved `bash` command can do anything the user's account can; the policy asks, it does not confine. In full access a shell command is limited by the blocked-command list alone: it can read or delete `$PAP_HOME` and Pi's `auth.json`. pap's other checks (writes outside the folder, protected reads, external tools after external content) apply to built-in tools only, and the copy says so (owner Q1).
- The blocked-command list (stage 01) is a best-effort reader, not a parser of every shell. Its documented bypasses are listed in `docs/agents/policy.md` (variables as the command word, aliases and functions defined earlier, scripts written then run, interpreters, brace expansion, `find -delete`, `xargs`, and others). Egress (stage 02) has documented limits too: unnamed clients, scripts, DNS, proxies set outside the command line.
- `grep` and `find` are read tools and run without asking, except toward pap's own sensitive files (stage 03 protected reads, M5R29). Pi 1.1.0 hands a model-chosen pattern, glob or path to ripgrep and fd as data, never as an option (`--pre`, `-x`); the probes in `packages/pi-host/src/host.probes.int.test.ts` pin that, and the nightly Pi-compat run is what would notice a version that does not. Pi's own path resolution for `grep`, `find` and `ls` targets was not probed against every spelling; both readings are judged.
- `event.input` is mutable: code that kept a reference to it could change the input while the approval dialog is open.
- Protected locations that are symlinked into the session directory, for example `.git/hooks/x -> ../../scripts/x`, a `core.hooksPath` directory, or an agent-directory subfolder linked into a dotfiles repository: a write to the link's target, spelled through the target's own name (`scripts/x`), is auto-accepted although it changes what the protected location runs.
- Auto-run files that are still not on the protected list. Since M5 the list covers the segments `.idea`, `.zed`, `.devcontainer`, `.lefthook` and `.mise`, the basenames `.envrc` and `.pre-commit-config.yaml`, lefthook and mise configuration (`lefthook.yml`, `lefthook-local.yml`, `mise.toml`, `mise.<env>.toml`, with or without a leading dot, `.config/mise/`, `mise/config.toml`). Still open: `.githooks/` reached through `core.hooksPath`, hooks in `.claude/settings*.json`, `lefthook.jsonc`, `mise/config.local.toml` and `mise/config.<env>.toml`.
- A dialog that is closed, times out or answers malformed is reported to the model as a denial, not as a fail-closed block, because `ctx.ui.confirm` returns a boolean.
