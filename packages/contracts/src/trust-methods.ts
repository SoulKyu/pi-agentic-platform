import { z } from "zod";
import { ClientPath } from "./client-path.ts";
import { defineMethod } from "./define.ts";
import { MCP_LIMITS, McpServerView } from "./mcp-methods.ts";

/** What the trust dialog lists at most (M7R107); `truncated` says a list was cut, so the dialog never looks complete when it is not. */
export const TRUST_LIMITS = {
  extensions: 100,
  skills: 100,
  settingsKeys: 50,
  name: 128,
  projects: 2000,
  unlisted: 16,
} as const;

const Cwd = ClientPath;
const AbsolutePath = ClientPath;
const ResourceName = z.string().min(1).max(TRUST_LIMITS.name);

/** Why trusting a folder would trust too much (M7R104). The copy for each is a fixed key of the web catalog. */
export const TRUST_REFUSALS = [
  "filesystem-root",
  "home-or-above",
  "holds-pi-or-pap",
  "holds-other-projects",
  "inside-pap-home",
] as const;
export const TrustRefusal = z.enum(TRUST_REFUSALS);
export type TrustRefusal = z.infer<typeof TrustRefusal>;

/** What trusting the folder turns on, from files only and never a value (M7R107). */
export const TrustResources = z
  .object({
    mcpServers: z.array(McpServerView).max(MCP_LIMITS.servers),
    extensions: z.array(ResourceName).max(TRUST_LIMITS.extensions),
    skills: z.array(ResourceName).max(TRUST_LIMITS.skills),
    promptTemplates: z.number().int().min(0).max(100_000),
    settingsKeys: z.array(ResourceName).max(TRUST_LIMITS.settingsKeys),
    systemPrompt: z.boolean(),
    truncated: z.boolean(),
    /**
     * What pap did not list although Pi may load it once the folder is trusted: a resource folder that is a link out of the
     * session folder or cannot be read, a settings file that cannot be read, an MCP file pap refuses. Fixed strings made
     * of a project-relative path and a reason, never file content. Empty means everything was listed.
     */
    unlisted: z.array(z.string().max(160)).max(TRUST_LIMITS.unlisted),
  })
  .strict();
export type TrustResources = z.infer<typeof TrustResources>;

export const TrustStatus = z
  .object({
    requiresTrust: z.boolean(),
    /** Pi's decision for the folder or the nearest folder above it; `null` when none, or when the store cannot be read. */
    decision: z.boolean().nullable(),
    decisionPath: z.string().max(4096).nullable(),
    /** The decision belongs to a folder above this one. */
    inherited: z.boolean(),
    resources: TrustResources,
  })
  .strict();
export type TrustStatus = z.infer<typeof TrustStatus>;

/** An answer, never a free text: a refusal names its rule and the web client has the copy (M7R104). */
export const TrustSetResult = z.union([
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), refusal: TrustRefusal }).strict(),
]);
export type TrustSetResult = z.infer<typeof TrustSetResult>;

/** The daemon hands the helper the roots of the owner's projects: the helper resolves them, the breadth rule needs real paths. */
export const TrustSetHelperParams = z
  .object({ decision: z.boolean().nullable(), projects: z.array(AbsolutePath).max(TRUST_LIMITS.projects) })
  .strict();
/** `folder` is the real path the decision was recorded for: the daemon audits it and restarts the workers under it. */
export const TrustSetHelperResult = z.union([
  z.object({ ok: z.literal(true), folder: AbsolutePath }).strict(),
  z.object({ ok: z.literal(false), refusal: TrustRefusal }).strict(),
]);
export type TrustSetHelperResult = z.infer<typeof TrustSetHelperResult>;

export const trustMethods = {
  // pi:admin like every MCP view (MC38): the servers are listed masked, and masking is heuristic.
  "trust.status": defineMethod({
    name: "trust.status",
    permission: "pi:admin",
    idempotent: true,
    params: z.object({ cwd: Cwd }).strict(),
    result: TrustStatus,
    errors: ["invalid_cwd", "capacity", "timeout", "helper_failed"],
  }),
  // Trusting runs the folder's code later: the password step-up (M7R133). A decision applies at the next open of a worker
  // (M7R105). A breach of the breadth rule is an `ok: false` answer with its rule, not an error.
  "trust.set": defineMethod({
    name: "trust.set",
    permission: "pi:admin",
    idempotent: false,
    params: z.object({ cwd: Cwd, decision: z.boolean().nullable() }).strict(),
    result: TrustSetResult,
    errors: ["step_up_required", "invalid_cwd", "capacity", "timeout", "helper_failed"],
  }),
} as const;
