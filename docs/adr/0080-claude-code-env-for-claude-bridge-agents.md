# ADR 0080: pap sets IS_SANDBOX=1 and CLAUDE_CONFIG_DIR for claude-bridge agents

Status: accepted · Date: 2026-10-21 · Amends ADR 0078 for the Claude Code environment. Topic note: `docs/agents/agents-vm.md` ("Providers and the Claude token").

## Context

pi-claude-bridge starts the Claude Code CLI with `{ ...process.env, ...CC_CHILD_ENV }`, so the worker's environment reaches the CLI. The CLI makes two assumptions that fail under pap:

1. It refuses `--dangerously-skip-permissions` when it runs as root. A VM worker runs as guest root.
2. It writes its configuration to `$HOME/.claude`. In a VM, `HOME` is `/root`, on a read-only root. In host mode, `HOME` is the owner's real home, so the CLI would write the owner's real `~/.claude`.

`IS_SANDBOX=1` is the CLI's documented escape for the first. `CLAUDE_CONFIG_DIR` fixes the second.

## Decision

- **Only agents that use the bridge get the variables**: the model's provider is `claude-bridge`, or a package pick is the bridge package (`isClaudeBridgeSource`, the decision the relay policy already makes). Every other agent's environment is unchanged. The base image no longer sets `IS_SANDBOX=1` (commit b387917f did, for every VM).
- **VM**: `IS_SANDBOX=1` and `CLAUDE_CONFIG_DIR=<layout.home>/.claude`. The daemon puts them in the spawn command it sends to the guest. The guest applies a closed allowlist: `IS_SANDBOX` only with the value `1`, `CLAUDE_CONFIG_DIR` only as an absolute path under the layout's home without `..`. Any other key or value is dropped and logged by key. The test (process) backend takes the same path.
- **Host**: `CLAUDE_CONFIG_DIR=<the agent's host home>/.claude` only. Never `IS_SANDBOX`.
- **Precedence**: in host mode the daemon's own environment reaches the worker, so a `CLAUDE_CONFIG_DIR` set there wins and pap derives none. In a VM the daemon's environment never reaches the worker (the guest builds it), so the rule does not apply.
- No setting: the environment is derived from the provider and the packages.

## Why it is safe

- **VM**: the flag's contract is "this process already runs in a sandbox". The VM is that sandbox: its own kernel, no credential in it (ADR 0078), the egress proxy as the only exit. The CLI's refusal under root adds nothing the VM does not already give. The bridge's Claude Code tools then run as VM root without pap's per-command shell policy; this was already the case once the image set the flag, and is now limited to the agents that use the bridge.
- **Host**: the CLI is not sandboxed and does not run as root. `IS_SANDBOX=1` would claim a sandbox that does not exist, so it is never set there. Only the configuration folder moves, into the agent's own home, so the owner's `~/.claude` is never written.

## Consequences

- The base image key changes (the `ENV` line lost `IS_SANDBOX=1`): the next launch rebuilds the base layer, then each agent image.
- An agent's `.claude/` folder lives in its home. In host mode the home is a git repository whose `.gitignore` holds `.pi/` only: `.claude/` shows as untracked there, and an agent that runs `git add -A` would commit it. pap runs git in a home only at its creation (ADR 0050) and reads no status or file count of it.
- Cost if wrong: a bridge agent without the variables fails at its first Claude Code call (root refusal in a VM, an unwritable `/root/.claude`); the error is visible in the thread, nothing runs unsandboxed.
