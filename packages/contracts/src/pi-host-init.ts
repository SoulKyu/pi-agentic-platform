import { z } from "zod";
import { AgentMemoryPolicy } from "./agents.ts";

/** What pi-mem0 is told through `pi-web:agent-profile` (M11R142). `profile: ""` is no valid profile: pi-mem0 fails closed. */
export const InitMemory = z
  .object({
    profile: z.string().max(128),
    trust: z.enum(["trusted", "untrusted"]),
    memory: AgentMemoryPolicy.optional(),
  })
  .strict();
export type InitMemory = z.input<typeof InitMemory>;

/** A subagent's child: the profile's prompt (M11R136). */
export const InitChild = z.object({ prompt: z.string().max(32_768) }).strict();
