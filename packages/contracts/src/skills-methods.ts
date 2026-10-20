import { z } from "zod";
import { defineMethod } from "./define.ts";

/**
 * Pinned at implementation: `skills` 1.7.2, published 2026-10-09 (at least 3 days old: minimumReleaseAge). The package is the
 * skills.sh CLI (repository github.com/vercel-labs/skills, the one skills.sh links to). The helper runs it and the web shows
 * the exact command (M7R140), so both read this one constant.
 */
export const SKILLS_CLI = "skills@1.7.2";

/** What the skills views hold at most; the helper cuts to these, and the daemon refuses an answer past them. */
export const SKILL_LIMITS = {
  list: 500,
  items: 100,
  results: 20,
  name: 128,
  description: 1024,
  path: 4096,
  query: 200,
  source: 300,
  url: 2048,
} as const;

/**
 * What the plugin views hold at most (Pi packages, Task 25). `source` is 2048: the longest remote source the helper accepts
 * is about 600 characters (a git host, path and ref), so even a masked one stays listed and addressable (MC55).
 */
export const PLUGIN_LIMITS = { list: 200, items: 100, source: 2048, path: 4096 } as const;

const Cwd = z.string().min(1).max(4096);
const AbsolutePath = z
  .string()
  .max(SKILL_LIMITS.path)
  .refine((path) => path.startsWith("/") && !path.includes("\0"), "must be an absolute path");
/** `true` or absent: the "Save anyway?" confirmation of a protected file (M7R133). */
const ConfirmProtected = z.literal(true).optional();

const SKILL_SCOPES = ["user", "project", "package", "other"] as const;
export const SkillView = z
  .object({
    name: z.string().min(1).max(SKILL_LIMITS.name),
    description: z.string().max(SKILL_LIMITS.description),
    path: AbsolutePath,
    scope: z.enum(SKILL_SCOPES),
    disableModelInvocation: z.boolean(),
  })
  .strict();
export type SkillView = z.infer<typeof SkillView>;

export const SkillsListResult = z
  .object({ skills: z.array(SkillView).max(SKILL_LIMITS.list), truncated: z.boolean() })
  .strict();
export type SkillsListResult = z.infer<typeof SkillsListResult>;

/** What a refused row of a switch says; the other rows were switched. */
export const SkillRowCode = z.enum([
  "not_found",
  "protected_path",
  "config_invalid",
  "config_path_refused",
  "write_failed",
]);
export type SkillRowCode = z.infer<typeof SkillRowCode>;

/** The params the switch shares with its helper operation: the helper gets `cwd` from the run, not from here. */
export const SkillsSetInvocationParams = z
  .object({
    items: z
      .array(z.object({ path: AbsolutePath, disabled: z.boolean() }).strict())
      .min(1)
      .max(SKILL_LIMITS.items),
    confirmProtected: ConfirmProtected,
  })
  .strict();
export const SkillsSetInvocationResult = z
  .object({
    results: z
      .array(z.object({ path: AbsolutePath, ok: z.boolean(), code: SkillRowCode.optional() }).strict())
      .max(SKILL_LIMITS.items),
  })
  .strict();
export type SkillsSetInvocationResult = z.infer<typeof SkillsSetInvocationResult>;

export const SkillsSearchParams = z
  .object({ query: z.string().trim().min(1).max(SKILL_LIMITS.query) })
  .strict();
/** Untrusted text from skills.sh, already clipped by the helper; `url` is `https:` or null. */
export const SkillsSearchResult = z
  .object({
    results: z
      .array(
        z
          .object({
            name: z.string().max(SKILL_LIMITS.name),
            source: z.string().max(SKILL_LIMITS.source),
            installs: z.number().int().min(0).nullable(),
            url: z
              .string()
              .max(SKILL_LIMITS.url)
              .refine((url) => url.startsWith("https://"), "must be https")
              .nullable(),
          })
          .strict(),
      )
      .max(SKILL_LIMITS.results),
  })
  .strict();
export type SkillsSearchResult = z.infer<typeof SkillsSearchResult>;

const INSTALL_SCOPES = ["global", "project"] as const;
export const SkillsInstallParams = z
  .object({
    source: z.string().min(1).max(SKILL_LIMITS.source),
    scope: z.enum(INSTALL_SCOPES),
    confirmProtected: ConfirmProtected,
  })
  .strict();

const Done = z.object({ ok: z.literal(true) }).strict();
const WRITE_ERRORS = [
  "bad_request",
  "protected_path",
  "invalid_cwd",
  "forbidden",
  "capacity",
  "timeout",
  "helper_failed",
] as const;

/** What the plugin writes also answer: the helper's `not_found`, `config_invalid`, `config_path_refused` and `conflict` (two entries masking alike). */
const PLUGIN_WRITE_ERRORS = [
  ...WRITE_ERRORS,
  "not_found",
  "config_invalid",
  "config_path_refused",
  "conflict",
] as const;

const PluginScope = z.enum(["user", "project"]);
/** A package source as the owner typed it or as Pi's settings hold it: the helper validates it (M7R115). */
const PluginSourceText = z.string().min(1).max(PLUGIN_LIMITS.source);
/**
 * A package's id (AVM-E33): 32 hex characters the helper makes from the scope and the exact source. It names the package without
 * the source, which may hold a secret, and tells apart two sources that mask alike. The daemon resolves it; a browser never does.
 */
export const PluginId = z.string().regex(/^[0-9a-f]{32}$/);
const PluginRef = z.object({ source: PluginSourceText, scope: PluginScope }).strict();

/** One package of `settings.json`. `source` is masked; `enabled` is false when its four resource lists are empty (M7R114). */
export const PluginView = z
  .object({
    id: PluginId,
    source: PluginSourceText,
    scope: PluginScope,
    installedPath: AbsolutePath.nullable(),
    enabled: z.boolean(),
    /** A hand-written filter Pi keeps: shown, and refused by the group switch. */
    filtered: z.boolean(),
  })
  .strict();
export type PluginView = z.infer<typeof PluginView>;
export const PluginsListResult = z
  .object({ plugins: z.array(PluginView).max(PLUGIN_LIMITS.list), truncated: z.boolean() })
  .strict();
export type PluginsListResult = z.infer<typeof PluginsListResult>;

/** The daemon's own question to the helper: the exact spellings of the owner's Pi packages (user scope), `null` for an id nothing holds. Not an RPC method. */
export const PluginsResolveParams = z.object({ ids: z.array(PluginId).max(PLUGIN_LIMITS.items) }).strict();
export const PluginsResolveResult = z
  .object({ sources: z.array(PluginSourceText.nullable()).max(PLUGIN_LIMITS.items) })
  .strict();

/** The params the plugin writes share with their helper operations: the helper gets `cwd` from the run, not from here. */
export const PluginSourceParams = z
  .object({ source: PluginSourceText, scope: PluginScope, confirmProtected: ConfirmProtected })
  .strict();
/** `scope` absent means the owner's Pi folder (`user`). Pi updates by source, so one call never mixes the scopes. */
export const PluginUpdateParams = z
  .object({
    source: PluginSourceText.optional(),
    scope: PluginScope.optional(),
    confirmProtected: ConfirmProtected,
  })
  .strict();
export const PluginUpdateResult = z.object({ updated: z.array(PluginRef).max(PLUGIN_LIMITS.list) }).strict();
export const PluginSetEnabledParams = z
  .object({
    items: z.array(PluginRef).min(1).max(PLUGIN_LIMITS.items),
    enabled: z.boolean(),
    confirmProtected: ConfirmProtected,
  })
  .strict();
/** Per row: `not_found` (no such configured package), `filtered` (a hand-written filter). A failed commit fails the whole op. */
export const PluginRowCode = z.enum(["not_found", "filtered"]);
export const PluginSetEnabledResult = z
  .object({
    results: z
      .array(
        z
          .object({
            source: PluginSourceText,
            scope: PluginScope,
            ok: z.boolean(),
            code: PluginRowCode.optional(),
          })
          .strict(),
      )
      .max(PLUGIN_LIMITS.items),
  })
  .strict();
export type PluginSetEnabledResult = z.infer<typeof PluginSetEnabledResult>;

export const skillsMethods = {
  // Skills are listed by Pi's own loader for the folder, a project's only while it is trusted (M7R110).
  "skills.list": defineMethod({
    name: "skills.list",
    // pi:admin (MC55, MC38): it serves file paths of the owner's folders, and a trusted project's settings can name a command.
    permission: "pi:admin",
    idempotent: true,
    params: z.object({ cwd: Cwd.optional() }).strict(),
    result: SkillsListResult,
    errors: ["bad_request", "config_path_refused", "invalid_cwd", "capacity", "timeout", "helper_failed"],
  }),
  // pi:admin. Per row: `not_found` (not a listed skill), `protected_path` (a project skill without `confirmProtected`).
  "skills.setInvocation": defineMethod({
    name: "skills.setInvocation",
    permission: "pi:admin",
    idempotent: false,
    params: SkillsSetInvocationParams.extend({ cwd: Cwd.optional() }),
    result: SkillsSetInvocationResult,
    errors: [...WRITE_ERRORS, "config_path_refused"],
  }),
  // The only call that sends the owner's query to skills.sh (M7R113). `pi:admin`: a token must not drive outbound requests (MC59).
  "skills.search": defineMethod({
    name: "skills.search",
    permission: "pi:admin",
    idempotent: true,
    params: SkillsSearchParams,
    result: SkillsSearchResult,
    errors: ["capacity", "timeout", "helper_failed"],
  }),
  // Global: the password step-up. Project: a trusted `cwd` and `confirmProtected`, no step-up (M7R140).
  "skills.install": defineMethod({
    name: "skills.install",
    permission: "pi:admin",
    idempotent: false,
    params: SkillsInstallParams.extend({ cwd: Cwd.optional() }),
    result: Done,
    errors: [...WRITE_ERRORS, "step_up_required"],
  }),
  // Pi packages (Task 25). Lists are read offline: a read never installs or clones (MC52).
  "plugins.list": defineMethod({
    name: "plugins.list",
    // pi:admin (MC55, MC38): masked sources, and `npm root -g` can run a trusted project's `npmCommand`.
    permission: "pi:admin",
    idempotent: true,
    params: z.object({ cwd: Cwd.optional() }).strict(),
    result: PluginsListResult,
    errors: [
      "bad_request",
      "config_invalid",
      "config_path_refused",
      "invalid_cwd",
      "capacity",
      "timeout",
      "helper_failed",
    ],
  }),
  // User scope: install and update take the password step-up. Project scope: a trusted `cwd` and `confirmProtected`, no step-up (M7R140).
  "plugins.install": defineMethod({
    name: "plugins.install",
    permission: "pi:admin",
    idempotent: false,
    params: PluginSourceParams.extend({ cwd: Cwd.optional() }),
    result: Done,
    errors: [...PLUGIN_WRITE_ERRORS, "step_up_required"],
  }),
  "plugins.remove": defineMethod({
    name: "plugins.remove",
    permission: "pi:admin",
    idempotent: false,
    params: PluginSourceParams.extend({ cwd: Cwd.optional() }),
    result: Done,
    errors: PLUGIN_WRITE_ERRORS,
  }),
  "plugins.update": defineMethod({
    name: "plugins.update",
    permission: "pi:admin",
    idempotent: false,
    params: PluginUpdateParams.extend({ cwd: Cwd.optional() }),
    result: PluginUpdateResult,
    errors: [...PLUGIN_WRITE_ERRORS, "step_up_required"],
  }),
  "plugins.setEnabled": defineMethod({
    name: "plugins.setEnabled",
    permission: "pi:admin",
    idempotent: false,
    params: PluginSetEnabledParams.extend({ cwd: Cwd.optional() }),
    result: PluginSetEnabledResult,
    errors: PLUGIN_WRITE_ERRORS,
  }),
} as const;
