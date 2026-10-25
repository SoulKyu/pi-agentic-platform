import { describe, expect, it } from "vitest";
import { ERROR_CODES, ERROR_MESSAGES } from "./errors.ts";
import { fontsMethods, FONT_LIMITS } from "./fonts.ts";
import { methods } from "./methods.ts";
import { AccountAppearanceFields } from "./settings.ts";

describe("fonts methods", () => {
  it("are in the catalogue with a permission each, and writes are not idempotent", () => {
    for (const name of Object.keys(fontsMethods) as Array<keyof typeof fontsMethods>)
      expect(methods[name], name).toBe(fontsMethods[name]);
    expect(fontsMethods["fonts.list"]).toMatchObject({ permission: "settings:read", idempotent: true });
    expect(fontsMethods["fonts.add"]).toMatchObject({ permission: "system:admin", idempotent: false });
    expect(fontsMethods["fonts.remove"]).toMatchObject({ permission: "system:admin", idempotent: false });
  });

  it("decode the family name at the trust boundary", () => {
    const { params } = fontsMethods["fonts.add"];
    for (const family of ["Inter", "Open Sans", "A".repeat(64)])
      expect(params.safeParse({ family }).success, family).toBe(true);
    for (const family of ["", " Inter", "In/ter", "Inter&x=1", "A".repeat(65), "Inter\n"])
      expect(params.safeParse({ family }).success, JSON.stringify(family)).toBe(false);
    expect(params.safeParse({ family: "Inter", extra: 1 }).success).toBe(false);
    expect(fontsMethods["fonts.remove"].params.safeParse({ slug: "../x" }).success).toBe(false);
    expect(fontsMethods["fonts.remove"].params.safeParse({ slug: "open-sans" }).success).toBe(true);
  });

  it("declare the limits and the error codes the screen words", () => {
    expect(FONT_LIMITS).toEqual({
      families: 16,
      filesPerFamily: 24,
      fileBytes: 2 * 1024 * 1024,
      cssBytes: 256 * 1024,
    });
    expect(fontsMethods["fonts.add"].errors).toEqual(
      expect.arrayContaining(["not_found", "network", "limit_reached", "bad_request"]),
    );
    expect(ERROR_CODES).toContain("network");
    expect(ERROR_MESSAGES.network).not.toBe("");
  });
});

describe("appearance font choices", () => {
  it("take the bundled names, system or custom:<slug>, and nothing else", () => {
    const ui = AccountAppearanceFields.shape.uiFont;
    const mono = AccountAppearanceFields.shape.monoFont;
    for (const value of ["manrope", "system", "custom:inter", "custom:open-sans"])
      expect(ui.safeParse(value).success, value).toBe(true);
    for (const value of ["jetbrains-mono", "custom:", "custom:../x", "custom:A", "Custom:a", "inter"])
      expect(ui.safeParse(value).success, value).toBe(false);
    for (const value of ["jetbrains-mono", "system", "custom:fira-code"])
      expect(mono.safeParse(value).success, value).toBe(true);
    for (const value of ["manrope", "custom:x y"]) expect(mono.safeParse(value).success, value).toBe(false);
    expect(ui.parse(undefined)).toBe("manrope");
    expect(mono.parse(undefined)).toBe("jetbrains-mono");
  });
});
