import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OKF_INDEX_TEXT } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type OpsBed, opsBed } from "./testing.ts";

const NOW = Date.UTC(2026, 9, 23, 12);
let bed: OpsBed;
beforeEach(() => {
  bed = opsBed(() => NOW);
});
afterEach(() => bed.clean());

const state = () => bed.value({ name: "knowledge.state" });
const enable = () => bed.call({ name: "knowledge.enable" });
const folder = () => join(bed.project, "knowledge");

describe("knowledge ops", () => {
  it("is off until enabled, then writes what the host writes and counts concepts", async () => {
    expect(await state()).toEqual({ enabled: false, concepts: 0 });
    expect(await enable()).toEqual({ ok: true, value: { enabled: true } });
    expect(readFileSync(join(folder(), "index.md"), "utf8")).toBe(OKF_INDEX_TEXT);
    expect(readFileSync(join(folder(), "log.md"), "utf8")).toBe("## 2026-10-23\n- OKF enabled\n");
    writeFileSync(join(folder(), "a.md"), "# a\n");
    mkdirSync(join(folder(), "sub"));
    writeFileSync(join(folder(), "sub", "b.md"), "# b\n");
    expect(await state()).toEqual({ enabled: true, concepts: 2 });
  });

  it("never overwrites and enabling twice is fine", async () => {
    await enable();
    writeFileSync(join(folder(), "log.md"), "mine\n");
    expect(await enable()).toEqual({ ok: true, value: { enabled: true } });
    expect(readFileSync(join(folder(), "log.md"), "utf8")).toBe("mine\n");
  });

  it("refuses a link or a file named knowledge, and an index.md that is not OKF", async () => {
    symlinkSync(bed.outside, folder());
    expect(await bed.refusal({ name: "knowledge.enable" })).toBe("conflict");
    expect(await state()).toEqual({ enabled: false, concepts: 0 });
    rmSync(folder());
    writeFileSync(folder(), "a file");
    expect(await bed.refusal({ name: "knowledge.enable" })).toBe("conflict");
    rmSync(folder());
    mkdirSync(folder());
    writeFileSync(join(folder(), "index.md"), "# not okf\n");
    expect(await bed.refusal({ name: "knowledge.enable" })).toBe("conflict");
    expect(readFileSync(join(folder(), "index.md"), "utf8")).toBe("# not okf\n");
    expect(await state()).toEqual({ enabled: false, concepts: 0 });
  });

  it("does not read the state through a linked index.md", async () => {
    mkdirSync(folder());
    writeFileSync(join(bed.outside, "index.md"), OKF_INDEX_TEXT);
    symlinkSync(join(bed.outside, "index.md"), join(folder(), "index.md"));
    expect(await state()).toEqual({ enabled: false, concepts: 0 });
    expect(await bed.refusal({ name: "knowledge.enable" })).toBe("conflict");
  });
});
