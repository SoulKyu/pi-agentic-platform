import { describe, expect, it } from "vitest";
import { translate, type Locale } from "../../../i18n/index.ts";
import { resultCountLabel } from "./result-count.ts";

const label = (locale: Locale, count: number) =>
  resultCountLabel(locale, (key, vars) => translate(locale, key, vars), count);

describe("resultCountLabel", () => {
  it("English: singular for 1 only", () => {
    expect([0, 1, 2].map((n) => label("en", n))).toEqual(["0 results", "1 result", "2 results"]);
  });
  it("French: singular for 0 and 1", () => {
    expect([0, 1, 2].map((n) => label("fr", n))).toEqual(["0 résultat", "1 résultat", "2 résultats"]);
  });
});
