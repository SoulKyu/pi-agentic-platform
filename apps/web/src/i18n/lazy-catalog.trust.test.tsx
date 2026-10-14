// @vitest-environment happy-dom
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { trustBannerEn, trustBannerFr, trustEn, trustFr } from "./catalog/trust.ts";
import { registerCatalog, translate } from "./index.ts";

const src = join(import.meta.dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe("lazy catalog (trust)", () => {
  it("registers English and French with the same keys and slots, banner and dialog apart", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(translate("en", "trust.banner.review")).toBe("trust.banner.review");
    await act(async () =>
      registerCatalog({ en: { ...trustBannerEn, ...trustEn }, fr: { ...trustBannerFr, ...trustFr } }),
    );
    expect(translate("en", "trust.banner.review")).toBe("Review");
    expect(Object.keys(trustFr)).toEqual(Object.keys(trustEn));
    expect(Object.keys(trustBannerFr)).toEqual(Object.keys(trustBannerEn));
    expect(Object.keys(trustBannerEn).filter((key) => key in trustEn)).toEqual([]);
    const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const [en, fr] of [
      [trustEn, trustFr],
      [trustBannerEn, trustBannerFr],
    ] as const)
      for (const key of Object.keys(en) as Array<keyof typeof en>) {
        expect(fr[key as keyof typeof fr], key).not.toBe("");
        expect(slots(fr[key as keyof typeof fr]), key).toEqual(slots(en[key]));
      }
  });

  it("stays out of the eager catalogs", async () => {
    const { en } = await import("./en.ts");
    const { fr } = await import("./fr.ts");
    expect(Object.keys(en).filter((key) => key.startsWith("trust."))).toEqual([]);
    expect(Object.keys(fr).filter((key) => key.startsWith("trust."))).toEqual([]);
  });

  it("the dialog is lazy: only the banner and the Settings MCP section name it, by import()", () => {
    const named = new Set(["features/trust/TrustBanner.tsx", "features/mcp/McpSection.tsx"]);
    expect([...named].filter((file) => !existsSync(join(src, file)))).toEqual([]);
    const offenders: string[] = [];
    for (const file of files(src)) {
      const name = relative(src, file).split("\\").join("/");
      if (!/\.tsx?$/.test(name) || /\.test\.|^i18n\/|^testing\/|trust-bed/.test(name)) continue;
      const code = readFileSync(file, "utf8");
      const importsDialog = /^import[^;]*["'][^"']*(TrustDialog|TrustResources)\.tsx["']/m.test(code);
      if (importsDialog && !name.startsWith("features/trust/")) offenders.push(`${name}: static import`);
      if (/^import[^;]*catalog\/trust\.ts/m.test(code) && !name.startsWith("features/trust/register"))
        offenders.push(`${name}: catalog import`);
    }
    expect(offenders).toEqual([]);
  });
});
