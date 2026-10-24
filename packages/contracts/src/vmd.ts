import { z } from "zod";
import { AgentResources, SystemPackage } from "./agents-resources.ts";
import { VM_IPV4 } from "./agents-net.ts";
import { GatewayToken, IMAGE_TAG, LaunchId } from "./agents-vm.ts";
import { BoxRef } from "./boxes.ts";

/** RT-33: one request per connection, at most this large; pap-vmd reads no more. */
export const VMD_MAX_FRAME_BYTES = 64 * 1024;
const Tag = z.string().regex(IMAGE_TAG);
const NodeImage = z.string().regex(/^docker\.io\/library\/node@sha256:[0-9a-f]{64}$/);
const Kind = z.enum(["thread", "isolated"]);
/** An isolated task's key (a task uuid without dashes). Its VM is `pap-<agent id>-<key>`, its disk pap-vmd's own (R30). */
export const TaskKey = z.string().regex(/^[0-9a-f]{32}$/);
const box = { box: BoxRef };
/** Every disk op names its disk (R30, RT-05): the box's (`taskKey: null`); only `disk.delete` may name a task's. */
const boxDisk = { box: BoxRef, taskKey: z.null() };
/** Only an agent's box has isolated tasks: a project box's VM and disk are always the box's own. */
const agentTasksOnly = (request: { box: BoxRef; taskKey: string | null }): boolean =>
  request.box.kind === "agent" || request.taskKey === null;
const AGENT_TASKS_ONLY = "a project box has no task key";

/**
 * The whole request surface of pap-vmd (R3, R7, R8, R30). No path, command, Dockerfile text or environment comes from the
 * daemon: pap-vmd derives every path from these fields and its own config. `kind: "isolated"` gets a blank disk pap-vmd
 * creates at `vm.start` and deletes at its `vm.stop`; `isolated` and `taskKey` go together. `disk.create` and `disk.grow` take
 * the agent's disk only; `disk.delete` with a task key removes a task disk a crash left behind.
 */
export const VmdRequest = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("vm.start"),
      ...box,
      kind: Kind,
      taskKey: TaskKey.nullable(),
      image: Tag,
      resources: AgentResources,
      launchId: LaunchId,
      token: GatewayToken,
    })
    .strict()
    .refine((request) => (request.kind === "isolated") === (request.taskKey !== null), "isolated iff taskKey")
    .refine(agentTasksOnly, AGENT_TASKS_ONLY),
  z
    .object({ op: z.literal("vm.stop"), ...box, taskKey: TaskKey.nullable() })
    .strict()
    .refine(agentTasksOnly, AGENT_TASKS_ONLY),
  // Sub-project 4's seam (page 03): no caller in sub-project 1.
  z.object({ op: z.literal("vm.pause"), ...box }).strict(),
  z.object({ op: z.literal("vm.resume"), ...box }).strict(),
  z
    .object({ op: z.literal("vm.status"), ...box, taskKey: TaskKey.nullable() })
    .strict()
    .refine(agentTasksOnly, AGENT_TASKS_ONLY),
  z.object({ op: z.literal("vm.list") }).strict(),
  z.object({ op: z.literal("disk.create"), ...boxDisk, diskMb: AgentResources.shape.diskMb }).strict(),
  z.object({ op: z.literal("disk.grow"), ...boxDisk, diskMb: AgentResources.shape.diskMb }).strict(),
  z
    .object({ op: z.literal("disk.delete"), ...box, taskKey: TaskKey.nullable(), purge: z.boolean() })
    .strict()
    .refine(agentTasksOnly, AGENT_TASKS_ONLY),
  /** RT-40: `box` null purges every trash entry older than 7 days; a box purges that box's entries now ("Purge now"). */
  z.object({ op: z.literal("trash.purge"), box: BoxRef.nullable() }).strict(),
  z
    .object({
      op: z.literal("image.build"),
      layer: z.enum(["base", "profile", "agent"]),
      tag: Tag,
      from: z.union([Tag, NodeImage]),
      aptPackages: z.array(SystemPackage).max(64),
      upgrade: z.boolean(),
    })
    .strict()
    .refine((build) => build.tag.startsWith(`pap-agent-${build.layer}-`), "the tag names the layer")
    .refine(
      (build) => (build.layer === "base") === NodeImage.safeParse(build.from).success,
      "base from Node, others from a pap tag",
    )
    .refine(
      (build) => build.layer !== "profile" || build.aptPackages.length === 0,
      "the profile layer has no apt packages",
    ),
  z.object({ op: z.literal("image.list") }).strict(),
  z.object({ op: z.literal("image.prune"), keep: z.array(Tag).max(256) }).strict(),
  z.object({ op: z.literal("version") }).strict(),
  /** RT-40: the facts `pap doctor` cannot read as pap's user (ruleset, bridge, root disk room). */
  z.object({ op: z.literal("vmd.health") }).strict(),
]);
export type VmdRequest = z.infer<typeof VmdRequest>;

export const VmState = z.enum(["absent", "starting", "running", "paused", "stopped"]);
/** `vm.start`'s result: the bridge address pap-vmd gave the VM (the relay binds the launch's key to it, R13). */
export const VmStartResult = z.object({ address: z.string().regex(VM_IPV4) }).strict();
export const VmdHealth = z
  .object({
    version: z.string().max(64),
    ruleset: z.boolean(),
    bridge: z.boolean(),
    stateFreeMb: z.number().int().min(0),
  })
  .strict();
export const VmdResponse = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(["bad_request", "not_found", "conflict", "capacity", "disk_low", "unavailable", "failed"]),
    })
    .strict(),
]);
