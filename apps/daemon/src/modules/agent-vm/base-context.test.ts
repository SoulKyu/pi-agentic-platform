import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { IMAGE_TAG } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { prepareBaseContext } from "./base-context.ts";

/*
 * Mutants, each run for real: the digest left out of the tag ("changes with the digest"); the bundle left out of the tag
 * ("changes with the bundle"); the link check removed (the three "link" cases); the required-file check removed
 * ("without dist/guest/main.js"); the output not replaced ("replaces").
 */
const DIGEST = `sha256:${"1".repeat(64)}`;
const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const put = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), "pap-base-ctx-"));
  roots.push(root);
  const bundle = join(root, "bundle");
  put(join(bundle, "package.json"), '{"name":"@pap/pi-host","type":"module"}\n');
  put(join(bundle, "dist/guest/main.js"), "export {};\n");
  put(join(bundle, "dist/relay/main.js"), "export {};\n");
  put(join(bundle, "node_modules/dep/package.json"), '{"name":"dep"}\n');
  put(join(bundle, "node_modules/dep/cli.js"), "export {};\n");
  symlinkSync("cli.js", join(bundle, "node_modules/dep/bin"));
  return { root, bundle, out: join(root, "ctx") };
};

describe("prepareBaseContext", () => {
  it("lays the bundle out as pap/pi-host, where the Dockerfile's COPY pap/ /opt/pap/ finds it", () => {
    const s = scratch();
    const { tag } = prepareBaseContext(s.bundle, s.out, DIGEST);
    expect(tag).toMatch(IMAGE_TAG);
    expect(tag).toMatch(/^pap-agent-base-/);
    for (const file of [
      "dist/guest/main.js",
      "dist/relay/main.js",
      "package.json",
      "node_modules/dep/cli.js",
    ])
      expect(existsSync(join(s.out, "pap/pi-host", file)), file).toBe(true);
    expect(readlinkSync(join(s.out, "pap/pi-host/node_modules/dep/bin"))).toBe("cli.js");
  });

  it("is deterministic and does not depend on the output folder or on file times", () => {
    const s = scratch();
    const first = prepareBaseContext(s.bundle, s.out, DIGEST).tag;
    utimesSync(join(s.bundle, "dist/guest/main.js"), 1, 1);
    expect(prepareBaseContext(s.bundle, join(s.root, "other"), DIGEST).tag).toBe(first);
  });

  // Mutant "bundle left out of the tag".
  it("changes with the bundle: a file, a mode, a link", () => {
    const s = scratch();
    const first = prepareBaseContext(s.bundle, s.out, DIGEST).tag;
    put(join(s.bundle, "dist/guest/main.js"), "export const x = 1;\n");
    const edited = prepareBaseContext(s.bundle, s.out, DIGEST).tag;
    expect(edited).not.toBe(first);
    chmodSync(join(s.bundle, "dist/relay/main.js"), 0o755);
    const exec = prepareBaseContext(s.bundle, s.out, DIGEST).tag;
    expect(exec).not.toBe(edited);
    rmSync(join(s.bundle, "node_modules/dep/bin"));
    symlinkSync("package.json", join(s.bundle, "node_modules/dep/bin"));
    expect(prepareBaseContext(s.bundle, s.out, DIGEST).tag).not.toBe(exec);
  });

  // Mutant "digest left out of the tag".
  it("changes with the digest, and a full reference names the same digest (changes with the digest)", () => {
    const s = scratch();
    const first = prepareBaseContext(s.bundle, s.out, DIGEST).tag;
    expect(prepareBaseContext(s.bundle, s.out, `sha256:${"2".repeat(64)}`).tag).not.toBe(first);
    expect(prepareBaseContext(s.bundle, s.out, `docker.io/library/node@${DIGEST}`).tag).toBe(first);
  });

  it("refuses a digest that is not a sha256 digest", () => {
    const s = scratch();
    for (const bad of ["", "latest", "sha256:abc", `sha256:${"G".repeat(64)}`, `node@${DIGEST}`])
      expect(() => prepareBaseContext(s.bundle, s.out, bad), bad).toThrow(/digest/);
  });

  it("refuses relative paths and an output folder that overlaps the bundle", () => {
    const s = scratch();
    expect(() => prepareBaseContext("bundle", s.out, DIGEST)).toThrow(/not usable/);
    expect(() => prepareBaseContext(s.bundle, "out", DIGEST)).toThrow(/not usable/);
    expect(() => prepareBaseContext(s.bundle, join(s.bundle, "ctx"), DIGEST)).toThrow(/not usable/);
    expect(() => prepareBaseContext(s.bundle, s.root, DIGEST)).toThrow(/not usable/);
    expect(existsSync(join(s.bundle, "dist/guest/main.js"))).toBe(true);
  });

  // Mutant "required-file check removed".
  for (const file of ["dist/guest/main.js", "dist/relay/main.js"])
    it(`refuses a bundle without ${file} and leaves no output`, () => {
      const s = scratch();
      rmSync(join(s.bundle, file));
      expect(() => prepareBaseContext(s.bundle, s.out, DIGEST)).toThrow(file);
      expect(existsSync(s.out)).toBe(false);
    });

  // Mutant "link check removed".
  it("refuses a link that leaves the bundle, a dangling one and an absolute one (link)", () => {
    for (const [target, pattern] of [
      ["../../../outside", /leaves the bundle/],
      ["nowhere", /does not resolve/],
      ["/etc/passwd", /absolute/],
    ] as const) {
      const s = scratch();
      mkdirSync(join(s.root, "outside"));
      symlinkSync(target, join(s.bundle, "node_modules/dep/bad"));
      expect(() => prepareBaseContext(s.bundle, s.out, DIGEST), target).toThrow(pattern);
      expect(existsSync(s.out)).toBe(false);
    }
  });

  // Mutant "output not replaced".
  it("replaces what the output folder held (replaces)", () => {
    const s = scratch();
    put(join(s.out, "stale"), "old");
    prepareBaseContext(s.bundle, s.out, DIGEST);
    expect(existsSync(join(s.out, "stale"))).toBe(false);
    expect(readFileSync(join(s.out, "pap/pi-host/dist/guest/main.js"), "utf8")).toBe("export {};\n");
  });
});
