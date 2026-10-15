import { IconButton, IconInbox } from "@pap/ui";
import { useState } from "react";
import { runCommand } from "../../features/commands/index.ts";
import { useT } from "../../i18n/index.ts";
import { useInboxStore } from "../../stores/inbox-store.ts";

/**
 * The top bar's Inbox button (DESIGN §9.1): a pink count of the questions waiting for an answer; with none and some unread
 * items, a small neutral dot. The count is in the accessible name, since the badge is a picture of it.
 */
export function InboxButton({
  shortcut,
  joiner,
}: {
  readonly shortcut: readonly string[];
  readonly joiner: "" | "+";
}) {
  const t = useT();
  const toHandle = useInboxStore((state) => state.view.toHandle);
  const unread = useInboxStore((state) => state.view.unread);
  const loaded = useInboxStore((state) => state.view.loaded);
  // A polite live region says a question that arrives, once; a refresh that changes nothing, a count going down and the
  // first snapshot stay silent. Adjusting state while rendering, not in an effect.
  const level = loaded ? toHandle : null;
  const [seen, setSeen] = useState(level);
  const [arrived, setArrived] = useState<number | null>(null);
  if (seen !== level) {
    setSeen(level);
    setArrived(seen !== null && level !== null && level > seen ? level : null);
  }
  const dot = toHandle === 0 && unread > 0;
  const label =
    toHandle > 0
      ? t("shell.top.inboxToHandle", { count: toHandle })
      : dot
        ? t("shell.top.inboxUnread")
        : t("shell.top.inbox");
  return (
    <span className="relative inline-flex">
      <IconButton
        icon={IconInbox}
        label={label}
        shortcut={shortcut}
        shortcutJoiner={joiner}
        badge={{ count: toHandle, label }}
        onClick={() => void runCommand("drawer.inbox.toggle")}
      />
      <span role="status" aria-live="polite" className="sr-only">
        {arrived === null ? "" : t("shell.top.inboxNew", { count: arrived })}
      </span>
      {dot ? (
        <span
          aria-hidden
          data-slot="inbox-dot"
          className="pointer-events-none absolute right-s1 top-s1 size-s2 rounded-full bg-muted"
        />
      ) : null}
    </span>
  );
}
