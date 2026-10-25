import {
  Badge,
  cn,
  FOCUS_RING,
  Icon,
  IconAgents,
  IconInbox,
  IconLists,
  IconWork,
  type IconGlyph,
} from "@pap/ui";
import { badgeText } from "../../features/agents/rail.vm.ts";
import { useT } from "../../i18n/index.ts";

export type MobileSection = "agents" | "work" | "lists" | "inbox";

const SECTIONS: ReadonlyArray<{
  readonly id: MobileSection;
  readonly icon: IconGlyph;
  readonly label: "shell.mobile.agents" | "shell.mobile.work" | "shell.mobile.lists" | "shell.mobile.inbox";
}> = [
  { id: "agents", icon: IconAgents, label: "shell.mobile.agents" },
  { id: "work", icon: IconWork, label: "shell.mobile.work" },
  { id: "lists", icon: IconLists, label: "shell.mobile.lists" },
  { id: "inbox", icon: IconInbox, label: "shell.mobile.inbox" },
];

interface BottomNavProps {
  readonly section: MobileSection;
  /** Questions waiting for an answer: what the top bar's badge counts too. */
  readonly inboxCount: number;
  /** Unread activity across the agents: the Agents tab's badge (board 05). */
  readonly agentsUnread?: number;
  onSection(section: MobileSection): void;
}

/** The phone's four sections (DESIGN.md §8). Hidden by styles.css while the keyboard is open. */
export function BottomNav({ section, inboxCount, agentsUnread, onSection }: BottomNavProps) {
  const t = useT();
  const unread = agentsUnread ?? 0;
  return (
    <nav
      aria-label={t("shell.mobile.sections")}
      data-slot="bottom-nav"
      className="grid shrink-0 grid-cols-4 border-t border-border bg-bg-side pb-safe"
    >
      {SECTIONS.map(({ id, icon, label }) => (
        <button
          key={id}
          type="button"
          aria-current={section === id ? "page" : undefined}
          onClick={() => onSection(id)}
          className={cn(
            "relative flex h-full min-h-11 flex-col items-center justify-center gap-s1 border-t-2 label-hud",
            section === id ? "border-agent text-fg" : "border-transparent text-muted",
            FOCUS_RING,
          )}
        >
          <Icon icon={icon} size={20} />
          <span>{t(label)}</span>
          {id === "inbox" && inboxCount > 0 ? (
            <span className="absolute right-s3 top-s1">
              {" "}
              <Badge count={inboxCount} label={t("shell.mobile.inboxCount", { count: inboxCount })} />
            </span>
          ) : null}
          {id === "agents" && unread > 0 ? (
            <span className="absolute right-s3 top-s1">
              <Badge count={unread} label={t("shell.agent.unread", { count: badgeText(unread) })} />
            </span>
          ) : null}
        </button>
      ))}
    </nav>
  );
}
