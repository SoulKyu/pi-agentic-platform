import type { ProjectSummary, ShellSession } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createRateLimiter } from "../../kernel/rate-limit.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";

export interface ShellPublisher {
  changed(sessionId: string): void;
  projectChanged(ownerId: string, projectId: string | null): void;
  countsChanged(ownerId: string): void;
}

/** What changed in one turn of the loop goes out once, sessions then projects then counts (M4R33). */
export function createShellPublisher(deps: {
  readonly hub: Pick<StreamHub, "publish">;
  summary(sessionId: string): { readonly ownerId: string; readonly session: ShellSession } | null;
  project(ownerId: string, projectId: string): ProjectSummary | null;
  archivedCount(ownerId: string): number;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly schedule?: (flush: () => void) => void;
}): ShellPublisher {
  const schedule = deps.schedule ?? queueMicrotask;
  const limiter = createRateLimiter(deps.clock, 60_000);
  const sessions = new Set<string>();
  const projects = new Map<string, { ownerId: string; projectId: string }>();
  const counts = new Set<string>();
  let armed = false;
  // One item that cannot be read must not drop the others; the next change or snapshot says the truth (RT-16).
  const each = (kind: string, publish: () => void) => {
    try {
      publish();
    } catch (error) {
      const said = limiter.check("shell_publish_failed");
      if (said.allowed)
        deps.logger.error("shell_publish_failed", { kind, err: error, suppressed: said.suppressed });
    }
  };
  const flush = () => {
    armed = false;
    for (const id of [...sessions]) {
      sessions.delete(id);
      each("session", () => {
        const found = deps.summary(id);
        if (found) deps.hub.publish("shell", found.ownerId, { kind: "session", session: found.session });
      });
    }
    for (const [key, { ownerId, projectId }] of [...projects]) {
      projects.delete(key);
      each("project", () => {
        const project = deps.project(ownerId, projectId);
        if (project) deps.hub.publish("shell", ownerId, { kind: "project", project });
      });
    }
    for (const ownerId of [...counts]) {
      counts.delete(ownerId);
      each("counts", () =>
        deps.hub.publish("shell", ownerId, { kind: "counts", archived: deps.archivedCount(ownerId) }),
      );
    }
  };
  const arm = () => {
    if (armed) return;
    armed = true;
    schedule(flush);
  };
  return {
    changed(sessionId) {
      sessions.add(sessionId);
      arm();
    },
    projectChanged(ownerId, projectId) {
      if (projectId === null) return;
      projects.set(JSON.stringify([ownerId, projectId]), { ownerId, projectId });
      arm();
    },
    countsChanged(ownerId) {
      counts.add(ownerId);
      arm();
    },
  };
}
