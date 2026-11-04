// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { settingsAppearanceEn, settingsAppearanceFr } from "../../i18n/catalog/settings-appearance.ts";
import { registerCatalog, setLocale } from "../../i18n/index.ts";
import { button, click, mount } from "../../testing/dom.ts";
import { segmentedGroup } from "../../testing/names.ts";
import { useAppearanceStore } from "./appearance-store.ts";
import { DEFAULT_ACCOUNT, parseAccount } from "./model.ts";
import { StartSection } from "./StartSection.tsx";

registerCatalog({ en: settingsAppearanceEn, fr: settingsAppearanceFr });
beforeEach(() => {
  setLocale("en");
  useAppearanceStore.setState({ account: DEFAULT_ACCOUNT });
});

describe("Settings › Appearance › Start (decision 147)", () => {
  it("defaults to Home, and an older document keeps it", () => {
    expect(DEFAULT_ACCOUNT.openOn).toBe("home");
    expect(parseAccount({ grid: false }).openOn).toBe("home");
  });

  it("offers Home and Overview with Home selected", async () => {
    const page = await mount(<StartSection />);
    expect(segmentedGroup(page.container, "Open on")).not.toBeNull();
    const selected = [...page.container.querySelectorAll('[aria-checked="true"]')].map((n) => n.textContent);
    expect(selected).toEqual(["Home"]);
  });

  it("writes overview to the account document, leaving the rest as it was", async () => {
    const page = await mount(<StartSection />);
    await click(button(page.container, "Overview"));
    const account = useAppearanceStore.getState().account;
    expect(account.openOn).toBe("overview");
    expect({ ...account, openOn: "home" }).toEqual(DEFAULT_ACCOUNT);
  });

  it("speaks French", async () => {
    setLocale("fr");
    const page = await mount(<StartSection />);
    expect(segmentedGroup(page.container, "Ouvrir sur")).not.toBeNull();
    expect(button(page.container, "Vue d'ensemble")).toBeTruthy();
  });
});
