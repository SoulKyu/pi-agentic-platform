import { z } from "zod";
import { defineMethod } from "./define.ts";

/** The most characters of `models.json` the editor carries: under the helper's 1 MiB record and the 1 MiB file bound. */
export const MODELS_CONFIG_TEXT_MAX = 900_000;
/** A save answers at most this many JSON paths, each clipped (M7R64). */
export const MODELS_CONFIG_ISSUES_MAX = 20;
export const MODELS_CONFIG_ISSUE_MAX_LENGTH = 100;

/** The HMAC-SHA-256 (hex) of the file's text under a key the daemon makes at each boot: not a hash anyone can guess against (MC32). */
export const Revision = z.string().regex(/^[0-9a-f]{64}$/);
const Issue = z.string().min(1).max(MODELS_CONFIG_ISSUE_MAX_LENGTH);

/**
 * The file as the browser sees it: every literal secret replaced by `"<redacted:N>"` (M7R62). `text: null` with no issue
 * means there is no file; with issues, the file does not parse and is not shown at all (fail closed, MC32): the issues
 * carry a position and a fixed phrase, never a value. A file too large for the editor is shown the same way, with the
 * single issue `text too large`.
 */
export const ConfigGetResult = z
  .object({
    text: z.string().max(MODELS_CONFIG_TEXT_MAX).nullable(),
    issues: z.array(Issue).max(MODELS_CONFIG_ISSUES_MAX),
    revision: Revision,
    /** Always `<agentDir>/models.json`: shown, never chosen by the client (M7R63). */
    path: z.string().max(4096),
  })
  .strict();
export type ConfigGetResult = z.infer<typeof ConfigGetResult>;

export const ConfigSaveParams = z
  .object({ text: z.string().max(MODELS_CONFIG_TEXT_MAX), baseRevision: Revision })
  .strict();
export type ConfigSaveParams = z.infer<typeof ConfigSaveParams>;

/** What the daemon, not the client, gives the helper: the boot key the revision is made with. */
const RevisionKey = z.object({ revisionKey: Revision }).strict();
export const ConfigGetHelperParams = RevisionKey;
export const ConfigSaveHelperParams = ConfigSaveParams.extend(RevisionKey.shape);

/**
 * Saved, or refused as `config_invalid` with JSON paths, positions and fixed phrases only (a parser message can quote a secret). The refusal is a
 * result, not an error: the paths have to reach the editor, and an error carries a fixed message only.
 */
export const ConfigSaveResult = z.union([
  z
    .object({
      revision: Revision,
      /** False when the file was saved but `enabledModels` in settings.json could not be brought up to date. */
      enabledModelsSynced: z.boolean(),
    })
    .strict(),
  z
    .object({
      code: z.literal("config_invalid"),
      issues: z
        .array(z.string().min(1).max(MODELS_CONFIG_ISSUE_MAX_LENGTH))
        .min(1)
        .max(MODELS_CONFIG_ISSUES_MAX),
    })
    .strict(),
]);
export type ConfigSaveResult = z.infer<typeof ConfigSaveResult>;

export const modelsConfigMethods = {
  "models.config.get": defineMethod({
    name: "models.config.get",
    // pi:admin, not pi:read (MC33): masking is best effort, so the masked text goes to browser sessions only, never a token.
    permission: "pi:admin",
    idempotent: true,
    params: z.object({}),
    result: ConfigGetResult,
    // config_invalid: more than 1000 secrets. A file that does not parse is not an error: it answers `text: null` and `issues`.
    errors: ["capacity", "timeout", "helper_failed", "config_invalid", "config_path_refused"],
  }),
  "models.config.save": defineMethod({
    name: "models.config.save",
    permission: "pi:admin",
    idempotent: false,
    sensitiveParams: ["baseRevision"],
    params: ConfigSaveParams,
    result: ConfigSaveResult,
    // A password step-up is required (owner c3). conflict: the file changed since `baseRevision`. timeout: whether
    // the file was written is unknown.
    errors: [
      "step_up_required",
      "conflict",
      "capacity",
      "timeout",
      "helper_failed",
      "config_invalid",
      "config_path_refused",
      "config_hard_link",
    ],
  }),
};
