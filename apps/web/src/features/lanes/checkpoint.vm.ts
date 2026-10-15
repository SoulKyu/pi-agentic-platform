import type { ResultOf } from "@pap/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageKey } from "../../i18n/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime } from "../../runtime/index.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { failureKey } from "./failure-text.ts";

type CheckpointStatus = ResultOf<"lanes.checkpointStatus">;

/** The daemon snapshots the tree to answer, so the banner asks at most once a second and only while the session is idle. */
export const CHECKPOINT_THROTTLE_MS = 1000;

const REFUSED = {
  busy: "lanes.checkpoint.busy",
  no_checkpoint: "lanes.checkpoint.none",
  failed: "lanes.checkpoint.failed",
} as const satisfies Record<string, MessageKey>;

/** The paths a restore left in place that the banner names; the rest is only counted (M9 sweep, item 12). */
export const LEFT_SHOWN = 5;

export interface LeftInPlace {
  readonly total: number;
  readonly paths: readonly string[];
}

export interface Checkpoint {
  readonly status: CheckpointStatus | null;
  readonly visible: boolean;
  readonly asking: boolean;
  readonly working: boolean;
  readonly note: MessageKey | null;
  readonly left: LeftInPlace | null;
  readonly canUndo: boolean;
  ask(): void;
  cancel(): void;
  restore(): void;
  undo(): void;
  dismiss(): void;
}

/**
 * M9R64: `lanes.checkpointStatus` runs while the session is idle (on a leaf change, on focus), never during a run, and
 * the last answer stays on screen through a run. Restore asks first, without a count; Undo follows a restore.
 */
export function useCheckpoint(laneId: string, sessionId: string): Checkpoint {
  const view = useSessionStore((state) => state.views[sessionId]);
  const idle = view?.status === "idle";
  const leafId = view?.leafId ?? null;
  const idleNow = useRef(idle);
  useEffect(() => {
    idleNow.current = idle;
  }, [idle]);
  const [status, setStatus] = useState<CheckpointStatus | null>(null);
  const [asking, setAsking] = useState(false);
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState<MessageKey | null>(null);
  const [left, setLeft] = useState<LeftInPlace | null>(null);
  const [restored, setRestored] = useState(false);
  const lastAt = useRef(Number.NEGATIVE_INFINITY);
  const askedLeaf = useRef<string | null | undefined>(undefined);
  const timer = useRef<number | null>(null);

  const load = useCallback(() => {
    lastAt.current = Date.now();
    return getRuntime()
      .rpc.call("lanes.checkpointStatus", { laneId, sessionId })
      .then(
        (answer) => setStatus(answer),
        () => reportClientIssue("command_failed"), // the last answer stays; the next trigger asks again
      );
  }, [laneId, sessionId]);

  const refresh = useCallback(() => {
    const wait = lastAt.current + CHECKPOINT_THROTTLE_MS - Date.now();
    if (wait <= 0) {
      void load();
      return;
    }
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (idleNow.current) void load();
    }, wait);
  }, [load]);

  useEffect(() => {
    if (!idle || askedLeaf.current === leafId) return;
    askedLeaf.current = leafId;
    refresh();
  }, [idle, leafId, refresh]);

  useEffect(() => {
    const onFocus = () => {
      if (idleNow.current) refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [refresh]);

  const run = async (params: { sessionId: string } | { undo: true }) => {
    if (working) return;
    setWorking(true);
    setAsking(false);
    setLeft(null);
    try {
      const { rpc } = getRuntime();
      const answer = await rpc.call(
        "lanes.restore",
        { laneId, ...params },
        { commandId: rpc.newCommandId() },
      );
      if (!answer.ok) setNote(REFUSED[answer.reason]);
      else if ("undo" in params) {
        setRestored(false);
        setNote(null);
      } else {
        setRestored(answer.changed);
        setNote(answer.changed ? "lanes.checkpoint.restored" : "lanes.checkpoint.same");
        const kept = answer.left ?? [];
        if (answer.changed && kept.length > 0) {
          setLeft({
            total: answer.leftTotal ?? kept.length,
            paths: kept.slice(0, LEFT_SHOWN).map((entry) => entry.path),
          });
        }
      }
      await load();
    } catch (failure) {
      setNote(failureKey(failure, "lanes.checkpoint.failed"));
    } finally {
      setWorking(false);
    }
  };

  const canUndo = status?.undoAvailable === true;
  return {
    status,
    visible: status?.differs === true || note !== null || (restored && canUndo),
    asking,
    working,
    note,
    left,
    canUndo,
    ask: () => setAsking(true),
    cancel: () => setAsking(false),
    restore: () => void run({ sessionId }),
    undo: () => void run({ undo: true }),
    dismiss: () => {
      setNote(null);
      setLeft(null);
      setRestored(false);
    },
  };
}
