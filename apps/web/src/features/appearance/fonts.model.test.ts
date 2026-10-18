import type { FontFamilyView } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { DEFAULT_ACCOUNT, DEFAULT_DEVICE, parseAccount, resolveAppearance, toBootCache } from "./model.ts";

const inter: FontFamilyView = { slug: "inter", family: "Inter", files: 2, bytes: 100, addedAt: 1 };
const mono: FontFamilyView = { slug: "fira-code", family: "Fira Code", files: 1, bytes: 50, addedAt: 2 };
const resolve = (over: Partial<typeof DEFAULT_ACCOUNT>, families: readonly FontFamilyView[] | null) =>
  resolveAppearance({ ...DEFAULT_ACCOUNT, ...over }, DEFAULT_DEVICE, false, families);

describe("custom fonts in the appearance", () => {
  it("an installed family sets the attribute to custom and the UI variable to its name", () => {
    const resolved = resolve({ uiFont: "custom:inter" }, [inter, mono]);
    expect(resolved.attrs["font-ui"]).toBe("custom");
    expect(resolved.vars["--font-ui"]).toBe('"Inter", ui-sans-serif, system-ui, sans-serif');
    expect(resolved.fontSlugs).toEqual(["inter"]);
    expect(resolved.vars["--font-code"]).toBeUndefined();
  });

  it("the code font uses its own variable, and both can be custom", () => {
    const resolved = resolve({ uiFont: "custom:inter", monoFont: "custom:fira-code" }, [inter, mono]);
    expect(resolved.attrs["font-mono"]).toBe("custom");
    expect(resolved.vars["--font-code"]).toBe('"Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace');
    expect(resolved.fontSlugs).toEqual(["inter", "fira-code"]);
  });

  it("a removed or not yet loaded family falls back to the default and links nothing", () => {
    for (const families of [[], [mono], null]) {
      const resolved = resolve({ uiFont: "custom:inter" }, families);
      expect(resolved.attrs["font-ui"], JSON.stringify(families)).toBe("default");
      expect(resolved.vars["--font-ui"]).toBeUndefined();
      expect(resolved.fontSlugs ?? []).toEqual([]);
    }
  });

  it("system and the bundled choices resolve as before", () => {
    expect(resolve({ uiFont: "system" }, [inter]).attrs["font-ui"]).toBe("system");
    expect(resolve({}, [inter]).attrs["font-ui"]).toBe("default");
    expect(resolve({ monoFont: "system" }, [inter]).attrs["font-mono"]).toBe("system");
  });

  it("never puts a name that is not a plain family name into a variable", () => {
    const hostile = { ...inter, family: 'Inter"; background: url(//x)' };
    expect(resolve({ uiFont: "custom:inter" }, [hostile]).vars["--font-ui"]).toBeUndefined();
  });

  it("parseAccount keeps a well formed custom choice and drops a malformed one field by field", () => {
    expect(parseAccount({ uiFont: "custom:inter", monoFont: "custom:fira-code" })).toMatchObject({
      uiFont: "custom:inter",
      monoFont: "custom:fira-code",
    });
    expect(parseAccount({ uiFont: "custom:../x", monoFont: "jetbrains-mono", grid: false })).toMatchObject({
      uiFont: "manrope",
      grid: false,
    });
    for (const bad of ["custom:", "Custom:inter", "custom:Inter", "jetbrains-mono", "custom:a b", 4, null])
      expect(parseAccount({ uiFont: bad }).uiFont, String(bad)).toBe("manrope");
    for (const bad of ["manrope", "custom:", "custom:x/y"])
      expect(parseAccount({ monoFont: bad }).monoFont, String(bad)).toBe("jetbrains-mono");
  });

  it("the boot cache never replays a custom font: it falls back to the default until the list is loaded", () => {
    const cache = toBootCache({ ...DEFAULT_ACCOUNT, uiFont: "custom:inter" }, DEFAULT_DEVICE);
    expect(cache.attrs["font-ui"]).toBe("default");
  });
});
