import { SessionStreamEvent } from "@pap/contracts";
import { toast } from "@pap/ui";
import { plainText } from "@pap/ui/extensions";
import { create } from "zustand";
import { t } from "../../i18n/index.ts";
import { codedServerText } from "../../i18n/server-text.ts";

/** A live `info` notice is transient, like `ctx.ui.notify` in Pi's TUI: a toast (the Toaster keeps the latest 3 and each lasts 5 s). A snapshot never calls this. */
export function toastLiveInfo(raw: unknown): void {
  if ((raw as { kind?: unknown } | null)?.kind !== "notice") return;
  const parsed = SessionStreamEvent.safeParse(raw);
  if (!parsed.success || parsed.data.kind !== "notice" || parsed.data.level !== "info") return;
  const event = parsed.data;
  const message =
    event.source === "extension"
      ? `${t("source.extension")}: ${plainText(event.text)}`
      : codedServerText(event);
  toast({ message });
}

interface DismissedState {
  readonly keys: ReadonlySet<string>;
  dismiss(key: string): void;
}

/** Warnings and errors the person closed, for this browser session (a reconnect snapshot carries them again). */
export const useDismissedNotices = create<DismissedState>()((set) => ({
  keys: new Set(),
  dismiss: (key) => set((state) => ({ keys: new Set(state.keys).add(key) })),
}));

export const noticeKey = (sessionId: string, notice: { level: string; text: string }): string =>
  `${sessionId}\u0000${notice.level}\u0000${notice.text}`;
