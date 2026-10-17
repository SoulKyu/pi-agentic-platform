import { describe, expect, it } from "vitest";
import {
  AccountAppearance,
  AccountAppearanceFields,
  AgentsSettings,
  SETTING_KEYS,
  SettingWrite,
} from "./settings.ts";

const older = {
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

describe("the agent appearance options (M11R98)", () => {
  it("default to the boards: cards, and the status panel shown", () => {
    const parsed = AccountAppearance.parse({});
    expect(parsed.eventCards).toBe("cards");
    expect(parsed.statusPanel).toBe("shown");
  });

  it("read from a document written before they existed", () => {
    const parsed = AccountAppearance.safeParse(older);
    expect(parsed.success).toBe(true);
    expect(parsed.success && [parsed.data.eventCards, parsed.data.statusPanel]).toEqual(["cards", "shown"]);
  });

  it("take compact and hidden, and refuse any other word", () => {
    const parsed = AccountAppearance.parse({ eventCards: "compact", statusPanel: "hidden" });
    expect([parsed.eventCards, parsed.statusPanel]).toEqual(["compact", "hidden"]);
    expect(AccountAppearanceFields.shape.eventCards.safeParse("tiny").success).toBe(false);
    expect(AccountAppearanceFields.shape.statusPanel.safeParse("folded").success).toBe(false);
  });
});

describe("the agents settings document (M11R99)", () => {
  it("is a setting key written with a revision, like the others", () => {
    expect(SETTING_KEYS).toContain("agents");
    expect(SettingWrite.safeParse({ key: "agents", value: {}, baseRevision: 0 }).success).toBe(true);
  });

  it("defaults the new-agent form to a required sandbox without network", () => {
    expect(AgentsSettings.parse({})).toEqual({
      newAgent: { sandbox: { required: true, network: false } },
      subagents: { enabled: true, maxConcurrent: 2 },
    });
    expect(AgentsSettings.parse({ newAgent: { sandbox: { network: true } } }).newAgent.sandbox).toEqual({
      required: true,
      network: true,
    });
  });

  it("refuses a value of the wrong type", () => {
    expect(
      SettingWrite.safeParse({
        key: "agents",
        value: { newAgent: { sandbox: { required: "yes" } } },
        baseRevision: 0,
      }).success,
    ).toBe(false);
  });
});
