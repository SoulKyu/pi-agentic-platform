import { OverviewSnapshot } from "@pap/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime } from "../../runtime/index.ts";

interface Load {
  readonly snapshot: OverviewSnapshot | null;
  readonly failed: boolean;
  /** When the snapshot landed (epoch ms): the pane's "now" for "tomorrow", fixed until the next read. */
  readonly readAt: number;
}

/**
 * `overview.get`, read on mount and once per tick of the `overview` stream (R2). One read at a time: a tick that comes
 * while a read is out waits for it and costs one more read after it, however many came. `reload` starts a read now and
 * replaces any still in flight (the stale-read guard of `use-agent-status.ts`: the newest answer wins). A failed re-read
 * keeps the last snapshot, with `failed`.
 */
export function useBoxesSnapshot(): Load & { reload(): void } {
  const [load, setLoad] = useState<Load>({ snapshot: null, failed: false, readAt: 0 });
  const control = useRef<() => void>(() => undefined);

  useEffect(() => {
    let latest = 0;
    let reading = false;
    let tickedMeanwhile = false;
    const read = () => {
      latest += 1;
      const mine = latest;
      reading = true;
      tickedMeanwhile = false;
      getRuntime()
        .rpc.call("overview.get", {})
        .then((raw) => {
          const snapshot = OverviewSnapshot.parse(raw);
          if (mine === latest) setLoad({ snapshot, failed: false, readAt: Date.now() });
        })
        .catch(() => {
          reportClientIssue("overview_read_failed");
          if (mine === latest) setLoad((previous) => ({ ...previous, failed: true }));
        })
        .finally(() => {
          if (mine !== latest) return;
          reading = false;
          if (tickedMeanwhile) read();
        });
    };
    control.current = read;
    const stop = getRuntime().subscriptions.subscribe(
      "overview",
      "me",
      () => {
        if (reading) tickedMeanwhile = true;
        else read();
      },
      () => reportClientIssue("overview_stream_failed"),
    );
    read();
    return () => {
      latest += 1;
      stop();
      control.current = () => undefined;
    };
  }, []);

  const reload = useCallback(() => control.current(), []);
  return { ...load, reload };
}
