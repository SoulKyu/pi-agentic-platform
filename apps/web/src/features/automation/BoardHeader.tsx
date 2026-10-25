import type { TasksCounts } from "@pap/contracts";
import { Chip, InlineError, Switch, usePendingAction } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { usePauseReread } from "../../lib/use-pause-reread.ts";
import { getRuntime } from "../../runtime/index.ts";
import { budgetText, quietNow } from "./board.vm.ts";
import { writePaused } from "./pause-setting.ts";

/** "Tasks · n / slots running · n queued · Today $x / $budget", the quiet-hours chip and the global pause (board 11 §2). */
export function BoardHeader({ counts }: { readonly counts: TasksCounts }) {
  const t = useT();
  const pending = usePendingAction();
  const [failed, setFailed] = useState(false);
  // What the last successful write set, good only while the stream still says what it said before the write.
  const [written, setWritten] = useState<{ readonly was: boolean; readonly paused: boolean } | null>(null);
  const paused = written !== null && written.was === counts.paused ? written.paused : counts.paused;
  // The stream moved on from what the write saw (another tab changed it): the overlay is over.
  if (written !== null && written.was !== counts.paused) setWritten(null);
  usePauseReread((stored) => setWritten({ was: counts.paused, paused: stored }));

  const setPaused = (next: boolean) =>
    void pending.run(async () => {
      setFailed(false);
      try {
        await writePaused(getRuntime().rpc, next);
        setWritten({ was: counts.paused, paused: next });
      } catch {
        setFailed(true);
      }
    });

  return (
    <header data-slot="board-header" className="flex flex-col gap-s2 border-b border-border px-s3 py-s2">
      <div className="flex flex-wrap items-center gap-s2">
        <h1 className="text-h2 text-fg">{t("automation.board.title")}</h1>
        <Chip
          tone={counts.running > 0 ? "run" : "mut"}
          label={t("automation.board.running", { running: counts.running, slots: counts.slots })}
        />
        <Chip tone="mut" label={t("automation.board.queued", { count: counts.queued })} />
        <span className="font-mono text-label text-muted tabular-nums">{budgetText(counts)}</span>
        {quietNow(counts) ? <Chip tone="mut" label={t("automation.board.quiet")} /> : null}
        <span className="flex-1" />
        <Switch
          label={t("automation.board.pause")}
          hint={t("automation.board.pauseHint")}
          checked={paused}
          disabled={pending.since !== null}
          onChange={setPaused}
        />
      </div>
      {failed ? <InlineError announce="action">{t("automation.board.pauseFailed")}</InlineError> : null}
    </header>
  );
}
