import type { QueueView } from "@pap/contracts";
import { Button } from "@pap/ui";
import { plural, useLocale, useT } from "../../i18n/index.ts";
import { queueMore } from "./queue.vm.ts";

/** What waits in Pi's queue: previews as plain text (they are message text), steering in the human colour, follow-ups dim. */
export function QueueStrip({ queue, onClear }: { queue: QueueView; onClear(): void }) {
  const t = useT();
  const locale = useLocale();
  const more = queueMore(queue);
  if (queue.count === 0 && queue.steering.length === 0 && queue.followUp.length === 0) return null;
  const rows = [
    ...queue.steering.map((preview, index) => ({ key: `steer:${index}`, preview, steering: true })),
    ...queue.followUp.map((preview, index) => ({ key: `follow:${index}`, preview, steering: false })),
  ];
  return (
    <section
      aria-label={t("sessions.queue.title", { count: queue.count })}
      className="flex flex-col gap-1 border-l-2 border-you-line bg-you-tint px-3 py-2"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-label font-semibold uppercase tracking-label text-muted">
          {t("sessions.queue.title", { count: queue.count })}
        </p>
        <Button onClick={onClear}>{t("sessions.queue.clear")}</Button>
      </div>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li
            key={row.key}
            className={row.steering ? "flex gap-2 text-ui text-you-text" : "flex gap-2 text-ui text-muted"}
          >
            <span className="shrink-0 font-mono text-label font-semibold uppercase tracking-label">
              {t(row.steering ? "sessions.queue.steer" : "sessions.queue.followUp")}
            </span>
            <span className="line-clamp-2 min-w-0 whitespace-pre-wrap break-words">{row.preview}</span>
          </li>
        ))}
      </ul>
      {more > 0 ? (
        <p data-queue-more className="text-ui text-muted">
          {plural(locale, "sessions.queue.more", more)}
        </p>
      ) : null}
    </section>
  );
}
