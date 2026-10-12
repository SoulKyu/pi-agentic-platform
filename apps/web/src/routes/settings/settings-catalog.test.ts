// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { translate } from "../../i18n/index.ts";

vi.mock("../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));

it("loading the Settings screen registers the Settings strings, and its first import is the registration", async () => {
  expect(translate("en", "settings.appearance.title")).toBe("settings.appearance.title");
  await import("./SettingsScreen.tsx");
  expect(translate("en", "settings.appearance.title")).toBe("Appearance");
  expect(translate("fr", "settings.appearance.title")).toBe("Apparence");
  const source = readFileSync(join(import.meta.dirname, "SettingsScreen.tsx"), "utf8");
  expect(source.split("\n")[0]).toBe('import "./register-settings-catalog.ts";');
});
