import { describe, expect, it } from "vitest";
import { SandboxSpec } from "./index.ts";

const spec = {
  bwrap: "/usr/bin/bwrap",
  view: "host",
  home: "/home/pap/agents/atlas-1a2b",
  writable: "/home/pap/agents/atlas-1a2b",
  hide: ["/home/owner"],
  network: false,
  egress: null,
};

describe("SandboxSpec (M11R9)", () => {
  it("parses a thread's spec and a precheck's (writable null)", () => {
    expect(SandboxSpec.safeParse(spec).success).toBe(true);
    expect(SandboxSpec.safeParse({ ...spec, view: "system", writable: null }).success).toBe(true);
  });

  it("refuses a relative path, a dot segment, a NUL and a trailing slash", () => {
    for (const bad of ["relative/x", "/a/../b", "/a/./b", "/a\u0000b", "/a/", "/", "//a"]) {
      expect(SandboxSpec.safeParse({ ...spec, home: bad }).success, `home ${JSON.stringify(bad)}`).toBe(
        false,
      );
      expect(SandboxSpec.safeParse({ ...spec, bwrap: bad }).success, `bwrap ${JSON.stringify(bad)}`).toBe(
        false,
      );
      expect(
        SandboxSpec.safeParse({ ...spec, writable: bad }).success,
        `writable ${JSON.stringify(bad)}`,
      ).toBe(false);
      expect(SandboxSpec.safeParse({ ...spec, hide: [bad] }).success, `hide ${JSON.stringify(bad)}`).toBe(
        false,
      );
    }
  });

  it("refuses an extra key, among them a read-only folder list (owner m7)", () => {
    expect(SandboxSpec.safeParse({ ...spec, readOnly: ["/data"] }).success).toBe(false);
    expect(SandboxSpec.safeParse({ ...spec, extra: 1 }).success).toBe(false);
  });

  it("bounds the hidden folders to 1..12", () => {
    const hide = (count: number) => Array.from({ length: count }, (_, i) => `/h${i}`);
    expect(SandboxSpec.safeParse({ ...spec, hide: [] }).success).toBe(false);
    expect(SandboxSpec.safeParse({ ...spec, hide: hide(12) }).success).toBe(true);
    expect(SandboxSpec.safeParse({ ...spec, hide: hide(13) }).success).toBe(false);
  });

  it("needs a view of host or system, and every field", () => {
    const without = (key: string) =>
      Object.fromEntries(Object.entries(spec).filter(([name]) => name !== key));
    expect(SandboxSpec.safeParse(without("view")).success).toBe(false);
    expect(SandboxSpec.safeParse({ ...spec, view: "full" }).success).toBe(false);
    expect(SandboxSpec.safeParse(without("network")).success).toBe(false);
  });
});
