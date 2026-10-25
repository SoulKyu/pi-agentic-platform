import type { FireView } from "@pap/contracts";
import { Button, Chip, Heading, InlineError, Segmented } from "@pap/ui";
import { useEffect, useState } from "react";
import { useLocale, useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import {
  costText,
  cursorOf,
  detailText,
  durationText,
  keeps,
  mergePage,
  verdictLabel,
  verdictTone,
  whenText,
  type JournalFilter,
} from "./journal.vm.ts";

interface FireJournalProps {
  readonly triggerId: string;
  /** Bumped when a fire happened here: the first page is read again. */
  readonly refreshKey: number;
  onOpenSession(sessionId: string): void;
}

type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly entries: readonly FireView[]; readonly hasMore: boolean };

/** The journal of fires (board 11 §1, bottom): newest first, repeats collapsed by the daemon, filters, "Load more". */
export function FireJournal({ triggerId, refreshKey, onOpenSession }: FireJournalProps) {
  const t = useT();
  const locale = useLocale();
  const tasks = useTasksStore((state) => state.view.list);
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [filter, setFilter] = useState<JournalFilter>("all");
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let current = true;
    getRuntime()
      .rpc.call("automation.journal", { triggerId })
      .then(
        (page) => {
          if (current)
            setLoaded({ kind: "ready", entries: page.entries ?? [], hasMore: page.hasMore === true });
        },
        () => {
          if (current) setLoaded({ kind: "failed" });
        },
      );
    return () => {
      current = false;
    };
  }, [triggerId, refreshKey]);

  const more = () => {
    if (loaded.kind !== "ready") return;
    const before = cursorOf(loaded.entries);
    if (before === undefined) return;
    getRuntime()
      .rpc.call("automation.journal", { triggerId, before })
      .then(
        (page) =>
          setLoaded((previous) =>
            previous.kind === "ready"
              ? { kind: "ready", entries: mergePage(previous.entries, page.entries), hasMore: page.hasMore }
              : previous,
          ),
        () => setLoaded({ kind: "failed" }),
      );
  };

  const sessionOf = (taskId: string | null): string | null =>
    taskId === null ? null : (tasks.find((task) => task.id === taskId)?.sessionId ?? null);

  return (
    <section data-slot="fire-journal" className="flex flex-col gap-s2 border-t border-border">
      <div className="flex flex-wrap items-center gap-s3 px-s3 pt-s2">
        <Heading level={3} variant="card" tone="agent">
          {t("automation.journal.title")}
        </Heading>
        <Segmented<JournalFilter>
          label={t("automation.journal.filter")}
          labelHidden
          value={filter}
          options={[
            { value: "all", label: t("automation.journal.all") },
            { value: "fired", label: t("automation.journal.fired") },
            { value: "refused", label: t("automation.journal.refused") },
          ]}
          onChange={setFilter}
        />
      </div>
      {loaded.kind === "failed" ? (
        <div className="px-s3">
          <InlineError announce="background">{t("automation.journal.failed")}</InlineError>
        </div>
      ) : null}
      {loaded.kind === "ready" && loaded.entries.length === 0 ? (
        <p className="px-s3 text-ui text-muted">{t("automation.journal.empty")}</p>
      ) : null}
      {loaded.kind === "ready" && loaded.entries.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-ui">
            <thead>
              <tr className="border-b border-border text-left">
                {(["when", "verdict", "detail", "task", "duration", "cost"] as const).map((column) => (
                  <th key={column} scope="col" className="label-hud px-s3 py-s1 text-muted">
                    {t(`automation.journal.${column}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loaded.entries
                .filter((entry) => keeps(entry, filter))
                .map((entry) => {
                  const session = sessionOf(entry.taskId);
                  return (
                    <tr key={entry.id} className="border-b border-border align-top">
                      <td className="whitespace-nowrap px-s3 py-s1 font-mono text-code text-muted tabular-nums">
                        {whenText(entry, now, locale)}
                      </td>
                      <td className="px-s3 py-s1">
                        <Chip tone={verdictTone(entry.verdict)} label={verdictLabel(entry)} />
                      </td>
                      <td className="min-w-0 break-words px-s3 py-s1 text-fg">{detailText(entry)}</td>
                      <td className="px-s3 py-s1 font-mono text-code text-muted">
                        {entry.taskId === null ? (
                          "—"
                        ) : (
                          <span className="flex flex-wrap items-center gap-s1">
                            {entry.taskId.slice(0, 12)}
                            {entry.taskState === null
                              ? null
                              : ` · ${t(`automation.state.${entry.taskState}`)}`}
                            {session === null ? null : (
                              <Button size="sm" variant="ghost" onClick={() => onOpenSession(session)}>
                                {t("automation.journal.open")}
                              </Button>
                            )}
                          </span>
                        )}
                      </td>
                      <td className="px-s3 py-s1 font-mono text-code text-muted tabular-nums">
                        {durationText(entry)}
                      </td>
                      <td className="px-s3 py-s1 font-mono text-code text-muted tabular-nums">
                        {costText(entry)}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      ) : null}
      {loaded.kind === "ready" && loaded.hasMore ? (
        <div className="px-s3 pb-s2">
          <Button onClick={more}>{t("automation.journal.more")}</Button>
        </div>
      ) : null}
    </section>
  );
}
