import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { bootClean, chooseRoot, daemonKey, dropFolder, prepareRoot, sessionFolder } from "./runtime-dir.ts";

let tmp: string;
const uid = process.getuid?.() ?? 0;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rtd-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const xdg = (name: string, mode = 0o700): string => {
  const dir = join(tmp, name);
  mkdirSync(dir, { mode });
  return dir;
};

describe("chooseRoot (M11R234)", () => {
  it("takes a short XDG_RUNTIME_DIR that is a private folder of the daemon's user", () => {
    const runtime = xdg("xdg");
    expect(chooseRoot({ runtimeDir: runtime, papHome: join(tmp, "home"), uid })).toBe(
      join(runtime, "pap", daemonKey(join(tmp, "home")), "egress"),
    );
  });

  it("falls back to PAP_HOME/run/egress when XDG is unset, open to others, a link or not ours", () => {
    const home = join(tmp, "home");
    const expected = join(home, "run", "egress");
    expect(chooseRoot({ runtimeDir: undefined, papHome: home, uid })).toBe(expected);
    expect(chooseRoot({ runtimeDir: xdg("open", 0o755), papHome: home, uid })).toBe(expected);
    const target = xdg("target");
    symlinkSync(target, join(tmp, "link"));
    expect(chooseRoot({ runtimeDir: join(tmp, "link"), papHome: home, uid })).toBe(expected);
    expect(chooseRoot({ runtimeDir: xdg("theirs"), papHome: home, uid: uid + 1 })).toBe(expected);
    expect(chooseRoot({ runtimeDir: join(tmp, "missing"), papHome: home, uid })).toBe(expected);
  });

  it("falls back when the XDG socket path would pass 107 bytes", () => {
    const long = xdg("l".repeat(90));
    const home = join(tmp, "h");
    expect(chooseRoot({ runtimeDir: long, papHome: home, uid })).toBe(join(home, "run", "egress"));
  });

  it("is unusable (null) when neither root fits", () => {
    const long = xdg("l".repeat(90));
    expect(chooseRoot({ runtimeDir: long, papHome: join(tmp, "h".repeat(90)), uid })).toBeNull();
  });

  it("counts bytes, with the longest socket path <root>/<6>/<6>.s at 107 exactly", () => {
    const fits = `/${"a".repeat(79)}`;
    expect(chooseRoot({ runtimeDir: undefined, papHome: fits, uid })).toBe(`${fits}/run/egress`);
    expect(chooseRoot({ runtimeDir: undefined, papHome: `${fits}a`, uid })).toBeNull();
    const wide = `/${"\u00e9".repeat(40)}`;
    expect(chooseRoot({ runtimeDir: undefined, papHome: wide, uid })).toBeNull();
  });
});

describe("daemonKey (W5-R42)", () => {
  it("is six hex digits of the real PAP_HOME, different per home and stable per home", () => {
    mkdirSync(join(tmp, "a"));
    mkdirSync(join(tmp, "b"));
    symlinkSync(join(tmp, "a"), join(tmp, "alias"));
    expect(daemonKey(join(tmp, "a"))).toMatch(/^[0-9a-f]{6}$/);
    expect(daemonKey(join(tmp, "a"))).not.toBe(daemonKey(join(tmp, "b")));
    expect(daemonKey(join(tmp, "alias"))).toBe(daemonKey(join(tmp, "a")));
  });
});

describe("the folders", () => {
  it("makes the root and a session folder 0700", () => {
    const root = join(tmp, "run", "egress");
    mkdirSync(join(tmp, "run"), { mode: 0o755 });
    prepareRoot(root, tmp);
    const folder = sessionFolder(root, "1a");
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(folder).toBe(join(root, "1a"));
  });

  it("refuses a root that is a link, and one whose parent is", () => {
    const victim = xdg("victim");
    mkdirSync(join(tmp, "run"));
    symlinkSync(victim, join(tmp, "run", "egress"));
    expect(() => prepareRoot(join(tmp, "run", "egress"), tmp)).toThrow();
    symlinkSync(victim, join(tmp, "linked"));
    expect(() => prepareRoot(join(tmp, "linked", "egress"), tmp)).toThrow();
    expect(readdirSync(victim)).toEqual([]);
  });

  it("says why a root cannot be made: a link, a file in the way, a root outside its base", () => {
    const reasonOf = (work: () => void): unknown => {
      try {
        work();
      } catch (error) {
        return (error as { reason?: string }).reason;
      }
      return "no error";
    };
    mkdirSync(join(tmp, "run"));
    symlinkSync(xdg("victim"), join(tmp, "run", "egress"));
    expect(reasonOf(() => prepareRoot(join(tmp, "run", "egress"), tmp))).toBe("link");
    writeFileSync(join(tmp, "file"), "");
    expect(reasonOf(() => prepareRoot(join(tmp, "file", "egress"), tmp))).toBe("not_a_folder");
    expect(reasonOf(() => prepareRoot(join(tmp, "..", "elsewhere"), tmp))).toBe("outside_base");
  });

  it("a session drop removes only its folder", () => {
    const root = join(tmp, "run", "egress");
    mkdirSync(join(tmp, "run"));
    prepareRoot(root, tmp);
    writeFileSync(join(sessionFolder(root, "1"), "0.s"), "");
    sessionFolder(root, "2");
    dropFolder(root, "1");
    expect(readdirSync(root)).toEqual(["2"]);
  });
});

describe("bootClean", () => {
  it("removes pap's folders and sockets, leaves anything else with one warning, follows no link", () => {
    const root = join(tmp, "run", "egress");
    mkdirSync(join(tmp, "run"));
    prepareRoot(root, tmp);
    writeFileSync(join(sessionFolder(root, "1a"), "0.s"), "");
    sessionFolder(root, "zz");
    writeFileSync(join(root, "9.s"), "");
    writeFileSync(join(root, "fwd.py"), "");
    writeFileSync(join(root, "notes.txt"), "keep");
    mkdirSync(join(root, "Weird-Name"));
    const victim = xdg("victim");
    writeFileSync(join(victim, "precious"), "keep");
    symlinkSync(victim, join(root, "b2"));
    const { logger, lines } = captureLogger();
    bootClean(root, logger);
    expect(readdirSync(root).sort()).toEqual(["Weird-Name", "b2", "notes.txt"]);
    expect(lstatSync(join(root, "b2")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(victim, "precious"))).toBe(true);
    const warnings = lines.filter((line) => line["msg"] === "egress_boot_foreign");
    expect(warnings).toEqual([expect.objectContaining({ level: "warn", count: 3 })]);
  });

  it("is quiet on an empty root", () => {
    const root = join(tmp, "run", "egress");
    mkdirSync(join(tmp, "run"));
    prepareRoot(root, tmp);
    const { logger, lines } = captureLogger();
    bootClean(root, logger);
    expect(lines).toEqual([]);
  });
});
