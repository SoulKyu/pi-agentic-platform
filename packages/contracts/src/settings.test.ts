import { describe, expect, it } from "vitest";
import { TOKEN_PERMISSIONS } from "./auth.ts";
import { methods } from "./methods.ts";
import {
  AccountAppearance,
  CustomTheme,
  DEFAULT_HOME_LAYOUT,
  KeybindingRules,
  ModelsSettings,
  SETTING_KEYS,
  SettingWrite,
} from "./settings.ts";

const base = {
  mode: "system",
  darkTheme: "night",
  lightTheme: "day",
  customThemes: [],
  uiFont: "manrope",
  monoFont: "jetbrains-mono",
  uppercaseLabels: true,
  grid: true,
  railPosition: "left",
  avatarStyle: "outlined",
  toolDetail: "compact",
  home: { status: true, explore: true, automate: true, project: true, help: true, recent: true },
} as const;
const withoutGrid = Object.fromEntries(Object.entries(base).filter(([name]) => name !== "grid"));
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

describe("account appearance", () => {
  it("accepts the defaults and a custom dark theme in use", () => {
    expect(AccountAppearance.safeParse(base).success).toBe(true);
    expect(AccountAppearance.safeParse({ ...base, customThemes: [ocean], darkTheme: "ocean" }).success).toBe(
      true,
    );
  });

  it("refuses a theme that does not exist or sits on the wrong side, and duplicate ids", () => {
    expect(AccountAppearance.safeParse({ ...base, darkTheme: "ocean" }).success).toBe(false);
    expect(AccountAppearance.safeParse({ ...base, customThemes: [ocean], lightTheme: "ocean" }).success).toBe(
      false,
    );
    expect(AccountAppearance.safeParse({ ...base, customThemes: [ocean, ocean] }).success).toBe(false);
  });

  it("lets only hex colours into a theme (no url(), no names, no alpha)", () => {
    for (const bad of ["url(https://x.test/a)", "red", "#fff", "#11223344", "var(--x)"]) {
      expect(
        AccountAppearance.safeParse({
          ...base,
          customThemes: [{ ...ocean, roles: { ...ocean.roles, bg: bad } }],
        }).success,
        bad,
      ).toBe(false);
    }
  });

  it("refuses a custom theme that takes a preset's id (M3-RT-09)", () => {
    for (const id of ["night", "day", "hc"])
      expect(CustomTheme.safeParse({ ...ocean, id }).success, id).toBe(false);
  });

  it("reads a document written before a field existed: the missing field takes its default", () => {
    expect(AccountAppearance.parse(withoutGrid)).toEqual(base);
    expect(AccountAppearance.parse({})).toEqual(base);
  });
});

describe("keybinding rules", () => {
  it("caps the list at 256 rules and refuses odd command ids", () => {
    const rule = { key: "mod+k", command: "palette.toggle" };
    expect(KeybindingRules.safeParse(Array.from({ length: 256 }, () => rule)).success).toBe(true);
    expect(KeybindingRules.safeParse(Array.from({ length: 257 }, () => rule)).success).toBe(false);
    expect(KeybindingRules.safeParse([{ key: "mod+k", command: "rm -rf /" }]).success).toBe(false);
  });
});

describe("setting writes", () => {
  it("pairs each key with its own schema and always names the revision it was based on", () => {
    expect(SettingWrite.safeParse({ key: "keybindings", value: [], baseRevision: 0 }).success).toBe(true);
    expect(SettingWrite.safeParse({ key: "keybindings", value: [] }).success).toBe(false);
    expect(SettingWrite.safeParse({ key: "keybindings", value: [], baseRevision: -1 }).success).toBe(false);
    expect(SettingWrite.safeParse({ key: "keybindings", value: base, baseRevision: 0 }).success).toBe(false);
    expect(SettingWrite.safeParse({ key: "theme", value: {}, baseRevision: 0 }).success).toBe(false);
  });
});

describe("models setting (M7R138)", () => {
  it("reads as off when nothing is stored, and every field has a default", () => {
    expect(ModelsSettings.parse({})).toEqual({ modelsDevPricing: false });
  });

  it("is a setting key the owner writes with a revision", () => {
    expect(SETTING_KEYS).toContain("models");
    expect(
      SettingWrite.safeParse({ key: "models", value: { modelsDevPricing: true }, baseRevision: 0 }).success,
    ).toBe(true);
    expect(
      SettingWrite.safeParse({ key: "models", value: { modelsDevPricing: "yes" }, baseRevision: 0 }).success,
    ).toBe(false);
  });

  it("takes the automation setting with its defaults, and refuses a bad value", () => {
    expect(SETTING_KEYS).toContain("automation");
    expect(SettingWrite.safeParse({ key: "automation", value: {}, baseRevision: 0 }).success).toBe(true);
    expect(SettingWrite.safeParse({ key: "automation", value: { slots: 0 }, baseRevision: 0 }).success).toBe(
      false,
    );
  });

  it("is flipped with settings:operate, which a token may hold (MC3): the switch only shows a control", () => {
    expect(methods["settings.set"].permission).toBe("settings:operate");
    expect(TOKEN_PERMISSIONS).toContain("settings:operate");
    expect(methods["models.pricing"].permission).toBe("pi:read");
  });
});

describe("the home layout (decision 85)", () => {
  it("shows every part by default, fills a partial layout with the defaults, and refuses a non-boolean", () => {
    const withoutHome = Object.fromEntries(Object.entries(base).filter(([name]) => name !== "home"));
    expect(AccountAppearance.parse(withoutHome).home).toEqual(DEFAULT_HOME_LAYOUT);
    expect(AccountAppearance.parse({ ...base, home: { status: false } }).home).toEqual({
      ...DEFAULT_HOME_LAYOUT,
      status: false,
    });
    expect(AccountAppearance.parse({ ...base, home: { status: false, future: 1 } }).home).toEqual({
      ...DEFAULT_HOME_LAYOUT,
      status: false,
    });
    expect(AccountAppearance.safeParse({ ...base, home: { status: "no" } }).success).toBe(false);
  });
});
