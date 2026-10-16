import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Executable fakes for systemctl, loginctl, journalctl and node. Each call is appended to `<dir>/calls` as
 * "<bin> <args>" and the names of its environment variables to `<dir>/env-keys`; answers come from `<dir>/answers/`:
 * load-state, active-enter, enabled (kept by enable, disable and is-enabled; absent means not enabled), linger, linger-after-enable (copied to linger by enable-linger), active, invocation-id, journal, journal-since, journal-any (the unmatched query: defaults to a manager line), node-version, hang-<verb>, fail-<verb>, flood-<verb> (2 MB of output).
 * `is-active` answers yes whatever the journal says: that is the Type=simple trap.
 */
export function fakeSystemd(dir: string) {
  const binDir = join(dir, "bin");
  const answers = join(dir, "answers");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(answers, { recursive: true });
  const script = (body: string) =>
    [
      "#!/bin/sh",
      `A='${answers}'`,
      'bin=$(basename "$0")',
      `echo "$bin $*" >> '${join(dir, "calls")}'`,
      `echo "$bin $#" >> '${join(dir, "argc")}'`,
      `env | cut -d= -f1 >> '${join(dir, "env-keys")}'`,
      body,
      "",
    ].join("\n");
  const guard = [
    'if [ -e "$A/hang-$verb" ]; then exec sleep 30; fi',
    'if [ -e "$A/fail-$verb" ]; then echo SECRET-STDERR >&2; exit 1; fi',
    'if [ -e "$A/flood-$verb" ]; then head -c 2000000 /dev/zero; exit 0; fi',
  ].join("\n");
  const show = (file: string) => `[ -e "$A/${file}" ] && cat "$A/${file}"`;
  const bins: Record<string, string> = {
    systemctl: script(
      [
        'verb=$2; case "$1" in --user) ;; *) verb=$1 ;; esac',
        guard,
        'case "$verb" in',
        `  show) case "$*" in *LoadState*) ${show("load-state")} ;; *ActiveEnterTimestamp*) ${show("active-enter")} ;; *) ${show("invocation-id")} ;; esac; exit 0 ;;`,
        '  enable) echo yes > "$A/enabled"; exit 0 ;;',
        '  disable) echo no > "$A/enabled"; exit 0 ;;',
        '  is-enabled) [ "$(cat "$A/enabled" 2>/dev/null)" = yes ] && exit 0; exit 1 ;;',
        '  is-active) [ -e "$A/active" ] && [ "$(cat "$A/active")" != yes ] && exit 3; exit 0 ;;',
        "esac",
        "exit 0",
      ].join("\n"),
    ),
    loginctl: script(
      [
        "verb=$1",
        guard,
        'case "$verb" in',
        `  show-user) ${show("linger")}; exit 0 ;;`,
        '  enable-linger) [ -e "$A/linger-after-enable" ] && cp "$A/linger-after-enable" "$A/linger"; exit 0 ;;',
        "esac",
        "exit 0",
      ].join("\n"),
    ),
    journalctl: script(
      [
        "verb=journal",
        guard,
        'file=journal; since=; prev=; for arg in "$@"; do [ "$prev" = --since ] && { file=journal-since; since=$arg; }; prev=$arg; done',
        '[ -n "$since" ] && [ -e "$A/journal-since@$since" ] && file="journal-since@$since"',
        'trusted=no; for arg in "$@"; do [ "$arg" = _SYSTEMD_USER_UNIT=pap.service ] && trusted=yes; done',
        'anyq=yes; for arg in "$@"; do case "$arg" in _SYSTEMD_*) anyq=no ;; esac; done',
        '[ "$anyq" = yes ] && { if [ -e "$A/journal-any" ]; then cat "$A/journal-any"; else echo "Started pap.service."; fi; exit 0; }',
        '[ "$trusted" = yes ] || file=journal-untrusted',
        `${show("$file")}`,
        "exit 0",
      ].join("\n"),
    ),
    node: script(["verb=node", guard, `${show("node-version")}`, "exit 0"].join("\n")),
  };
  for (const [name, text] of Object.entries(bins)) {
    writeFileSync(join(binDir, name), text, { mode: 0o755 });
    chmodSync(join(binDir, name), 0o755);
  }
  const lines = (file: string): string[] =>
    existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean) : [];
  return {
    binDir,
    calls: () => lines("calls"),
    argcs: () => lines("argc"),
    envKeys: () => [...new Set(lines("env-keys"))],
    set: (name: string, text: string) => writeFileSync(join(answers, name), text),
  };
}
