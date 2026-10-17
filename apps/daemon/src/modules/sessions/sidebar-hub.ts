import type { ShellStreamEvent } from "@pap/contracts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import type { SessionsStore } from "./store.ts";

/**
 * The hub the shell publisher writes to. The sessions of agents belong to the agent, not to the sidebar (M11R56): their
 * `session` events are not published to the shell stream. The attention feed wraps this hub and still sees them, so an open
 * question reaches the Inbox (M10R33).
 */
export function createSidebarHub(
  store: Pick<SessionsStore, "get">,
  hub: Pick<StreamHub, "publish">,
): Pick<StreamHub, "publish"> {
  return {
    publish(stream, key, event) {
      const shell = event as ShellStreamEvent;
      if (
        stream === "shell" &&
        shell.kind === "session" &&
        store.get(shell.session.id)?.agentId !== undefined
      )
        return;
      hub.publish(stream, key, event);
    },
  };
}
