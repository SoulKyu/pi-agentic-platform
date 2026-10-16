import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const text = readFileSync(join(import.meta.dirname, "smoke-install.ts"), "utf8");

describe("smoke-install.ts", () => {
  it("cleans up the daemon and the temporary root on SIGINT (exit 130) and SIGTERM (exit 143)", () => {
    expect(text).toMatch(/\["SIGINT", 130\]/);
    expect(text).toMatch(/\["SIGTERM", 143\]/);
    expect(text).toMatch(/process\.once\(signal, \(\) => \{\s*cleanup\(\);\s*process\.exit\(code\);/);
  });
  it("runs the same cleanup in finally", () => {
    expect(text).toMatch(/finally \{\s*cleanup\(\);/);
  });
});
