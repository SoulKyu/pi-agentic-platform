import { PapError } from "@pap/contracts";
import type { Clock } from "./kernel/clock.ts";
import type { Logger } from "./kernel/logger.ts";
import { createMirrorInputs, type MirrorHooks } from "./modules/agent-vm/index.ts";
import type { MirrorInputs } from "./modules/sessions/index.ts";

/**
 * The daemon's mirrors of the VM session files and the hooks they report to (R23, R32). AVM-E21: until the hooks are bound a
 * notice or a taint could go nowhere, so no VM session starts (a seam's mirrors are the test's).
 */
export function composeMirrors(deps: {
  readonly mirrors: MirrorInputs | undefined;
  readonly home: string;
  readonly minFreeDiskMb: number;
  readonly clock: Clock;
  readonly logger: Logger;
}) {
  const { logger } = deps;
  let hooks: MirrorHooks = {
    notice: (sessionId) => logger.warn("agent_mirror_notice_unbound", { sessionId }),
    taint: (sessionId) => logger.error("agent_mirror_taint_unbound", { sessionId }),
    canWrite: () => true,
  };
  const own =
    deps.mirrors === undefined
      ? createMirrorInputs({
          papHome: deps.home,
          clock: deps.clock,
          logger,
          minFreeDiskMb: deps.minFreeDiskMb,
          notice: (sessionId, text, now) => hooks.notice(sessionId, text, now),
          taint: (sessionId) => hooks.taint(sessionId),
          canWrite: () => hooks.canWrite(),
        })
      : null;
  let bound = false;
  const bindHooks = (next: MirrorHooks): void => {
    hooks = next;
    bound = true;
  };
  const mirrors: MirrorInputs =
    deps.mirrors ??
    ({
      inputFor(row, resources) {
        if (!bound) throw new PapError("internal");
        return (own as NonNullable<typeof own>).inputFor(row, resources);
      },
    } satisfies MirrorInputs);
  return { own, mirrors, bindHooks };
}
