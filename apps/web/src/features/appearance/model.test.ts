import { AccountAppearance } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_CACHE_KEY,
  changedAccountFields,
  DEFAULT_ACCOUNT,
  DEFAULT_DEVICE,
  DEVICE_KEY,
  mergeAccount,
  parseAccount,
  parseDevice,
  resolveAppearance,
  toBootCache,
} from "./model.ts";

const ocean = {
  id: "ocean",
  name: "Ocean",
  base: "night",
  roles: {
    bg: "#0E1626",
    surface: "#132033",
    text: "#E6EDF7",
    agent: "#38BDF8",
    you: "#FB923C",
    attn: "#EC4899",
    ok: "#34D399",
    err: "#F87171",
  },
} as const;

describe("appearance model", () => {
  it("pins the storage keys the boot script reads", () => {
    expect([DEVICE_KEY, ACCOUNT_CACHE_KEY]).toEqual([
      "pap.appearance.device.v1",
      "pap.appearance.account.v1",
    ]);
  });

  it("device settings parse fail-soft, field by field", () => {
    expect(parseDevice(null)).toEqual(DEFAULT_DEVICE);
    expect(parseDevice("{not json")).toEqual(DEFAULT_DEVICE);
    expect(parseDevice('{"density":"comfortable","uiSize":99,"motion":"none","extra":1}')).toEqual({
      ...DEFAULT_DEVICE,
      density: "comfortable",
      motion: "none",
    });
  });

  it("DEFAULT_ACCOUNT is the contracts' defaults, and anything but an object reads as them", () => {
    expect(AccountAppearance.parse({})).toEqual(DEFAULT_ACCOUNT);
    for (const value of [null, undefined, 3, "x", [1]]) expect(parseAccount(value)).toEqual(DEFAULT_ACCOUNT);
  });

  it("a document missing one field keeps the others (owner R3-4)", () => {
    const older = Object.fromEntries(
      Object.entries({ ...DEFAULT_ACCOUNT, railPosition: "right", toolDetail: "full" }).filter(
        ([name]) => name !== "grid",
      ),
    );
    expect(parseAccount(older)).toEqual({ ...DEFAULT_ACCOUNT, railPosition: "right", toolDetail: "full" });
  });

  it("a bad field falls back on its own", () => {
    expect(parseAccount({ ...DEFAULT_ACCOUNT, mode: "sepia", grid: "yes", railPosition: "right" })).toEqual({
      ...DEFAULT_ACCOUNT,
      railPosition: "right",
    });
  });

  it("keeps the valid custom themes, drops the rest, and repairs a side whose theme is gone", () => {
    const account = parseAccount({
      ...DEFAULT_ACCOUNT,
      customThemes: [
        ocean,
        { ...ocean, id: "day" },
        { ...ocean, roles: { ...ocean.roles, bg: "red" } },
        ocean,
      ],
      darkTheme: "ocean",
      lightTheme: "ocean",
    });
    expect(account.customThemes).toEqual([ocean]);
    expect([account.darkTheme, account.lightTheme]).toEqual(["ocean", "day"]);
    expect(parseAccount({ ...DEFAULT_ACCOUNT, darkTheme: "gone" }).darkTheme).toBe("night");
    // The cap: at most 16 custom themes survive, the first ones.
    const many = parseAccount({
      ...DEFAULT_ACCOUNT,
      customThemes: Array.from({ length: 20 }, (_, i) => ({ ...ocean, id: `t${i}` })),
    });
    expect([many.customThemes.length, many.customThemes.at(-1)?.id]).toEqual([16, "t15"]);
  });

  it("names the changed fields and merges local changes over the server copy", () => {
    const local = { ...DEFAULT_ACCOUNT, grid: false, customThemes: [ocean], darkTheme: "ocean" };
    expect(changedAccountFields(DEFAULT_ACCOUNT, local).sort()).toEqual([
      "customThemes",
      "darkTheme",
      "grid",
    ]);
    const server = { ...DEFAULT_ACCOUNT, railPosition: "right" } as const;
    expect(mergeAccount(server, local, new Set(["grid"]), DEFAULT_ACCOUNT)).toEqual({
      ...DEFAULT_ACCOUNT,
      railPosition: "right",
      grid: false,
    });
    // The side points to a theme the server copy does not have: it falls back rather than naming nothing.
    expect(mergeAccount(server, local, new Set(["darkTheme"]), DEFAULT_ACCOUNT).darkTheme).toBe("night");
  });

  it("follows the system by default and picks each side's theme", () => {
    expect(resolveAppearance(DEFAULT_ACCOUNT, DEFAULT_DEVICE, false).attrs.theme).toBe("night");
    expect(resolveAppearance(DEFAULT_ACCOUNT, DEFAULT_DEVICE, true).attrs.theme).toBe("day");
    expect(resolveAppearance({ ...DEFAULT_ACCOUNT, mode: "night" }, DEFAULT_DEVICE, true).attrs.theme).toBe(
      "night",
    );
    expect(
      resolveAppearance({ ...DEFAULT_ACCOUNT, darkTheme: "hc" }, DEFAULT_DEVICE, false).attrs.theme,
    ).toBe("hc");
  });

  it("sets a custom theme on its base with its tokens as variables, and device sizes as variables", () => {
    const resolved = resolveAppearance(
      { ...DEFAULT_ACCOUNT, customThemes: [ocean], darkTheme: "ocean" },
      { ...DEFAULT_DEVICE, uiSize: 15 },
      false,
    );
    expect(resolved.attrs.theme).toBe("night");
    expect(resolved.vars["--bg"]).toBe("#0e1626");
    expect(resolved.vars["--size-ui"]).toBe("15px");
  });

  it("maps the account switches to attributes", () => {
    const { attrs } = resolveAppearance(
      { ...DEFAULT_ACCOUNT, uppercaseLabels: false, grid: false, railPosition: "right", uiFont: "system" },
      DEFAULT_DEVICE,
      false,
    );
    expect([attrs.labels, attrs.grid, attrs.rail, attrs["font-ui"]]).toEqual([
      "sentence",
      "off",
      "right",
      "system",
    ]);
  });

  it("caches both sides for the boot script", () => {
    const cache = toBootCache({ ...DEFAULT_ACCOUNT, darkTheme: "hc" }, DEFAULT_DEVICE);
    expect([cache.v, cache.mode, cache.dark.theme, cache.light.theme]).toEqual([1, "system", "hc", "day"]);
    expect(cache.attrs).not.toHaveProperty("theme");
  });
});
