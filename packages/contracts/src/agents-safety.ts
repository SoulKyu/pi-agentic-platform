import { z } from "zod";
import { AGENT_FILE_LIMITS, AgentFilePath } from "./agents-files.ts";
import { AGENT_LIMITS } from "./agents.ts";
import { AUTOMATION_LIMITS } from "./automation.ts";
import { AgentHostEntry } from "./host-entry.ts";
import { TrustedHost } from "./policy.ts";
import { VaultName } from "./platform.ts";
import { ToolPreset } from "./session-loadout.ts";

// Task 21: quarantine, the permissions sheet and the prompt chips. Its own file keeps lane A's additions to `agents.ts` apart.

/** The steps of a quarantine after the first, by name (M11R115; `vm` runs first after the pause, RT-41); an `errors` entry names the one that failed. */
export const QUARANTINE_STEPS = [
  "vm",
  "tasks",
  "subagents",
  "thread",
  "requests",
  "once_values",
  "triggers",
  "vault",
  "files",
  "memory",
] as const;

/** What `agents.quarantine` answers (M11R115): the new webhook secrets, shown once, and what is left for the owner to rotate. */
export const QuarantineResult = z
  .object({
    secrets: z
      .array(
        z
          .object({
            triggerId: z.string().min(1).max(128),
            name: z.string().min(1).max(320),
            secret: z.string().min(1).max(128),
          })
          .strict(),
      )
      .max(AUTOMATION_LIMITS.triggersPerOwner),
    vaultNames: z.array(VaultName).max(50),
    /** The paths of the agent's imported files (credentials to revoke at the source); absent from an answer of an older daemon. */
    filePaths: z.array(AgentFilePath).max(AGENT_FILE_LIMITS.maxFiles).optional(),
    tasksCancelled: z.number().int().min(0),
    errors: z
      .array(z.object({ step: z.enum(QUARANTINE_STEPS), code: z.string().min(1).max(64) }).strict())
      .max(QUARANTINE_STEPS.length * 4),
  })
  .strict();
export type QuarantineResult = z.infer<typeof QuarantineResult>;

/** The prompt chips (M11R186): the `.md` files directly under `<home>/prompts/`. */
export const AGENT_PROMPT_LIMITS = { names: 12, nameChars: 64, bytes: 16 * 1024 } as const;
export const AgentPromptName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  .refine((name) => name.endsWith(".md") && name.length <= AGENT_PROMPT_LIMITS.nameChars, "a .md file name");

/**
 * The trifecta of pi-web's assessment in pap's terms (M11R116): advice only, nothing is blocked by it. `true` means the leg
 * cannot be ruled out (an MCP server or extension may be active), not that it was seen.
 */
export const Trifecta = z
  .object({ privateData: z.boolean(), untrustedContent: z.boolean(), exfiltration: z.boolean() })
  .strict();

/** `agents.permissions` (M11R116, W5-R-autonomy carries): what the agent can do, in the owner's words. No folder list (owner m7). */
export const PermissionsView = z
  .object({
    tools: z
      .object({
        preset: ToolPreset,
        /** From a live thread's loadout only; the sheet never starts a worker. */
        active: z.union([z.array(z.string().min(1).max(256)).max(256), z.literal("unknown-until-start")]),
      })
      .strict(),
    sandbox: z
      .object({
        required: z.boolean(),
        effective: z.enum(["on", "off", "unavailable"]),
        network: z.boolean(),
      })
      .strict(),
    hosts: z.union([
      z.array(AgentHostEntry).max(AGENT_LIMITS.hosts),
      z.literal("owner's list"),
      z.literal("any"),
    ]),
    blocked: z.number().int().min(0),
    vaultNames: z.array(VaultName).max(50),
    triggers: z
      .array(
        z
          .object({
            name: z.string().min(1).max(320),
            source: z.enum(["schedule", "webhook", "feed", "manual"]),
            target: z.enum(["thread", "isolated"]),
          })
          .strict(),
      )
      .max(20),
    mcp: z.literal("owner's servers"),
    trustedSources: z.array(TrustedHost).max(AGENT_LIMITS.trustedSources),
    trustedAutonomy: z.boolean(),
    /** `proxied`: the sandbox is on and its network goes through pap's allowlist proxy. */
    egress: z.enum(["proxied", "off"]),
    trifecta: Trifecta,
  })
  .strict();
export type PermissionsView = z.infer<typeof PermissionsView>;
