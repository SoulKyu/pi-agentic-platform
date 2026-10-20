import { z } from "zod";
import { defineMethod } from "./define.ts";
import { ApiKeyValue } from "./models-methods.ts";
import { AgentId } from "./platform.ts";

const Params = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
/** The owner's `claude setup-token`, as typed: trimmed, one line (it ends up in a header), at most 512 characters. */
export const ClaudeToken = ApiKeyValue.max(512);
const Ok = z.object({ ok: z.literal(true) }).strict();

/** The phases `agents.vmStatus` reports for an agent's VM. */
export const VM_PHASES = ["stopped", "starting", "running", "paused", "stopping"] as const;

/** `agents.vmStatus`: Settings › Agents and the agent screen read it (R6: "run `sudo pap vm setup`" when not usable). */
export const VmStatusView = z
  .object({
    runtime: z.enum(["host", "vm"]),
    usable: z.boolean(),
    reason: z.string().max(256).nullable(),
    vmdVersion: z.string().max(64).nullable(),
    claudeToken: z.enum(["set", "missing"]),
    /**
     * What the host can give ONE agent (AVM-E33, the agent form's ceilings): the memory a VM may ask for (the cap less the VM's own
     * overhead), the host's cores, and the disk the state folder can add (its free space less `PAP_MIN_FREE_DISK_MB`; null when
     * pap-vmd did not say). Null or absent in host mode, or when pap-vmd does not answer.
     */
    host: z
      .object({
        memoryMb: z.number().int().min(0),
        cpus: z.number().int().min(1),
        diskMb: z.number().int().min(0).nullable(),
      })
      .strict()
      .nullable()
      .optional(),
    agents: z.array(z.object({ id: AgentId, phase: z.enum(VM_PHASES) }).strict()).max(32),
  })
  .strict();
export type VmStatusView = z.infer<typeof VmStatusView>;

export const agentsVmMethods = {
  // Browser only like `models.setApiKey` (pi:admin is outside the token permissions); the token is a secret, so the
  // receipt hashes no params (`sensitiveParams: []`: the only field is the secret, MC30). timeout: the outcome is unknown.
  "agents.vm.setClaudeToken": defineMethod({
    name: "agents.vm.setClaudeToken",
    permission: "pi:admin",
    idempotent: false,
    sensitiveParams: [],
    params: Params({ token: ClaudeToken }),
    result: Ok,
    errors: ["step_up_required", "sandbox_unavailable"],
  }),
  "agents.vm.clearClaudeToken": defineMethod({
    name: "agents.vm.clearClaudeToken",
    permission: "pi:admin",
    idempotent: false,
    params: Params({}),
    result: Ok,
    errors: ["step_up_required", "sandbox_unavailable"],
  }),
  "agents.vmStatus": defineMethod({
    name: "agents.vmStatus",
    permission: "agents:read",
    idempotent: true,
    params: Params({}),
    result: VmStatusView,
    errors: [],
  }),
  // J1b: the owner's deleted agents still in the trash, so "Purge now" outlives the delete toast.
  "agents.trash": defineMethod({
    name: "agents.trash",
    permission: "agents:read",
    idempotent: true,
    params: Params({}),
    result: z
      .object({
        agents: z
          .array(
            z
              .object({ agentId: AgentId, name: z.string().min(1).max(32), deletedAt: z.number().int() })
              .strict(),
          )
          .max(32),
      })
      .strict(),
    errors: [],
  }),
  // RT-40: "Purge now" empties that agent's trash entries at once.
  "agents.purgeTrash": defineMethod({
    name: "agents.purgeTrash",
    permission: "agents:admin",
    idempotent: false,
    params: Params({ agentId: AgentId }),
    result: Ok,
    errors: ["step_up_required", "not_found", "sandbox_unavailable"],
  }),
};
