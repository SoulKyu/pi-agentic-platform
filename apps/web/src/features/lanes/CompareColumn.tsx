import "./register-compare-catalog.ts";
import { Button, Chip, InlineError } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import type { ColumnModel } from "./compare.vm.ts";
import { TaintedConfirm } from "./TaintedConfirm.tsx";
import { useRunTests } from "./use-compare.ts";

interface Props {
  readonly model: ColumnModel;
  onView(): void;
  onPick(): void;
}

function Figure({
  label,
  value,
  note,
}: {
  readonly label: string;
  readonly value: string;
  readonly note?: string | undefined;
}) {
  return (
    <>
      <dt className="text-ui text-muted">{label}</dt>
      <dd className="text-right font-mono text-code tabular-nums text-fg">
        {value}
        {note === undefined ? null : <span className="font-sans text-muted"> {note}</span>}
      </dd>
    </>
  );
}

/**
 * One lane of the fan-out (board 10 §2): its model, branch and tests chip, the figures, the summary as plain text, and
 * the actions. The picked winner is outlined in the you colour; nothing ranks the columns (decision 30).
 */
export function CompareColumn({ model, onView, onPick }: Props) {
  const t = useT();
  const tests = useRunTests(model.laneId);
  const unknown = "—";
  return (
    <section
      data-lane={model.laneId}
      data-winner={model.winner}
      aria-label={t("compare.column.title", {
        letter: model.letter,
        model: model.model ?? t("compare.model.default"),
      })}
      className={`flex min-w-0 flex-col rounded-md bg-surface ${model.winner ? "border-2 border-you" : "border border-border-strong"}`}
    >
      <header className="flex flex-wrap items-center gap-s2 border-b border-border p-s2">
        <h2 className="min-w-0 truncate text-ui font-bold text-fg">
          {t("compare.column.title", {
            letter: model.letter,
            model: model.model ?? t("compare.model.default"),
          })}
        </h2>
        <span className="min-w-0 truncate font-mono text-code text-muted">{model.branch}</span>
        <span className="ml-auto flex items-center gap-s1">
          {model.winner ? <Chip tone="you" label={t("compare.winner")} /> : null}
          <Chip tone={model.chip.tone} label={t(model.chip.key, { code: model.chip.code ?? 0 })} />
        </span>
      </header>
      <dl className="grid grid-cols-2 gap-x-s3 gap-y-s1 p-s2">
        <Figure label={t("compare.diff")} value={model.diff ?? unknown} />
        <Figure label={t("compare.files")} value={model.files ?? unknown} />
        <Figure
          label={t("compare.duration")}
          value={model.duration ?? (model.running ? t("compare.duration.running") : unknown)}
        />
        <Figure
          label={t("compare.cost")}
          value={model.cost ?? t("compare.cost.none")}
          note={model.apiEquivalent && model.cost !== null ? t("compare.cost.apiEquivalent") : undefined}
        />
      </dl>
      <p className="flex-1 whitespace-pre-wrap break-words border-t border-border p-s2 text-ui text-muted">
        {model.summary === null || model.summary === "" ? t("compare.summary.none") : model.summary}
      </p>
      {tests.tainted ? (
        <div className="border-t border-border p-s2">
          <TaintedConfirm busy={tests.busy} onConfirm={() => tests.run(true)} onCancel={tests.cancel} />
        </div>
      ) : null}
      {tests.problem !== null ? (
        <div className="border-t border-border p-s2">
          <InlineError announce="action">{t(tests.problem)}</InlineError>
        </div>
      ) : null}
      <footer className="flex flex-wrap items-center gap-s2 border-t border-border p-s2">
        <Button size="sm" data-view onClick={onView}>
          {t("compare.viewDiff")}
        </Button>
        {model.runTests ? (
          <Button size="sm" data-run-tests disabled={tests.busy || tests.tainted} onClick={() => tests.run()}>
            {t("compare.runTests")}
          </Button>
        ) : null}
        <span className="ml-auto">
          <Button
            size="sm"
            variant={model.winner ? "primary" : "secondary"}
            aria-pressed={model.winner}
            data-pick
            onClick={onPick}
          >
            {t("compare.pick")}
          </Button>
        </span>
      </footer>
    </section>
  );
}
