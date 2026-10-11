# Daemon composition

Code: `apps/daemon/src/daemon.ts` (composition root), `main.ts` (`pap serve`), `shutdown.ts`, `kernel/home.ts`. The test harness is `apps/daemon/src/testing/harness.ts`.

## Start and stop

- `createDaemon(config, deps)` builds everything in one place: home and lock, migrations, receipt purge, auth, sessions, ws, http. Each thing that must be undone is pushed on a list; a start that fails half-way (port taken, migration refused) and `stop()` both run it in reverse, so nothing is left locked or open. `deps` carries the injected clock, logger and worker environment, plus `onFatal` and `announceSetupUrl`.
- Stop order (R104), in `DaemonHandle.stop()`, idempotent (the second call returns the first call's promise): `sessions.shutdownAll()` first, so every worker climbs its kill ladder (shutdown request, SIGTERM, SIGKILL; at most 10 s) and pi-host kills Pi's bash trees on the way; only then `killAllWorkerGroups()`; then ws, http, receipt purge, database, instance lock. The order matters: Pi starts every command in a group of its own, out of reach of a SIGKILL to the worker's group, so killing the groups first leaks those trees. `daemon.boot.int.test.ts` runs a real `sleep` under a worker and fails when the order is swapped.
- `main.ts` turns SIGTERM, SIGINT and SIGHUP into that stop (`shutdown.ts`). A second signal, a failed stop, or `STOP_DEADLINE_MS` (15 s) without a result calls `killAllWorkerGroups()` and exits 1: nothing can keep the process alive. Exit 0 only after a clean stop.
- `--tls-cert` and `--tls-key` are read once, in `loadConfig` (`Config.tls` holds the PEM bytes; the server never reads the files again). A file that cannot be read, a certificate or key that is not PEM (or a key with a passphrase) and a key that does not belong to the certificate each end in a `ConfigError` that names the flag and, for a read, only the errno code (`--tls-cert cannot be read (ENOENT)`): one line, exit 64, never a stack trace from the HTTPS server.
- `pap serve` exits 64 on a bad command line and 1 on a startup refusal an operator can fix (`InstanceLockError`, `HomeError`, `MigrationError`, `EADDRINUSE`/`EACCES`/`EADDRNOTAVAIL`), with one line `pap: <message>`. Anything else keeps its stack trace.

## Server errors

- `startServer` requires `onError`: Node throws an `'error'` that no listener handles (accept failing on EMFILE, say) as an uncaught exception. The daemon logs `server_error` with the error `code` and nothing else, then calls `deps.onFatal("server_error")`; `main.ts` answers with the graceful stop and exit code 1, so the service manager restarts it.
- A database written by a newer pap opens read-only (`read_only_mode` warning at boot). A write that SQLite then refuses (a sign-in, a session that is due to slide) is `503 {"error":{"code":"read_only"}}` on HTTP, the same code the RPC answers, logged as the warn line `http_read_only` instead of an `http_error` stack. `kernel/db/read-only.ts` (`isReadOnlyError`) is the one test for it. The page reads that code from a failed `/auth/status` too, so the gate says the database is read-only instead of "unreachable".
- `onFatal` fires once (R115). A later error is only logged: a second `shutdown.trigger` would count as a second signal and SIGKILL the worker groups before pi-host cleaned up.

## Home, permissions, umask

- `prepareHome` runs before the database is opened: `$PAP_HOME`, `backups/`, `secrets/` and `logs/` are 0700, and `state.db`, `-wal` and `-shm` are 0600 (R68). SQLite gives the WAL and shared-memory file the mode of the database file; snapshots are chmod-ed explicitly. A home or database file an earlier run left more open is tightened at boot (R117); a path that cannot be made private is a `HomeError` naming it. The database files are checked with `lstat` and a symlink among them is skipped, so a chmod never lands on whatever it points to; a symlinked `$PAP_HOME` itself and its directories are followed.
- A home that cannot be chmod-ed refuses to boot (R119): on a volume that ignores or forbids chmod (some container volume drivers, FAT/exFAT, some network file systems) `prepareHome` throws a `HomeError`, and the daemon exits 1 instead of running with a state directory the OS cannot protect. Mount a volume that honours Unix modes, or run with a user that owns it.
- The process umask is 077 from then on, so any file the daemon creates later is private by default.
- Workers do not inherit it (R114). `prepareHome` returns the umask the process had before its first call (module-level, captured once, R114b), the sessions module puts it in every `InitRecord.umask`, and pi-host applies it with `process.umask()` before it opens the Pi session. Files Pi's tools and bash children create in a project get the user's usual modes; state files stay 0600. A worker started without `umask`, or with one outside 0..0o777, refuses to start.

## One daemon per home

- `acquireInstanceLock` (R70) creates `pap.lock` in `$PAP_HOME` before migrating. The file holds `<pid> <start time>` and appears with its content already in it (hard link of a written temp file), so a second instance never reads an empty file. A second daemon exits with `pap is already running on <home> (pid N)`.
- A lock is stale, and replaced, when its pid is gone, when the process now at that pid started at another time (Linux: field 22 of `/proc/<pid>/stat`; this catches a reboot or a pid that wrapped), when its content is unreadable, or when it names our own pid and this process does not hold that path (R116: in an OCI container the daemon is pid 1 every time, so "alive" would be true for ever after a restart).
- Limits: taking over a stale lock is not atomic, so two instances started in the same instant after a crash could both win. Where there is no `/proc` only the pid is compared. A file system without hard links gives an `InstanceLockError` saying so; the hint appears only for the errors a missing `link()` produces (`EPERM`, `ENOTSUP`, `EOPNOTSUPP`, `EXDEV`, `ENOSYS`, `EMLINK`), any other code (`EACCES`, `ENOSPC`, `EROFS`...) is reported as plain `(CODE)`.
- The lock is a pid, so it only works inside one PID namespace: one daemon per `$PAP_HOME`, and never one home on a volume shared by daemons in different PID namespaces (two containers on one volume, a container and the host). Each would see the other's pid as dead or as its own and take the lock over; they would then migrate and write the same database. Give every daemon its own home.

## HTTP headers

- Every response carries the CSP of R74 (`default-src 'self'` and the rest, no inline script) from `secureHeaders`, API and static alike. `connect-src 'self'` covers same-origin ws/wss; if a library needs more, relax one directive and write an ADR.
- HSTS (`max-age=15552000`, no `includeSubDomains`) only when the daemon itself serves TLS: `createHttpApp({ servesTls })` is `config.tls !== null`. Plain HTTP never sends it, because it would pin `localhost` and every other local port for 180 days. A reverse proxy that terminates TLS adds its own.
- A request refused for its Origin (an unsafe-method HTTP request, or a `/ws` upgrade) is answered 403 and logged as the warn line `origin_refused`: `via` (`http` or `ws`), the Origin clipped to 100 characters (`(none)` when absent), `suppressed` (refusals the window swallowed) and a hint naming `PAP_PUBLIC_ORIGIN`. One line per path every 10 s (`createOriginRefusalLog`), never a cookie, header or path. The case it exists for: `--host 0.0.0.0` with no `PAP_PUBLIC_ORIGIN` only accepts the loopback origins, so a browser on the LAN gets a bare "forbidden" otherwise. The startup warning `plain_http_on_network` names `PAP_PUBLIC_ORIGIN` for the same reason.
- `GET /ws?proto=N` is a plain request answering 426 (another protocol), 401 (no session) or 200: the browser cannot read the status of a failed upgrade.

## Setup address

- The one-time setup URL is logged once, as `setup_url` with the field `url` (the logger redacts keys called `token`, not `url`). `main.ts` announces it through a logger fixed at info, so `PAP_LOG_LEVEL=error` does not hide the only way to create the owner (R117); with no `announceSetupUrl` it goes through the daemon's own logger.
- In `--dev` the address and `DaemonHandle.setupUrl` carry the Vite origin (`http://localhost:5173`), because that is where the browser is (R31).
- After the owner exists a restart prints no `setup_url`.

## Tests

- `startTestDaemon(script, { tls?, config?, deps? })` boots a daemon on a free port in a temporary home, on the scripted provider and under the network guard (R94); the worker gets a minimal environment, never the outer process's `PI_*` or `HOME`. It removes its temporary directory when the start fails. Its client rejects a call that gets no response within 30 s and never retries a mutation (R105).
- Workers get the daemon's `--conditions*` and `--import=<file>` node flags and nothing else (`workerExecArgv` in `kernel/config.ts`; write a preload as `--import=<file>`, the two-token form is not forwarded). That is how a preload such as the test network guard reaches the workers of a daemon started from `main.js`.
- `pnpm smoke` (`scripts/smoke-dist.ts`, a step of the CI `build` job after `pnpm build`) runs the built `apps/daemon/dist/main.js` with no `--conditions` against the built `packages/pi-host/dist/main.js`: temporary `HOME`, `PAP_HOME` and `PI_CODING_AGENT_DIR`, `PI_OFFLINE=1`, the scripted provider and the network guard in the daemon and in every worker. It sets the owner up, signs in, opens `/ws`, creates a session, prompts, approves the card, waits for the tool output and `agent_settled`, sends SIGTERM and expects exit 0 and no process left under its `HOME`. Run `pnpm build` first; it prints the daemon's last lines when a step fails. Linux only (it reads `/proc`).
- `main.int.test.ts` runs the real entry point in a child process with a throwaway home.
