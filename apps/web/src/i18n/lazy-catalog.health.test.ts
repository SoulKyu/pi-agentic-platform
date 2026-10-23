import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { HEALTH_TABLE } from "@pap/contracts";
import { healthEn, healthFr } from "./catalog/health.ts";
import { en } from "./en.ts";
import { fr } from "./fr.ts";

const src = join(import.meta.dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe("lazy catalog (health)", () => {
  it("has the same keys and slots in English and French, none empty", () => {
    expect(Object.keys(healthFr)).toEqual(Object.keys(healthEn));
    const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(healthEn) as Array<keyof typeof healthEn>) {
      expect(healthFr[key], key).not.toBe("");
      expect(slots(healthFr[key]), key).toEqual(slots(healthEn[key]));
    }
  });

  it("carries the fixed sentences of the brief", () => {
    expect(healthEn["health.title"]).toBe("Health");
    expect(healthFr["health.title"]).toBe("Santé");
    expect(healthEn["health.failed"]).toBe(
      "The failure list did not load. The daemon keeps running and the events are kept. Retry.",
    );
    expect(healthFr["health.failed"]).toBe(
      "La liste des échecs n'a pas chargé. Le daemon continue de tourner et les événements sont conservés. Réessayez.",
    );
    expect(healthEn["health.empty.title"]).toBe("No daemon failures recorded for this daemon run.");
    expect(healthFr["health.empty.title"]).toBe("Aucun échec enregistré pour cette exécution du daemon.");
    expect(healthEn["health.empty.action"]).toBe("Open the tasks board");
    expect(healthFr["health.empty.action"]).toBe("Ouvrir le tableau des tâches");
  });

  it("covers every code of the closed table, feed_status with its {status} slot", () => {
    for (const row of HEALTH_TABLE) {
      if (row.code === "feed_status_<n>") {
        expect(healthEn["health.code.feed_status"]).toContain("{status}");
        expect(healthFr["health.code.feed_status"]).toContain("{status}");
        continue;
      }
      expect(healthEn[`health.code.${row.code}`], row.code).toBeDefined();
      expect(healthFr[`health.code.${row.code}`], row.code).toBeDefined();
    }
  });

  it("is named only by the health chunk's own files, and stays out of the eager catalogs", () => {
    const inChunk = new Set([
      "features/health/HealthSection.tsx",
      "features/health/health.vm.ts",
      "routes/settings/HealthSettings.tsx",
    ]);
    expect([...inChunk].filter((file) => !existsSync(join(src, file)))).toEqual([]);
    const offenders: string[] = [];
    for (const file of files(src)) {
      const name = relative(src, file).split("\\").join("/");
      if (!/\.tsx?$/.test(name) || /\.test\.|^i18n\/|^testing\//.test(name) || inChunk.has(name)) continue;
      const code = readFileSync(file, "utf8");
      if (/["'`]health\./.test(code)) offenders.push(`${name}: health key`);
      if (/catalog\/health\.ts"|register-health\.ts"/.test(code)) offenders.push(`${name}: import`);
    }
    expect(offenders).toEqual([]);
    expect(Object.keys(en).filter((key) => key.startsWith("health."))).toEqual([]);
    expect(Object.keys(fr).filter((key) => key.startsWith("health."))).toEqual([]);
  });
});
