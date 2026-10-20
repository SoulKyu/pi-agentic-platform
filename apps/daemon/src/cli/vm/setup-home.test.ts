import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSetup, type SetupOptions } from "./setup.ts";
import { makeBed } from "./testing/bed.ts";

/*
 * Mutants (final review M11), run for real: the unit not read ("follows the unit's PAP_HOME"); the unit read before --home
 * ("--home wins over the unit"); the default dropped when the unit has no home ("the user's ~/.pap").
 */
const beds: Array<ReturnType<typeof makeBed>> = [];
afterEach(() => {
  for (const bed of beds.splice(0)) bed.cleanup();
});
const UNIT = (home: string | null): string =>
  [
    "[Service]",
    ...(home === null ? [] : [`Environment=PAP_HOME=${home}`]),
    "ExecStart=/usr/bin/node /opt/pap/main.js serve",
    "",
  ].join("\n");
const homeOf = async (unit: string | null, home?: string): Promise<string> => {
  const b = makeBed();
  beds.push(b);
  const options: SetupOptions = { user: "pap", home, assets: undefined, devFromTree: false };
  const read = (userHome: string): string | null => (userHome === "/home/pap" ? unit : null);
  await runSetup(options, { ...b.deps, readUserUnit: read }, b.io);
  return (JSON.parse(readFileSync(join(b.roots.etc, "config.json"), "utf8")) as { papHome: string }).papHome;
};

describe("pap vm setup: --home defaults to the unit's PAP_HOME (M11)", () => {
  it("follows the unit's PAP_HOME", async () => {
    expect(await homeOf(UNIT("/srv/pap-data"))).toBe("/srv/pap-data");
  });
  it("--home wins over the unit", async () => {
    expect(await homeOf(UNIT("/srv/pap-data"), "/other")).toBe("/other");
  });
  it("is the user's ~/.pap when the unit sets none, or there is no unit, or it is hand-edited", async () => {
    expect(await homeOf(UNIT(null))).toBe("/home/pap/.pap");
    expect(await homeOf(null)).toBe("/home/pap/.pap");
    expect(await homeOf("garbage")).toBe("/home/pap/.pap");
  });
});
