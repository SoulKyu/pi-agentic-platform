import "./register-lanes-catalog.ts";
import { Button, EmptyState, LoadingLine } from "@pap/ui";
import { errorKey, useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { retryLanes } from "../../stores/lane-feed.ts";
import { useLaneShip } from "../../stores/lane-ship-store.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { CommitBar } from "./CommitBar.tsx";
import { LaneBody, type LanePanes } from "./LaneBody.tsx";

interface Props extends LanePanes {
  readonly laneId: string;
  /** Opens the archived-lanes list (the shell decides where it lives). */
  onOpenArchived(): void;
}

/**
 * The lane tab (M9R62). A lane the store lacks was archived: say so, with a way to the list. The panes come from the
 * shell as render props; the review is a slot Task 19 fills; the commit bar (Task 20) fills its own.
 */
export function LaneScreen({ laneId, onOpenArchived, ...panes }: Props) {
  const t = useT();
  const view = useLaneStore((state) => state.view);
  const lane = view.lanes.get(laneId);
  const { keptBranch } = useLaneShip(laneId);
  if (lane) {
    // The commit bar fills its slot by name; a shell that passes its own `commitBar` wins.
    const commitBar = <CommitBar laneId={lane.id} worktree={lane.worktree} />;
    return <LaneBody key={lane.id} lane={lane} panes={{ commitBar, ...panes }} />;
  }
  if (view.failed !== null) {
    return (
      <EmptyState
        title={t("shell.lane.failed.title")}
        purpose={t(errorKey(view.failed))}
        action={
          <Button variant="secondary" onClick={() => retryLanes(getRuntime().subscriptions)}>
            {t("shell.lane.failed.retry")}
          </Button>
        }
      />
    );
  }
  if (!view.loaded)
    return (
      <div className="p-s4">
        <LoadingLine label={t("shell.lane.loading")} />
      </div>
    );
  return (
    <>
      <EmptyState
        title={t("shell.lane.archived.title")}
        purpose={t("shell.lane.archived.purpose")}
        action={
          <Button variant="secondary" onClick={onOpenArchived}>
            {t("shell.lane.archived.open")}
          </Button>
        }
      />
      {keptBranch !== null ? (
        <p role="status" className="px-s4 text-center text-ui text-attn">
          {t("lanes.archive.branchKept", { branch: keptBranch })}
        </p>
      ) : null}
    </>
  );
}
