import type { PushTarget } from "@pap/contracts";
import type { InboxView } from "../../stores/inbox-reducer.ts";
import type { ShellView } from "../../stores/shell-reducer.ts";

/**
 * Where a notification leads. The ids are the daemon's and stay data: the shell turns a destination into a page it
 * knows (and refuses an id it does not take), the landing never builds a URL from them (M12R33).
 */
export type Destination =
  | { readonly kind: "session" | "agent"; readonly id: string }
  | { readonly kind: "settings"; readonly section: "automation" | "notifications" }
  | { readonly kind: "inbox"; readonly itemId: string | null };

const SETTINGS = ["automation", "notifications"] as const;

export function destinationOf(target: PushTarget): Destination | null {
  const { kind, id } = target;
  switch (kind) {
    case "session":
    case "agent":
      return id === null || id === "" ? null : { kind, id };
    case "settings": {
      const section = id === null ? "notifications" : SETTINGS.find((one) => one === id);
      return section === undefined ? null : { kind: "settings", section };
    }
    case "inbox":
      return { kind: "inbox", itemId: id === "" ? null : id };
  }
}

export interface Streams {
  readonly inbox: Pick<InboxView, "loaded" | "items" | "truncated">;
  readonly shell: Pick<ShellView, "loaded" | "unreadable" | "failed" | "sessions">;
}
export type Verdict = "wait" | "open" | "handled";

/**
 * Whether anything still waits behind the target. A closed or answered target still resolves on the daemon; the
 * page reads its own streams to say "already handled". A stream that cannot say (unreadable, truncated, failed) is
 * never taken for "handled": the person is taken there and looks.
 */
export function verdictOf(destination: Destination, { inbox, shell }: Streams): Verdict {
  if (destination.kind === "inbox") {
    if (destination.itemId === null) return "open";
    if (!inbox.loaded) return "wait";
    const row = inbox.items.find((item) => item.id === destination.itemId);
    if (row === undefined) return inbox.truncated ? "open" : "handled";
    return row.toHandle && row.resolvedAt !== null ? "handled" : "open";
  }
  if (destination.kind !== "session") return "open";
  if (!shell.loaded) return "wait";
  if (shell.unreadable || shell.failed !== null) return "open";
  const session = shell.sessions.get(destination.id);
  return session !== undefined && !session.needsInput ? "handled" : "open";
}
