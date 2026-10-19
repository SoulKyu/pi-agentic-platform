import { z } from "zod";
import { LINE_HIDDEN } from "./text-rules.ts";

/** Decision 109. Host-dependent ceilings (the memory cap, the host's cores) are checked by the agents service at save (RT-30). */
export const AgentResources = z
  .object({
    memoryMb: z.number().int().min(512).max(1_048_576),
    cpus: z.number().int().min(1).max(256),
    diskMb: z.number().int().min(1024).max(65_536),
  })
  .strict();
export type AgentResources = z.output<typeof AgentResources>;
export const DEFAULT_AGENT_RESOURCES: AgentResources = Object.freeze({
  memoryMb: 1024,
  cpus: 1,
  diskMb: 4096,
});

export const AGENT_VM_LIMITS = Object.freeze({ systemPackages: 64, packages: 64 });
const unique = (items: readonly string[]): boolean => new Set(items).size === items.length;

/** A Debian package name (Debian policy 5.6.1), at most 63 characters: it reaches `apt-get install` (R7). */
export const SystemPackage = z.string().regex(/^[a-z0-9][a-z0-9+.-]{0,62}$/);
export const SystemPackages = z
  .array(SystemPackage)
  .max(AGENT_VM_LIMITS.systemPackages)
  .refine(unique, "each package once");

/** Package sources exactly as `settings.json` spells them; null: every package of the Pi profile (decision 108 Q4). */
export const PackagePicks = z
  .array(
    z
      .string()
      .min(1)
      .max(512)
      .refine((text) => !LINE_HIDDEN.test(text), "visible text on one line"),
  )
  .max(AGENT_VM_LIMITS.packages)
  .refine(unique, "each package once")
  .nullable();
