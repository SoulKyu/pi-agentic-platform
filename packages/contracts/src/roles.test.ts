import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, memberDenied, permissionsOf, ROLES } from "./index.ts";

describe("roles", () => {
  it("has the owner and the member", () => {
    expect(ROLES).toEqual(["owner", "member"]);
  });

  it("gives the owner every permission", () => {
    expect(permissionsOf("owner")).toEqual(new Set(ALL_PERMISSIONS));
  });

  it("gives a member everything but system:admin, pi:*, users:* and lanes:*", () => {
    const member = permissionsOf("member");
    expect(member.has("sessions:admin")).toBe(true);
    expect(member.has("settings:operate")).toBe(true);
    expect(member.has("system:read")).toBe(true);
    for (const denied of ["system:admin", "pi:read", "pi:admin", "users:read", "users:admin", "lanes:read"])
      expect(member.has(denied as never), denied).toBe(false);
    for (const permission of ALL_PERMISSIONS) expect(member.has(permission)).toBe(!memberDenied(permission));
  });
});
