import { Message } from "@pap/ui";
import { t } from "../../i18n/index.ts";
import type { MessageItem, PartialItem, SummaryItem } from "./transcript.vm.ts";

function Thinking({ text }: { text: string }) {
  return (
    <details className="mb-1 text-muted">
      <summary className="cursor-pointer font-mono text-label uppercase tracking-label">
        {t("sessions.transcript.thinking")}
      </summary>
      <p className="mt-1 whitespace-pre-wrap break-words text-ui">{text}</p>
    </details>
  );
}

/** A message, or the reply being written: plain text, the thinking folded above it. */
export function MessageRow({ item }: { item: MessageItem | PartialItem }) {
  const author = item.kind === "partial" ? "agent" : item.author;
  return (
    <Message author={author} label={t(`author.${author}`)}>
      {item.thinking ? <Thinking text={item.thinking} /> : null}
      {item.text}
    </Message>
  );
}

/** A compaction or a branch summary, folded: its text is what the model was given in place of the rows. */
export function SummaryRow({ item }: { item: SummaryItem }) {
  const title =
    item.variant === "compaction"
      ? t("sessions.transcript.compacted", { tokens: item.tokensBefore ?? 0 })
      : t("sessions.transcript.branchSummary");
  return (
    <details data-summary={item.variant} className="border-l-2 border-line bg-bg px-3 py-2 text-muted">
      <summary className="cursor-pointer font-mono text-label uppercase tracking-label">{title}</summary>
      <p className="mt-1 whitespace-pre-wrap break-words text-ui">{item.text}</p>
    </details>
  );
}
