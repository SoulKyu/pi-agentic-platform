import { describe, expect, it } from "vitest";
import { bwrapVmArgv, type VmShellSpec } from "./argv.ts";

// AVM-E19: the bind-source guard compares NORMALIZED paths. Mutant: compare the raw strings (no normalize): every refusal
// case below that is spelled with a trailing slash, `//` or `..` is accepted and the test fails.

const SLOT = "0123456789abcdef0123456789abcdef";
const layout = {
  root: "/agent",
  home: "/agent/home",
  knowledge: "/agent/knowledge",
  inbox: "/agent/inbox",
  pi: "/agent/.pi",
  sessions: "/agent/.pi/sessions",
  piAgentDir: "/agent/.pi/agent",
  imageAgentDir: "/opt/pap/pi-agent",
  shellOverlay: "/run/pap-shell",
};
const argv = (over: Partial<typeof layout>): string[] =>
  bwrapVmArgv(
    {
      bwrap: "/usr/bin/bwrap",
      layout: { ...layout, ...over },
      slot: SLOT,
      rootView: "read-only",
      network: false,
    } as VmShellSpec,
    "true",
    3,
  );

describe("bwrapVmArgv: the bind-source guard compares normalized paths (AVM-E19)", () => {
  it("refuses a bind source that spells the root or `.pi` another way", () => {
    for (const spelling of [
      "/agent/",
      "/agent//",
      "/agent/.pi/",
      "/agent//.pi",
      "/agent/a/../.pi",
      "/agent/./.pi",
      "/agent/.pi/sessions/",
      "/agent/home/../.pi",
      "/agent/../agent",
    ])
      for (const key of ["home", "knowledge", "inbox"] as const)
        expect(() => argv({ [key]: spelling }), `${key}=${spelling}`).toThrow(RangeError);
  });

  it("normalizes `layout.root` and `layout.pi` the same way", () => {
    expect(() => argv({ root: "/agent/", home: "/agent" })).toThrow(RangeError);
    expect(() => argv({ pi: "/agent//.pi/", home: "/agent/.pi" })).toThrow(RangeError);
    expect(() => argv({ pi: "/agent/./.pi", knowledge: "/agent/.pi/k" })).toThrow(RangeError);
  });

  it("refuses a bind source that is an ancestor of `.pi`", () => {
    expect(() => argv({ home: "/" })).toThrow(RangeError);
    expect(() => argv({ inbox: "/agent/.pi/.." })).toThrow(RangeError);
  });

  it("accepts a bind source spelled with a trailing slash or `..` that lands elsewhere, and binds the normalized path", () => {
    const list = argv({ home: "/agent/home/", knowledge: "/agent/x/../knowledge", inbox: "/agent//inbox" });
    for (const dir of ["/agent/home", "/agent/knowledge", "/agent/inbox"]) {
      const at = list.findIndex((arg, i) => arg === "--bind" && list[i + 1] === dir);
      expect(at, dir).toBeGreaterThan(-1);
      expect(list[at + 2]).toBe(dir);
    }
    expect(list).toContain("/agent/home");
  });
});
