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
