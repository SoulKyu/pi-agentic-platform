import { Markdown, Message, Reasoning, type MarkdownProps } from "@pap/ui";
import { memo } from "react";
import { useT } from "../../i18n/index.ts";
import { FencedPart } from "./FencedPart.tsx";
import { splitFences } from "./fence.vm.ts";
import "./register-policy-catalog.ts";
import { useReplyMarkdown } from "./reply-markdown.ts";
import { RowButtons, type RowActions } from "./RowActions.tsx";
import { splitBlocks } from "./streaming-blocks.ts";
import type { MessageItem, PartialItem, SummaryItem } from "./transcript.vm.ts";

export type { RowActions } from "./RowActions.tsx";

/** Your own text: a task's first message is the rendered prompt, so pap's fences in it show as the untrusted frame. */
function YourText({ text }: { text: string }) {
  const parts = splitFences(text);
  if (!parts.some((part) => part.kind === "fenced")) return <>{text}</>;
  return (
    <>
      {parts.map((part, index) =>
        part.kind === "fenced" ? <FencedPart key={index} source={part.source} text={part.text} /> : part.text,
      )}
    </>
  );
}

type ReplyMarkdown = Pick<MarkdownProps, "onLoadError" | "copyLabels" | "pathLinks" | "shellHandOff">;

/** One block of a streaming reply: it renders again only when its own text changes (M4R113). */
const MarkdownBlock = memo(function MarkdownBlock({ text, tools }: { text: string; tools: ReplyMarkdown }) {
  return <Markdown text={text} {...tools} />;
});

/**
 * A message, or the reply being written: the agent's text as markdown (plain until the renderer arrives, and if it never
 * does), your own as typed; thinking folded above it. Your rows can fork, be edited or step between branches. `grouped`:
 * the run's header stands for this row's.
 */
export function MessageRow({
  sessionId,
  item,
  actions,
  grouped,
}: {
  sessionId: string;
  item: MessageItem | PartialItem;
  actions?: RowActions;
  grouped?: boolean;
}) {
  const t = useT();
  const markdown = useReplyMarkdown(sessionId, item.kind === "message");
  const author = item.kind === "partial" ? "agent" : item.author;
  const entryId = item.kind === "message" && author === "you" ? item.entryId : null;
  // The reply is still thinking while no answer text has come.
  const thinking = item.kind === "partial" && item.text === "";
  return (
    <Message
      author={author}
      label={t(`author.${author}`)}
      grouped={grouped ?? false}
      actions={
        actions && entryId !== null ? (
          <RowButtons
            entryId={entryId}
            actions={actions}
            text={item.text}
            unverified={item.kind === "message" && item.unverified === true}
          />
        ) : undefined
      }
    >
      {item.thinking ? (
        <Reasoning label={thinking ? t("sessions.transcript.thinking") : t("sessions.transcript.thought")}>
          <p className="whitespace-pre-wrap break-words">{item.thinking}</p>
        </Reasoning>
      ) : null}
      {author === "agent" && item.text ? (
        item.kind === "partial" ? (
          // Blocks only grow at the end, so an index names the same block until the message ends.
          splitBlocks(item.text).map((block, index) => (
            <MarkdownBlock key={index} text={block} tools={markdown} />
          ))
        ) : (
          <Markdown text={item.text} {...markdown} />
        )
      ) : author === "you" ? (
        <YourText text={item.text} />
      ) : (
        item.text
      )}
    </Message>
  );
}

/** A compaction or a branch summary, folded: its text is what the model was given in place of the rows. */
export function SummaryRow({ item }: { item: SummaryItem }) {
  const t = useT();
  const title =
    item.variant === "compaction"
      ? t("sessions.transcript.compacted", { tokens: item.tokensBefore ?? 0 })
      : t("sessions.transcript.branchSummary");
  return (
    <details data-summary={item.variant} className="border-l-2 border-border bg-bg px-s3 py-s2 text-muted">
      <summary className="cursor-pointer label-hud focus-ring">{title}</summary>
      <p className="mt-s1 whitespace-pre-wrap break-words text-ui">{item.text}</p>
    </details>
  );
}
