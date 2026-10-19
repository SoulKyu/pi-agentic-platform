import { z } from "zod";
import { LaunchId, RelayKey } from "./agents-vm.ts";
import { AgentId } from "./platform.ts";

const Provider = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const ModelIdText = z.string().min(1).max(256);
/** R13: what the daemon tells its relay child over IPC. Never logged (grants and the Claude token are secrets). */
export const RelayCommand = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("relay_grant"),
      launchId: LaunchId,
      agentId: AgentId,
      key: RelayKey,
      address: z.string().regex(/^(?:10\.213\.0\.\d{1,3}|127\.0\.0\.1)$/),
    })
    .strict(),
  z.object({ type: z.literal("relay_revoke"), launchId: LaunchId }).strict(),
  z
    .object({
      type: z.literal("agent_policy"),
      agentId: AgentId,
      /** The models the agent's picker offers (ADR 0068), at most 512 pairs; the bridge's models make `claude` true. */
      models: z.array(z.object({ provider: Provider, id: ModelIdText }).strict()).max(512),
      claude: z.boolean(),
      blocked: z.enum(["paused", "budget"]).nullable(),
    })
    .strict(),
  z.object({ type: z.literal("claude_token"), token: z.string().min(1).max(512).nullable() }).strict(),
]);
export type RelayCommand = z.infer<typeof RelayCommand>;
/** What the relay child reports: its port once listening, and counts per agent every 60 s (attribution, RT-17). */
export const RelayReport = z.discriminatedUnion("type", [
  z.object({ type: z.literal("relay_ready"), port: z.number().int().min(1).max(65_535) }).strict(),
  z
    .object({
      type: z.literal("relay_usage"),
      agents: z
        .array(
          z
            .object({
              agentId: AgentId,
              requests: z.number().int().min(0),
              refused: z.number().int().min(0),
              bytesIn: z.number().int().min(0),
              bytesOut: z.number().int().min(0),
            })
            .strict(),
        )
        .max(64),
    })
    .strict(),
]);
