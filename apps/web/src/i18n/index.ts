import { en } from "./en.ts";
import { fr } from "./fr.ts";

export type MessageKey = keyof typeof en;
export type Locale = "en" | "fr";

/** Errors the page raises itself, next to the server's `ERROR_CODES`. */
export const CLIENT_ERROR_CODES = [
  "connection_lost",
  "offline",
  "passkey_cancelled",
  "passkey_failed",
  "password_incorrect",
] as const;
const CATALOGS: Record<Locale, { readonly [K in MessageKey]: string }> = { en, fr };
let current: Locale = "en";

export function pickLocale(languages: readonly string[], stored: string | null): Locale {
  if (stored === "en" || stored === "fr") return stored;
  return languages.some((language) => language.toLowerCase().startsWith("fr")) ? "fr" : "en";
}

export function setLocale(locale: Locale): void {
  current = locale;
}

export function translate(
  locale: Locale,
  key: MessageKey,
  vars: Record<string, string | number> = {},
): string {
  return CATALOGS[locale][key].replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

type PluralBase = {
  [K in MessageKey]: K extends `${infer Base}.one` ? Base : never;
}[MessageKey];

/** A message that depends on a count: `<base>.one`, `<base>.other`... by the locale's plural rules, `.other` when a form is missing. */
export function plural(locale: Locale, base: PluralBase, count: number): string {
  const form = new Intl.PluralRules(locale).select(count);
  const key = `${base}.${form}`;
  return translate(locale, (Object.hasOwn(en, key) ? key : `${base}.other`) as MessageKey, { count });
}

export const tp = (base: PluralBase, count: number): string => plural(current, base, count);

export const t = (key: MessageKey, vars?: Record<string, string | number>): string =>
  translate(current, key, vars);

export function errorKey(code: string): MessageKey {
  const key = `error.${code}`;
  return Object.hasOwn(en, key) ? (key as MessageKey) : "error.internal";
}
