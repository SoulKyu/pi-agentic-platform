import type { InboxItem } from "@pap/contracts";
import { type AvatarStyle, Chip, cn, FOCUS_RING, Icon, IconWork } from "@pap/ui";
import { formatAge } from "../../i18n/age.ts";
import { useT } from "../../i18n/index.ts";
import { AgentInboxRow } from "./AgentInboxRow.tsx";
import { BOX_PAUSED, BoxPausedRow } from "./BoxPausedRow.tsx";
import { chipOf, costOf, isAgentItem, isOpen, titleOf } from "./inbox.vm.ts";

export interface InboxRowProps {
  readonly item: InboxItem;
  readonly now: number;
  readonly avatarStyle: AvatarStyle;
  onPick(item: InboxItem): void;
  /** The shell opens the project's page. */
  onOpenProject?(projectId: string): void;
}

/** A paused box is a project row (R7); an agent's item is an agent row (M11R129); every other kind is M10's task line. */
export function InboxRow(props: InboxRowProps) {
  if (props.item.kind === BOX_PAUSED) return <BoxPausedRow {...props} />;
  return isAgentItem(props.item) ? <AgentInboxRow {...props} /> : <TaskRow {...props} />;
}

/** One line of the Inbox (board 09 §2): a task glyph, the title, the kind chip, the age and the cost. A question to handle wears the attention tint. */
function TaskRow({ item, now, onPick }: InboxRowProps) {
  const t = useT();
  const chip = chipOf(item);
  const cost = costOf(item);
  const open = isOpen(item);
  const unread = item.readAt === null;
  const meta = [formatAge(now, item.createdAt, t), cost].filter((part) => part !== null).join(" · ");
  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        data-slot="inbox-row"
        data-item-id={item.id}
        data-unread={unread ? "true" : undefined}
        onClick={() => onPick(item)}
        className={cn(
          "flex w-full items-start gap-s2 border-l-2 px-s3 py-s2 text-left pointer-coarse:min-h-11",
          open ? "border-l-attn bg-attn-tint" : "border-l-transparent",
          FOCUS_RING,
        )}
      >
        <span aria-hidden className="mt-s1 text-muted">
          <Icon icon={IconWork} size={16} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-s1">
          <span className={cn("break-words text-ui", unread ? "font-semibold text-fg" : "text-muted")}>
            {titleOf(item)}
          </span>
          <span className="flex flex-wrap items-center gap-s2">
            <Chip tone={chip.tone} label={t(chip.label)} />
            <span className="font-mono text-label text-muted tabular-nums">{meta}</span>
            {unread ? <span className="sr-only">{t("inbox.unread")}</span> : null}
          </span>
        </span>
      </button>
    </li>
  );
}
