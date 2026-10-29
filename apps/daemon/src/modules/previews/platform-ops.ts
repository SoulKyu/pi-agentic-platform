import { type ApprovalMode, type BoxRef, PapError } from "@pap/contracts";
import { type PlatformContext, type PlatformHandler, PlatformRefusal } from "../platform/index.ts";
import type { PreviewRegistry } from "./registry.ts";

export interface PreviewOpDeps {
  readonly registry: Pick<PreviewRegistry, "start" | "stop">;
  /** The project box of a plain session (`sessions.projectBoxOf`), or null. */
  projectOf(sessionId: string): string | null;
  /** UX2-R68: the session's own shell's network, its start-time profile's `sandbox.network`; null when no worker started it. */
  shellNetwork(ownerId: string, sessionId: string): boolean | null;
  /** UX2-R69: the approval mode the daemon composes for the session now (its policy row; an agent thread's `effectiveMode`). */
  modeNow(ownerId: string, sessionId: string): ApprovalMode | null;
}

/**
 * The guest's and the registry's refusals, in the fixed words a worker can say (no daemon text reaches the model). Anything
 * else is rethrown as it is: the dispatcher logs its class and answers `internal`.
 */
function refusalOf(error: unknown): unknown {
  if (error instanceof PlatformRefusal) return error;
  if (error instanceof PapError) {
    if (error.code === "box_stopped") return new PlatformRefusal("unavailable");
    if (error.code === "limit_reached" || error.code === "timeout" || error.code === "bad_request")
      return new PlatformRefusal(error.code);
  }
  return error;
}

/**
 * UX2-R28: the daemon decides the box, never the worker. An agent thread runs in its agent's VM, a plain session in its
 * project's box; every other caller, a host session included, is `forbidden`.
 */
function boxOf(deps: PreviewOpDeps, ctx: PlatformContext): BoxRef {
  if (ctx.type === "agent-thread" && ctx.agentId !== null) return { kind: "agent", id: ctx.agentId };
  if (ctx.type === "plain") {
    const projectId = deps.projectOf(ctx.sessionId);
    if (projectId !== null) return { kind: "project", id: projectId };
  }
  throw new PlatformRefusal("forbidden");
}

/** Where a service's network comes from: an agent's is the one its shell started with (R68), a box session's is the project's. */
function networkOf(deps: PreviewOpDeps, ctx: PlatformContext): boolean {
  if (ctx.type !== "agent-thread") return true;
  const network = deps.shellNetwork(ctx.ownerId, ctx.sessionId);
  // No start-time profile means no worker of ours can be calling.
  if (network === null) throw new PlatformRefusal("forbidden");
  return network;
}

export function createPreviewStart(deps: PreviewOpDeps): PlatformHandler<"preview.start"> {
  return async (args, ctx) => {
    try {
      const box = boxOf(deps, ctx);
      const network = networkOf(deps, ctx);
      // UX2-R69: the worker plans a read-only block, but its word is not enough; a mode the daemon cannot read is no mode.
      const mode = deps.modeNow(ctx.ownerId, ctx.sessionId);
      if (mode === null || mode === "read-only") throw new PlatformRefusal("forbidden");
      const view = await deps.registry.start(
        box,
        ctx.ownerId,
        { name: args.name, command: args.command, port: args.port, network },
        ctx.signal,
      );
      return {
        id: view.id,
        name: view.name,
        port: view.port,
        status: view.state === "running" ? "running" : "failed",
        reason: view.reason,
      };
    } catch (error) {
      throw refusalOf(error);
    }
  };
}

/** `preview_stop` runs nothing, so no mode refuses it. */
export function createPreviewStop(deps: PreviewOpDeps): PlatformHandler<"preview.stop"> {
  return async (args, ctx) => {
    try {
      return { stopped: await deps.registry.stop(boxOf(deps, ctx), args.name) };
    } catch (error) {
      throw refusalOf(error);
    }
  };
}
