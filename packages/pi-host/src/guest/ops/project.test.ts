import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type OpsBed, opsBed } from "./testing.ts";

let bed: OpsBed;
beforeEach(() => {
  bed = opsBed();
  mkdirSync(join(bed.project, ".pi"));
});
afterEach(() => bed.clean());

const config = (text: string) => writeFileSync(join(bed.project, ".pi", "project.yaml"), text);
const NONE = { preview: null, previewInvalid: false };
const read = () => bed.value({ name: "project.config" });

describe("project.config", () => {
  it("wants nothing from a project without the file", async () => {
    expect(await read()).toEqual({ ...NONE, packages: null, error: null });
  });

  it("reads packages and refuses a bad package name", async () => {
    config("setup: pnpm install\npackages: [ripgrep, build-essential, g++]\n");
    expect(await read()).toEqual({ ...NONE, packages: ["ripgrep", "build-essential", "g++"], error: null });
    config("packages: [ok, Not-A-Package]\n");
    expect(await read()).toEqual({ ...NONE, packages: null, error: "bad_packages" });
    config("packages: ripgrep\n");
    expect(await read()).toEqual({ ...NONE, packages: null, error: "bad_packages" });
    config(`packages: [${Array.from({ length: 65 }, (_, i) => `p${i}`).join(", ")}]\n`);
    expect(await read()).toEqual({ ...NONE, packages: null, error: "bad_packages" });
  });

  it("reads the preview declaration and names an invalid one", async () => {
    config("preview:\n  command: npm run dev\n  port: 5173\n");
    expect(await read()).toEqual({
      packages: null,
      error: null,
      preview: { command: "npm run dev", port: 5173 },
      previewInvalid: false,
    });
    config("preview: {command: x, port: 7842}\npackages: [jq]\n");
    expect(await read()).toEqual({ packages: ["jq"], error: null, preview: null, previewInvalid: true });
  });

  it("says why a file cannot be read", async () => {
    config("- a\n- b\n");
    expect(await read()).toEqual({ ...NONE, packages: null, error: "not_a_map" });
    config("a: &x 1\nb: *x\n");
    expect(await read()).toEqual({ ...NONE, packages: null, error: "invalid_yaml" });
    config(`a: ${"x".repeat(70 * 1024)}\n`);
    expect(await read()).toEqual({ ...NONE, packages: null, error: "too_large" });
  });

  it("does not follow a link in the file's place", async () => {
    writeFileSync(join(bed.outside, "wanted.yaml"), "packages: [evil]\n");
    symlinkSync(join(bed.outside, "wanted.yaml"), join(bed.project, ".pi", "project.yaml"));
    expect(await read()).toEqual({ ...NONE, packages: null, error: null });
  });
});
