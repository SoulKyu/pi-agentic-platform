# ADR 0046: feeds and the precheck without a sandbox

Status: accepted (M10, Task 24)
Date: 2026-10-15
Spec: C §6.4. Rulings: M10R68 to M10R77, M10R151, M10R158, agreements 8 and 9.

## Context

C §6.4 runs the precheck "under sandbox" and fetches feeds. The sandbox (bwrap) is M11. A feed is an outbound request to an address the owner typed, and a precheck is a shell command.

## Decision

Feeds:

- A feed trigger is polled every `everyMinutes` (15 to 1440) as a `feed.poll` effect. A disabled or deleted trigger is never fetched, a dry-run never fetches, nothing is fetched in read-only mode, and nothing is fetched while automation is paused or the owner is over budget (the poll writes a journal line and sets no baseline).
- The address guard (`net-guard.ts`): https only, no credentials; a literal non-public address is refused before connecting; every name resolves through the `lookup` handed to `https.request`, so the socket connects to an address the guard saw, and one non-public answer refuses the name. Refused: private, loopback, link-local (cloud metadata), CGNAT and Tailscale, multicast, reserved, NAT64, 6to4, Teredo, ULA, documentation, and the IPv4-compatible and IPv4-translated IPv6 forms that embed an IPv4 address. IPv4-mapped IPv6 is judged by the IPv4 rules. It runs at save (`feedUrlRefusal`, `bad_request`) and at each poll. Redirects are judged again (5 at most); one 10 s deadline for the chain; 1 MiB counted as it streams; no cookie.
- The parser has no XML library and no entities: RSS items and Atom entries, the five XML entities and numeric references only; `<!DOCTYPE` or `<!ENTITY` anywhere is `not_a_feed`. The first poll marks entries seen and fires nothing; then at most 10 new entries per task, fenced as `feed`.

Precheck:

- It is the owner's command (`/bin/sh -c`, saved with the password step-up), run for schedule, feed and manual fires, never for a webhook. cwd is the trigger's folder.
- Its whole environment is `unattendedEnv(process.env, { keep: [...NETWORK_ENV, ...TOOLING_ENV, ...trigger.execution.env] })`: M9's shared allowlist (`packages/contracts/src/child-env.ts`, re-exported by `kernel/child-env.ts`; owner c7) keeps the proxy, CA and tooling names and the trigger's own variable names (names only), and withholds the SSH agent, `GIT_*`, `LD_*`, provider and cloud key families and credential-looking names even when named.
- The process group is tracked by the kernel (`trackGroup`, `signalGroup`, `releaseGroup`) so `killAllWorkerGroups()` and the exit hook reach it; masked stdio, stdin closed, 4 KiB tail; 30 s, SIGTERM to the group, 2 s, SIGKILL; after SIGKILL and a grace the verdict settles as a timeout and the slot is freed even if the shell does not die. In a systemd scope (`kind: "terminal"`) when scopes are on.
- Bounds: one precheck per trigger at a time, two running in the daemon, scheduler-origin prechecks queue, manual and token ones refuse past 8 waiting. It runs after the pause and budget gates; a refused fire never spawns the command.

## Consequences

- Residual (M10R72): a job the command starts with `setsid` leaves the process group and survives the kill. With systemd scopes the reap ends it; without them it survives. A project trigger's precheck runs as the owner with no sandbox; an agent trigger's precheck always runs in the agent's sandbox (ADR 0048, ADR 0050).
- A value that lives only in an environment variable of a withheld family is not passed; the command sets it inline or reads a file.
- A hostile feed cannot make pap fetch an internal address, expand an entity or hold more than 1 MiB; it can still put 10 fenced entries a poll into a tainted task.
