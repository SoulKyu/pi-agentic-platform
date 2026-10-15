import "../../i18n/register-home.ts";
import type { ProjectSummary } from "@pap/contracts";
import { formatCost, Tooltip } from "@pap/ui";
import { Fragment, type ReactNode } from "react";
import { plural, useLocale, useT } from "../../i18n/index.ts";
import { useInboxStore } from "../../stores/inbox-store.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import type { HomeActions, HomeTarget } from "./home-actions.ts";
import { type StatusPart, statusParts } from "./status-line.vm.ts";
import { useSpend } from "./use-spend.ts";

/** A part looks like a link either way: a link when it opens a tab, a button when it opens a drawer (PH10). */
const PART_CLASSES = "rounded-sm text-fg underline focus-ring can-hover:hover:text-agent";

interface Props {
  readonly project: ProjectSummary | null;
  readonly actions: HomeActions;
}

/** §3.3: one line, every part clickable; it reads the stores the shell and the home already feed, and one summary. */
export function StatusLine({ project, actions }: Props) {
  const t = useT();
  const locale = useLocale();
  const lanes = useLaneStore((state) => state.view.lanes);
  const tasks = useTasksStore((state) => state.view.list);
  const unread = useInboxStore((state) => state.view.unread);
  const spend = useSpend();
  const parts = statusParts({ project, lanes: lanes.values(), tasks, unread, spend });
  if (parts.length === 0) return null;

  const link = (target: HomeTarget, children: ReactNode) => (
    <a
      href={actions.href(target)}
      className={PART_CLASSES}
      onClick={(event) => {
        // A modified or non-primary click is the browser's "open in a new tab".
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        actions.open(target);
      }}
    >
      {children}
    </a>
  );
  const show = (part: StatusPart): ReactNode => {
    switch (part.kind) {
      case "lanes":
        return (
          <button type="button" className={PART_CLASSES} onClick={() => actions.openTree()}>
            {plural(locale, "home.status.lanes", part.count)}
          </button>
        );
      case "tasks":
        return link({ kind: "tasks" }, plural(locale, "home.status.tasks", part.count));
      case "inbox":
        return (
          <button type="button" className={PART_CLASSES} onClick={() => actions.openInbox()}>
            {t("home.status.inbox", { count: part.count })}
          </button>
        );
      case "spend": {
        const amount = formatCost(part.usd);
        const shown = part.none
          ? t("home.status.noSpend")
          : t(part.apiEquivalent ? "home.status.spendApi" : "home.status.spend", { amount });
        return (
          <Tooltip label={t("home.status.spendScope")}>
            {link(
              { kind: "settings", section: "automation" },
              <>
                {shown}
                <span className="sr-only"> {t("home.status.spendScope")}</span>
              </>,
            )}
          </Tooltip>
        );
      }
    }
  };
  return (
    <div
      role="group"
      aria-label={t("home.status.label")}
      data-home-status=""
      className="flex flex-wrap items-center gap-s1 text-ui text-muted"
    >
      {parts.map((part, index) => (
        <Fragment key={part.kind}>
          {index > 0 ? <span aria-hidden="true">{"·"}</span> : null}
          {show(part)}
        </Fragment>
      ))}
    </div>
  );
}
