import { useCallback, useSyncExternalStore } from "react";
import type { LazyFailureText } from "../lib/lazy.tsx";
import { reportClientIssue } from "../lib/report.ts";
import { en } from "./en.ts";
import { fr } from "./fr.ts";

import type { changesEn } from "./catalog/changes.ts";
import type { filesEn } from "./catalog/files.ts";
import type { firstRunEn } from "./catalog/first-run.ts";
import type { galleryEn } from "./catalog/gallery.ts";
import type { laneCommitEn } from "./catalog/lane-commit.ts";
import type { laneCompareEn } from "./catalog/lane-compare.ts";
import type { laneNewEn } from "./catalog/lane-new.ts";
import type { laneReviewEn } from "./catalog/lane-review.ts";
import type { lanesEn } from "./catalog/lanes.ts";
import type { serverEn } from "./catalog/server.ts";
import type { sessionModelsEn } from "./catalog/session-models.ts";
import type { sessionToolsEn } from "./catalog/session-tools.ts";
import type { sessionPolicyEn } from "./catalog/session-policy.ts";
import type { sessionFilesEn } from "./catalog/session-files.ts";
import type { sessionScreenEn } from "./catalog/session-screen.ts";
import type { settingsAccessEn } from "./catalog/settings-access.ts";
import type { settingsAppearanceEn } from "./catalog/settings-appearance.ts";
import type { settingsApprovalsEn } from "./catalog/settings-approvals.ts";
import type { settingsMcpEn } from "./catalog/settings-mcp.ts";
import type { settingsMcpAddEn } from "./catalog/settings-mcp-add.ts";
import type { settingsSkillsEn } from "./catalog/settings-skills.ts";
import type { settingsModelsEn } from "./catalog/settings-models.ts";
import type { settingsScreenEn } from "./catalog/settings-screen.ts";
import type { settingsShortcutsEn } from "./catalog/settings-shortcuts.ts";
import type { sidebarEn } from "./catalog/sidebar.ts";
import type { terminalEn } from "./catalog/terminal.ts";
import type { trustBannerEn, trustEn } from "./catalog/trust.ts";

/** The eager keys plus the keys of lazy catalogs (type-only import: nothing of them is bundled eagerly). */
export type MessageKey =
  | keyof typeof en
  | keyof typeof sessionScreenEn
  | keyof typeof sessionFilesEn
  | keyof typeof settingsScreenEn
  | keyof typeof settingsAppearanceEn
  | keyof typeof settingsShortcutsEn
  | keyof typeof settingsApprovalsEn
  | keyof typeof settingsAccessEn
  | keyof typeof galleryEn
  | keyof typeof serverEn
  | keyof typeof sidebarEn
  | keyof typeof sessionPolicyEn
  | keyof typeof filesEn
  | keyof typeof changesEn
  | keyof typeof terminalEn
  | keyof typeof lanesEn
  | keyof typeof laneNewEn
  | keyof typeof laneCompareEn
  | keyof typeof laneCommitEn
  | keyof typeof laneReviewEn
  | keyof typeof sessionModelsEn
  | keyof typeof sessionToolsEn
  | keyof typeof settingsModelsEn
  | keyof typeof settingsMcpEn
  | keyof typeof settingsMcpAddEn
  | keyof typeof settingsSkillsEn
  | keyof typeof firstRunEn
  | keyof typeof trustBannerEn
  | keyof typeof trustEn;
export type Locale = "en" | "fr";

/** Errors the page raises itself, next to the server's `ERROR_CODES`. */
export const CLIENT_ERROR_CODES = [
  "connection_lost",
  "offline",
  "passkey_cancelled",
  "passkey_failed",
  "password_incorrect",
] as const;
type Catalogs = Readonly<Record<Locale, Readonly<Record<string, string>>>>;
// Replaced, never mutated: a registration gives `useT` a new snapshot.
let CATALOGS: Catalogs = { en, fr };
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

/**
 * Adds the strings of a lazy chunk (Settings) to the live catalogs; mounted `useT` consumers re-render.
 * Called at the evaluation of that chunk, before any of its components renders.
 */
export function registerCatalog(entries: {
  readonly en: Readonly<Record<string, string>>;
  readonly fr: Readonly<Record<string, string>>;
}): void {
  CATALOGS = { en: { ...CATALOGS.en, ...entries.en }, fr: { ...CATALOGS.fr, ...entries.fr } };
  for (const listener of [...listeners]) listener();
}

export const getLocale = (): Locale => current;

export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

const getCatalogs = (): Catalogs => CATALOGS;

/** The locale as React state: components that read it re-render when it changes, the Compiler included. */
export function useLocale(): Locale {
  return useSyncExternalStore(onLocaleChange, getLocale, getLocale);
}

/** `t` for components. Plain `t()` stays for code outside React (view-models, toasts built in handlers). */
export function useT(): Translate {
  const locale = useLocale();
  const catalogs = useSyncExternalStore(onLocaleChange, getCatalogs, getCatalogs);
  return useCallback((key, vars) => translateIn(catalogs[locale], key, vars), [catalogs, locale]);
}

/** The words of a lazy part that failed to load or threw, for `LazyPanel`, `LazyMenu` and `LazyPane`. */
export function useLazyFailureText(): LazyFailureText {
  const t = useT();
  return { stale: t("shell.lazyFailed"), broken: t("shell.lazyBroken"), reload: t("shell.reload") };
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
  return translateIn(CATALOGS[locale], key, vars);
}

function translateIn(
  catalog: Readonly<Record<string, string>>,
  key: MessageKey,
  vars: Record<string, string | number> = {},
): string {
  const message = catalog[key];
  if (message === undefined) {
    reportClientIssue("message_missing"); // a lazy catalog not registered yet: the key itself shows
    return key;
  }
  return message.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

type PluralBase = {
  [K in MessageKey]: K extends `${infer Base}.one` ? Base : never;
}[MessageKey];

/** A message that depends on a count: `<base>.one`, `<base>.other`... by the locale's plural rules, `.other` when a form is missing. */
export function plural(
  locale: Locale,
  base: PluralBase,
  count: number,
  vars: Record<string, string | number> = {},
): string {
  const form = new Intl.PluralRules(locale).select(count);
  const key = `${base}.${form}`;
  // The live catalogs: a lazy chunk's forms count once it registered them (M4R139).
  const known = Object.hasOwn(CATALOGS[locale], key);
  return translate(locale, (known ? key : `${base}.other`) as MessageKey, { ...vars, count });
}

export const t = (key: MessageKey, vars?: Record<string, string | number>): string =>
  translate(current, key, vars);

export function errorKey(code: string): MessageKey {
  const key = `error.${code}`;
  return Object.hasOwn(en, key) ? (key as MessageKey) : "error.internal";
}
