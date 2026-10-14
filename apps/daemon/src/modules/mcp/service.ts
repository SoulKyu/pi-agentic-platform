import {
  type Caller,
  type CodemodeSettings,
  HELPER_OPS,
  type McpOverview,
  type McpServerView,
  type McpSetEnabledResult,
  type McpTestResult,
  PapError,
} from "@pap/contracts";
import type { z } from "zod";
import type { Clock } from "../../kernel/clock.ts";
import type { HelperPool } from "../../kernel/helper/pool.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createPiWriteQueue, type PiWriteQueue } from "../../kernel/pi-write-queue.ts";
import { requireStepUp } from "../auth/index.ts";
import type { ProjectsPort } from "../projects/index.ts";
import { createTestResults } from "./test-results.ts";
import { createUndoStore } from "./undo.ts";

/** Reading two small files: the helper starts, reads, answers (M7R82). */
const READ_DEADLINE_MS = 30_000;
const WRITE_DEADLINE_MS = 30_000;
/** How long a Test waits for the server (M7R93); the module's option shortens it in tests. */
export const TEST_DEADLINE_MS = 20_000;
/** On top of the wait: the helper starts Pi's session, and stops the server at the end. */
const TEST_HELPER_MARGIN_MS = 15_000;

export interface McpServiceDeps {
  readonly helpers: HelperPool;
  readonly projects: Pick<ProjectsPort, "covers">;
  readonly logger: Logger;
  readonly clock: Clock;
  /** The daemon's one Pi write queue, shared with the models service (MC29); a service built alone gets its own. */
  readonly writes?: PiWriteQueue;
  /** How long a Test waits for the server to connect (default 20 s). */
  readonly testDeadlineMs?: number;
}

type OpName = keyof typeof HELPER_OPS;
type Scope = "global" | "project";
type Confirm = { confirmProtected?: boolean | undefined };

export function createMcpService(deps: McpServiceDeps) {
  const writes = deps.writes ?? createPiWriteQueue();
  const undo = createUndoStore({ clock: deps.clock });
  const results = createTestResults();
  const testDeadlineMs = deps.testDeadlineMs ?? TEST_DEADLINE_MS;

  /** The last Test of a server, as the overview shows it. */
  const lastTestOf = (
    owner: string,
    server: McpServerView,
    cwd: string | undefined,
  ): McpServerView["lastTest"] => {
    const last = results.get(owner, server.scope, server.name, cwd);
    if (last === undefined) return null;
    return {
      at: last.at,
      ok: last.state === "connected",
      state: last.state,
      tools: last.state === "connected" ? last.count : null,
    };
  };

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
      deps.logger.warn("mcp_helper_result_invalid", { issues: parsed.error.issues.length });
      throw new PapError("helper_failed");
    }
    return parsed.data as z.infer<(typeof HELPER_OPS)[N]["result"]>;
  }

  /** The cwd is a folder the caller has a project in (M7R50). A project target needs it, and the "Save anyway?" flag (M7R133). */
  function target(
    caller: Caller,
    scopes: readonly Scope[],
    cwd: string | undefined,
    confirm: Confirm,
  ): string | undefined {
    if (cwd !== undefined && !deps.projects.covers(caller.userId, cwd)) throw new PapError("invalid_cwd");
    if (!scopes.includes("project")) return cwd;
    if (cwd === undefined) throw new PapError("bad_request");
    if (confirm.confirmProtected !== true) throw new PapError("protected_path");
    return cwd;
  }

  return {
    /**
     * What `mcp.json` files say, read in a helper and never run (M7R82). The `cwd` is a folder the caller has a project in,
     * so an arbitrary path is no probe (M7R50). The helper's answer is parsed with the strict contract before it goes on:
     * a field the schema does not list (a value, say) fails the call, and nothing of it reaches the caller or the log.
     */
    async overview(caller: Caller, cwd?: string): Promise<McpOverview> {
      if (cwd !== undefined && !deps.projects.covers(caller.userId, cwd)) throw new PapError("invalid_cwd");
      const view = await run("mcp.overview", {}, READ_DEADLINE_MS, cwd);
      const withTests = (servers: McpServerView[]): McpServerView[] =>
        servers.map((server) => ({ ...server, lastTest: lastTestOf(caller.userId, server, cwd) }));
      return {
        ...view,
        global: { ...view.global, servers: withTests(view.global.servers) },
        project: view.project === null ? null : { ...view.project, servers: withTests(view.project.servers) },
      };
    },

    /** Switches never ask for the password (M7R133); a project row asks for the confirmation. */
    async setEnabled(
      caller: Caller,
      params: { servers: Array<{ scope: Scope; name: string }>; enabled: boolean; cwd?: string } & Confirm,
    ): Promise<McpSetEnabledResult> {
      const { cwd, ...rest } = params;
      const checked = target(
        caller,
        params.servers.map((row) => row.scope),
        cwd,
        params,
      );
      return writes.run(() => run("mcp.setEnabled", rest, WRITE_DEADLINE_MS, checked));
    },
    async setExposure(
      caller: Caller,
      params: { scope: Scope; name: string; exposure: string; cwd?: string } & Confirm,
    ) {
      const { cwd, ...rest } = params;
      const checked = target(caller, [params.scope], cwd, params);
      return writes.run(() => run("mcp.setExposure", rest, WRITE_DEADLINE_MS, checked));
    },
    async setInProject(caller: Caller, params: { name: string; enabled: boolean; cwd: string } & Confirm) {
      const { cwd, ...rest } = params;
      const checked = target(caller, ["project"], cwd, params);
      return writes.run(() => run("mcp.setInProject", rest, WRITE_DEADLINE_MS, checked));
    },

    /**
     * Removes an entry and keeps its text for a minute (M7R90). A full undo list refuses first, with the file untouched;
     * the check runs inside the write queue, so two removals cannot both pass it at 99. The text stays in this process.
     */
    async remove(caller: Caller, params: { scope: Scope; name: string; cwd?: string } & Confirm) {
      const { cwd, ...rest } = params;
      const checked = target(caller, [params.scope], cwd, params);
      return writes.run(async () => {
        undo.requireRoom(caller.userId);
        const removed = await run("mcp.remove", rest, WRITE_DEADLINE_MS, checked);
        results.drop(caller.userId, params.scope, params.name, checked);
        return undo.put(caller.userId, {
          scope: params.scope,
          name: params.name,
          ...(params.scope === "project" && checked !== undefined ? { cwd: checked } : {}),
          entry: removed.entry,
          index: removed.index,
        });
      });
    },

    /**
     * Puts a removed entry back. A global undo brings a command back into Pi's own config, so it takes the password step-up;
     * a project one takes the confirmation. The record is taken only after the helper wrote the file: a failed write keeps it.
     */
    async undo(caller: Caller, params: { token: string } & Confirm) {
      const first = undo.peek(caller.userId, params.token);
      if (first === undefined) throw new PapError("not_found");
      if (first.scope === "global") requireStepUp(caller, deps.clock.now());
      const cwd = target(caller, [first.scope], first.cwd, params);
      return writes.run(async () => {
        const record = undo.peek(caller.userId, params.token);
        if (record === undefined) throw new PapError("not_found");
        const result = await run(
          "mcp.restore",
          {
            scope: record.scope,
            name: record.name,
            index: record.index,
            entry: record.entry,
            ...(params.confirmProtected === undefined ? {} : { confirmProtected: params.confirmProtected }),
          },
          WRITE_DEADLINE_MS,
          cwd,
        );
        undo.take(caller.userId, params.token);
        return result;
      });
    },

    /** A global add runs a command later: the password step-up first (M7R133); a project add takes the confirmation. */
    async add(
      caller: Caller,
      params: { scope: Scope; name: string; entry: Record<string, unknown>; cwd?: string } & Confirm,
    ) {
      const { cwd, ...rest } = params;
      if (params.scope === "global") requireStepUp(caller, deps.clock.now());
      const checked = target(caller, [params.scope], cwd, params);
      return writes.run(() => run("mcp.add", rest, WRITE_DEADLINE_MS, checked));
    },

    /**
     * Runs what the file says for that name in a throwaway Pi session inside a helper (M7R93). It starts a command or opens a
     * connection, so it takes the password step-up like a global add; an untrusted project answers `forbidden` (M7R94, the
     * helper decides). The result is kept as the server's last one, within the cap (M7R97), and returned either way.
     */
    async test(caller: Caller, params: { scope: Scope; name: string; cwd?: string }): Promise<McpTestResult> {
      requireStepUp(caller, deps.clock.now());
      const { scope, name, cwd } = params;
      if (scope === "project" && cwd === undefined) throw new PapError("bad_request");
      const checked = target(caller, [], cwd, {});
      // A removal while the Test runs makes its result stale (the entry may be gone or replaced): not kept (MC45 M2).
      const epoch = results.epoch();
      const outcome = await run(
        "mcp.test",
        { scope, name, deadlineMs: testDeadlineMs },
        testDeadlineMs + TEST_HELPER_MARGIN_MS,
        scope === "project" ? checked : undefined,
      );
      const result: McpTestResult = { ...outcome, at: deps.clock.now() };
      results.put(caller.userId, scope, name, scope === "project" ? checked : undefined, result, epoch);
      return result;
    },

    /** Code mode keys of Pi's `settings.json`: through the same queue as the models writes (MC29). */
    async setCodemode(
      _caller: Caller,
      params: { choice?: "automatic" | "always"; mode?: "on" | "only"; inlineBudget?: number | null },
    ): Promise<CodemodeSettings> {
      return writes.run(() => run("mcp.codemode", params, WRITE_DEADLINE_MS));
    },
  };
}
export type McpService = ReturnType<typeof createMcpService>;
