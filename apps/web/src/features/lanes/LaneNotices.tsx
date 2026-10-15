import "./register-lanes-catalog.ts";
import type { LaneView } from "@pap/contracts";
import { Button, IconButton, IconClose } from "@pap/ui";
import { create } from "zustand";
import { plural, useLocale, useT } from "../../i18n/index.ts";
import { noticeModels } from "./lane-header.vm.ts";

interface Dismissed {
  readonly ids: ReadonlySet<string>;
  dismiss(id: string): void;
}

/** Notices the person closed, for this browser session: they live in the daemon's memory, so a reload shows them again. */
export const useDismissedLaneNotices = create<Dismissed>()((set) => ({
  ids: new Set(),
  dismiss: (id) => set((state) => ({ ids: new Set(state.ids).add(id) })),
}));

/** One muted line each, newest first (M9R65). */
export function LaneNotices({
  laneId,
  notices,
  onStartSession,
}: {
  readonly laneId: string;
  readonly notices: LaneView["notices"];
  onStartSession(): void;
}) {
  const t = useT();
  const locale = useLocale();
  const ids = useDismissedLaneNotices((state) => state.ids);
  const dismiss = useDismissedLaneNotices((state) => state.dismiss);
  const shown = noticeModels(notices).filter((notice) => !ids.has(`${laneId}:${notice.id}`));
  if (shown.length === 0) return null;
  return (
    <ul className="flex flex-col gap-s1">
      {shown.map((notice) => (
        <li key={notice.id} data-lane-notice className="flex items-center gap-s2 text-ui text-muted">
          <span className="min-w-0 flex-1">
            {notice.plural !== null && notice.count !== null
              ? plural(locale, notice.plural as Parameters<typeof plural>[1], notice.count)
              : t(notice.key)}
          </span>
          {notice.startSession ? (
            <Button size="sm" onClick={onStartSession}>
              {t("lanes.notice.startSession")}
            </Button>
          ) : null}
          <IconButton
            icon={IconClose}
            size="sm"
            label={t("lanes.notice.dismiss")}
            onClick={() => dismiss(`${laneId}:${notice.id}`)}
          />
        </li>
      ))}
    </ul>
  );
}
