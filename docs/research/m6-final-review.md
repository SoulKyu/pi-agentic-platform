# M6 final whole-branch review (Opus, 2026-10-16)

Range 810b6be..6233151, then one fix round (e9dbb74, 6e4a07c) and a residual fix (4ca63bb), each re-reviewed by Opus: all items addressed, "ready to merge: yes". Merged as d7c3a40 (squash). The real-host check was not run before the merge (owner, 2026-10-16); it moves to M6b.

**Final review: M6 "KISS install" (`810b6be..6233151`, branch `feat/m6-install`)**

I reviewed every changed file as it stands at head 6233151 rather than reading the 236 KB diff file top to bottom. New files were read in full, shared files through `git diff`, plus the plan, the controller rulings and the ledger. Probes I ran, none of which touch systemd:
- The four focused unit test files: 71 passed.
- I booted the built daemon in a scratch HOME (no `XDG_RUNTIME_DIR`) to check the order of its log lines.
- I ran the filled template in scratch to reproduce M3.
- I read `~/.config/systemd/user/pap-preview.service` (read-only) to answer the owner-host question.

I never ran the real `systemctl --user`, `loginctl` or `systemd-run`.

## 1. Strengths

- **One code path.** Both scripts are thin, and `pap service install` owns the unit, the launcher, linger, readiness and the summary. Flags, paths, port 7777, `~/.pap`, `/setup#token=`, the launcher and the summary lines agree end to end for both methods.
- **Small injection surface.**
  - `safePath` allowlists every path that goes into the unit and the launcher; the port is an integer.
  - Unit names, invocation ids and the `--since` value are validated before anything is spawned.
  - Every spawn uses an argument list, a five-name environment, a timeout and an output cap, and reports a fixed sentence, never the child's stderr.
- **Readiness is the daemon's own `listening` line.** It is selected on trusted journal fields (`_SYSTEMD_USER_UNIT` AND the invocation id), and the `is-active` trap is tested.
- **The archive installer follows the ADR 0057 threat model.**
  - `HOME` is validated before anything is written.
  - The hash, the listing and the extraction all read one private copy.
  - `TAR_OPTIONS` is unset.
  - The listing parser uses numeric owners, and the extracted tree is re-checked with `find` and `readlink -m`.
  - `current` is switched only after verification, restored on failure, and pruning runs last and only warns.
- **The builder does not leak secrets or paths.** The `.npmrc` is allowlisted, manifests are scanned for credentials, `.bin` shims and node-gyp leftovers are stripped, a leak scan fails closed, template values are validated, and the tar flags are deterministic.
- **Tests are isolated and the fakes are honest.** Every test uses a temp HOME, fakes first on `PATH` and no `XDG_RUNTIME_DIR`. I checked that an empty `PATH` gives ENOENT rather than falling back to `/usr/bin`. The smoke test boots the unit's own `ExecStart` under `setpriv --no-new-privs`.
- **The docs are honest** about what the checksum proves, the token held in the journal (including the syslog copy) and the checkout caveat. The flake fix in 379f611 is correct and minimal.

## 2. Issues

### Critical
None.

### Important

**I1. systemd's start limit blocks the documented retry and the rollback restart.**
- **Where:**
  - `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m6/apps/daemon/src/cli/service/install.ts:164-168`: `restart` with no `reset-failed` first.
  - `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m6/scripts/archive-install.sh.tpl:57`: the rollback restart.
  - `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m6/apps/daemon/src/cli/service/unit.ts:44-45,54-55`: 5 starts in 120 s, `Restart=on-failure`, `RestartSec=5`.
- **What:** `man systemd.unit` on this host says start limits "apply to all kinds of starts (including manual)", and only `systemctl reset-failed` clears the counter early. Readiness gives up after about 21–22 s. Two cases follow:
  - **Port taken or home locked.** About 4–5 starts have happened when the install exits 1. The troubleshooting row says "use `--port`". A rerun within 2 minutes then fails with `systemctl restart failed (exit 1)`. That rerun takes seconds with method 2, or with `pap service install --port N` through the launcher.
  - **A new release that crashes fast (about 0.2 s), installed over a healthy service.** systemd starts it at roughly 0, 5, 10, 15 and 20 s. The rollback's restart at about 22 s is the sixth start and is refused. The old release is back in `current` but the service is down. The printed advice `systemctl --user restart pap.service` is refused too, for up to 120 s. This breaks Review Focus 2: "a failed second install … restarts it".
- **Fix:**
  - Run `systemctl --user reset-failed pap.service` (result ignored) before `restart` in `install.ts` and in the template's `cleanup`.
  - Add a test that pins the call order, and a troubleshooting row.
  - Verify on the real host. I expect the counter survives `daemon-reload` on systemd 259; the fix is harmless if it does not.

**I2. On a host with a volatile journal, every install reports failure, and method 2 then takes apart a running install.**
- **Where:**
  - `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m6/apps/daemon/src/cli/service/systemd.ts:77-90,150-155`
  - `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m6/apps/daemon/src/cli/service/readiness.ts:23-32`
  - `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m6/scripts/archive-install.sh.tpl:65-67`
  - `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m6/docs/agents/install.md:7-15,126,128`
- **What:** `man journalctl` on this host: "Note that --user only works if persistent logging is enabled". `journald.conf(5)` says per-user journal files exist only with persistent storage. This applies with `Storage=volatile`, or `Storage=auto` without `/var/log/journal`. To my knowledge that is the RHEL/Alma/Rocky default, Debian ≤ 11 with rsyslog, and Raspberry Pi OS; I have not verified those here. On such a host:
  - Every read returns nothing, so after about 20 s the install says "pap did not start listening" while the daemon is actually serving.
  - `pap service url` says "not listening yet", and the hint `journalctl --user -u pap` also shows nothing.
  - A method 2 first install then runs `rm -f current` under the running daemon. The unit and `~/.local/bin/pap` point at nothing, and the next restart fails. The documented stop / `pap serve` / start fallback uses that broken launcher.
  - On a reinstall, a healthy release is rolled back.
- **Docs:** row 128 says a volatile journal only loses the URL at reboot, which is wrong. The prerequisites do not list a persistent journal.
- **Fix, minimum:**
  - Add a persistent-journal line to the prerequisites and the troubleshooting table.
  - Detect "the journal shows nothing at all for pap": `journalctl --user -u pap.service --since <restart>`, without the `_SYSTEMD_USER_UNIT` match, includes the user manager's own "Started pap.service" line. Empty output therefore means the journal is unreadable, not that the daemon never bound.
  - Report that case with its own sentence, and do not treat it as a failed release in the template.
- **Needs a ruling (owner/controller):** a reader without `--user` (`--user-unit=pap.service _UID=<uid> _SYSTEMD_USER_UNIT=pap.service`, which works for `adm`/`systemd-journal` members), or the 0600-file fallback already parked under M6R35/Q5.

### Minor

**M1. Readiness can be wrong in narrow windows.**
- **Owner claim on a fresh install.** `serve` logs `listening` (`daemon.ts:332`) before `setup_url` (`main.ts:78`). I confirmed this by booting the built daemon: the two lines are adjacent and carry the same millisecond. A journal read that lands between the two entries prints "an owner already exists" on a fresh install (`readiness.ts:27-28`). That contradicts ADR 0056 ("the only case where that is said"). The probability is low: a sub-millisecond window against a 500 ms poll.
- **Stale URL.** In `systemd.ts:153-154`, the `--since` fallback runs on every early read while the new process boots, using a start time floored to the second. Two installs within the same second can therefore show the previous start's dead URL.
- **Log level.** `PAP_LOG_LEVEL=warn` in the user manager's environment (environment.d) hides `listening`, so every install fails.
- **Fix:** count `listening` without a URL as "owner" only on a second consecutive read; use `--since` only after several empty reads; accept only a URL whose port equals the installed port.

**M2. What a failed install leaves behind is not reported.**
- This goes beyond the deferred T2 minor, which covered enable/restart failures, not the never-listening path.
- After the unit is written, a never-listening outcome leaves `pap.service` enabled, and it retries at every boot (`install.ts:153-177`).
- On a first archive install, `current` is also removed (`archive-install.sh.tpl:65-67`). The unit and the launcher then point at nothing, so `pap service uninstall` through the launcher cannot run. The message only names the journal.
- **Owner host:** an install without `--home` binds 127.0.0.1:7777 beside the preview's 192.168.1.182:7777, then fails on the `~/.pap` lock. It leaves an enabled `pap.service` that races `pap-preview` for `~/.pap` at the next boot. `pap-preview` has `Restart=always` and would loop.
- **Fix:** print what remains and the exact undo commands, or `disable` the unit on the never-listening path.

**M3. Reinstalling the same release id prunes the rollback target.**
- In `/home/ubuntu/Workspace/soulkyu/pi-agentic-platform/.worktrees/feat-m6/scripts/archive-install.sh.tpl:142,153-158`, `previous` becomes the new id itself. Reproduced in scratch: install r1, then r2, then r2 again leaves only r2.
- **Fix:** keep the newest other complete release, or skip pruning on a same-id install. Add a test; none covers this today.

**M4. Settings are not carried across a reinstall.**
- `install.ts:131-135` keeps no memory of earlier flags. Running `./pap-install-<new>.sh` without the original `--home/--port/--bin-dir` silently moves the service to `~/.pap` on 7777 and prints a fresh setup URL, which looks like data loss. `install.md:84-91` only says "run the installer again".
- An exported `PAP_HOME` is ignored by the unit. The launcher sets no `PAP_HOME` without `--home`, so recovery commands follow the shell's `PAP_HOME`. The service and `pap passkey reset` can then target different homes.
- **Fix:** read the existing unit's home and port and warn when they change; warn when `PAP_HOME` is set without `--home`; add a doc line.

**M5. The KillMode carry is still open** (ledger line 19).
- The unit uses the default `KillMode=control-group` (`unit.ts:47-56`). When worker scopes are off (linger refused, a supported degraded mode), a stop or restart sends SIGTERM to workers and their tool processes at the same time as the daemon. That cuts short the daemon's own graceful kill ladder.
- It is neither on the real-host list nor ruled on.
- **Fix:** add `KillMode=mixed` with a test and an ADR 0056 line, or record a ruling.

**M6. Doc drift.**
- `README.md:23` "prints it again until used", and `install.md:104`: once the owner exists, `pap service url` keeps printing the spent URL until the next restart.
- `install.md:26` says changes take effect "on its next restart". A rebuild changes newly forked workers (`main.ts:28`) and the served web files at once, because Vite empties `apps/web/dist`. A failed rebuild during a method 1 reinstall leaves the running service without them. ADR 0055 words this correctly.
- `install.sh:9` accepts any Linux architecture, while the plan's global constraint is "other platforms are refused". Either add the refusal or relax the doc and plan.

**M7. Nit.** `systemd.ts:68` uses `args[1]`, so a journalctl failure reads "journalctl -q failed (exit N)".

## 3. Recommendations

- Fix I1, I2 (at least the minimum) and the first bullet of M1 before merge; the rest can follow.
- **For the real-host check (W5-R2):**
  - **Archive:** the user manager reads only its own `~/.config/systemd/user`, so an archive install into a temp HOME fails at `systemctl enable`. Use the real HOME with `--home ~/.pap-m6-try --bin-dir ~/.pap-m6-try/bin`, or a throwaway account. Remove `~/.local/share/pap` afterwards.
  - **Method 1:** run it from a separate clone, never from the preview's checkout, because `install.sh` rebuilds `dist` in place.
  - **Extra cases:** a taken port or locked home followed by a rerun within 2 minutes (I1), a KillMode check with scopes off (M5), and `systemctl --user show pap -p NoNewPrivileges,KillMode`.
  - **Afterwards:** confirm no `pap.service` remains enabled (M2).
- **Expected outcome of that check:**
  - I expect it to pass on `NoNewPrivileges` with a worker scope: `systemd-run --scope` needs no privilege, AppArmor allows transitions from an unconfined process under no_new_privs, and bwrap under setpriv was measured.
  - I also expect it to pass on the journal field (already verified) and on linger.
  - Two things could fail: I1 if a quick retry is tried, and the archive at runtime if anything in the production dependencies needs a `.bin` shim (unknown).

## 4. Declined to judge

1. The journal as the setup-URL channel, and the token's exposure there: owner decision i5 / M6R35. I only flag the volatile-journal gap (I2).
2. The unit's fixed `PATH`, so agent tools miss `~/.local/bin`, nvm and `/snap/bin` (terminals get them through login shells): deliberate under M6R3 and M6R43.
3. `XDG_CONFIG_HOME` taken from the CLI's environment while the user manager searches its own: mandated by the plan (T2 "Produces").
4. A hand-written `~/.config/systemd/user/pap.service` is replaced without a foreign-file check: the plan asks for that check on the launcher only.
5. `uninstall` leaves a `pap.service.d/` drop-in behind: reinstalling with it is arguably intended (the PAP_BWRAP drop-in).
6. Shared libraries of the bundled Node other than glibc (libstdc++) are not checked: an accepted cost under M6R11.
7. bash reads the installer script lazily, so the same user could rewrite it mid-run: same-user threat, outside ADR 0057.
8. The 20 s readiness window also triggers the archive rollback, so a slow first boot (a long migration) rolls back onto an old binary that opens the database read-only: health-checked updates are M6b.
9. Lines injected into the journal from inside `pap.service`'s cgroup when scopes are off: there is no realistic window before an owner exists; covered as defence in depth in M1.
10. The builder's home (`/root` in a container) used as a leak-scan needle could fail a build closed: it fails safe, and I did not verify it because your rules forbid searching `node_modules`.
11. `DEFAULT_PORT` is duplicated in `install.ts`, and the "listening on" line is built from the flag rather than the daemon's line: cosmetic.
12. `NODE_OPTIONS` and similar variables in the user manager's environment reach the daemon: the same as under `pap serve`.
13. No `After=network-online.target`: the service is loopback only.

## 5. Assessment

**Ready to merge: With fixes.** The security posture and the agreement between the two methods are solid. I1 breaks the plan's own "failed second install restarts the first" promise and the documented port-taken retry. I2 makes the install report false failures, and method 2 dismantle a working install, on hosts with a volatile journal. Both are cheap to fix or to document, and I2 also needs a ruling on a fallback reader.