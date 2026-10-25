// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { settingsAgentsEn, settingsAgentsFr } from "../../i18n/catalog/settings-agents.ts";
import { registerCatalog, setLocale } from "../../i18n/index.ts";
import { button, click, mount, text } from "../../testing/dom.ts";
import { segmentedGroup } from "../../testing/names.ts";
import { AgentsSection } from "./AgentsSection.tsx";
import { useAppearanceStore } from "./appearance-store.ts";
import { DEFAULT_ACCOUNT, parseAccount } from "./model.ts";

registerCatalog({ en: settingsAgentsEn, fr: settingsAgentsFr });
beforeEach(() => {
  setLocale("en");
  useAppearanceStore.setState({ account: DEFAULT_ACCOUNT });
});

describe("the agent appearance fields in the account document (M11R98)", () => {
  it("default to cards and shown", () => {
    expect(DEFAULT_ACCOUNT.eventCards).toBe("cards");
    expect(DEFAULT_ACCOUNT.statusPanel).toBe("shown");
  });

  it("read from an older document that has neither, and keep the other fields", () => {
    const parsed = parseAccount({ grid: false });
    expect([parsed.eventCards, parsed.statusPanel, parsed.grid]).toEqual(["cards", "shown", false]);
  });

  it("fall back one by one when a value is not one of the words", () => {
    const parsed = parseAccount({ eventCards: "compact", statusPanel: "folded" });
    expect([parsed.eventCards, parsed.statusPanel]).toEqual(["compact", "shown"]);
  });
});

describe("Settings › Appearance › Agents", () => {
  it("offers both options with the boards' defaults selected", async () => {
    const page = await mount(<AgentsSection />);
    expect(text(page.container)).toContain("Agents");
    expect(segmentedGroup(page.container, "Event cards")).not.toBeNull();
    expect(segmentedGroup(page.container, "Status panel")).not.toBeNull();
    const selected = [...page.container.querySelectorAll('[aria-checked="true"]')].map((n) => n.textContent);
    expect(selected).toEqual(["Cards", "Shown"]);
  });

  it("writes compact and hidden to the account document, leaving the rest as it was", async () => {
    const page = await mount(<AgentsSection />);
    await click(button(page.container, "Compact"));
    await click(button(page.container, "Hidden"));
    const account = useAppearanceStore.getState().account;
    expect([account.eventCards, account.statusPanel]).toEqual(["compact", "hidden"]);
    expect({ ...account, eventCards: "cards", statusPanel: "shown" }).toEqual(DEFAULT_ACCOUNT);
  });

  it("explains that hidden leaves a toggle in the agent header", async () => {
    const page = await mount(<AgentsSection />);
    expect(text(page.container)).toContain("a toggle in the agent header");
  });
});
