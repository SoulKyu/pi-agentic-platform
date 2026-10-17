import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSystemClock } from "../clock.ts";
import { probeSandbox } from "./probe.ts";

// Real bwrap again: it refuses a `--tmpfs` target whose path crosses a link from the read-only root (bwrap 0.11.1).
const baseline = await probeSandbox(undefined, { timers: createSystemClock() });
if (!baseline.usable && process.env.CI)
  throw new Error("probe.link.int.test: CI must provide a working /usr/bin/bwrap");
if (!baseline.usable) console.warn("probe.link.int.test: skipped: no usable /usr/bin/bwrap on this machine");

// Inside the checkout, never /tmp (bwrap's empty /tmp would hide the folder for the wrong reason).
const CACHE = fileURLToPath(new URL("../../../../../node_modules/.cache", import.meta.url));
let base: string;
beforeEach(() => {
  mkdirSync(CACHE, { recursive: true });
  base = realpathSync(mkdtempSync(join(CACHE, "pap-probe-link-")));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe.skipIf(!baseline.usable)("a $PAP_HOME behind a link (the canary folder is made inside it)", () => {
  it("probes usable, and leaves no canary folder behind", async () => {
    const real = join(base, "real-pap");
    mkdirSync(real);
    const link = join(base, "pap-link");
    symlinkSync(real, link);
    const result = await probeSandbox(undefined, { timers: createSystemClock(), tmp: link });
    expect(result.usable).toBe(true);
    expect(readdirSync(real)).toEqual([]);
  });
});
