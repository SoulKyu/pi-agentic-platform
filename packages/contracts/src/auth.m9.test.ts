import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, TOKEN_PERMISSIONS, TokenPermission } from "./index.ts";

describe("lanes permissions and tokens (M9R1)", () => {
  it("lets a token read and operate lanes, never administer them", () => {
    expect(ALL_PERMISSIONS).toContain("lanes:admin");
    expect(TOKEN_PERMISSIONS).toContain("lanes:read");
    expect(TOKEN_PERMISSIONS).toContain("lanes:operate");
    expect(TOKEN_PERMISSIONS).not.toContain("lanes:admin");
    expect(TokenPermission.safeParse("lanes:admin").success).toBe(false);
    expect(TokenPermission.safeParse("lanes:operate").success).toBe(true);
  });
});
