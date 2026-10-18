import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { goodMembers, installBed, makeRoot, readIfExists, type Root } from "./archive-install-bed.ts";

/** A fake node whose `service install` can rewrite the launcher and the unit like the real one, then fail or be signalled. */
const FAKE = [
  "#!/bin/sh",
  'printf \'%s\\n\' "$*" >> "$HOME/calls"',
  'case "$*" in',
  '  *" service install "*)',
  '    bin="${BIN_DIR:-$HOME/.local/bin}"',
  '    if [ -n "$REWRITE_LAUNCHER" ]; then mkdir -p "$bin"; printf NEWLAUNCHER > "$bin/pap.tmp"; chmod 755 "$bin/pap.tmp"; mv -T "$bin/pap.tmp" "$bin/pap"; fi',
  '    if [ -n "$REWRITE_UNIT" ]; then u="$HOME/.config/systemd/user/pap.service"; rm -f "$u"; printf CLOBBERED > "$u"; fi',
  '    if [ -n "$KILL_SIG" ]; then kill -"$KILL_SIG" $PPID; fi ;;',
  "esac",
  'exit "${NODE_EXIT:-0}"',
  "",
].join("\n");

const bedFor = (id: string, root: Root) =>
  installBed(id, root, {
    members: goodMembers(id).map((m) => (m.name.endsWith("/node/bin/node") ? { ...m, data: FAKE } : m)),
  });
const OLD = "#!/bin/sh\n# old launcher\n";
const UNIT = "[Service]\nExecStart=/x serve --port 7791 --home /h\n";

const setup = () => {
  const root = makeRoot();
  const bed = bedFor("r1", root);
  expect(bed.run().status).toBe(0);
  const unitDir = join(root.home, ".config/systemd/user");
  mkdirSync(unitDir, { recursive: true });
  const bin = join(root.home, ".local/bin");
  mkdirSync(bin, { recursive: true });
  const launcher = join(bin, "pap");
  writeFileSync(launcher, OLD);
  chmodSync(launcher, 0o750);
  return { root, bed, unitDir, bin, launcher, unit: join(unitDir, "pap.service") };
};
const plainUnit = (unit: string) => {
  writeFileSync(unit, UNIT);
  chmodSync(unit, 0o640);
};
const expectOld = (launcher: string) => {
  expect(readFileSync(launcher, "utf8")).toBe(OLD);
  expect(statSync(launcher).mode & 0o777).toBe(0o750);
};
const FLAGS = ["--port", "7790"];

describe("archive installer: a failed reinstall restores the launcher and a symlinked unit", () => {
  it("(a) a failure after the launcher was rewritten puts the old launcher back (content and mode)", () => {
    const s = setup();
    plainUnit(s.unit);
    const result = s.bed.run({ args: FLAGS, env: { NODE_EXIT: "1", REWRITE_LAUNCHER: "1" } });
    expect(result.status).toBe(1);
    expectOld(s.launcher);
  });

  it.each([
    ["TERM", 143],
    ["INT", 130],
  ])("(b) SIG%s during service install restores the launcher", (sig, code) => {
    const s = setup();
    plainUnit(s.unit);
    const result = s.bed.run({ args: FLAGS, env: { KILL_SIG: sig, REWRITE_LAUNCHER: "1" } });
    expect(result.status).toBe(code);
    expectOld(s.launcher);
  });

  it("(a) a launcher that did not exist is removed again", () => {
    const s = setup();
    plainUnit(s.unit);

    rmSync(s.launcher);
    const result = s.bed.run({ args: FLAGS, env: { NODE_EXIT: "1", REWRITE_LAUNCHER: "1" } });
    expect(result.status).toBe(1);
    expect(readIfExists(s.launcher)).toBe("");
  });

  it("(a) a --bin-dir=<dir> flag names the launcher that is saved and restored", () => {
    const s = setup();
    plainUnit(s.unit);
    const custom = join(s.root.root, "custom-bin");
    mkdirSync(custom);
    writeFileSync(join(custom, "pap"), OLD);
    chmodSync(join(custom, "pap"), 0o750);
    const result = s.bed.run({
      args: [`--bin-dir=${custom}`],
      env: { NODE_EXIT: "1", REWRITE_LAUNCHER: "1", BIN_DIR: custom },
    });
    expect(result.status).toBe(1);
    expectOld(join(custom, "pap"));
  });

  it("(c) a symlinked unit is again a symlink to the same target, whose bytes are unchanged", () => {
    const s = setup();
    const target = join(s.unitDir, "real-unit.service");
    writeFileSync(target, UNIT);
    symlinkSync("real-unit.service", s.unit);
    const result = s.bed.run({ args: FLAGS, env: { NODE_EXIT: "1", REWRITE_UNIT: "1" } });
    expect(result.status).toBe(1);
    expect(lstatSync(s.unit).isSymbolicLink()).toBe(true);
    expect(readlinkSync(s.unit)).toBe("real-unit.service");
    expect(readFileSync(target, "utf8")).toBe(UNIT);
  });

  it("(d) a success ends with the new launcher", () => {
    const s = setup();
    plainUnit(s.unit);
    const result = s.bed.run({ args: FLAGS, env: { REWRITE_LAUNCHER: "1" } });
    expect(result.status).toBe(0);
    expect(readFileSync(s.launcher, "utf8")).toBe("NEWLAUNCHER");
  });
});
