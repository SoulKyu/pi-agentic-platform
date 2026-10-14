// @vitest-environment happy-dom
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { settingsSkillsEn, settingsSkillsFr } from "./catalog/settings-skills.ts";
import { registerCatalog, translate } from "./index.ts";

const src = join(import.meta.dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe("lazy catalog (Settings › Skills)", () => {
  it("registers with the section's chunk, English and French, with the same keys and slots", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(translate("en", "settingsSkills.retry")).toBe("settingsSkills.retry");
    await act(async () => registerCatalog({ en: settingsSkillsEn, fr: settingsSkillsFr }));
    expect(translate("en", "settingsSkills.retry")).toBe("Try again");
    expect(translate("fr", "settingsSkills.group.partial", { on: 1, total: 3 })).toBe("1/3 activés");
    expect(Object.keys(settingsSkillsFr)).toEqual(Object.keys(settingsSkillsEn));
    const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(settingsSkillsEn) as Array<keyof typeof settingsSkillsEn>) {
      expect(settingsSkillsFr[key], key).not.toBe("");
      expect(slots(settingsSkillsFr[key]), key).toEqual(slots(settingsSkillsEn[key]));
    }
  });

  it("is named only by the section's own files: nothing eager or in the Settings chunk can render a raw key", () => {
    const inChunk = new Set([
      "features/skills/PluginInstall.tsx",
      "features/skills/PluginList.tsx",
      "features/skills/ProtectedAsk.tsx",
      "features/skills/ScopePicker.tsx",
      "features/skills/SkillList.tsx",
      "features/skills/SkillSearch.tsx",
      "features/skills/SkillsSection.tsx",
      "features/skills/register-skills-catalog.ts",
      "features/skills/skills.vm.ts",
    ]);
    expect([...inChunk].filter((file) => !existsSync(join(src, file)))).toEqual([]);
    const offenders: string[] = [];
    for (const file of files(src)) {
      const name = relative(src, file).split("\\").join("/");
      if (!/\.tsx?$/.test(name) || /\.test\.|^i18n\/|^testing\/|skills-bed/.test(name) || inChunk.has(name))
        continue;
      const code = readFileSync(file, "utf8");
      if (/["'`]settingsSkills\./.test(code)) offenders.push(`${name}: settingsSkills key`);
      if (/catalog\/settings-skills\.ts"|register-skills-catalog\.ts"/.test(code))
        offenders.push(`${name}: import`);
    }
    expect(offenders).toEqual([]);
  });

  it("stays out of the eager catalogs and apart from the other lazy ones", async () => {
    const { en } = await import("./en.ts");
    const { fr } = await import("./fr.ts");
    const { settingsMcpEn } = await import("./catalog/settings-mcp.ts");
    const { settingsScreenEn } = await import("./catalog/settings-screen.ts");
    expect(Object.keys(en).filter((key) => key.startsWith("settingsSkills."))).toEqual([]);
    expect(Object.keys(fr).filter((key) => key.startsWith("settingsSkills."))).toEqual([]);
    for (const other of [settingsMcpEn, settingsScreenEn])
      expect(Object.keys(other).filter((key) => key in settingsSkillsEn)).toEqual([]);
  });
});
