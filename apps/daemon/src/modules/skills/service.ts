import {
  type Caller,
  HELPER_OPS,
  PapError,
  type PluginsListResult,
  type PluginSetEnabledResult,
  type SkillsListResult,
  type SkillsSearchResult,
  type SkillsSetInvocationResult,
} from "@pap/contracts";
import type { z } from "zod";
import type { Clock } from "../../kernel/clock.ts";
import type { HelperPool } from "../../kernel/helper/pool.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createPiWriteQueue, type PiWriteQueue } from "../../kernel/pi-write-queue.ts";
import { requireStepUp } from "../auth/index.ts";
import type { ProjectsPort } from "../projects/index.ts";

/** Reading skill folders, one frontmatter line, or one small search: the helper starts, does it, answers. */
const DEADLINE_MS = 30_000;
/** The helper's `npx` has 5 minutes (M7R112); the run waits a little longer so the helper's own failure comes first. */
const INSTALL_DEADLINE_MS = 330_000;
/** Removing a package may run `npm uninstall` or delete a clone. */
const REMOVE_DEADLINE_MS = 120_000;

export interface SkillsServiceDeps {
  readonly helpers: HelperPool;
  readonly projects: Pick<ProjectsPort, "covers">;
  readonly logger: Logger;
  readonly clock: Clock;
  /** The shared queue of every write of Pi's own files (MC29); a module built on its own gets a private one. */
  readonly writes?: PiWriteQueue;
}

type OpName = keyof typeof HELPER_OPS;
type Confirm = { confirmProtected?: true | undefined };
type PluginScope = "user" | "project";
type PluginRef = { source: string; scope: PluginScope };

export function createSkillsService(deps: SkillsServiceDeps) {
  // Frontmatter edits and installs run one at a time, on one queue: two switches never race on one file (MC29), two installs
  // never run `npx` over the same folders, and a switch never writes into a folder an install is replacing (MC55).
  // `settings.json` is not touched here, so the shared Pi queue does not apply.
  const skillFiles = createPiWriteQueue();
  // Plugins write Pi's `settings.json` (and its package folders): the one queue of every Pi settings writer (MC29).
  const piWrites = deps.writes ?? createPiWriteQueue();

  /** One helper run; its result is parsed with the strict contract before it goes on (nothing of a bad answer is logged). */
  async function run<N extends OpName>(
    op: N,
    params: unknown,
    deadlineMs: number,
    cwd?: string,
  ): Promise<z.infer<(typeof HELPER_OPS)[N]["result"]>> {
    const handle = deps.helpers.run(op, params, { deadlineMs, ...(cwd === undefined ? {} : { cwd }) });
    const parsed = HELPER_OPS[op].result.safeParse(await handle.done);
    if (!parsed.success) {
      deps.logger.warn("skills_helper_result_invalid", { op, issues: parsed.error.issues.length });
      throw new PapError("helper_failed");
    }
    return parsed.data as z.infer<(typeof HELPER_OPS)[N]["result"]>;
  }

  /** The cwd is a folder the caller has a session or project in, so an arbitrary path is no probe (M7R50). */
  function folderOf(caller: Caller, cwd: string | undefined): string | undefined {
    if (cwd !== undefined && !deps.projects.covers(caller.userId, cwd)) throw new PapError("invalid_cwd");
    return cwd;
  }

  /**
   * The scope rule of M7R140 for the plugin writes: the user scope is the owner's Pi folder (a step-up when `widens`, and
   * whatever `cwd` came along is ignored); the project scope needs a folder of the caller's and the confirmation, and no
   * step-up. An untrusted project is refused by the helper (`project_untrusted`, which maps to `forbidden`).
   */
  function pluginGate<T extends { cwd?: string | undefined } & Confirm>(
    caller: Caller,
    scopes: readonly PluginScope[],
    params: T,
    widens: boolean,
  ): { folder: string | undefined; rest: Omit<T, "cwd"> } {
    const { cwd, ...rest } = params;
    if (!scopes.includes("project")) {
      if (widens) requireStepUp(caller, deps.clock.now());
      return { folder: undefined, rest };
    }
    if (cwd === undefined) throw new PapError("bad_request");
    const folder = folderOf(caller, cwd);
    if (params.confirmProtected !== true) throw new PapError("protected_path");
    return { folder, rest };
  }

  return {
    /** The skills Pi's loader finds for the folder; a project's only while it is trusted (the helper decides, M7R110). */
    async list(caller: Caller, cwd?: string): Promise<SkillsListResult> {
      return run("skills.list", {}, DEADLINE_MS, folderOf(caller, cwd));
    },

    /**
     * Switches model invocation on listed skill files. No step-up (M7R133); a project skill takes the confirmation, row by
     * row, in the helper. The run's folder carries the cwd; the helper's params do not.
     */
    async setInvocation(
      caller: Caller,
      params: { items: Array<{ path: string; disabled: boolean }>; cwd?: string } & Confirm,
    ): Promise<SkillsSetInvocationResult> {
      const { cwd, ...rest } = params;
      const folder = folderOf(caller, cwd);
      return skillFiles.run(() => run("skills.setInvocation", rest, DEADLINE_MS, folder));
    },

    /** The one call that sends the owner's query out (M7R113): the helper asks skills.sh, bounded. */
    async search(_caller: Caller, query: string): Promise<SkillsSearchResult> {
      return run("skills.search", { query: query.trim() }, DEADLINE_MS);
    },

    /**
     * Installs from skills.sh (M7R112). Global means the owner's Pi folder and takes the password step-up; a project
     * install needs a folder of the caller's and the protected-file confirmation, and no step-up (M7R140). An untrusted
     * project is refused by the helper (`project_untrusted`, which maps to `forbidden`).
     */
    async install(
      caller: Caller,
      params: { source: string; scope: "global" | "project"; cwd?: string } & Confirm,
    ): Promise<{ ok: true }> {
      const { cwd, ...rest } = params;
      if (params.scope === "global") {
        requireStepUp(caller, deps.clock.now());
        return skillFiles.run(() => run("skills.install", rest, INSTALL_DEADLINE_MS));
      }
      if (cwd === undefined) throw new PapError("bad_request");
      const folder = folderOf(caller, cwd);
      if (params.confirmProtected !== true) throw new PapError("protected_path");
      return skillFiles.run(() => run("skills.install", rest, INSTALL_DEADLINE_MS, folder));
    },

    /** Pi packages for the folder: the owner's, and a trusted project's. Read offline in the helper (MC52). */
    async listPlugins(caller: Caller, cwd?: string): Promise<PluginsListResult> {
      return run("plugins.list", {}, DEADLINE_MS, folderOf(caller, cwd));
    },

    /** Installs a Pi package (M7R114). User scope takes the password step-up; project scope the confirmation (M7R140). */
    async installPlugin(
      caller: Caller,
      params: { source: string; scope: PluginScope; cwd?: string } & Confirm,
    ): Promise<{ ok: true }> {
      const { folder, rest } = pluginGate(caller, [params.scope], params, true);
      return piWrites.run(() => run("plugins.install", rest, INSTALL_DEADLINE_MS, folder));
    },

    async removePlugin(
      caller: Caller,
      params: { source: string; scope: PluginScope; cwd?: string } & Confirm,
    ): Promise<{ ok: true }> {
      const { folder, rest } = pluginGate(caller, [params.scope], params, false);
      return piWrites.run(() => run("plugins.remove", rest, REMOVE_DEADLINE_MS, folder));
    },

    /** Updates what Pi's own check found newer (M7R117). With no scope: the owner's Pi folder, which takes the step-up. */
    async updatePlugins(
      caller: Caller,
      params: { source?: string; scope?: PluginScope; cwd?: string } & Confirm,
    ): Promise<{ updated: PluginRef[] }> {
      const { folder, rest } = pluginGate(caller, [params.scope ?? "user"], params, true);
      return piWrites.run(() => run("plugins.update", rest, INSTALL_DEADLINE_MS, folder));
    },

    /** Switches whole packages on or off. A row per item; no step-up; a project item takes the confirmation. */
    async setPluginsEnabled(
      caller: Caller,
      params: { items: PluginRef[]; enabled: boolean; cwd?: string } & Confirm,
    ): Promise<PluginSetEnabledResult> {
      const { folder, rest } = pluginGate(
        caller,
        params.items.map((item) => item.scope),
        params,
        false,
      );
      return piWrites.run(() => run("plugins.setEnabled", rest, DEADLINE_MS, folder));
    },
  };
}
export type SkillsService = ReturnType<typeof createSkillsService>;
