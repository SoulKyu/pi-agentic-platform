import type { LaneView } from "@pap/contracts";
import { useCallback, useEffect, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";

export interface ArchivedLanes {
  readonly lanes: readonly LaneView[];
  /** The last `lanes.listArchived` call failed: the list lacks the archived lanes until `retry` succeeds. */
  readonly failed: boolean;
  readonly retry: () => void;
}

/**
 * The first page of archived lanes (`lanes.listArchived`), asked once when the home mounts and again on `retry` (a click,
 * never a timer): Recent work lists them and groups their fan-outs (§3.4). The newest archives come first; older ones
 * stay on the tree's shelf. An answer that arrives after unmount or after a newer call is dropped.
 */
export function useArchivedLanes(): ArchivedLanes {
  const [lanes, setLanes] = useState<readonly LaneView[]>([]);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    getRuntime()
      .rpc.call("lanes.listArchived", {})
      .then(
        (page) => {
          if (!current) return;
          if (Array.isArray(page.lanes)) setLanes(page.lanes);
          setFailed(false);
        },
        () => {
          if (current) setFailed(true);
        },
      );
    return () => {
      current = false;
    };
  }, [attempt]);
  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  return { lanes, failed, retry };
}
