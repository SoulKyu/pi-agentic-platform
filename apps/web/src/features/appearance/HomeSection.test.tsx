// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { settingsAppearanceEn, settingsAppearanceFr } from "../../i18n/catalog/settings-appearance.ts";
import { registerCatalog } from "../../i18n/index.ts";
import { click, mount, text } from "../../testing/dom.ts";
import { useAppearanceStore } from "./appearance-store.ts";
import { HomeSection } from "./HomeSection.tsx";
import { DEFAULT_ACCOUNT } from "./model.ts";

registerCatalog({ en: settingsAppearanceEn, fr: settingsAppearanceFr });
const box = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="checkbox"]')].find(
    (candidate) => candidate.closest("label")?.textContent === label,
  ) as HTMLElement;

beforeEach(() => useAppearanceStore.setState({ account: DEFAULT_ACCOUNT }));

describe("Settings › Appearance › Home (§6)", () => {
  it("has one checkbox per part, all checked by default, and none for the composer", async () => {
    const page = await mount(<HomeSection />);
    expect(text(page.container)).toContain("Home");
    expect(
      [...document.querySelectorAll('[role="checkbox"]')].map((node) => node.getAttribute("aria-checked")),
    ).toEqual(["true", "true", "true", "true", "true", "true"]);
    expect(text(page.container)).toContain("The composer is always shown.");
  });

  it("unchecking a part writes it to the account document and leaves the others", async () => {
    await mount(<HomeSection />);
    await click(box("Status line"));
    await click(box("Recent work"));
    expect(useAppearanceStore.getState().account.home).toEqual({
      ...DEFAULT_ACCOUNT.home,
      status: false,
      recent: false,
    });
    expect(useAppearanceStore.getState().account.customThemes).toEqual(DEFAULT_ACCOUNT.customThemes);
  });
});
