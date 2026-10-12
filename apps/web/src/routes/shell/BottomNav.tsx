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
import { useLocale, useT, type Locale, type Translate } from "../../i18n/index.ts";

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

/** "1 unread", "2 unread": the plural category comes from the language (French: 0 and 1 are singular). */
function inboxCountLabel(locale: Locale, t: Translate, count: number): string {
  const singular = new Intl.PluralRules(locale).select(count) === "one";
  return t(singular ? "shell.mobile.inboxCountOne" : "shell.mobile.inboxCount", { count });
}

interface BottomNavProps {
  readonly section: MobileSection;
  readonly inboxCount: number;
  onSection(section: MobileSection): void;
}

/** The phone's four sections (DESIGN.md §8). Hidden by styles.css while the keyboard is open. */
export function BottomNav({ section, inboxCount, onSection }: BottomNavProps) {
  const t = useT();
  const locale = useLocale();
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
            "relative flex h-full min-h-11 flex-col items-center justify-center gap-s1 label-hud",
            section === id ? "text-fg" : "text-muted",
            FOCUS_RING,
          )}
        >
          <Icon icon={icon} size={20} />
          <span>{t(label)}</span>
          {id === "inbox" && inboxCount > 0 ? (
            <span className="absolute right-s3 top-s1">
              {" "}
              <Badge count={inboxCount} label={inboxCountLabel(locale, t, inboxCount)} />
            </span>
          ) : null}
        </button>
      ))}
    </nav>
  );
}
