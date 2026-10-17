import type { InboxItem } from "@pap/contracts";
import { type AvatarStyle, Button, Chip, EmptyState, Segmented, toast, type Option } from "@pap/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import "../../i18n/register-inbox.ts";
import { errorKey, useT } from "../../i18n/index.ts";
import { getRuntime, RpcError } from "../../runtime/index.ts";
import { useInboxReveal } from "../../stores/inbox-reveal.ts";
import { useInboxStore } from "../../stores/inbox-store.ts";
import { FILTERS, visible, type InboxFilter } from "./inbox.vm.ts";
import { InboxRow } from "./InboxRow.tsx";

export interface InboxPanelProps {
  /** The shell opens the session (features never import each other). */
  onOpenSession(sessionId: string): void;
  /** The shell opens the agent's tab, scrolled to `entryId` when it is given. */
  onOpenAgent?(agentId: string, entryId: string | null): void;
  /** The shell opens Settings › Memory, where a `memory_review` item's facts wait (W5-R61: the row carries no fact text). */
  onOpenMemory?(): void;
  /** The account's avatar style (Settings › Appearance), given by the shell. */
  readonly avatarStyle?: AvatarStyle;
}

/** The Inbox (decision 29, board 09 §2): header, filters, rows to handle first. Shown in the right drawer and in the phone's Inbox section. */
export default function InboxPanel({
  onOpenSession,
  onOpenAgent,
  onOpenMemory,
  avatarStyle,
}: InboxPanelProps) {
  const t = useT();
  const view = useInboxStore((state) => state.view);
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const rows = useMemo(() => visible(view.items, filter), [view.items, filter]);

  // A tapped notification named a row: bring it into view once the list holds it. Ids are compared, never put in a selector.
  const wanted = useInboxReveal((state) => state.itemId);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (wanted === null) return;
    const row = [...(list.current?.querySelectorAll<HTMLElement>("[data-item-id]") ?? [])].find(
      (candidate) => candidate.dataset["itemId"] === wanted,
    );
    if (row === undefined) return;
    useInboxReveal.getState().takeItem();
    row.scrollIntoView?.({ block: "center" });
    row.focus({ preventScroll: true });
  }, [wanted, rows]);

  const markRead = (params: { ids: string[] } | { all: true }) => {
    const rpc = getRuntime().rpc;
    return rpc.call("inbox.markRead", params, { commandId: rpc.newCommandId() });
  };
  const readAll = () => {
    setError(null);
    markRead({ all: true }).catch((failure: unknown) =>
      setError(t(errorKey(failure instanceof RpcError ? failure.code : "internal"))),
    );
  };
  const pick = (item: InboxItem) => {
    if (item.readAt === null)
      markRead({ ids: [item.id] }).catch(() => toast({ message: t("inbox.readAllFailed"), tone: "error" }));
    if (item.kind === "memory_review") onOpenMemory?.();
    else if (item.agentId !== null) onOpenAgent?.(item.agentId, item.entryId);
    else if (item.sessionId !== null) onOpenSession(item.sessionId);
  };
  const options: Option<InboxFilter>[] = FILTERS.map((value) => ({
    value,
    label: t(`inbox.filter.${value}`),
  }));
  const emptyKind = (
    {
      all: "inbox.empty",
      handle: "inbox.emptyHandle",
      replies: "inbox.emptyReplies",
      tasks: "inbox.empty",
    } as const
  )[filter];

  return (
    <section data-inbox-panel="" className="flex min-h-0 flex-col">
      <header className="flex items-center gap-s2 border-b border-border px-s3 py-s2">
        <h2 className="text-h2 text-fg">
          {view.toHandle > 0 ? t("inbox.header", { count: view.toHandle }) : t("inbox.headerNone")}
        </h2>
        {view.toHandle > 0 ? <Chip tone="att" label={t("inbox.filter.handle")} /> : null}
        <span className="flex-1" />
        <Button size="sm" disabled={view.unread === 0} onClick={readAll}>
          {t("inbox.readAll")}
        </Button>
      </header>
      <div className="border-b border-border px-s3 py-s1">
        <Segmented<InboxFilter>
          label={t("inbox.filters")}
          value={filter}
          options={options}
          onChange={setFilter}
        />
      </div>
      {error ? (
        <p role="alert" className="px-s3 py-s2 text-ui text-attn">
          {error}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <div className="p-s3">
          <EmptyState title={t(`${emptyKind}.title`)} purpose={t(`${emptyKind}.purpose`)} />
        </div>
      ) : (
        <ul ref={list} aria-label={t("inbox.list")}>
          {rows.map((item) => (
            <InboxRow
              key={item.id}
              item={item}
              now={now}
              avatarStyle={avatarStyle ?? "outlined"}
              onPick={pick}
            />
          ))}
        </ul>
      )}
      {view.truncated ? <p className="px-s3 py-s2 text-ui text-muted">{t("inbox.truncated")}</p> : null}
    </section>
  );
}
