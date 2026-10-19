import { PapError } from "@pap/contracts";
import type { LiveSession } from "./live-session.ts";
import type { createProjectLink } from "./project-link.ts";
import type { createShellPublisher } from "./shell-publisher.ts";
import type { SessionRow } from "./store.ts";

/** The worker a dialog or a panel answer may go to: none once it is being released, whose dialogs closed with it. */
export const openWorkerOf =
  (live: ReadonlyMap<string, LiveSession>) =>
  (id: string): LiveSession => {
    const session = live.get(id);
    if (!session || session.stopping()) throw new PapError("not_found");
    return session;
  };

/** A copy of a session (a fork) lands in its source's project, and everyone watching is told. */
export const filedOf =
  (link: ReturnType<typeof createProjectLink>, publisher: ReturnType<typeof createShellPublisher>) =>
  <T extends { sessionId: string }>(source: SessionRow, result: T): T => {
    const projectId = link.copy(source.id, result.sessionId);
    publisher.changed(result.sessionId);
    publisher.projectChanged(source.ownerId, projectId);
    return result;
  };
