import type { Locale, Translate } from "../../../i18n/index.ts";

/** The count line read out politely. The plural category comes from the language (French: 0 is singular). */
export function resultCountLabel(locale: Locale, t: Translate, count: number): string {
  const singular = new Intl.PluralRules(locale).select(count) === "one";
  return t(singular ? "commands.palette.countOne" : "commands.palette.count", { count });
}
