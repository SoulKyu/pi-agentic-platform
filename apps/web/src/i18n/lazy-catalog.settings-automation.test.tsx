// @vitest-environment happy-dom
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { settingsAutomationEn, settingsAutomationFr } from "./catalog/settings-automation.ts";

const src = join(import.meta.dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe("lazy catalog (Settings › Automation)", () => {
  it("has the same keys and slots in English and French", () => {
    expect(Object.keys(settingsAutomationFr)).toEqual(Object.keys(settingsAutomationEn));
    const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(settingsAutomationEn) as Array<keyof typeof settingsAutomationEn>) {
      expect(settingsAutomationFr[key], key).not.toBe("");
      expect(slots(settingsAutomationFr[key]), key).toEqual(slots(settingsAutomationEn[key]));
    }
  });

  it("is named only by the section's own files: nothing eager can render a raw key", () => {
    const inChunk = new Set([
      "features/usage/AutomationForm.tsx",
      "features/usage/AutomationSection.tsx",
      "features/usage/ObservabilityState.tsx",
      "features/usage/SpendingPanel.tsx",
      "features/usage/automation-form.vm.ts",
      "features/usage/register-automation-settings-catalog.ts",
      "features/usage/spending.vm.ts",
    ]);
    expect([...inChunk].filter((file) => !existsSync(join(src, file)))).toEqual([]);
    const offenders: string[] = [];
    for (const file of files(src)) {
      const name = relative(src, file).split("\\").join("/");
      if (!/\.tsx?$/.test(name) || /\.test\.|^i18n\/|^testing\//.test(name) || inChunk.has(name)) continue;
      const code = readFileSync(file, "utf8");
      if (/["'`]settingsAutomation\./.test(code)) offenders.push(`${name}: settingsAutomation key`);
      if (/catalog\/settings-automation\.ts"|register-automation-settings-catalog\.ts"/.test(code))
        offenders.push(`${name}: import`);
    }
    expect(offenders).toEqual([]);
  });

  it("stays out of the eager catalogs", async () => {
    const { en } = await import("./en.ts");
    const { fr } = await import("./fr.ts");
    expect(Object.keys(en).filter((key) => key.startsWith("settingsAutomation."))).toEqual([]);
    expect(Object.keys(fr).filter((key) => key.startsWith("settingsAutomation."))).toEqual([]);
  });
});
