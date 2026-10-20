import { existsSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codePaths } from "./real-deps.ts";
import { runSetup, type SetupOptions } from "./setup.ts";
import { assertRootOwnedCode } from "./trusted-code.ts";
import { makeBed } from "./testing/bed.ts";

/*
 * Mutants (final review I3, RT-22), run for real: the check removed from runSetup ("refuses ... before anything is
 * installed"); the owner test dropped ("not owned by root"); the mask 0o002 instead of 0o022 ("group-writable"); one path
 * left out of the list ("each of the four"); the dev exception inverted ("--dev-from-tree skips the check").
 */
const beds: Array<ReturnType<typeof makeBed>> = [];
afterEach(() => {
  for (const bed of beds.splice(0)) bed.cleanup();
});
const bed = () => {
  const made = makeBed();
  beds.push(made);
  return made;
};
const opts = (extra: Partial<SetupOptions> = {}): SetupOptions => ({
  user: "pap",
  home: undefined,
  assets: undefined,
  devFromTree: false,
  ...extra,
});
const PATHS = ["/code/main.js", "/code", "/code/vm-assets.json", "/code/node"];

describe("pap vm setup runs only code that root owns (I3)", () => {
  it.each([
    ["owned by the pap user", { uid: 1001, mode: 0o100755 }],
    ["group-writable", { uid: 0, mode: 0o100775 }],
    ["other-writable", { uid: 0, mode: 0o100757 }],
  ])("refuses a path %s, each of the four, before anything is installed", async (_label, loose) => {
    for (const path of PATHS) {
      const b = bed();
      const deps = { ...b.deps, statCode: (p: string) => (p === path ? loose : { uid: 0, mode: 0o100755 }) };
      await expect(runSetup(opts(), deps, b.io)).rejects.toThrow(
        new RegExp(`${path.replace(".", "\\.")}.*release archive unpacked as root`, "s"),
      );
      expect(b.calls).toEqual([]);
      expect(b.downloads).toEqual([]);
      expect(existsSync(b.roots.opt)).toBe(false);
    }
  });

  it("names every loose path at once", async () => {
    const b = bed();
    const deps = { ...b.deps, statCode: () => ({ uid: 1001, mode: 0o100755 }) };
    await expect(runSetup(opts(), deps, b.io)).rejects.toThrow(/main\.js.*vm-assets\.json.*node/s);
  });

  // N1. Mutant: the ancestors not walked -> a user-owned folder above a root-owned unpack passes.
  describe("the folders above each path (N1)", () => {
    const ROOT_OK = { uid: 0, mode: 0o040755 };
    const check = (loose: Record<string, { uid: number; mode: number }>) => {
      const seen: string[] = [];
      assertRootOwnedCode(
        ["/home/u/pap/dist/main.js", "/home/u/pap/dist"],
        (p) => (seen.push(p), loose[p] ?? ROOT_OK),
      );
      return seen;
    };

    it.each([
      ["a user-owned folder", "/home/u", { uid: 1001, mode: 0o040755 }],
      ["a group-writable folder", "/home/u/pap", { uid: 0, mode: 0o040775 }],
      ["the root folder when others can write it", "/", { uid: 0, mode: 0o040757 }],
      ["a sticky world-writable folder (like --assets, no exemption)", "/home", { uid: 0, mode: 0o041777 }],
    ])("refuses %s, naming it", (_label, path, facts) => {
      expect(() => check({ [path]: facts })).toThrow(
        new RegExp(`as root: ${path.replaceAll("/", "\\/")}\\.`),
      );
    });

    it("looks at every folder once, from the path up to /", () => {
      expect(check({}).sort()).toEqual(
        ["/", "/home", "/home/u", "/home/u/pap", "/home/u/pap/dist", "/home/u/pap/dist/main.js"].sort(),
      );
    });

    it("refuses through runSetup when only an ancestor is loose", async () => {
      const b = bed();
      const deps = {
        ...b.deps,
        codePaths: () => ["/code/a/main.js"],
        statCode: (p: string) => (p === "/code" ? { uid: 1001, mode: 0o040755 } : { uid: 0, mode: 0o040755 }),
      };
      await expect(runSetup(opts(), deps, b.io)).rejects.toThrow(/as root: \/code\./);
      expect(b.calls).toEqual([]);
    });
  });

  it("refuses a path it cannot inspect", () => {
    expect(() =>
      assertRootOwnedCode(["/x"], () => {
        throw new Error("ENOENT");
      }),
    ).toThrow(/cannot inspect \/x/);
  });

  it("goes on when all four are root-owned and closed to group and others", async () => {
    const b = bed();
    expect(await runSetup(opts(), b.deps, b.io)).toBe(0);
  });

  it("--dev-from-tree skips the check (its residual is printed instead)", async () => {
    const b = bed();
    const deps = {
      ...b.deps,
      statCode: () => {
        throw new Error("must not be called");
      },
    };
    expect(await runSetup(opts({ devFromTree: true }), deps, b.io)).toBe(0);
  });

  it("the real list holds the entry, its folder, vm-assets.json and the running Node, links resolved", () => {
    const list = codePaths(process.argv[1]);
    expect(list).toHaveLength(4);
    expect(list[0]).toBe(realpathSync(process.argv[1] as string));
    expect(basename(list[2] as string)).toBe("vm-assets.json");
    expect(list[3]).toBe(realpathSync(process.execPath));
    expect(list[1]).toBe(list[0]?.slice(0, list[0].lastIndexOf("/")));
  });
});
