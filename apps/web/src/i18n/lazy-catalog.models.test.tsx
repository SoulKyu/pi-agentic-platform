// @vitest-environment happy-dom
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { serverEn } from "./catalog/server.ts";
import { sessionModelsEn, sessionModelsFr } from "./catalog/session-models.ts";
import { sessionPolicyEn } from "./catalog/session-policy.ts";
import { sessionScreenEn } from "./catalog/session-screen.ts";
import { sidebarEn } from "./catalog/sidebar.ts";
import { registerCatalog, translate } from "./index.ts";

const src = join(import.meta.dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe("lazy catalog (session models)", () => {
  it("registers its strings with the model bar, English and French, the same slots in both", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(translate("en", "sessionModels.idleOnly")).toBe("sessionModels.idleOnly");
    await act(async () => registerCatalog({ en: sessionModelsEn, fr: sessionModelsFr }));
    expect(translate("en", "sessionModels.idleOnly")).toBe("Change the model when the agent is idle");
    expect(translate("fr", "sessionModels.pill.thinking", { level: "élevée" })).toBe(
      "réflexion\u202f: élevée",
    );
    expect(Object.keys(sessionModelsFr)).toEqual(Object.keys(sessionModelsEn));
    const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(sessionModelsEn) as Array<keyof typeof sessionModelsEn>)
      expect(slots(sessionModelsFr[key]), key).toEqual(slots(sessionModelsEn[key]));
  });

  it("is named only by the session chunk's model files: nothing eager can render a raw key", () => {
    const inChunk = new Set([
      "features/sessions/CommandMenu.tsx",
      "features/sessions/ModelBar.tsx",
      "features/sessions/ModelMenu.tsx",
      "features/sessions/model-menu.vm.ts",
      "features/sessions/register-models-catalog.ts",
      "features/sessions/SkillChip.tsx",
    ]);
    expect([...inChunk].filter((file) => !existsSync(join(src, file)))).toEqual([]);
    const offenders: string[] = [];
    for (const file of files(src)) {
      const name = relative(src, file).split("\\").join("/");
      if (!/\.tsx?$/.test(name) || /\.test\.|^i18n\/|^testing\//.test(name) || inChunk.has(name)) continue;
      const code = readFileSync(file, "utf8");
      if (/["'`]sessionModels\./.test(code)) offenders.push(`${name}: sessionModels key`);
      if (/catalog\/session-models\.ts"|register-models-catalog\.ts"/.test(code))
        offenders.push(`${name}: import`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the model bar strings out of the eager catalogs and apart from every other lazy catalog", async () => {
    const { en } = await import("./en.ts");
    const { fr } = await import("./fr.ts");
    expect(Object.keys(en).filter((key) => key.startsWith("sessionModels."))).toEqual([]);
    expect(Object.keys(fr).filter((key) => key.startsWith("sessionModels."))).toEqual([]);
    for (const other of [sessionScreenEn, sessionPolicyEn, serverEn, sidebarEn])
      expect(Object.keys(other).filter((key) => key in sessionModelsEn)).toEqual([]);
  });
});
