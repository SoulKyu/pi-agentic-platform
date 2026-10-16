# ADR 0056: the service unit, readiness and the setup URL from the journal

Status: accepted (M6, Task 7)
Date: 2026-10-15
Spec: A success criterion 3, C section 6. ADR 0004 (loopback HTTP). Rulings: M6R1 to M6R7, M6R13 to M6R17, M6R35 to M6R37, W5-R1, W5-R2, W5-R7, W5-R8.

## Decision

The unit (`apps/daemon/src/cli/service/unit.ts`) is a fixed template with three allowlisted paths (`--node`, `--main`, `--home`, checked by `safePath`: absolute, `[A-Za-z0-9._+@/-]` only, no `..`, no `//`) and one port number:

```
[Unit]            StartLimitIntervalSec=120, StartLimitBurst=5
[Service]         ExecStart=<node> --disable-warning=ExperimentalWarning <main> serve [--port N]
                  Environment=PATH=<node dir>:/usr/local/bin:/usr/bin:/bin
                  Environment=PAP_HOME=<home>            (only when --home is given)
                  NoNewPrivileges=yes, RestrictSUIDSGID=yes, LockPersonality=yes
                  Restart=on-failure, RestartSec=5, KillMode=mixed, TimeoutStopSec=<STOP_DEADLINE_MS/1000 rounded up + 10>
[Install]         WantedBy=default.target
```

No `--host`, `--insecure-http` or `--tls-*`: the daemon stays on loopback. No secret, provider key or M11 env in the unit.

Hardening, measured: `setpriv --no-new-privs bwrap --ro-bind / / --unshare-user --unshare-pid --dev /dev --proc /proc true` exits 0 on the Ubuntu preview host (AppArmor userns profile), and `systemd-analyze verify --user` accepts the unit. Real-host check: not run before the merge (owner, 2026-10-16). CI, the smoke of the installed unit and the measurements above cover what is proven; a real `pap.service` under `NoNewPrivileges` with a worker scope, linger and the archive on a real host are checked in M6b.

Deliberately absent, and why: `ProtectHome`, `PrivateTmp`, `RestrictNamespaces`, `PrivateUsers`, any `SystemCallFilter` without `@mount` and `unshare`: M11's bubblewrap sandbox needs user namespaces and `PAP_BWRAP` is not set by the unit. `UMask` (W5-R8, dropped after review): the daemon sets 077 for its own home and keeps the starting umask for the owner's terminals, workers and lane scripts (R114/R114b); under the unit a `UMask=0077` would make the owner's files 0600. `NoNewPrivileges` is M6's call (W5-R7): M11 depends on no directive; if a worker scope fails under it, it is dropped alone and this ADR is amended. Cost if wrong: a stricter unit is a one-line follow-up (M6b).

Start limit (W5-R1): kept instead of `RestartPreventExitStatus=1`, because a real crash also exits 1 and must restart a few times. 5 starts in 120 s bound a port that is taken; readiness, not `is-active`, tells the owner.

KillMode=mixed (W5-R19): the main process alone gets SIGTERM; the rest of the cgroup gets SIGKILL as soon as the main process exits or at `TimeoutStopSec`, whichever comes first (systemd.kill(5)). With worker scopes off (linger refused) the workers sit in the unit's cgroup, and the daemon's own graceful kill ladder must run first. Cost if wrong: when the daemon crashes with scopes off, its leftover tool processes get SIGKILL instead of SIGTERM.

Install retries (final review I1): the start limit counts manual starts, so `pap service install` and the archive rollback run `systemctl --user reset-failed pap.service` (result ignored) before `restart`. A volatile journal (I2, W5-R18) is reported with exit code 3, not as a failed start.

No instance lock (M6R1): `pap service` commands never open `$PAP_HOME`, so they work while pap runs (reinstall) and create no home as a side effect.

Readiness is the daemon's own `listening` journal line, not `is-active` (`Type=simple` says active while the port is taken): `listening` with a loopback `http:` setup URL on the installed port prints it; `listening` alone on two consecutive reads means an owner exists (the daemon logs `listening` just before `setup_url`; this is the only case where that is said); no line after 40 reads (about 20 s) is exit 1 with `journalctl --user -u pap -n 30` and no URL. When the journal shows nothing at all for `pap.service` since the restart (`journalctl --user -u pap.service --since <restart>`, no `_SYSTEMD_USER_UNIT` match), the install is unverified, not failed: exit 3 and its own sentence (W5-R18, W5-R22).

Setup URL via the journal. Measured on the preview host (systemd 259): user-unit journal lines carry `_SYSTEMD_INVOCATION_ID` (equal to the unit's `InvocationID`) and no `USER_INVOCATION_ID`. The trusted selection is `journalctl --user -u pap -q _SYSTEMD_USER_UNIT=pap.service _SYSTEMD_INVOCATION_ID=<id> -o cat`; `-u` plus a field match is an AND (a mismatching field returns nothing). When that stays empty for 4 reads, the command retries with `--since "<UTC time>"` (format validated) and the same unit fields; a user cannot forge `_SYSTEMD_USER_UNIT`. Real-host check: not run before the merge (owner, 2026-10-16). CI, the smoke of the installed unit and the measurements above cover what is proven; a real `pap.service` under `NoNewPrivileges` with a worker scope, linger and the archive on a real host are checked in M6b.

The one-time token sits in the persistent user journal until used, readable by members of `adm` / `systemd-journal` and by the owner's own processes outside an agent sandbox (M11 hides `/var/log` and `/var/tmp` from agent shells). The setup lines are also copied to `/var/log/syslog` (readable by `adm`) when rsyslog forwards the journal. `pap service url` prints the current start's URL. Fallback if the journal is persistent and group-readable on a shared host: a 0600 file under `$PAP_HOME`; it touches the auth module, so it is a separate owner decision, not M6.

Launcher (M6R37): `pap service install` writes `<bin-dir>/pap` (default `~/.local/bin`, mode 0755, fixed text with a marker, `PAP_HOME` only with `--home`, `exec '<node>' ... '<main>' "$@"`), atomically. A regular file without the marker or a symlink is foreign: never replaced. `uninstall` removes it only when it carries the marker. `PATH` is never edited.

## Consequences

- Reinstall restarts the service (running turns are cut, `~/.pap` stays); the command says so.
- `systemctl`, `loginctl`, `journalctl` are started with argument lists, a filtered env, a timeout and an output cap; raw stderr is never shown.
