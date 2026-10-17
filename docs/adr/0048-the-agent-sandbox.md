# ADR 0048: the agent sandbox

Status: accepted (M11a, Task 28). A deviation from C §5 row 05 and §5.4. Limit 3 below is now enforced by the egress proxy (ADR 0047, decision 90); exfiltration to a reachable host remains.
Date: 2026-10-16
Spec: C §5, §5.3, §5.4. Rulings: M11R17 to M11R27, M11R30 to M11R34, M11R50 to M11R58, M11R162, M11R163, M11R167, M11R176, M11R177, M11R179, M11R181, M11R230 to M11R233, W5-R9, W5-R11, W5-R15, W5-R17, W5-R24, W5-R25, W5-R27, W5-R29, W5-R31. Owner answers m2, m3, m7, m16, m17.

## Context

C §5 row 05 puts a sandbox under every agent. Pi's `bash` is an unsandboxed shell of the owner. An agent that works for days on its own needs a shell that cannot read the owner's keys, pap's database or its siblings' homes, and an isolated task started by a webhook needs one that cannot write outside its own folder. The host has bubblewrap (`bwrap`). Pi's other tools (`read`, `edit`, `write`, `grep`, `find`, `ls`) run in the worker's process, so bwrap cannot wrap them: pap's path rules keep them away from the owner's files instead (W5-R63; limit 2).

## Decision

pap's own `bash`:

- When `init.sandbox` is present the worker loads `pap-sandbox` (`<inline:pap-sandbox>`), which registers `bash` from Pi's `createBashToolDefinition` with pap's process behind it. Output handling, truncation and rendering are Pi's. There is no `commandPrefix` and no `shellPath`; the shell is always `/bin/sh -c`. Stage 02 blocks any command-bearing tool that is not that `bash` while the profile requires the sandbox (`sandbox-rule.ts`), Pi's own `bash` and `powershell` included, so an extension cannot bring its own shell.
- Each command is one detached process group: `spawn(bwrap, argv, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })`. Stop, the tool timeout and the worker's shutdown SIGKILL the group (bwrap's pid namespace takes every process with it). The shell holds fds 0 to 2 only. There is no fallback: a bwrap that fails is a failed command.
- Before every spawn the worker checks that the home and the writable folder are real folders (no link at any level) and that every hidden entry is a real folder. A missing hidden entry is dropped; a link or a file is refused.
- The environment is `unattendedEnv` over the worker's, plus the agent's vault values, with `HOME` = the agent home and `TMPDIR=/tmp`. Provider keys, `PI_*`, the SSH agent and credential-looking names never reach the shell. Values are never put on a command line: there is no `--setenv`, because `/proc/<pid>/cmdline` is readable by every user. Vault names that would hijack the shell or bwrap itself (`PATH`, `LD_*`, `GLIBC_TUNABLES`, `*_PROXY`, glibc's unsecure-environment names and the rest of `isVaultName`) are refused in the schema (W5-R17).

The argument list (`bwrapArgv`, pure, in contracts) has two views (owner m16):

- `host` (an agent thread): `--ro-bind / /`, so the shell sees the whole system read-only except what is hidden.
- `system` (an isolated task, an agent trigger's precheck): only `/usr`, `/etc`, `/bin`, `/sbin`, `/lib`, `/lib32`, `/lib64`, `/libx32`, `/opt`, each bound read-only when it exists.
- In both views: a fresh `/dev`, `/proc` of a new pid namespace, an empty `/run` and `/tmp`, new pid, ipc and uts namespaces (and cgroup when possible), always `--unshare-net`, then the hidden folders behind empty tmpfs (shortest first, at most 12), the agent home (read-write when it is the writable folder, read-only otherwise), the writable folder, `--chdir` to the writable folder (the home for a precheck), `--die-with-parent`, `--new-session`.
- Hidden, when they exist as real folders: the owner's home, `$PAP_HOME`, Pi's agent folder (real path and given spelling), `/var/log` as a whole, `/var/tmp`, `/var/crash` and `/var/lib/systemd/coredump`. `/var/log` goes whole, not only the journal, because bwrap keeps the owner's supplementary groups and a user in `adm` could read `/var/log/syslog`, a copy of the journal with pap's setup URL (W5-R15). Core dumps hold provider keys and vault values (W5-R25).
- No folder of the owner's home is bound in M11 (owner m7). An SRE agent's thread still reads the log files outside `/var/log` that the owner can read, an MCP server the owner enabled, or the whole system with its sandbox off, which is the owner's choice and shown in its settings.
- A thread's shell writes its home only. An isolated task's home is read-only; its one writable folder is a scratch folder `$PAP_HOME/agents/.runs/<agent>/<task>/` beside the home (owner m17, W5-R4): a search of the home never reaches it, and the thread's shell, which hides `$PAP_HOME`, never sees it.
- A networked shell has no resolver and no route: it sees `lo`, the forwarder on `127.0.0.1:3128` and the command's proxy socket (ADR 0047). The spec for a networked sandbox names its egress, and only it.

Required and fail closed:

- The sandbox is required by default (owner m3). Without a usable bwrap an agent session does not start: every launch (new, reopened, relaunched after an idle release or a crash) goes through the gate and answers `sandbox_unavailable`, `agent_paused` or `invalid_cwd`, never a start without the sandbox. Turning the sandbox off is a widening edit with the password; with it off the agent uses Pi's own `bash`, gets no vault and cannot call `secret.request`.
- An agent trigger's precheck always runs in the agent's sandbox, whatever `sandbox.required` says (W5-R31): on a host with no usable bwrap every agent precheck answers `sandbox_unavailable`, while threads of agents with the sandbox off still start.
- The probe (`kernel/sandbox/probe.ts`) takes a root-owned `bwrap` from `/usr/bin`, `/usr/local/bin` or `/bin`, never from `PATH`. `PAP_BWRAP` (absolute, or unset; a relative value stops the boot) must pass the same test, which judges the real path and every folder above it (root-owned, writable by root alone). The probe runs the strictest flags with a canary: a file made outside must be invisible inside and the command inside must echo a nonce, so a root binary that exits 0 without sandboxing is `refused`. The probe has 5 s on the kernel `Clock`, and the result is `usable` or `missing`, `unsafe_path`, `refused`, `timeout`. It runs at boot (in the background), on "Check again" (a browser, one per 10 s) and before a launch when the last result is not usable and older than 60 s. A user-namespace restriction such as Ubuntu's AppArmor setting shows as `refused`.
- Stage 05 of the audit records `sandbox: bwrap (network off|on)` for a sandboxed session.

How the shell is judged (stage 03, M11R30 and M11R162):

- A sandboxed shell without network is an edit of its own folder (owner m2): unasked in auto-accept-edits, asked in supervised, blocked in read-only, and not external, so its output never taints the thread. It names no path, so the path review is skipped; the rules must name its home or scratch folder as a real agent folder, or the call is blocked.
- A sandboxed shell with network is `exec` and external at the call. The taint question and the mode's exec question apply; its result taints per the egress report (ADR 0047). In an isolated task it is blocked without a host list and asks (Inbox) with one.
- In an agent thread or isolated task, a Pi path tool (`read`, `write`, `edit`, `grep`, `find`, `ls`) is refused when the same assistant message holds an allowed sandboxed-shell call, in either order (W5-R11). Pi judges all calls of a message before running any, and the shell may change what a path resolves to before Pi's host-side tool opens it. This depends on Pi running one message's `tool_call` hooks one after another, which `agent-sessions.int.test.ts` pins.
- Agent sessions open with Pi's context-file discovery off (W5-R24): an `AGENTS.md` the agent wrote in its home would otherwise join every later system prompt unfenced. Project trust is never given to an agent session, and is refused for any folder inside `$PAP_HOME/agents` (W5-R27, W5-R29).
- Scratch folders: an isolated task reading its own scratch folder is not fenced (W5-R9). Any other session, and a thread reading its own runs folder (W5-R65), reading a scratch folder or another agent's home is reading external content: the text is fenced (`agent-run`, `agent-home`) and the reader is tainted (W5-R45, W5-R46).

Known limits, in the order the plan listed them, with the ones decision 90 and the sweeps added:

1. The worker itself (Pi, its extensions, MCP stdio servers) runs unsandboxed as the owner. R101's residual stays: code inside the worker can write raw frames on the worker's channel, because the sandbox wraps the agent's shell and not the worker.
2. `read`, `edit`, `write`, `grep`, `find` and `ls` are pap-policy's path checks, not bwrap. C §5 row 05 therefore holds for Pi's tools and the system view, not for a thread's shell; this ADR is where that deviation is recorded. For an agent thread (W5-R63, owner decision), `read`, `grep`, `find` and `ls` are blocked, in every mode and without a question, outside its home, its own runs folder (`agents/.runs/<id>/`: its isolated tasks' output, still fenced and tainting, W5-R65), the files attached to that thread, Pi's skills folder (`<Pi agent dir>/skills/`, read-only, neither fenced nor tainting: the owner installed them, W5-R66) and the system folders of the sandbox's system view (`SYSTEM_FOLDERS`); the owner's home, the rest of `$PAP_HOME`, other agents' homes, the runs folders and `/var/tmp` answer "outside this agent's folder". The isolated task's read rule does the judging (`readsInside`). Its edits stay in its home as before; `auth.json` and the rest of Pi's folder stay blocked. The thread's shell, with the sandbox on, sees what limit 5 says.
3. With network on, the shell reaches only what the egress proxy lets through (ADR 0047). The proxy guarantees hosts, not content: exfiltration through any reachable host remains.
4. Same-user processes outside the sandbox can read the sandbox's environment, vault values included, through `/proc/<bwrap pid>/environ`.
5. An agent thread's shell reads everything the owner can read outside the hidden folders: other mounts, `/srv`, most of `/var`, other users' readable files. Only an isolated task and a precheck are limited to the system folders.
6. The shell has no `node`, `rg` or `fd` unless they are installed system-wide; the owner's Node directory and Pi's `bin` sit under hidden folders.
7. bwrap keeps the owner's supplementary groups, so `connect()` to a unix socket outside `/run` that a kept group may open (lxd, for example) is possible from a thread's shell.
8. The tmpfs mounts (`/tmp`, `/run`, the hidden folders) have no size limit of their own.
9. `AF_VSOCK` is not tied to the network namespace.
10. The vault's limits are in ADR 0049.

## Consequences

- A host without bwrap (or with a user-namespace restriction) runs no sandbox-required agent. Settings › Agents shows why and offers "Check again"; the install guide names `sudo apt install bubblewrap` and the AppArmor setting.
- An agent shell cannot run `node`, `rg` or `fd` from the owner's home. The owner installs them system-wide.
- A home or writable folder replaced by a link between the launch and a command is refused at that command.
- A lane script, a project trigger and an install child (`npx`, `npm`, `git`) still run as the owner outside the policy; M11 sandboxes agent shells and agent prechecks only.
