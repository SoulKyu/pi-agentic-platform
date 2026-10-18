import type { EnabledOp, ModelsOverview } from "@pap/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { reportClientIssue } from "../../../lib/report.ts";
import { getRuntime } from "../../../runtime/index.ts";
import { refreshExtensions } from "../extension-read.ts";
import { readOnlyPath, writeFailureText } from "../models.vm.ts";
import { isStale, parseAvailable, type AvailableState } from "../picker/use-available-models.ts";
import { useModelWrites } from "../use-model-writes.ts";
import { modeOf } from "./availability.vm.ts";

const LOADING: AvailableState = { status: "loading" };

interface Reads {
  /** Bumped by every request: an answer counts only while this is still the number it started under. */
  wanted: number;
  running: boolean;
  alive: boolean;
}

/** The key a write is tracked under: the one `ModelsSection` uses for the same switch. */
const keyOf = (op: EnabledOp): string =>
  op.op === "toggle" ? `m:${op.provider}/${op.modelId}` : op.op === "provider" ? `p:${op.provider}` : op.op;

/**
 * `models.available` for the Settings scope, one read in flight per view: a request while a read runs waits and
 * becomes at most one trailing read, so rapid clicks cannot fill the helper pool (carry of task 3). An answer counts
 * only when no newer request was made since its read started, so an older read never replaces the result of a later
 * write's reload (MP-RT-14, as `use-overview.ts` drops an answer for a gone screen). The last good list stays on
 * screen while the next one loads.
 */
function usePreview(): { state: AvailableState; request(): void } {
  const [state, setState] = useState<AvailableState>(LOADING);
  const reads = useRef<Reads>({ wanted: 0, running: false, alive: true });
  const start = useRef<() => void>(() => {});

  const request = useCallback(() => {
    reads.current.wanted += 1;
    start.current();
  }, []);

  useEffect(() => {
    const now = reads.current;
    now.alive = true;
    start.current = () => {
      if (now.running || !now.alive) return;
      now.running = true;
      const mine = now.wanted;
      const settled = (next: AvailableState) => {
        if (now.alive && now.wanted === mine) setState(next);
      };
      getRuntime()
        .rpc.call("models.available", {})
        .then(
          (answer) => {
            const ready = parseAvailable(answer);
            if (ready === null) reportClientIssue("setting_load_failed");
            settled(ready ?? { status: "failed", stale: false, reload: request });
          },
          (error: unknown) => {
            reportClientIssue("setting_load_failed");
            settled({ status: "failed", stale: isStale(error), reload: request });
          },
        )
        .finally(() => {
          now.running = false;
          if (now.alive && now.wanted !== mine) start.current();
        });
    };
    return () => {
      now.alive = false;
    };
  }, [request]);

  return { state, request };
}

export interface AvailabilitySource {
  readonly value: ModelsOverview;
  reload(): void;
}

/**
 * The availability view's data (task 14): the overview of the Settings screen (its reload is handed in, so the
 * provider list and this view never disagree), the preview, and writes through `models.setEnabled` (no step-up).
 * The preview is read again whenever the overview changes and after every write.
 */
export function useAvailability(overview: AvailabilitySource) {
  const { value, reload: reloadOverview } = overview;
  const preview = usePreview();
  const { request } = preview;
  useEffect(request, [value, request]);

  const path = readOnlyPath(value.enabled);
  const failure = useCallback((error: unknown) => writeFailureText(error, path), [path]);
  // After a write the extensions read in this tab are read again too: their `enabled` and `offered` follow the selection.
  const reload = useCallback(() => {
    reloadOverview();
    request();
    refreshExtensions();
  }, [reloadOverview, request]);
  const writes = useModelWrites(reload, failure);
  const { run } = writes;
  const write = useCallback(
    (op: EnabledOp): Promise<void> =>
      run(keyOf(op), async () => {
        const rpc = getRuntime().rpc;
        await rpc.call("models.setEnabled", { op }, { commandId: rpc.newCommandId() });
        return null;
      }),
    [run],
  );

  return useMemo(
    () => ({
      overview: value,
      available: preview.state,
      mode: modeOf(value.enabled.patterns),
      readOnlyPath: path,
      write,
      reload,
      pending: writes.pending,
      notice: writes.notice,
    }),
    [value, preview.state, path, write, reload, writes.pending, writes.notice],
  );
}
