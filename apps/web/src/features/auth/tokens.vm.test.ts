import { methods, TOKEN_PERMISSIONS } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { isExpired, permissionGrid, riskyPermissions } from "./tokens.vm.ts";

describe("permissionGrid", () => {
  const cells = (grid = permissionGrid()) =>
    grid.flatMap((row) => row.levels.map((level) => level.permission));

  it("shows only permissions some method declares, and still has sessions:operate (M7R124)", () => {
    const used = new Set(Object.values(methods).map((method) => method.permission));
    expect(cells()).toEqual(TOKEN_PERMISSIONS.filter((permission) => used.has(permission)));
    expect(cells()).toContain("sessions:operate");
    expect(cells()).not.toContain("policy:operate");
    for (const unused of [
      "sessions:admin",
      "settings:admin",
      "system:operate",
      "audit:operate",
      "pi:operate",
    ])
      expect(cells()).not.toContain(unused);
  });

  it("has a row per domain in use, files and vcs included, and no terminal or auth row", () => {
    const domains = permissionGrid().map((row) => row.domain);
    expect(domains).toEqual(expect.arrayContaining(["system", "sessions", "policy", "files", "vcs", "pi"]));
    expect(domains).not.toContain("terminal");
    expect(domains).not.toContain("auth");
  });

  it("adds a permission as soon as a method declares it, without a list to edit", () => {
    const base = Object.values(methods);
    expect(cells(permissionGrid(base))).not.toContain("policy:operate");
    const added = [...base, { permission: "policy:operate" as const }];
    expect(cells(permissionGrid(added))).toContain("policy:operate");
    expect(cells(permissionGrid(added)).indexOf("policy:operate")).toBeGreaterThan(
      cells(permissionGrid(added)).indexOf("policy:read"),
    );
  });

  it("never offers what a token may not hold, whatever a method declares", () => {
    const hostile = [
      { permission: "policy:admin" as const },
      { permission: "terminal:operate" as const },
      { permission: "auth:read" as const },
      { permission: "pi:admin" as const },
    ];
    expect(cells(permissionGrid(hostile))).toEqual([]);
  });
});

describe("riskyPermissions", () => {
  it("flags files:read and files:operate, not vcs:read", () => {
    expect(riskyPermissions(["files:read", "files:operate", "vcs:read"])).toEqual([
      "files:read",
      "files:operate",
    ]);
  });

  it("flags sessions:operate only", () => {
    expect(riskyPermissions(["sessions:operate", "policy:operate"])).toEqual(["sessions:operate"]);
    expect(riskyPermissions(["sessions:read", "policy:operate"])).toEqual([]);
    expect(riskyPermissions([])).toEqual([]);
  });
});

describe("automation in the grid and the create form", () => {
  it("warns about automation:operate, which starts runs that spend money", () => {
    expect(riskyPermissions(["automation:operate", "automation:read"])).toEqual(["automation:operate"]);
  });

  it("shows the automation, usage and inbox rows once methods use them, and never an automation:admin cell", () => {
    const declared = [
      "automation:read",
      "automation:operate",
      "automation:admin",
      "usage:read",
      "usage:operate",
      "inbox:read",
      "inbox:operate",
    ].map((permission) => ({ permission }));
    const grid = permissionGrid(declared);
    expect(grid.map((row) => row.domain)).toEqual(["automation", "usage", "inbox"]);
    const cells = grid.flatMap((row) => row.levels.map((level) => level.permission));
    expect(cells).not.toContain("automation:admin");
    expect(cells).toContain("automation:operate");
  });
});

describe("isExpired", () => {
  it("is true from the expiry instant on", () => {
    expect(isExpired(1000, 999)).toBe(false);
    expect(isExpired(1000, 1000)).toBe(true);
    expect(isExpired(1000, 1001)).toBe(true);
  });
});
