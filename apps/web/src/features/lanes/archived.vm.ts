import type { LaneView } from "@pap/contracts";
import { useCallback, useEffect, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";

export interface ArchivedList {
  readonly lanes: readonly LaneView[];
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly failed: boolean;
  /** Reads the next page (the first when nothing is listed yet), or the same one again after a failure. */
  more(): void;
}

/** `lanes.listArchived` page by page: each page starts after the last row's `(archivedAt, id)`. */
export function useArchivedLanes(enabled: boolean): ArchivedList {
  const [lanes, setLanes] = useState<readonly LaneView[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(enabled);
  const [failed, setFailed] = useState(false);

  // The first page loads from the initial state (`loading`), so the effect sets nothing before the answer.
  const fetchPage = useCallback((after: LaneView | undefined) => {
    const before =
      after?.archivedAt == null ? {} : { before: { archivedAt: after.archivedAt, id: after.id } };
    getRuntime()
      .rpc.call("lanes.listArchived", before)
      .then(
        (page) => {
          setLanes((was) => [
            ...was,
            ...page.lanes.filter((lane) => !was.some((held) => held.id === lane.id)),
          ]);
          setHasMore(page.hasMore);
          setLoading(false);
        },
        () => {
          setFailed(true);
          setLoading(false);
        },
      );
  }, []);
  useEffect(() => {
    if (enabled) fetchPage(undefined);
  }, [enabled, fetchPage]);
  const more = () => {
    setLoading(true);
    setFailed(false);
    fetchPage(lanes.at(-1));
  };
  return { lanes, hasMore, loading, failed, more };
}
