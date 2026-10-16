import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LAUNCHER_MARK, removeLauncher, renderLauncher, writeLauncher } from "./launcher.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-launcher-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NODE = "/opt/node/bin/node";
const MAIN = "/opt/pap/main.js";

describe("renderLauncher", () => {
  it("is fixed text with the marker and the exec line", () => {
    expect(renderLauncher({ node: NODE, main: MAIN })).toBe(
      `#!/bin/sh\n${LAUNCHER_MARK}\nexec '${NODE}' --disable-warning=ExperimentalWarning '${MAIN}' "$@"\n`,
    );
  });
  it("exports PAP_HOME only when a home is given", () => {
    const text = renderLauncher({ node: NODE, main: MAIN, home: "/home/u/.pap" });
    expect(text).toContain("PAP_HOME='/home/u/.pap'\nexport PAP_HOME\nexec ");
    expect(renderLauncher({ node: NODE, main: MAIN })).not.toContain("PAP_HOME");
  });
  it.each([
    ["a space", "/a b"],
    ["a single quote", "/a'b"],
    ["a percent", "/a%b"],
    ["a newline", "/a\nb"],
    ["a dot-dot segment", "/a/../b"],
  ])("refuses %s in any of the three paths", (_name, bad) => {
    expect(() => renderLauncher({ node: bad, main: MAIN })).toThrow(/--node/);
    expect(() => renderLauncher({ node: NODE, main: bad })).toThrow(/--main/);
    expect(() => renderLauncher({ node: NODE, main: MAIN, home: bad })).toThrow(/--home/);
  });
});

describe("writeLauncher", () => {
  it("creates the directory, writes mode 0755, leaves no temp file and replaces its own file", () => {
    const bin = join(dir, "new", "bin");
    expect(writeLauncher(bin, renderLauncher({ node: NODE, main: MAIN }))).toBe("written");
    expect(lstatSync(join(bin, "pap")).mode & 0o777).toBe(0o755);
    expect(readdirSync(bin)).toEqual(["pap"]);
    const next = renderLauncher({ node: NODE, main: "/opt/pap/other.js" });
    expect(writeLauncher(bin, next)).toBe("written");
    expect(readFileSync(join(bin, "pap"), "utf8")).toBe(next);
    expect(readdirSync(bin)).toEqual(["pap"]);
  });
  it("runs the node it names with the arguments intact and the exported PAP_HOME", () => {
    const fakeNode = join(dir, "node");
    writeFileSync(fakeNode, '#!/bin/sh\nfor a in "$@"; do echo "arg:$a"; done\necho "home:$PAP_HOME"\n', {
      mode: 0o755,
    });
    const bin = join(dir, "bin");
    writeLauncher(bin, renderLauncher({ node: fakeNode, main: MAIN, home: "/h/pap" }));
    const out = execFileSync(join(bin, "pap"), ["service", "a b"], { encoding: "utf8", env: {} });
    expect(out.split("\n")).toEqual([
      "arg:--disable-warning=ExperimentalWarning",
      `arg:${MAIN}`,
      "arg:service",
      "arg:a b",
      "home:/h/pap",
      "",
    ]);
  });
  it("keeps a foreign regular file byte-identical", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "pap"), "#!/bin/sh\necho mine\n");
    expect(writeLauncher(bin, renderLauncher({ node: NODE, main: MAIN }))).toBe("foreign");
    expect(readFileSync(join(bin, "pap"), "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(readdirSync(bin)).toEqual(["pap"]);
  });
  it("keeps a symlink, even one that points at our marker", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const real = join(dir, "real");
    writeFileSync(real, `#!/bin/sh\n${LAUNCHER_MARK}\n`);
    symlinkSync(real, join(bin, "pap"));
    expect(writeLauncher(bin, renderLauncher({ node: NODE, main: MAIN }))).toBe("foreign");
    expect(lstatSync(join(bin, "pap")).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe(`#!/bin/sh\n${LAUNCHER_MARK}\n`);
    removeLauncher(bin);
    expect(lstatSync(join(bin, "pap")).isSymbolicLink()).toBe(true);
  });
  it.skipIf(process.getuid?.() === 0)(
    "keeps a foreign file nobody can read (fails closed; skipped as root, which reads mode 000)",
    () => {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "pap"), `#!/bin/sh\n${LAUNCHER_MARK}\n`, { mode: 0o000 });
      expect(writeLauncher(bin, renderLauncher({ node: NODE, main: MAIN }))).toBe("foreign");
      removeLauncher(bin);
      expect(readdirSync(bin)).toEqual(["pap"]);
    },
  );
  it("a foreign file that only quotes the marker is not ours", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const text = `#!/bin/sh\necho "${LAUNCHER_MARK}"\n`;
    writeFileSync(join(bin, "pap"), text);
    expect(writeLauncher(bin, renderLauncher({ node: NODE, main: MAIN }))).toBe("foreign");
    expect(readFileSync(join(bin, "pap"), "utf8")).toBe(text);
  });
  it("refuses a bin dir with a space", () => {
    expect(() => writeLauncher("/a b/bin", "x")).toThrow(/--bin-dir/);
  });
});

describe("removeLauncher", () => {
  it("removes ours, keeps a foreign file, and does nothing when absent", () => {
    const bin = join(dir, "bin");
    removeLauncher(bin);
    writeLauncher(bin, renderLauncher({ node: NODE, main: MAIN }));
    removeLauncher(bin);
    expect(readdirSync(bin)).toEqual([]);
    writeFileSync(join(bin, "pap"), "foreign\n");
    removeLauncher(bin);
    expect(readFileSync(join(bin, "pap"), "utf8")).toBe("foreign\n");
  });
});
