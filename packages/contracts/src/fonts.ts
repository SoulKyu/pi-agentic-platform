import { z } from "zod";
import { defineMethod } from "./define.ts";

/** What the owner may type: the name of a Google Fonts family (letters, digits, single spaces). */
export const FONT_FAMILY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ]{0,63}$/;
export const FONT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const FONT_LIMITS = {
  families: 16,
  filesPerFamily: 24,
  fileBytes: 2 * 1024 * 1024,
  cssBytes: 256 * 1024,
} as const;

/** The appearance value naming an installed family; the bundled choices are `manrope`, `jetbrains-mono` and `system`. */
export const CUSTOM_FONT_PATTERN = "custom:[a-z0-9][a-z0-9-]{0,63}";

const Params = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const FontFamilyView = Params({
  slug: z.string().regex(FONT_SLUG_PATTERN),
  family: z.string().regex(FONT_FAMILY_PATTERN),
  files: z.number().int().min(0),
  bytes: z.number().int().min(0),
  addedAt: z.number().int(),
});
export type FontFamilyView = z.infer<typeof FontFamilyView>;

/**
 * Every `fonts.*` method is for a browser session: the service refuses a token before any read or download.
 * `network` covers every failure on the way to Google (a refused address, a redirect, a timeout, a file that is not woff2).
 */
export const fontsMethods = {
  "fonts.list": defineMethod({
    name: "fonts.list",
    permission: "settings:read",
    idempotent: true,
    params: Params({}),
    result: Params({ families: z.array(FontFamilyView).max(FONT_LIMITS.families) }),
    errors: ["forbidden"],
  }),
  "fonts.add": defineMethod({
    name: "fonts.add",
    permission: "system:admin",
    idempotent: false,
    params: Params({ family: z.string().regex(FONT_FAMILY_PATTERN) }),
    result: FontFamilyView,
    errors: ["forbidden", "bad_request", "not_found", "network", "limit_reached", "payload_too_large"],
  }),
  "fonts.remove": defineMethod({
    name: "fonts.remove",
    permission: "system:admin",
    idempotent: false,
    params: Params({ slug: z.string().regex(FONT_SLUG_PATTERN) }),
    result: Params({ ok: z.literal(true) }),
    errors: ["forbidden", "not_found"],
  }),
};
