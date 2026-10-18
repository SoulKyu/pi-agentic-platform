#!/usr/bin/env bash
# pap installer for one archive. The checksum below is pinned by scripts/build-archive.ts: it is the only integrity check.
# Exit status: 0 success; 1 every other failure; 3 installed but unverified; 4 update failed and rolled back; 5 update failed, rollback incomplete.
# Exit 3 means "pap service install" or "pap update apply" exited 3 (the user journal is unreadable): no rollback, "current" stays,
# and the summary says why. A script never reads it as success (W5-R22). Exits 4 and 5 come from "pap update apply" (M6bR11).
set -euo pipefail
umask 077
unset PAP_UNIT     # the unit is always pap.service here: a PAP_UNIT of the caller must not redirect update apply to another unit
unset TAR_OPTIONS   # a user-set tar option (-P, --exclude, ...) must not change how the archive is read

readonly EXPECTED_SHA256="@@SHA256@@"
readonly RELEASE_ID="@@RELEASE_ID@@"
readonly ARCHIVE_NAME="@@ARCHIVE_NAME@@"
readonly MIN_GLIBC="@@MIN_GLIBC@@"

die() { printf 'pap-install: %s\n' "$*" >&2; exit 1; }
warn() { printf 'pap-install: warning: %s\n' "$*" >&2; }

[ "$(id -u)" -ne 0 ] || die "do not run as root: pap is a user service"
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || die "this archive is for linux-x64"
case "${HOME:-}" in /*) ;; *) die "HOME must be an absolute path" ;; esac
case "$HOME" in
  *[!A-Za-z0-9._+@/-]* | *//* | */ | */. | */./* | */.. | */../*)
    die "HOME holds a character that is not safe in a systemd unit (only letters, digits and . _ + @ / - are allowed): method 1 (scripts/install.sh) works only with a safe --bin-dir; see docs/agents/install.md" ;;
esac
[ "${#HOME}" -le 900 ] || die "HOME is too long"
for tool in tar sha256sum awk sort getconf systemctl cp find readlink; do
  command -v "$tool" >/dev/null 2>&1 || die "missing tool: $tool"
done
systemctl --user show-environment >/dev/null 2>&1 \
  || die "no systemd user manager (log in with a full session, or set XDG_RUNTIME_DIR=/run/user/$(id -u))"
host_glibc="$(getconf GNU_LIBC_VERSION 2>/dev/null | cut -s -d' ' -f2)" || host_glibc=""
[ -n "$host_glibc" ] || die "cannot read the glibc version: this archive needs glibc"
[ "$(printf '%s\n%s\n' "$MIN_GLIBC" "$host_glibc" | sort -V | head -n1)" = "$MIN_GLIBC" ] \
  || die "glibc $host_glibc is older than $MIN_GLIBC, which this archive was built against"
bwrap_path="${PAP_BWRAP:-/usr/bin/bwrap}"
{ [ -x "$bwrap_path" ] && [ "$(stat -c %u -- "$bwrap_path")" = 0 ]; } \
  || warn "bubblewrap not found: agents that require the sandbox will not start (sudo apt install bubblewrap)"

source_archive="$(cd -- "$(dirname -- "$0")" && pwd -P)/$ARCHIVE_NAME"
[ -f "$source_archive" ] && [ ! -L "$source_archive" ] || die "$ARCHIVE_NAME must sit next to this script (and not be a symbolic link)"

app="$HOME/.local/share/pap"
rel="$app/releases/$RELEASE_ID"
mkdir -p -m 700 "$app" "$app/releases"
chmod 700 -- "$app" "$app/releases"   # an older, looser folder is tightened
chmod -R u+rwX -- "$app"/releases/.stage.* 2>/dev/null || true   # a failed extraction may leave a folder nobody can read
rm -rf -- "$app"/releases/.stage.*   # leftovers of an installer that was killed; one installer at a time
stage="$(mktemp -d "$app/releases/.stage.XXXXXX")"
switched=0
previous=""
case "${XDG_CONFIG_HOME:-}" in /*) unit_file="$XDG_CONFIG_HOME/systemd/user/pap.service" ;; *) unit_file="$HOME/.config/systemd/user/pap.service" ;; esac
unit_saved=0   # 1 once the unit file as it was is kept in the stage, 2 once a symlinked unit's target is kept in unit_link; the trap puts it back (M6b-C13)
unit_link=""
launcher_file=""
launcher_saved=0   # 1: the launcher as it was is kept in the stage; 2: there was none. "pap service install" rewrites it, the trap puts it back.
cleanup() {
  status=$?
  set +e   # every step runs, whatever an earlier one did
  if [ "$status" -ne 0 ] && [ "$switched" = 1 ] && [ "$launcher_saved" != 0 ]; then
    if [ "$launcher_saved" = 1 ]; then
      if cp -p -- "$stage/launcher.prev" "$launcher_file.restore" && mv -T -- "$launcher_file.restore" "$launcher_file"; then
        printf 'pap-install: the previous launcher was restored\n' >&2
      else
        rm -f -- "$launcher_file.restore"
        printf 'pap-install: could not restore the previous launcher %s: check it by hand\n' "$launcher_file" >&2
      fi
    elif [ ! -L "$launcher_file" ]; then
      rm -f -- "$launcher_file"   # there was none before: the one the failed install wrote goes away
    fi
  fi
  if [ "$status" -ne 0 ] && [ "$switched" = 1 ] && [ "$unit_saved" != 0 ]; then
    # "pap service install" may have rewritten the unit (new port, home or release path): the previous one comes back first.
    # A symlinked unit comes back as a symlink to the same target, never as a regular file.
    if { if [ "$unit_saved" = 2 ]; then ln -sfn -- "$unit_link" "$unit_file.restore"; else cp -p -- "$stage/unit.prev" "$unit_file.restore"; fi; } \
       && mv -T -- "$unit_file.restore" "$unit_file"; then
      systemctl --user daemon-reload >/dev/null 2>&1
      printf 'pap-install: the previous unit file was restored\n' >&2
    else
      rm -f -- "$unit_file.restore"
      printf 'pap-install: could not restore the previous unit file %s: check it by hand\n' "$unit_file" >&2
    fi
  fi
  chmod -R u+rwX -- "$stage" 2>/dev/null
  rm -rf -- "$stage"
  if [ "$status" -ne 0 ] && [ "$switched" = 1 ]; then
    if [ -n "$previous" ]; then
      if ln -sfn -- "releases/$previous" "$app/current.new" && mv -T -- "$app/current.new" "$app/current"; then
        systemctl --user reset-failed pap.service >/dev/null 2>&1   # the start limit counts manual starts too
        if systemctl --user restart pap.service >/dev/null 2>&1; then
          printf 'pap-install: the previous release (%s) is back in place and the service was restarted on it\n' "$previous" >&2
        else
          printf 'pap-install: the previous release (%s) is back in place; restarting failed: run systemctl --user restart pap.service\n' "$previous" >&2
        fi
      else
        printf 'pap-install: could not put the previous release (%s) back: "current" still points at the new one\n' "$previous" >&2
      fi
    else
      rm -f -- "$app/current"
    fi
  fi
}
trap cleanup EXIT
# A signal must end in the same cleanup with a failing status (bash hands the EXIT trap $?=0 otherwise, and nothing is restored).
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# From here on only the private copy is read: the file next to this script is never named again.
copy="$stage/archive.tar.gz"
cp -- "$source_archive" "$copy"
actual="$(sha256sum -- "$copy" | cut -d' ' -f1)"
[ "$actual" = "$EXPECTED_SHA256" ] || die "checksum mismatch: nothing was installed (expected $EXPECTED_SHA256, got $actual)"

# Defence in depth (the checksum already pins the content): every member sits under pap-<id>/ without a ".." segment,
# only files, directories and links are allowed, and no link points outside the release folder. The listing is read with
# numeric owners (no spaces in the columns) and links whose target could confuse the parser are refused.
LC_ALL=C tar --numeric-owner -tvzf "$copy" 2>/dev/null | LC_ALL=C awk -v prefix="pap-$RELEASE_ID/" '
  function escapes(base, target,    n, i, depth, seg) {
    if (substr(target, 1, 1) == "/") return 1
    depth = 0
    n = split(base "/" target, seg, "/")
    for (i = 1; i <= n; i++) {
      if (seg[i] == "" || seg[i] == ".") continue
      if (seg[i] == "..") { depth--; if (depth < 1) return 1; continue }
      depth++
    }
    return 0
  }
  {
    type = substr($0, 1, 1)
    if (type != "-" && type != "d" && type != "l" && type != "h") { bad = 1; next }
    if (!match($0, /^[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +[^ ]+ +/)) { bad = 1; next }
    rest = substr($0, RLENGTH + 1)
    name = rest
    if (type == "l") {
      i = index(rest, " -> ")
      if (i == 0) { bad = 1; next }
      name = substr(rest, 1, i - 1); base = name; sub(/[^\/]*$/, "", base)
      target = substr(rest, i + 4)
      if (target ~ / -> / || escapes(base, target)) bad = 1
    } else if (type == "h") {
      i = index(rest, " link to ")
      if (i == 0) { bad = 1; next }
      name = substr(rest, 1, i - 1); target = substr(rest, i + 9)
      if (target ~ / link to / || index(target, prefix) != 1 || target ~ /(^|\/)\.\.(\/|$)/) bad = 1
    }
    if (index(name, prefix) != 1 || name ~ /(^|\/)\.\.(\/|$)/) bad = 1
  }
  END { exit bad }' || die "the archive holds a path or a link outside pap-$RELEASE_ID/, a member that is not a file, folder or link, or a listing this installer cannot read (GNU tar is required)"

mkdir -m 700 "$stage/x"
tar -xzf "$copy" -C "$stage/x" --no-same-owner --no-same-permissions 2>/dev/null \
  || die "could not extract the archive"
top="$stage/x/pap-$RELEASE_ID"
{ [ -d "$top" ] && [ ! -L "$top" ]; } || die "the release folder in the archive is not a plain folder"
# Defence in depth after the listing check: nothing but files, folders and links, and every link stays in the release.
# A folder with a restrictive mode (and a failing find) must not hide anything: modes are opened first, and a find
# that fails is fatal.
chmod -R u+rwX -- "$stage/x" 2>/dev/null || die "could not read the extracted archive"
odd_list="$stage/odd.list"
link_list="$stage/link.list"
find "$stage/x" ! -type f ! -type d ! -type l -print0 > "$odd_list" 2>/dev/null || die "could not read the extracted archive"
[ ! -s "$odd_list" ] || die "the archive holds a member that is not a file, folder or link"
find "$stage/x" -type l -print0 > "$link_list" 2>/dev/null || die "could not read the extracted archive"
top_real="$(readlink -m -- "$top")"
while IFS= read -r -d '' link; do
  case "$(readlink -m -- "$link")" in
    "$top_real" | "$top_real"/*) ;;
    *) die "the archive holds a link that points outside pap-$RELEASE_ID/" ;;
  esac
done < "$link_list"
complete() { [ -x "$1/node/bin/node" ] && [ -f "$1/app/apps/daemon/dist/main.js" ]; }
complete "$top" || die "the archive holds no node runtime or no daemon"

if [ -e "$rel" ] && ! complete "$rel"; then rm -rf -- "$rel"; fi   # a half-moved or corrupted earlier folder
if [ ! -e "$rel" ]; then mv -T -- "$top" "$rel"; fi

if [ -L "$app/current" ]; then previous="$(basename -- "$(readlink -- "$app/current")")"; fi

# update/op.lock (M6bR51): "<pid> <process start time>". Prints the pid when that process is alive and is the one that wrote it.
op_lock_holder() {
  local pid="" started="" now
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  read -r pid started < "$1" || true
  case "$pid" in "" | *[!0-9]*) return 1 ;; esac
  now="$(awk '{ sub(/^.*\) /, ""); print $20 }' "/proc/$pid/stat" 2>/dev/null)" || return 1
  [ -n "$now" ] && [ "$now" = "$started" ] || return 1
  printf '%s' "$pid"
}

check_op_lock() {
  # Over an installed pap it must not interleave with an update, rollback, recover or restore (M6bR51). Read-only check of
  # update/op.lock in every home that could be the service's: the --home flag, the installed unit's PAP_HOME (drop-ins
  # included; the last Environment= reset wins), and ~/.pap when the unit names none. The shell's PAP_HOME is not one
  # (service install and update apply ignore it). The installer writes no lock itself (M6b-C4).
  if [ -n "$previous" ]; then
    unit_home="$(systemctl --user cat pap.service 2>/dev/null | awk '{ sub(/^[ \t]+/, "") } /^Environment=[ \t]*$/ { h = ""; next } /^Environment=/ { n = split(substr($0, 13), a, /[ \t]+/); for (i = 1; i <= n; i++) if (a[i] ~ /^PAP_HOME=/) h = substr(a[i], 10) } END { print h }')" || unit_home=""
    homes=("${unit_home:-$HOME/.pap}")
    want_home=0
    for arg in "$@"; do
      if [ "$want_home" = 1 ]; then homes+=("$arg"); want_home=0; continue; fi
      case "$arg" in --home) want_home=1 ;; --home=*) homes+=("${arg#--home=}") ;; esac
    done
    for pap_home in "${homes[@]}"; do
      if holder="$(op_lock_holder "$pap_home/update/op.lock")"; then
        die "another pap update, rollback, recover or restore is running (pid $holder): wait for it to finish, then run this installer again"
      fi
    done
  fi
}

new_node="$rel/node/bin/node"
new_main="$rel/app/apps/daemon/dist/main.js"
status=0
unverified=0
if [ -n "$previous" ] && [ "$previous" != "$RELEASE_ID" ] && [ "$#" -eq 0 ]; then
  # An update of an installed pap, with no flags: the unit stays as it is. The NEW release's own CLI stops the service,
  # snapshots the database, switches `current`, restarts, probes and rolls everything back on failure (M6bR11, ADR 0064).
  # It takes update/op.lock itself; this script holds none, so the two cannot deadlock and a busy lock makes it refuse.
  if ! "$new_node" --disable-warning=ExperimentalWarning "$new_main" update apply --help >/dev/null 2>&1; then
    die "release $RELEASE_ID has no 'pap update apply' (it is older than the update feature): it cannot replace a running install with an automatic rollback. To reinstall it anyway, run this installer with explicit flags (for example --port 7777); there is then no rollback"
  fi
  "$new_node" --disable-warning=ExperimentalWarning "$new_main" update apply --release="$RELEASE_ID" || status=$?
  case "$status" in
    0) ;;
    3) unverified=1 ;;
    4) printf 'pap-install: the update failed; the previous release (%s) was restored and is running (details above)\n' "$previous" >&2; exit 4 ;;
    5) printf 'pap-install: the update failed and the rollback is INCOMPLETE: run: pap update recover (then: systemctl --user status pap)\n' >&2; exit 5 ;;
    *) die "pap update apply failed (exit code $status); if it was interrupted, run: pap doctor" ;;
  esac
elif [ "$previous" = "$RELEASE_ID" ] && [ "$#" -eq 0 ] && [ -f "$unit_file" ] && [ ! -L "$unit_file" ]; then
  # The installed release again, with no flags and a unit already installed: the unit is never rewritten (a re-render with
  # defaults would move a service started with --port/--home to 7777 and ~/.pap, M6b-C13). Restart it, nothing else.
  check_op_lock "$@"
  systemctl --user reset-failed pap.service >/dev/null 2>&1   # the start limit counts manual starts too
  systemctl --user restart pap.service >/dev/null 2>&1 || die "release $RELEASE_ID is already installed; restarting failed: run systemctl --user restart pap.service"
  printf 'pap-install: release %s is already installed; restarted pap.service (the unit was not changed: pass the original flags to change it)\n' "$RELEASE_ID"
else
  # First install, a re-install of the same release with flags, or an explicit re-install with flags (M6 behaviour, unchanged).
  check_op_lock "$@"
  if [ -L "$unit_file" ]; then
    if unit_link="$(readlink -- "$unit_file")"; then unit_saved=2; fi
  elif [ -f "$unit_file" ] && cp -p -- "$unit_file" "$stage/unit.prev"; then
    unit_saved=1
  fi
  # The launcher lives in the --bin-dir given (last one wins, both spellings), else ~/.local/bin; a relative one is pap's to refuse.
  bin_dir="$HOME/.local/bin"
  want_bin=0
  for arg in "$@"; do
    if [ "$want_bin" = 1 ]; then bin_dir="$arg"; want_bin=0; continue; fi
    case "$arg" in --bin-dir) want_bin=1 ;; --bin-dir=*) bin_dir="${arg#--bin-dir=}" ;; esac
  done
  case "$bin_dir" in
    /*)
      launcher_file="$bin_dir/pap"
      if [ -L "$launcher_file" ]; then :   # not ours: pap leaves it alone
      elif [ -f "$launcher_file" ]; then
        if cp -p -- "$launcher_file" "$stage/launcher.prev"; then launcher_saved=1; fi
      elif [ ! -e "$launcher_file" ]; then
        launcher_saved=2
      fi ;;
  esac
  ln -sfn -- "releases/$RELEASE_ID" "$app/current.new"
  mv -T -- "$app/current.new" "$app/current"
  switched=1
  node="$app/current/node/bin/node"
  main="$app/current/app/apps/daemon/dist/main.js"
  "$node" --disable-warning=ExperimentalWarning "$main" service install --node "$node" --main "$main" "$@" || status=$?
  if [ "$status" -eq 3 ]; then unverified=1; elif [ "$status" -ne 0 ]; then die "pap service install failed (exit code $status)"; fi
fi

# Reinstalling the release that is already current would make it its own rollback target and prune the real one.
if [ "$previous" != "$RELEASE_ID" ]; then
  for dir in "$app"/releases/*/; do
    dir="${dir%/}"   # a trailing slash would make rm follow a symbolic link
    name="$(basename -- "$dir")"
    [ ! -L "$dir" ] || continue
    [ "$name" = "$RELEASE_ID" ] || [ "$name" = "$previous" ] || rm -rf -- "$dir" || warn "could not remove the old release $name: remove it by hand"
  done
fi

if [ "$unverified" = 1 ]; then
  switched=0   # first: a failed write below must not roll back a release that is installed and running
  printf 'pap-install: installed but NOT verified: the user journal is not readable (a volatile journal?), so the start of pap could not be checked.\n'
  printf 'pap-install: pap may be running: systemctl --user status pap (see "Prerequisites" in docs/agents/install.md)\n'
  exit 3
fi
