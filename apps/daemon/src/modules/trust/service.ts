import {
  type Caller,
  HELPER_OPS,
  PapError,
  TRUST_LIMITS,
  type TrustSetResult,
  type TrustStatus,
} from "@pap/contracts";
import type { z } from "zod";
import type { Clock } from "../../kernel/clock.ts";
import type { HelperPool } from "../../kernel/helper/pool.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createPiWriteQueue, type PiWriteQueue } from "../../kernel/pi-write-queue.ts";
import type { AuditPort } from "../audit/index.ts";
import { requireStepUp } from "../auth/index.ts";
import type { ProjectsPort } from "../projects/index.ts";
import type { SessionsModule } from "../sessions/index.ts";

/** Reading a few files, or one small write to `trust.json`: the helper starts, does it, answers. */
const DEADLINE_MS = 30_000;

export interface TrustServiceDeps {
  readonly helpers: HelperPool;
  readonly projects: Pick<ProjectsPort, "covers" | "roots">;
  /** A decision applies at the next open of a worker (M7R105). */
  readonly sessions: Pick<SessionsModule, "restartFolder">;
  readonly audit: Pick<AuditPort, "append">;
  readonly logger: Logger;
  readonly clock: Clock;
  /** Decisions are written one at a time; a service built alone gets its own queue. */
  readonly writes?: PiWriteQueue;
}

type OpName = "trust.status" | "trust.set";

const AUDIT_REASON = new Map<
  boolean | null,
  "project_trusted" | "project_untrusted" | "project_trust_cleared"
>([
  [true, "project_trusted"],
  [false, "project_untrusted"],
  [null, "project_trust_cleared"],
]);

/** What lanes ask of trust (M9R39). */
export interface TrustPort {
  /** Pi's decision for the folder or the nearest folder above it; null when there is none or the helper failed. */
  status(folder: string): Promise<boolean | null>;
  /** Records `true` for `folder` because `from` (its project) is trusted; false when Pi's store refuses or fails. */
  inherit(
    ownerId: string,
    folder: string,
    from: string,
    by?: Pick<Caller, "kind" | "credentialId">,
  ): Promise<boolean>;
  /** Removes the decision recorded for `folder`; throws `helper_failed` when it is not recorded. */
  clear(ownerId: string, folder: string): Promise<void>;
}

const absolute = (folder: string): boolean =>
  folder.startsWith("/") && !folder.includes("\0") && folder.length <= 4096;

/** The folders the breadth rule compares with: absolute paths the helper's schema accepts, within its bound (M7R104). */
const projectPaths = (roots: readonly string[]): string[] =>
  roots.filter((root) => root.startsWith("/") && !root.includes("\0") && root.length <= 4096);

export function createTrustService(deps: TrustServiceDeps) {
  // Pi's trust.json is read and written only by a helper (M7R103); two decisions never overlap, so none is lost.
  const writes = deps.writes ?? createPiWriteQueue();

  /** One helper run; its result is parsed with the strict contract before it goes on (nothing of a bad answer is logged). */
  async function run<N extends OpName>(
    op: N,
    params: unknown,
    cwd: string,
  ): Promise<z.infer<(typeof HELPER_OPS)[N]["result"]>> {
    const handle = deps.helpers.run(op, params, { deadlineMs: DEADLINE_MS, cwd });
    const parsed = HELPER_OPS[op].result.safeParse(await handle.done);
    if (!parsed.success) {
      deps.logger.warn("trust_helper_result_invalid", { issues: parsed.error.issues.length });
      throw new PapError("helper_failed");
    }
    return parsed.data as z.infer<(typeof HELPER_OPS)[N]["result"]>;
  }

  /** The folder is one the caller has a session or a project in, so an arbitrary path is no probe (M7R50). */
  function folderOf(caller: Caller, cwd: string): string {
    if (!deps.projects.covers(caller.userId, cwd)) throw new PapError("invalid_cwd");
    return cwd;
  }

  /** The trust port (M9R39): internal, no step-up. Lanes use it to give a worktree its project's decision. */
  const port: TrustPort = {
    async status(folder) {
      if (!absolute(folder)) return null;
      try {
        return (await run("trust.status", {}, folder)).decision;
      } catch (error) {
        deps.logger.warn("trust_port_status_failed", { err: error });
        return null;
      }
    },
    async inherit(ownerId, folder, from, by) {
      const projects = projectPaths(deps.projects.roots(ownerId));
      if (!absolute(folder) || projects.length > TRUST_LIMITS.projects) return false;
      try {
        return await writes.run(async () => {
          // An owner revoke between the caller's status check and this queue turn must win (T6a-3).
          if ((await run("trust.status", {}, from)).decision !== true) return false;
          const result = await run(
            "trust.set",
            { decision: true, projects: projects.slice(0, TRUST_LIMITS.projects) },
            folder,
          );
          if (!result.ok) {
            deps.logger.info("trust_port_inherit_failed", { folder });
            return false;
          }
          deps.audit.append({
            ownerId,
            actor: by?.kind === "token" ? "token" : "user",
            ...(by?.kind === "token" && by.credentialId ? { actorId: by.credentialId } : {}),
            kind: "policy",
            reason: "project_trusted",
            detail: { folder: result.folder, inheritedFrom: from },
          });
          return true;
        });
      } catch (error) {
        deps.logger.warn("trust_port_inherit_failed", { err: error });
        return false;
      }
    },
    async clear(ownerId, folder) {
      if (!absolute(folder)) throw new PapError("invalid_cwd");
      await writes.run(async () => {
        const result = await run("trust.set", { decision: null, projects: [] }, folder);
        if (!result.ok) throw new PapError("helper_failed");
        deps.audit.append({
          ownerId,
          actor: "user",
          kind: "policy",
          reason: "project_trust_cleared",
          detail: { folder: result.folder },
        });
      });
    },
  };

  return {
    port,
    /** What Pi's store says about the folder and what trusting it turns on (M7R107). */
    async status(caller: Caller, cwd: string): Promise<TrustStatus> {
      return run("trust.status", {}, folderOf(caller, cwd));
    },

    /**
     * Records, or clears, the decision. Trusting runs the folder's code later, so it takes the password step-up (M7R133),
     * and so does clearing (MC47); only `false` never asks. The audit row names the folder the helper recorded (M7R106), then the owner's workers in it are
     * let go so that the next open reads the decision (M7R105).
     */
    async set(caller: Caller, params: { cwd: string; decision: boolean | null }): Promise<TrustSetResult> {
      // Clearing asks too (MC47): removing an explicit `false` under a trusted parent widens trust. Only `false` narrows.
      if (params.decision !== false) requireStepUp(caller, deps.clock.now());
      const cwd = folderOf(caller, params.cwd);
      const projects = projectPaths(deps.projects.roots(caller.userId));
      // Past the cap the breadth rule cannot compare with every project: trusting fails closed rather than judging a part.
      if (params.decision === true && projects.length > TRUST_LIMITS.projects) {
        deps.logger.warn("trust_projects_over_cap", { cap: TRUST_LIMITS.projects });
        throw new PapError("capacity");
      }
      return writes.run(async () => {
        const result = await run(
          "trust.set",
          { decision: params.decision, projects: projects.slice(0, TRUST_LIMITS.projects) },
          cwd,
        );
        if (!result.ok) return result;
        deps.audit.append({
          ownerId: caller.userId,
          actor: "user",
          kind: "policy",
          reason: AUDIT_REASON.get(params.decision) ?? "project_trust_cleared",
          detail: { folder: result.folder },
        });
        try {
          deps.sessions.restartFolder(caller.userId, result.folder);
        } catch (error) {
          // The decision is recorded; the workers take it at their next open anyway.
          deps.logger.warn("trust_restart_failed", { err: error });
        }
        return { ok: true };
      });
    },
  };
}
export type TrustService = ReturnType<typeof createTrustService>;
