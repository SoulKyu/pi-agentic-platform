import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { settingsScreenEn, settingsScreenFr } from "./catalog/settings-screen.ts";

const dir = new URL("./catalog/", import.meta.url);
const values = readdirSync(dir)
  .filter((file) => file.endsWith(".ts") && !file.includes(".test."))
  .flatMap((file) =>
    [
      ...readFileSync(new URL(file, dir), "utf8").matchAll(
        /^ {2}"([^"]*(?:\.loading|transcript\.thinking))": "(.*)",?$/gm,
      ),
    ].map((match) => ({ file, key: match[1] ?? "", value: match[2] ?? "" })),
  );

describe("loading copy", () => {
  it("every loading value ends with … and none with ...", () => {
    expect(values.length).toBeGreaterThan(40);
    const bad = values.filter(({ value }) => !value.endsWith("…") || value.endsWith("..."));
    expect(bad.map(({ file, key }) => `${file} ${key}`)).toEqual([]);
  });

  it("no catalog value ends in three ASCII dots, whatever its key", () => {
    const THREE_DOTS = "\u002e\u002e\u002e";
    const bad = readdirSync(dir)
      .filter((file) => file.endsWith(".ts") && !file.includes(".test."))
      .flatMap((file) =>
        [...readFileSync(new URL(file, dir), "utf8").matchAll(/^ {2}"([^"]+)":\s*"(.*)",?$/gm)]
          .filter((match) => (match[2] ?? "").endsWith(THREE_DOTS))
          .map((match) => `${file} ${match[1] ?? ""}`),
      );
    expect(bad).toEqual([]);
  });

  it("Settings › GitHub has a loading key of its own", () => {
    expect(settingsScreenEn["settings.github.loading"]).toBe("Loading the GitHub settings…");
    expect(settingsScreenFr["settings.github.loading"]).toBe("Chargement des réglages GitHub…");
  });
});
