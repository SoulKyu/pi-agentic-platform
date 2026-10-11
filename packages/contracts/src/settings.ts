import { z } from "zod";
import { defineMethod } from "./define.ts";

// Account-scope settings (DESIGN.md §13): validated here, on the server before a write and on the client before an
// import, so a stored document is always one the client can read back.
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const THEME_ROLES = ["bg", "surface", "text", "agent", "you", "attn", "ok", "err"] as const;
export const ThemeRoles = z.object({
  bg: Hex,
  surface: Hex,
  text: Hex,
  agent: Hex,
  you: Hex,
  attn: Hex,
  ok: Hex,
  err: Hex,
});
export type ThemeRoles = z.infer<typeof ThemeRoles>;

/** Preset theme ids: a custom theme taking one would shadow the preset (M3-RT-09). */
export const PRESET_THEME_IDS = ["night", "day", "hc"] as const;

/** DESIGN.md §13.1: a custom theme edits roles, not variables. The id rule is T3's (themePalette.ts). */
export const CustomTheme = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,47}$/)
    .refine((id) => !(PRESET_THEME_IDS as readonly string[]).includes(id), "reserved theme id"),
  name: z.string().trim().min(1).max(64),
  base: z.enum(["night", "day"]),
  roles: ThemeRoles,
});
export type CustomTheme = z.infer<typeof CustomTheme>;

/**
 * Every field has a default (owner R3-4): a document written before a field existed reads with that field's
 * default, and the client parses field by field from this shape (Task 13).
 */
export const AccountAppearanceFields = z.object({
  mode: z.enum(["system", "night", "day"]).default("system"),
  /** "night", "hc" or the id of a custom theme on a night base. */
  darkTheme: z.string().min(1).max(48).default("night"),
  /** "day" or the id of a custom theme on a day base. */
  lightTheme: z.string().min(1).max(48).default("day"),
  customThemes: z
    .array(CustomTheme)
    .max(16)
    .default(() => []),
  uiFont: z.enum(["manrope", "system"]).default("manrope"),
  monoFont: z.enum(["jetbrains-mono", "system"]).default("jetbrains-mono"),
  uppercaseLabels: z.boolean().default(true),
  grid: z.boolean().default(true),
  railPosition: z.enum(["left", "right"]).default("left"),
  avatarStyle: z.enum(["outlined", "tinted", "glyph"]).default("outlined"),
  toolDetail: z.enum(["compact", "expanded", "full"]).default("compact"),
});

export const AccountAppearance = AccountAppearanceFields.superRefine((value, ctx) => {
  const ids = new Set<string>();
  for (const theme of value.customThemes) {
    if (ids.has(theme.id))
      ctx.addIssue({ code: "custom", path: ["customThemes"], message: "duplicate theme id" });
    ids.add(theme.id);
  }
  const custom = (id: string, base: "night" | "day") =>
    value.customThemes.some((t) => t.id === id && t.base === base);
  if (!(value.darkTheme === "night" || value.darkTheme === "hc" || custom(value.darkTheme, "night"))) {
    ctx.addIssue({ code: "custom", path: ["darkTheme"], message: "unknown dark theme" });
  }
  if (!(value.lightTheme === "day" || custom(value.lightTheme, "day"))) {
    ctx.addIssue({ code: "custom", path: ["lightTheme"], message: "unknown light theme" });
  }
});
export type AccountAppearance = z.infer<typeof AccountAppearance>;

/** A user rule with this key unbinds the command's defaults (Task 16b merge rule). */
export const KEY_NONE = "none";

/** T3's keybinding rule shape ({key, command, when}); later rules win. */
export const KeybindingRule = z.object({
  key: z.string().min(1).max(64),
  command: z.string().regex(/^[a-z][a-zA-Z0-9.-]{0,127}$/),
  when: z.string().min(1).max(256).optional(),
});
export type KeybindingRule = z.infer<typeof KeybindingRule>;
export const KeybindingRules = z.array(KeybindingRule).max(256);

export const SETTING_KEYS = ["appearance", "keybindings"] as const;
export const SettingKey = z.enum(SETTING_KEYS);
export type SettingKey = z.infer<typeof SettingKey>;
export const MAX_SETTING_BYTES = 131_072;

/** The revision the client read before this write; 0 creates the document (compare-and-set, owner R3-4). */
const BaseRevision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const SettingWrite = z.discriminatedUnion("key", [
  z.object({ key: z.literal("appearance"), value: AccountAppearance, baseRevision: BaseRevision }),
  z.object({ key: z.literal("keybindings"), value: KeybindingRules, baseRevision: BaseRevision }),
]);
export type SettingWrite = z.infer<typeof SettingWrite>;

export const settingsMethods = {
  "settings.get": defineMethod({
    name: "settings.get",
    permission: "settings:read",
    idempotent: true,
    params: z.object({ key: SettingKey }),
    result: z.object({ value: z.unknown().nullable(), revision: z.number().int().nonnegative() }),
    errors: [],
  }),
  "settings.set": defineMethod({
    name: "settings.set",
    permission: "settings:operate",
    idempotent: false,
    params: SettingWrite,
    result: z.object({ revision: z.number().int().positive() }),
    // conflict: the stored revision is not baseRevision any more; the client re-reads, merges and retries once.
    errors: ["payload_too_large", "conflict"],
  }),
} as const;
