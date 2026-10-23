import { describe, expect, it } from "vitest";

describe("the egress module", () => {
  it("exports only the VM proxy", async () => {
    const keys = Object.keys(await import("./index.ts"));
    expect(keys).toContain("createVmEgress");
    expect(keys).not.toContain("createEgress");
    expect(keys).not.toContain("bootEgress");
    expect(keys).not.toContain("createProxy");
  });
});
