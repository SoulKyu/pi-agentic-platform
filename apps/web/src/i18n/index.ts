import { useCallback, useSyncExternalStore } from "react";
import { reportClientIssue } from "../lib/report.ts";
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

const listeners = new Set<() => void>();

export function setLocale(locale: Locale): void {
  if (current === locale) return;
  current = locale;
  for (const listener of [...listeners]) listener();
}

export const getLocale = (): Locale => current;

export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** The locale as React state: components that read it re-render when it changes, the Compiler included. */
export function useLocale(): Locale {
  return useSyncExternalStore(onLocaleChange, getLocale, getLocale);
}

/** `t` for components. Plain `t()` stays for code outside React (view-models, toasts built in handlers). */
export function useT(): Translate {
  const locale = useLocale();
  return useCallback((key, vars) => translate(locale, key, vars), [locale]);
}

/** Settings › Language: remembered on this device, applied without a reload. False: applied to this page only. */
export function switchLocale(
  locale: Locale,
  deps: { storage?: Pick<Storage, "setItem">; root?: HTMLElement } = {},
): boolean {
  let stored = true;
  try {
    (deps.storage ?? localStorage).setItem("pap.locale", locale);
  } catch {
    stored = false;
    reportClientIssue("storage_refused");
  }
  (deps.root ?? document.documentElement).lang = locale;
  setLocale(locale);
  return stored;
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
