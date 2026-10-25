import {
  AccountAppearanceFields,
  CustomTheme,
  DEFAULT_HOME_LAYOUT,
  type AccountAppearance,
} from "@pap/contracts";
import type { FontFamilyView } from "@pap/contracts";
import { DENSITIES, type Density, type ThemeName } from "@pap/ui";
import { deriveTheme, tokenVars } from "./derive.ts";
import { resolveFont } from "./fonts.ts";
import { newThemeId } from "./theme-ids.ts";

export const DEVICE_KEY = "pap.appearance.device.v1";
export const ACCOUNT_CACHE_KEY = "pap.appearance.account.v1";

export const DEFAULT_ACCOUNT: AccountAppearance = {
  mode: "system",
  darkTheme: "night",
  lightTheme: "day",
  customThemes: [],
  uiFont: "manrope",
  monoFont: "jetbrains-mono",
  uppercaseLabels: true,
  grid: true,
  railPosition: "left",
  avatarStyle: "outlined",
  toolDetail: "compact",
  home: DEFAULT_HOME_LAYOUT,
  eventCards: "cards",
  statusPanel: "shown",
};

export interface DeviceAppearance {
  readonly density: Density;
  /** px; null follows the density. */
  readonly uiSize: number | null;
  readonly chatSize: number | null;
  readonly codeSize: number | null;
  readonly motion: "system" | "reduced" | "none";
  /** Default full width (pi-web rejected a 72ch cap, decision 28). */
  readonly chatWidth: "full" | "wide" | "narrow";
  /** Line length of prose: capped at the reading measure, or the whole column (`data-prose`, D3). */
  readonly proseMeasure: "limited" | "full";
  /** A short tone when a run ends while the tab is hidden or unfocused (M13R21); off by default. */
  readonly completionSound: boolean;
}

export const DEFAULT_DEVICE: DeviceAppearance = {
  density: "mixed",
  uiSize: null,
  chatSize: null,
  codeSize: null,
  motion: "system",
  chatWidth: "full",
  proseMeasure: "limited",
  completionSound: false,
};
export const SIZE_RANGES = { uiSize: [12, 16], chatSize: [13, 18], codeSize: [11, 16] } as const;

const MAX_CUSTOM_THEMES = 16;
const MAX_THEME_ENTRIES_READ = 64;

/**
 * Field by field (owner R3-4, M3-RT-01): an unreadable or missing field falls back on its own; custom themes keep
 * their valid entries; a side whose theme is gone falls back to its preset. Never throws.
 */
export function parseAccount(value: unknown): AccountAppearance {
  const source: Readonly<Record<string, unknown>> =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const field = <K extends keyof AccountAppearance>(name: K): AccountAppearance[K] => {
    const parsed = AccountAppearanceFields.shape[name].safeParse(source[name]);
    return parsed.success ? (parsed.data as AccountAppearance[K]) : DEFAULT_ACCOUNT[name];
  };
  const themes: CustomTheme[] = [];
  const ids = new Set<string>();
  const entries: readonly unknown[] = Array.isArray(source.customThemes)
    ? source.customThemes.slice(0, MAX_THEME_ENTRIES_READ)
    : [];
  for (const entry of entries) {
    const parsed = CustomTheme.safeParse(entry);
    if (!parsed.success || ids.has(parsed.data.id) || themes.length === MAX_CUSTOM_THEMES) continue;
    ids.add(parsed.data.id);
    themes.push(parsed.data);
  }
  const side = (
    id: string,
    base: CustomTheme["base"],
    presets: readonly string[],
    fallback: string,
  ): string =>
    presets.includes(id) || themes.some((theme) => theme.id === id && theme.base === base) ? id : fallback;
  return {
    mode: field("mode"),
    darkTheme: side(field("darkTheme"), "night", ["night", "hc"], "night"),
    lightTheme: side(field("lightTheme"), "day", ["day"], "day"),
    customThemes: themes,
    uiFont: field("uiFont"),
    monoFont: field("monoFont"),
    uppercaseLabels: field("uppercaseLabels"),
    grid: field("grid"),
    railPosition: field("railPosition"),
    avatarStyle: field("avatarStyle"),
    toolDetail: field("toolDetail"),
    home: field("home"),
    eventCards: field("eventCards"),
    statusPanel: field("statusPanel"),
  };
}

/** The account fields whose value differs (themes compared as JSON: they are plain data). */
export function changedAccountFields(previous: AccountAppearance, next: AccountAppearance): string[] {
  return (Object.keys(next) as Array<keyof AccountAppearance>).filter(
    (name) => JSON.stringify(previous[name]) !== JSON.stringify(next[name]),
  );
}

/** JSON with sorted keys: two themes with the same content are equal whatever order their keys were built in. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([one], [other]) => (one < other ? -1 : 1)))
      : inner,
  );

const sameTheme = (one: CustomTheme | undefined, other: CustomTheme | undefined): boolean =>
  canonical(one) === canonical(other);

/**
 * The server's theme list with this device's changes since `base` applied by id: its adds are appended, its edits
 * replace the server's theme or bring it back when the other device deleted it, and its deletes remove a theme only
 * if the other device left it as it was in `base`. So an edit always wins over a delete, on either device, and no
 * theme added elsewhere is lost. An add whose id the server already has with other content (ids are slugs of the
 * name, so two devices duplicating the same preset collide) gets a fresh id, reported in `renamed`.
 */
function mergeThemes(
  server: readonly CustomTheme[],
  local: readonly CustomTheme[],
  base: readonly CustomTheme[],
): { themes: CustomTheme[]; renamed: Map<string, string> } {
  const inBase = new Map(base.map((theme) => [theme.id, theme]));
  const inLocal = new Map(local.map((theme) => [theme.id, theme]));
  const written = new Set<string>();
  const merged: CustomTheme[] = [];
  const collisions: CustomTheme[] = [];
  for (const theme of server) {
    const mine = inLocal.get(theme.id);
    const known = inBase.get(theme.id);
    if (mine === undefined && known !== undefined) {
      if (!sameTheme(theme, known)) merged.push(theme); // deleted here, edited there: the edit stays
      continue;
    }
    written.add(theme.id);
    if (mine !== undefined && known === undefined) {
      merged.push(theme); // added on both devices: the server's stays
      if (!sameTheme(mine, theme)) collisions.push(mine);
      continue;
    }
    merged.push(mine !== undefined && !sameTheme(mine, known) ? mine : theme);
  }
  for (const theme of local) {
    if (written.has(theme.id)) continue;
    // Added here, or edited here after the other device deleted it: it comes back. Unchanged here: it stays deleted.
    if (!sameTheme(theme, inBase.get(theme.id))) merged.push(theme);
  }
  const taken = new Set([...merged, ...local].map((theme) => theme.id));
  const renamed = new Map<string, string>();
  for (const theme of collisions) {
    const id = newThemeId(theme.name, taken);
    taken.add(id);
    renamed.set(theme.id, id);
    merged.push({ ...theme, id });
  }
  return { themes: merged, renamed };
}

/**
 * True when this device edited its theme list and the merged list is over the 16-theme cap before `parseAccount`
 * cuts it. The server's themes come first and local edits replace them in place, so everything cut is this device's.
 */
export function mergeCutsThemes(
  server: AccountAppearance,
  local: AccountAppearance,
  dirty: ReadonlySet<string>,
  base: AccountAppearance,
): boolean {
  return (
    dirty.has("customThemes") &&
    mergeThemes(server.customThemes, local.customThemes, base.customThemes).themes.length > MAX_CUSTOM_THEMES
  );
}

/**
 * The server copy with the local values of the fields changed on this device laid over it, re-read field by field.
 * The theme library is merged by id against `base` (the last server copy), the other fields are replaced.
 */
export function mergeAccount(
  server: AccountAppearance,
  local: AccountAppearance,
  dirty: ReadonlySet<string>,
  base: AccountAppearance,
): AccountAppearance {
  const merged: Record<string, unknown> = { ...server };
  for (const name of dirty) if (name in local) merged[name] = local[name as keyof AccountAppearance];
  if (dirty.has("customThemes")) {
    const { themes, renamed } = mergeThemes(server.customThemes, local.customThemes, base.customThemes);
    merged.customThemes = themes;
    // This device's side follows its theme to the new id.
    for (const side of ["darkTheme", "lightTheme"] as const) {
      const moved = dirty.has(side) ? renamed.get(local[side]) : undefined;
      if (moved !== undefined) merged[side] = moved;
    }
  }
  return parseAccount(merged);
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;
const size = (value: unknown, [min, max]: readonly [number, number]): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;

/** Field by field: one bad field never resets the others (Review Focus 1). */
export function parseDevice(raw: string | null): DeviceAppearance {
  let value: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    if (parsed && typeof parsed === "object") value = parsed as Record<string, unknown>;
  } catch {
    value = {};
  }
  return {
    density: oneOf(value.density, DENSITIES, DEFAULT_DEVICE.density),
    uiSize: size(value.uiSize, SIZE_RANGES.uiSize),
    chatSize: size(value.chatSize, SIZE_RANGES.chatSize),
    codeSize: size(value.codeSize, SIZE_RANGES.codeSize),
    motion: oneOf(value.motion, ["system", "reduced", "none"] as const, DEFAULT_DEVICE.motion),
    chatWidth: oneOf(value.chatWidth, ["full", "wide", "narrow"] as const, DEFAULT_DEVICE.chatWidth),
    proseMeasure: oneOf(value.proseMeasure, ["limited", "full"] as const, DEFAULT_DEVICE.proseMeasure),
    completionSound: value.completionSound === true,
  };
}

export const APPEARANCE_ATTRS = [
  "theme",
  "density",
  "font-ui",
  "font-mono",
  "labels",
  "grid",
  "rail",
  "motion",
  "chat-width",
  "prose",
  "tool-detail",
  "avatar",
] as const;
export type AppearanceAttr = (typeof APPEARANCE_ATTRS)[number];

export interface ResolvedAppearance {
  readonly attrs: Readonly<Record<AppearanceAttr, string>>;
  readonly vars: Readonly<Record<string, string>>;
  /** The downloaded families in use: the controller keeps one stylesheet link for each. */
  readonly fontSlugs?: readonly string[];
}

function side(
  account: AccountAppearance,
  light: boolean,
): { theme: ThemeName; vars: Record<string, string> } {
  const id = light ? account.lightTheme : account.darkTheme;
  const custom = account.customThemes.find((theme) => theme.id === id);
  if (custom) return { theme: custom.base, vars: tokenVars(deriveTheme(custom)) };
  return { theme: id === "hc" ? "hc" : light ? "day" : "night", vars: {} };
}

function deviceVars(device: DeviceAppearance): Record<string, string> {
  const vars: Record<string, string> = {};
  if (device.uiSize !== null) vars["--size-ui"] = `${device.uiSize}px`;
  if (device.chatSize !== null) vars["--size-chat"] = `${device.chatSize}px`;
  if (device.codeSize !== null) vars["--size-code"] = `${device.codeSize}px`;
  return vars;
}

function plainAttrs(
  account: AccountAppearance,
  device: DeviceAppearance,
  families: readonly FontFamilyView[] | null = null,
): Omit<Record<AppearanceAttr, string>, "theme"> {
  return {
    density: device.density,
    "font-ui": resolveFont(account.uiFont, "ui", families).attr,
    "font-mono": resolveFont(account.monoFont, "mono", families).attr,
    labels: account.uppercaseLabels ? "upper" : "sentence",
    grid: account.grid ? "on" : "off",
    rail: account.railPosition,
    motion: device.motion,
    "chat-width": device.chatWidth,
    prose: device.proseMeasure,
    "tool-detail": account.toolDetail,
    avatar: account.avatarStyle,
  };
}

export function resolveAppearance(
  account: AccountAppearance,
  device: DeviceAppearance,
  prefersLight: boolean,
  families: readonly FontFamilyView[] | null = null,
): ResolvedAppearance {
  const light = account.mode === "day" || (account.mode === "system" && prefersLight);
  const { theme, vars } = side(account, light);
  const ui = resolveFont(account.uiFont, "ui", families);
  const mono = resolveFont(account.monoFont, "mono", families);
  return {
    attrs: { theme, ...plainAttrs(account, device, families) },
    vars: {
      ...vars,
      ...deviceVars(device),
      ...(ui.stack === null ? {} : { "--font-ui": ui.stack }),
      ...(mono.stack === null ? {} : { "--font-code": mono.stack }),
    },
    fontSlugs: [ui.slug, mono.slug].filter((slug): slug is string => slug !== null),
  };
}

export interface BootSide {
  readonly theme: ThemeName;
  readonly vars: Readonly<Record<string, string>>;
}

export interface BootCache {
  readonly v: 1;
  readonly mode: AccountAppearance["mode"];
  readonly attrs: Readonly<Record<string, string>>;
  readonly vars: Readonly<Record<string, string>>;
  readonly dark: BootSide;
  readonly light: BootSide;
}

/** What the boot script replays before the first paint: both sides, so "system" resolves without the app. */
export function toBootCache(account: AccountAppearance, device: DeviceAppearance): BootCache {
  return {
    v: 1,
    mode: account.mode,
    attrs: plainAttrs(account, device),
    vars: deviceVars(device),
    dark: side(account, false),
    light: side(account, true),
  };
}
