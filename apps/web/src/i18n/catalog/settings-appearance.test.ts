import { describe, expect, it } from "vitest";
import { settingsAppearanceEn, settingsAppearanceFr } from "./settings-appearance.ts";

describe("the settings-appearance catalog", () => {
  it("the font example is IBM Plex Sans", () => {
    expect(settingsAppearanceEn["settings.appearance.fonts.placeholder"]).toBe("IBM Plex Sans");
    expect(settingsAppearanceFr["settings.appearance.fonts.placeholder"]).toBe("IBM Plex Sans");
  });

  it("names the line length choice in both languages", () => {
    expect(settingsAppearanceEn["settings.appearance.prose.full"]).toBe("Full width");
    expect(settingsAppearanceFr["settings.appearance.prose.label"]).toBe("Longueur des lignes");
  });
});
