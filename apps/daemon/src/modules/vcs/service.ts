import { type Caller, PapError, type ParamsOf, type ResultOf } from "@pap/contracts";
import { boxOfPath } from "../../kernel/box-path.ts";
import type { BoxControl, BoxOps, ProjectBoxSource } from "../../kernel/boxes.ts";
import type { Clock } from "../../kernel/clock.ts";
import { type BoundaryConfig, judgePath, type Scope } from "../../kernel/fs/boundary.ts";
import type { DenySet } from "../../kernel/fs/deny-set.ts";
import type { GitRunner } from "../../kernel/git/runner.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import { readBoxDiff, readBoxStatus } from "./box-status.ts";
import { readDiff } from "./diff.ts";
import { createLineCounter } from "./line-counts.ts";
import { createPoller, tokenKey } from "./poller.ts";
import { readStatus, restrictStatus } from "./status.ts";

export interface VcsDeps {
  /** The caller's project roots (M8R15). */
  roots(ownerId: string): readonly string[];
  readonly boundary: BoundaryConfig;
  readonly deny: DenySet;
  readonly git: GitRunner;
  readonly hub: Pick<StreamHub, "registerSnapshot" | "publish" | "hasSubscribers">;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Late-bound (J1 wires them): with no source bound, every root is a host root. */
  readonly boxes?: () => ProjectBoxSource | undefined;
  readonly boxOps?: () => BoxOps | undefined;
  readonly boxControl?: () => BoxControl | undefined;
}

export interface VcsService {
  /**
   * Judges the root and starts a refresh; the handler opens the subscription right after (M8R48). Answers the stream key:
   * the root for a browser session, the token's own filtered view for a token (MC24).
   */
  prepareSubscription(caller: Caller, root: string): Promise<string>;
  refresh(caller: Caller, root: string): Promise<void>;
  fileDiff(caller: Caller, params: ParamsOf<"vcs.fileDiff">): Promise<ResultOf<"vcs.fileDiff">>;
  shutdown(): void;
}

export function createVcsService(deps: VcsDeps): VcsService {
  const logger = deps.logger.child({ module: "vcs" });
  // The transport's caller, never the params, decides whose roots and which strictness apply (C 4.4).
  const scopeOf = (caller: Caller): Scope => ({
    roots: deps.roots(caller.userId),
    config: deps.boundary,
    caller: caller.kind,
  });
  // The status of a root is cached once with real counts for the owner; a token gets a filtered copy on its own key (MC24).
  const ownerScope = (root: string): Scope => ({ roots: [root], config: deps.boundary, caller: "session" });
  const tokenScope = (root: string): Scope => ({ roots: [root], config: deps.boundary, caller: "token" });
  /** The box roots a subscription was judged for, with their project: the poll and the phase listener look here. */
  const boxRoots = new Map<string, string>();
  const running = (projectId: string): boolean => deps.boxControl?.()?.phase(projectId) === "running";
  const boxOps = (): BoxOps => {
    const ops = deps.boxOps?.();
    if (ops === undefined) throw new PapError("box_stopped");
    return ops;
  };
  const poller = createPoller({
    clock: deps.clock,
    logger,
    hub: deps.hub,
    restrict: (status) => restrictStatus(status, tokenScope(status.root)),
    newCounter: (root) => createLineCounter({ root, scope: ownerScope(root), deny: deps.deny, logger }),
    read: (root, counter, timed) => {
      const projectId = boxRoots.get(root);
      return projectId === undefined
        ? readStatus({ git: deps.git, logger, now: () => deps.clock.now() }, root, counter)
        : readBoxStatus(boxOps(), projectId, root, timed);
    },
    // The poll asks a running box only and never starts one.
    paused: (root) => {
      const projectId = boxRoots.get(root);
      return projectId !== undefined && !running(projectId);
    },
  });
  let unlisten: (() => void) | undefined;
  /** A box that just came up refreshes the roots it holds (its status was not read while it was down). */
  function listenToBoxes(): void {
    const control = deps.boxControl?.();
    if (unlisten !== undefined || control === undefined) return;
    unlisten = control.onPhase((projectId, phase) => {
      if (phase !== "running") return;
      for (const [root, id] of boxRoots) {
        if (id !== projectId) continue;
        try {
          poller.refresh(root);
        } catch (error) {
          logger.debug("vcs_box_refresh_failed", { err: error });
        }
      }
    });
  }
  deps.hub.registerSnapshot("vcs", (key) => ({ kind: "snapshot", status: poller.snapshot(key) }));

  /** M8R44: exactly one of the caller's project roots, and one the boundary lets them open. Anything else is `not_found`. */
  async function authorize(
    caller: Caller,
    root: string,
  ): Promise<{ scope: Scope; box: { projectId: string; root: string } | null }> {
    const scope = scopeOf(caller);
    if (!scope.roots.includes(root)) throw new PapError("not_found");
    const box = boxOfPath(deps.boxes?.(), caller.userId, root);
    if (box !== null) {
      // No host judgement for a box root: the guest owns the folder. A stopped box is never started by a call.
      if (box.root !== root) throw new PapError("not_found");
      if (!running(box.projectId)) throw new PapError("box_stopped");
      boxRoots.set(root, box.projectId);
      listenToBoxes();
      return { scope, box };
    }
    const judgement = await judgePath(root, scope, "list");
    if (!judgement.ok) {
      logger.debug("vcs_refused", { why: judgement.why });
      throw new PapError("not_found");
    }
    return { scope, box: null };
  }

  return {
    async prepareSubscription(caller, root) {
      await authorize(caller, root);
      poller.watch(root);
      return caller.kind === "token" ? tokenKey(root) : root;
    },
    async refresh(caller, root) {
      await authorize(caller, root);
      poller.refresh(root);
    },
    async fileDiff(caller, { root, path, oldPath, from, to }) {
      const { scope, box } = await authorize(caller, root);
      if (box !== null)
        return readBoxDiff({ ops: boxOps(), logger }, caller.kind, box, { path, oldPath, from, to });
      return readDiff({ git: deps.git, deny: deps.deny, logger }, scope, root, { path, oldPath, from, to });
    },
    shutdown: () => {
      unlisten?.();
      unlisten = undefined;
      poller.stop();
    },
  };
}
