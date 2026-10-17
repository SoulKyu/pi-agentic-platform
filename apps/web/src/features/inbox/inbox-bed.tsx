import "../../i18n/register-inbox.ts";
import type { InboxItem } from "@pap/contracts";
import { TooltipProvider } from "@pap/ui";
import type { ReactElement } from "react";
import type { Runtime } from "../../runtime/index.ts";
import { useInboxStore } from "../../stores/inbox-store.ts";
import { mount } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";

export const current: { runtime: Runtime | undefined } = { runtime: undefined };
export const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

export const itemOf = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: "i1",
  kind: "task_needs_input",
  toHandle: true,
  taskId: "t1",
  sessionId: "s1",
  triggerName: "prod-alerts",
  costUsd: 0.21,
  createdAt: NOW - 240_000,
  readAt: null,
  resolvedAt: null,
  resolution: null,
  agentId: null,
  refId: null,
  entryId: null,
  detail: null,
  ...over,
});

/** The Inbox store holding `items`, as a snapshot would leave it. */
export function loadInbox(items: readonly InboxItem[], extra: { truncated?: boolean } = {}): void {
  useInboxStore.getState().reset();
  useInboxStore.getState().apply({
    kind: "snapshot",
    items,
    unread: items.filter((item) => item.readAt === null).length,
    toHandle: items.filter((item) => item.toHandle && item.resolvedAt === null).length,
    truncated: extra.truncated ?? false,
  });
}

export function newBed() {
  const bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  return bed;
}

export const show = (element: ReactElement) => mount(<TooltipProvider>{element}</TooltipProvider>);
