import "./register-compare-catalog.ts";
import { Button, EmptyState, useIsPhone } from "@pap/ui";
import { useState } from "react";
import { getLocale, useT } from "../../i18n/index.ts";
import { escapeHidden } from "../../lib/escape-hidden.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { useComparePick } from "./compare-pick.ts";
import { agoText, columnModels, losersOf, runAgainPrefill, type RunAgainPrefill } from "./compare.vm.ts";
import { CompareColumn } from "./CompareColumn.tsx";
import { CloseLosersDialog } from "./CloseLosersDialog.tsx";
import { showReview } from "./lane-layout.ts";
import { laneSignature, useCompare } from "./use-compare.ts";

interface Props {
  readonly fanoutId: string;
  /** Opens a lane's tab (the shell owns tabs). */
  onOpenLane(laneId: string): void;
  /** Opens the new lane dialog with the group's prompt and models. */
  onRunAgain(prefill: RunAgainPrefill): void;
  /** The clock of the confirmation guard and of "started … ago"; tests give their own. */
  readonly now?: () => number;
}

/** The prompt shows this many characters, then "Show all": the stored prompt can hold a whole fenced issue. */
const PROMPT_PREVIEW = 600;
/** Columns on a wide screen: equal widths, two rows of two for four lanes. */
const COLUMNS: Readonly<Record<number, string>> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3" };

/**
 * The compare tab (board 10 §2, M9R96): one column per lane of a fan-out, the prompt, Run again and Close losers.
 * Nothing here ranks or recommends a column (decision 30): the owner picks.
 */
export function CompareScreen({ fanoutId, onOpenLane, onRunAgain, now }: Props) {
  const t = useT();
  const phone = useIsPhone();
  const view = useLaneStore((state) => state.view);
  const winnerId = useComparePick((state) => state.winners[fanoutId] ?? null);
  const [closing, setClosing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [startedAt] = useState(() => (now ?? Date.now)());
  const fanout = view.fanouts.get(fanoutId);
  const live = (fanout?.laneIds ?? []).flatMap((id) => view.lanes.get(id) ?? []);
  const { columns, error, reload } = useCompare(fanoutId, fanout !== undefined, laneSignature(live));

  if (fanout === undefined) {
    return view.loaded ? (
      <EmptyState title={t("compare.gone.title")} purpose={t("compare.gone")} />
    ) : (
      <p className="p-s4 text-ui text-muted">{t("compare.loading")}</p>
    );
  }
  const winner = winnerId !== null && live.some((lane) => lane.id === winnerId) ? winnerId : null;
  const models = columnModels(fanout, view.lanes, columns ?? [], winner);
  const winnerModel = models.find((model) => model.winner);
  const losers = losersOf(models);
  const prompt = escapeHidden(fanout.prompt);
  const longPrompt = prompt.length > PROMPT_PREVIEW;
  const prefill = runAgainPrefill(fanout, view.lanes);

  const viewDiff = (laneId: string) => {
    showReview(laneId);
    onOpenLane(laneId);
  };
  const pick = (laneId: string) => {
    useComparePick.getState().pick(fanoutId, laneId);
    onOpenLane(laneId);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <header className="flex flex-col gap-s2 border-b border-border p-s3">
        <div className="flex flex-wrap items-center gap-s2">
          <p className="label-hud text-muted">
            {t("compare.header", {
              count: fanout.laneIds.length,
              ago: agoText(fanout.createdAt, startedAt, getLocale()),
            })}
          </p>
          <span className="ml-auto flex flex-wrap items-center gap-s2">
            <Button size="sm" disabled={prefill === null} onClick={() => prefill && onRunAgain(prefill)}>
              {t("compare.runAgain")}
            </Button>
            <Button
              size="sm"
              aria-describedby={winnerModel === undefined ? "compare-close-hint" : undefined}
              disabled={winnerModel === undefined || losers.length === 0}
              onClick={() => setClosing(true)}
            >
              {t("compare.closeLosers")}
            </Button>
          </span>
        </div>
        <p
          aria-label={t("compare.prompt")}
          className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-ui text-fg"
        >
          {expanded || !longPrompt ? prompt : `${prompt.slice(0, PROMPT_PREVIEW)}…`}
        </p>
        {longPrompt ? (
          <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)}>
            {expanded ? t("compare.prompt.less") : t("compare.prompt.more")}
          </Button>
        ) : null}
        {winnerModel === undefined ? (
          <p id="compare-close-hint" className="text-code text-dim">
            {t("compare.closeLosers.hint")}
          </p>
        ) : null}
      </header>
      {error !== null ? (
        <div role="alert" className="flex flex-wrap items-center gap-s2 p-s3 text-ui text-attn">
          <span>{t(error)}</span>
          <Button size="sm" onClick={reload}>
            {t("compare.retry")}
          </Button>
        </div>
      ) : null}
      <div
        role="group"
        aria-label={t("compare.columns")}
        className={`grid gap-s3 p-s3 ${phone ? "grid-cols-1" : (COLUMNS[models.length] ?? "grid-cols-2")}`}
      >
        {models.map((model) => (
          <CompareColumn
            key={model.laneId}
            model={model}
            onView={() => viewDiff(model.laneId)}
            onPick={() => pick(model.laneId)}
          />
        ))}
      </div>
      {closing && winnerModel !== undefined ? (
        <CloseLosersDialog
          fanoutId={fanoutId}
          winner={winnerModel}
          losers={losers}
          now={now}
          onClose={() => setClosing(false)}
        />
      ) : null}
    </div>
  );
}
