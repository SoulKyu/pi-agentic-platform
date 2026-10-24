import { z } from "zod";
import { AgentResources, SystemPackage } from "./agents-resources.ts";
import { BoxPhase, ProjectHosts } from "./boxes.ts";
import { defineMethod } from "./define.ts";
import { ProjectView, SHELL_LIMITS } from "./shell.ts";

const Id = z.string().min(1).max(128);
const Params = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const Ok = z.object({ ok: z.literal(true) }).strict();

/** What the project page shows of a box project: its state, its settings and the counts a delete confirmation names. */
export const ProjectBoxView = z
  .object({
    phase: BoxPhase,
    resources: AgentResources,
    hosts: ProjectHosts,
    /** `built`: the packages the box image holds; `wanted`: what `.pi/project.yaml` asks for (null: no `packages` key). */
    packages: z
      .object({
        built: z.array(SystemPackage).max(64),
        wanted: z.array(SystemPackage).max(64).nullable(),
      })
      .strict(),
    scratch: z.boolean(),
    counts: z
      .object({ sessions: z.number().int().nonnegative(), triggers: z.number().int().nonnegative() })
      .strict(),
  })
  .strict();
export type ProjectBoxView = z.infer<typeof ProjectBoxView>;

// `capacity`: 2000 projects (or the box's host is full); `bad_request`: a name empty once cleaned, or resources over the host's ceilings.
const BOX_LIFE_ERRORS = [
  "not_found",
  "capacity",
  "sandbox_unavailable",
  "disk_low",
  "command_failed",
  // A refused start (spec §3): `agent_paused` is a box paused after 3 crashes, `vm_bundle_stale` code older than pap.
  "agent_paused",
  "vm_bundle_stale",
] as const;

/** Projects that live in a box (decision 124): the box is made, started, tuned, rebuilt and deleted from the project page. */
export const projectBoxMethods = {
  "projects.create": defineMethod({
    name: "projects.create",
    permission: "sessions:operate",
    idempotent: false,
    params: Params({
      name: z
        .string()
        .min(1)
        .max(SHELL_LIMITS.projectName * 2),
    }),
    result: Params({ project: ProjectView }),
    errors: ["bad_request", "capacity", "read_only", "internal"],
  }),
  "projects.scratch": defineMethod({
    name: "projects.scratch",
    permission: "sessions:operate",
    idempotent: true, // the owner's one Scratch: made on the first call, the same one after
    params: Params({}),
    result: Params({ project: ProjectView }),
    errors: ["capacity", "read_only", "internal"],
  }),
  // Always asks for the password. `conflict`: Scratch with sessions. Only a box project is deleted (`not_found` for a host one).
  "projects.delete": defineMethod({
    name: "projects.delete",
    permission: "sessions:admin",
    idempotent: false,
    params: Params({ projectId: Id }),
    result: Ok,
    errors: ["step_up_required", "not_found", "conflict", "read_only"],
  }),
  "projects.box": defineMethod({
    name: "projects.box",
    permission: "sessions:read",
    idempotent: true,
    params: Params({ projectId: Id }),
    result: Params({ box: ProjectBoxView }),
    errors: ["not_found"],
  }),
  // `bad_request`: resources over the host's ceilings, or a smaller disk (the disk only grows). Applies at the next start.
  "projects.setBox": defineMethod({
    name: "projects.setBox",
    permission: "sessions:admin",
    idempotent: false,
    params: Params({ projectId: Id, resources: AgentResources.optional(), hosts: ProjectHosts.optional() }),
    result: Params({ box: ProjectBoxView }),
    errors: ["not_found", "bad_request", "read_only", "internal"],
  }),
  "projects.startBox": defineMethod({
    name: "projects.startBox",
    permission: "sessions:operate",
    idempotent: false,
    params: Params({ projectId: Id }),
    result: Ok,
    errors: BOX_LIFE_ERRORS,
  }),
  "projects.restartBox": defineMethod({
    name: "projects.restartBox",
    permission: "sessions:operate",
    idempotent: false,
    params: Params({ projectId: Id }),
    result: Ok,
    errors: BOX_LIFE_ERRORS,
  }),
  "projects.rebuild": defineMethod({
    name: "projects.rebuild",
    permission: "sessions:admin",
    idempotent: false,
    params: Params({ projectId: Id }),
    result: Ok,
    errors: BOX_LIFE_ERRORS,
  }),
} as const;
