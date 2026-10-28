import { z } from "zod";

/** UX-1 prompt templates: `<Pi agent dir>/prompts/<name>.md`, written by the Pi configuration helper (ADR 0023). */
export const TEMPLATE_LIMITS = { name: 64, description: 200, bodyBytes: 32 * 1024 } as const;

/** Pi's built-in commands (Pi 1.1.0 docs/slash-commands.md): a template under one of these names would collide. */
export const RESERVED_TEMPLATE_NAMES = [
  "settings",
  "model",
  "thinking",
  "scoped-models",
  "login",
  "logout",
  "llama",
  "new",
  "resume",
  "name",
  "session",
  "tree",
  "fork",
  "clone",
  "compact",
  "import",
  "copy",
  "export",
  "share",
  "bug",
  "trust",
  "reload",
  "hotkeys",
  "changelog",
  "quit",
] as const;
const RESERVED: ReadonlySet<string> = new Set(RESERVED_TEMPLATE_NAMES);

export const PromptTemplateName = z
  .string()
  .min(1)
  .max(TEMPLATE_LIMITS.name)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lower-case letters, digits and -, starting with a letter or a digit")
  .refine((name) => !RESERVED.has(name), "a Pi command has this name");
export type PromptTemplateName = z.infer<typeof PromptTemplateName>;

// Controls (but tab, LF, CR in a body), line/paragraph separators, lone surrogates and bidi controls: refused, never stripped.
const UNSAFE_BODY = /(?![\t\n\r])\p{Cc}|[\p{Zl}\p{Zp}\p{Cs}]|\p{Bidi_Control}/u;
const UNSAFE_LINE = /[\p{Cc}\p{Zl}\p{Zp}\p{Cs}]|\p{Bidi_Control}/u;
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

export const TemplateDescription = z
  .string()
  .refine((text) => Array.from(text).length <= TEMPLATE_LIMITS.description, "at most 200 characters")
  .refine((text) => !UNSAFE_LINE.test(text), "one plain line");
export const TemplateBody = z
  .string()
  .refine((text) => text.trim() !== "", "a prompt")
  .refine((text) => !UNSAFE_BODY.test(text), "no hidden characters")
  .refine((text) => utf8Bytes(text) <= TEMPLATE_LIMITS.bodyBytes, "at most 32 KiB");

export const TemplatesSaveParams = z
  .object({
    name: PromptTemplateName,
    description: TemplateDescription.optional(),
    body: TemplateBody,
    /** The second, explicit step after a `conflict`. */
    replace: z.boolean().optional(),
  })
  .strict();
export type TemplatesSaveParams = z.infer<typeof TemplatesSaveParams>;
export const TemplatesSaveResult = z.object({ name: PromptTemplateName, replaced: z.boolean() }).strict();
export type TemplatesSaveResult = z.infer<typeof TemplatesSaveResult>;
export const TemplateWriteResult = z.object({ replaced: z.boolean() }).strict();
export type TemplateWriteResult = z.infer<typeof TemplateWriteResult>;
export const TEMPLATE_AUDIT_REASON = "prompt_template_saved";
