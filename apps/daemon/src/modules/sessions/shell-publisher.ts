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

export interface ShellStatusFeed {
  /** Hears each session that went out on the `shell` stream, with its owner; returns the way to stop. */
  onStatus(listener: (ownerId: string, sessionId: string) => void): () => void;
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
}): ShellPublisher & ShellStatusFeed {
  const schedule = deps.schedule ?? queueMicrotask;
  const limiter = createRateLimiter(deps.clock, 60_000);
  const sessions = new Set<string>();
  const projects = new Map<string, { ownerId: string; projectId: string }>();
  const counts = new Set<string>();
  const statusListeners = new Set<(ownerId: string, sessionId: string) => void>();
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
  // A listener that throws is logged and the next one still runs; the set is bounded by the daemon's wiring.
  const tellStatus = (ownerId: string, sessionId: string) => {
    for (const listener of [...statusListeners]) {
      try {
        listener(ownerId, sessionId);
      } catch (error) {
        deps.logger.warn("session_status_listener_failed", { err: error });
      }
    }
  };
  const flush = () => {
    armed = false;
    for (const id of [...sessions]) {
      sessions.delete(id);
      each("session", () => {
        const found = deps.summary(id);
        if (!found) return;
        deps.hub.publish("shell", found.ownerId, { kind: "session", session: found.session });
        tellStatus(found.ownerId, id);
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
    onStatus(listener) {
      statusListeners.add(listener);
      return () => void statusListeners.delete(listener);
    },
  };
}
