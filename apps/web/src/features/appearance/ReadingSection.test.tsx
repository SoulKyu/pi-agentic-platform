// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { settingsAppearanceEn, settingsAppearanceFr } from "../../i18n/catalog/settings-appearance.ts";
import { registerCatalog, setLocale } from "../../i18n/index.ts";
import { button, click, mount } from "../../testing/dom.ts";
import { segmentedGroup } from "../../testing/names.ts";
import { useAppearanceStore } from "./appearance-store.ts";
import { DEFAULT_DEVICE } from "./model.ts";
import { ReadingSection } from "./ReadingSection.tsx";

registerCatalog({ en: settingsAppearanceEn, fr: settingsAppearanceFr });
beforeEach(() => {
  setLocale("en");
  useAppearanceStore.setState({ device: DEFAULT_DEVICE });
});

describe("Settings › Appearance › Reading", () => {
  it("Line length starts at Full width and sets data-prose to limited and back", async () => {
    const page = await mount(<ReadingSection />);
    const group = segmentedGroup(page.container, "Line length");
    expect(group).not.toBeNull();
    expect(group?.querySelector('[aria-checked="true"]')?.textContent).toBe("Full width");
    await click(button(page.container, "Limited"));
    expect(useAppearanceStore.getState().device.proseMeasure).toBe("limited");
    await click(button(page.container, "Full width"));
    expect(useAppearanceStore.getState().device.proseMeasure).toBe("full");
  });

  it("chat width and motion show their labels", async () => {
    const page = await mount(<ReadingSection />);
    const labels = [...page.container.querySelectorAll('[data-slot="segmented-field"] > span')];
    const visible = labels.filter((label) => !label.classList.contains("sr-only")).map((l) => l.textContent);
    expect(visible).toEqual(expect.arrayContaining(["Density", "Chat width", "Motion", "Line length"]));
  });

  it("speaks French", async () => {
    setLocale("fr");
    const page = await mount(<ReadingSection />);
    expect(segmentedGroup(page.container, "Longueur des lignes")).not.toBeNull();
  });
});
