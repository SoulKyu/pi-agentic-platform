import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DENSITY_SIZES } from "./ReadingSection.tsx";

const tokens = readFileSync(join(import.meta.dirname, "../../../../../packages/ui/src/tokens.css"), "utf8");

const sizesOf = (density: string) => {
  const block = new RegExp(`\\[data-density="${density}"\\]\\s*\\{([^}]*)\\}`).exec(tokens)?.[1] ?? "";
  const px = (name: string) => Number(new RegExp(`--size-${name}:\\s*([\\d.]+)px`).exec(block)?.[1]);
  return { uiSize: px("ui"), chatSize: px("chat"), codeSize: px("code") };
};

describe("slider positions while following a density", () => {
  it.each(Object.keys(DENSITY_SIZES))("%s matches tokens.css", (density) => {
    expect(DENSITY_SIZES[density as keyof typeof DENSITY_SIZES]).toEqual(sizesOf(density));
  });
});
