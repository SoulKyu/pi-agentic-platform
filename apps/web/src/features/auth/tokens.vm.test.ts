import { TOKEN_PERMISSIONS } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { isExpired, permissionGrid, riskyPermissions } from "./tokens.vm.ts";

describe("permissionGrid", () => {
  it("has every domain but auth, three levels each except policy (read and operate)", () => {
    const grid = permissionGrid();
    expect(grid.map((row) => row.domain)).toEqual(["system", "sessions", "policy", "settings", "audit"]);
    for (const row of grid)
      expect(row.levels.map((level) => level.label)).toEqual(
        row.domain === "policy" ? ["read", "operate"] : ["read", "operate", "admin"],
      );
  });

  it("is built from TOKEN_PERMISSIONS: no auth cell, no policy:admin, nothing else", () => {
    const cells = permissionGrid().flatMap((row) => row.levels.map((level) => level.permission));
    expect(cells).toEqual([...TOKEN_PERMISSIONS]);
    expect(cells).not.toContain("policy:admin");
    expect(cells.some((cell) => cell.startsWith("auth:"))).toBe(false);
  });
});

describe("riskyPermissions", () => {
  it("flags sessions:operate only", () => {
    expect(riskyPermissions(["sessions:operate", "policy:operate"])).toEqual(["sessions:operate"]);
    expect(riskyPermissions(["sessions:read", "policy:operate"])).toEqual([]);
    expect(riskyPermissions([])).toEqual([]);
  });
});

describe("isExpired", () => {
  it("is true from the expiry instant on", () => {
    expect(isExpired(1000, 999)).toBe(false);
    expect(isExpired(1000, 1000)).toBe(true);
    expect(isExpired(1000, 1001)).toBe(true);
  });
});
