# ADR 0024 — Read-only shell commands run unasked, "always" rules can cover a prefix or a tool

Status: accepted · Date: 2026-10-13 · Spec: C §5 (policy), deviation from M5's matrix · Decisions: 75 Q6, owner m1, m2, m3 · Rulings: M7R1–M7R16, M7R136, MC4, MC7–MC11, MC13–MC18, MC36

## Context

M5's matrix asks for every `exec` call in the default mode, so `ls`, `git status` and `rg foo` each showed a card, and an "always" answer covered only the exact command. Two things are wrong with that for daily use: the questions teach the owner to click through, and "always allow `pnpm test`" never matches `pnpm test --watch`. Loosening either must not open a way to run code unasked.

The risk of a read-only shell command is not the command but what it can be made to run: an option that writes a file or runs a program (`sort -o`, `find -exec`, `rg --pre`), an operand outside the folder, a shell that was configured to run something first, and for git the repository's own config (`core.fsmonitor`, a filter or diff driver, a hook), which a planted `.git/config` can set.

## Decision

Read-only commands (worker, `packages/pi-host/src/policy/`):

- Only Pi's built-in `bash`, in `supervised` and `auto-accept-edits` (`READ_ONLY_COMMAND_MODES`, `stage-approval.ts:13`), with the owner's `readOnlyCommands` switch on (default). The read-only mode keeps blocking the shell. Stages 01, 02 and 04 run unchanged around it. A covered call is judged as a `read`: the audit category stays `exec`, stage 03 says `allow` "read-only command" (owner m1).
- `coverCommand` (`command-cover.ts:51`) covers a command only when every simple command is on the allowlist (`read-only-commands.ts`): a rule names how the operands are judged (as the built-in tool of the same reach would be, with M5's protected-read lists) and every option that writes, runs a program or reads a list of files, in each spelling getopt accepts. A command that is not listed, a wrapper, an assignment, an expansion, an output redirection other than to `/dev/null`, a custom shell, a startup file, a command prefix or a relative or session-folder `PATH` entry makes the whole line ask. The reader never throws: a failure asks.
- A tainted session still runs the covered commands (owner m2: none can reach the network), except git (MC17): there, every git segment asks.
- Git subcommands are a short list of readers (`GIT_READ_ONLY`). Before one runs unasked, `repoConfigRefusal` (`git-config-guard.ts:146`) finds the repository git would use (`git-discovery.ts`, strictly narrower than git's own rules: anything it does not fully accept asks, MC7) and reads its `config`, `config.worktree`, the `commondir` ones and every `include` / `includeIf` target. It asks when a config names a program (`git-config.ts:163`: owner m3's keys plus MC8 and MC13 additions), cannot be read or parsed, has an include it cannot resolve, sets another object format, when the repository has a `.gitmodules`, a `modules/` folder, a gitlink in its index (MC9–MC11, `git-index.ts`) or a `post-index-change` hook. No repository found asks (MC17). Two relaxations (MC4): `core.fsmonitor` set to a boolean, and the exact standard git-lfs `clean`, `smudge` and `process` entries (`LFS_ENTRIES` in contracts; `filter.lfs.required` is not a program key, so it never asks).
- The worker pins `safe.bareRepository=explicit` for every git the agent runs (`git-env.ts`, MC18), so a bare layout planted in the same message is never discovered. `GIT_DIR`-style variables in the shell make git ask (`ShellFacts.gitEnv`).
- The owner's own `~/.gitconfig`, `/etc/gitconfig` and `GIT_CONFIG_*` are not read: they are his.

Pattern "always" rules (daemon `modules/policy/`, worker `policy/pattern-grants.ts`, `prefix-proposal.ts`):

- Besides `exact`, two kinds: `prefix` (bash only) and `tool` (every call of a built-in or MCP tool of an edit, network or external-write category). The worker offers the scopes on its question (`alwaysScopesOf`, `pattern-grants.ts:54`); the client names one, and a scope that was not offered is refused. The stored value comes from the stored offer, never from the frame.
- A prefix is proposed only for a single plain segment (no pipe, redirection or substitution) whose first word is not a launcher or shell (`NEVER_FIRST` in `prefix-proposal.ts`: `sh`, `sudo`, `env`, `xargs`, ...), at most three words (`pnpm run test`). It covers a command when every simple command of the line is a `cd`, starts with a stored prefix, or is read-only (`command-cover.ts:87-91`). A rule is never valid in a tainted session (`pattern-grants.ts:29`). Detail: `docs/agents/policy.md`.

## Consequences

- `ls`, `rg`, `git status` in a clean repository stop asking. `curl` and anything not listed still ask.
- Friction, by design: a repository with a program key in its config (`git lfs install --local` with a non-standard entry, a local `core.fsmonitor` command, a submodule) asks for every git read command; an exact or prefix always-rule removes it for that repository. In a tainted session git asks until the owner clears the taint.
- Residuals (`policy.md`): a process other than a pap write that rewrites `.git/config` between the check and git's own read; an alias or function from an earlier approved command does not persist (Pi starts a fresh shell per call); `/proc/<pid>/environ`, `ps e` and other files outside M5's protected list are readable, like the built-in `read`. The approval card does not say why coverage failed.
- The git guard is a stricter-than-git acceptance: it can only add questions. A differential test against real git (`git-index.fuzz.ts`) pins the index reader.
