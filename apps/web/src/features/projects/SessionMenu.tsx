import "../../i18n/register-sidebar.ts";
import { isSnoozed, type MarkChange, type ShellSession } from "@pap/contracts";
import { IconButton, IconMore, toast } from "@pap/ui";
import type { MenuItem } from "@pap/ui/overlays";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { errorKey, type MessageKey, type Translate, useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyMenu } from "../../lib/LazyMenu.tsx";
import { sessionLabel } from "../../lib/session-label.ts";
import { getRuntime } from "../../runtime/index.ts";
import { pinnedIds, type ShellView } from "../../stores/shell-reducer.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useMenuFocus, wantFocus } from "./menu-focus.ts";
import { organise, type OrganiseDeps, type Outcome, undo } from "./organise.ts";
import SnoozeDialog from "./SnoozeDialog.tsx";
import { snoozeTimes } from "./snooze.ts";

/** What every filing action runs on: the runtime's rpc, the shell store, and a fresh `shell` snapshot on request. */
export function organiseDeps(): OrganiseDeps {
  const runtime = getRuntime();
  return {
    rpc: runtime.rpc,
    store: useShellStore,
    resync: () => runtime.subscriptions.resync("shell", "me"),
  };
}

/** The toast of a change that Undo can take back. */
interface UndoToast {
  readonly message: MessageKey;
  readonly title: string;
  readonly sessionId: string;
}

const UNDOABLE: Partial<Record<MarkChange["kind"], MessageKey>> = {
  archive: "sidebar.toast.archived",
  settle: "sidebar.toast.settled",
  snooze: "sidebar.toast.snoozed",
  unpin: "sidebar.toast.unpinned",
};

/** The clock at the moment of a press, not of a render. */
const pressedAt = (): number => Date.now();

const failed: Outcome = { result: "refused", code: "internal" };

/** Says how an action ended; none ends in silence but a plain success (the list already shows it). */
export function say(outcome: Outcome, t: Translate, undoable?: UndoToast): void {
  if (outcome.result === "refused") {
    toast({ message: t(errorKey(outcome.code ?? "internal")), tone: "error" });
  } else if (outcome.result === "busy") {
    toast({ message: t("sidebar.busy"), tone: "error" });
  } else if (outcome.result === "unknown") {
    toast({ message: t("sidebar.unknown"), tone: "error" });
  } else if (undoable && outcome.undo) {
    const state = outcome.undo;
    toast({
      message: t(undoable.message, { title: undoable.title }),
      action: {
        label: t("sidebar.undo"),
        altText: t("sidebar.undoAlt"),
        run: () => {
          undo({ sessionId: undoable.sessionId, state, now: Date.now }, organiseDeps()).then(
            (result) => say(result, t),
            () => say(failed, t),
          );
        },
      },
    });
  }
}

/** The pinned neighbours of a pinned session: the one above, and where it would stand moved one down (undefined: it is last). */
function pinNeighbours(view: ShellView, session: ShellSession) {
  if (session.pinRank === null) return { up: undefined, down: undefined };
  const pins = pinnedIds(view);
  const at = pins.indexOf(session.id);
  return {
    up: at > 0 ? (pins[at - 1] as string) : undefined,
    down: at !== -1 && at < pins.length - 1 ? (pins[at + 2] ?? null) : undefined,
  };
}

interface SessionMenuProps {
  readonly session: ShellSession;
  readonly now: number;
}

/** The "⋯" menu of a session row: pin, move, snooze, settle, archive — shown at once, with Undo (M4R98). */
export function SessionMenu({ session, now }: SessionMenuProps) {
  const t = useT();
  const lazyText = useLazyFailureText();
  const pending = useShellStore((state) => state.view.pending.size > 0);
  const neighbours = useShellStore(useShallow((state) => pinNeighbours(state.view, session)));
  const [snoozing, setSnoozing] = useState(false);
  const key = `session:${session.id}`;
  useMenuFocus(key, pending);
  const title = sessionLabel(session) || t("shell.tab.session");

  const run = (change: MarkChange) => {
    wantFocus(key);
    const toastKey = UNDOABLE[change.kind];
    const undoable = toastKey ? { message: toastKey, title, sessionId: session.id } : undefined;
    organise({ session, change, now: pressedAt() }, organiseDeps()).then(
      (outcome) => {
        if (outcome.result === "busy") wantFocus(null);
        say(outcome, t, undoable);
      },
      () => say(failed, t),
    );
  };

  const archived = session.archivedAt !== null;
  const item = (id: string, label: MessageKey, onSelect: () => void): MenuItem => ({
    id,
    label: t(label),
    onSelect,
  });
  // The times are worked out when the item is pressed: a menu can stay mounted for a long while.
  const snooze = (pick: (times: ReturnType<typeof snoozeTimes>) => number) => () =>
    run({ kind: "snooze", until: pick(snoozeTimes(new Date(pressedAt()))) });
  const items: MenuItem[] = [];
  if (archived) {
    items.push(item("unarchive", "sidebar.action.unarchive", () => run({ kind: "unarchive" })));
  } else {
    if (session.pinRank === null) {
      items.push(item("pin", "sidebar.action.pin", () => run({ kind: "pin", before: null })));
    } else {
      items.push(item("unpin", "sidebar.action.unpin", () => run({ kind: "unpin" })));
      const { up, down } = neighbours;
      if (up !== undefined)
        items.push(item("up", "sidebar.action.moveUp", () => run({ kind: "pin", before: up })));
      if (down !== undefined)
        items.push(item("down", "sidebar.action.moveDown", () => run({ kind: "pin", before: down })));
    }
    items.push(
      item(
        "snooze-hour",
        "sidebar.action.snoozeHour",
        snooze((times) => times.hour),
      ),
      item(
        "snooze-tomorrow",
        "sidebar.action.snoozeTomorrow",
        snooze((times) => times.tomorrow),
      ),
      item(
        "snooze-week",
        "sidebar.action.snoozeWeek",
        snooze((times) => times.nextWeek),
      ),
      item("snooze-custom", "sidebar.action.snoozeCustom", () => setSnoozing(true)),
    );
    if (isSnoozed(session, now)) items.push(item("wake", "sidebar.action.wake", () => run({ kind: "wake" })));
    items.push(
      session.settledAt === null
        ? item("settle", "sidebar.action.settle", () => run({ kind: "settle" }))
        : item("unsettle", "sidebar.action.unsettle", () => run({ kind: "unsettle" })),
      item("archive", "sidebar.action.archive", () => run({ kind: "archive" })),
    );
  }

  return (
    <>
      <LazyMenu
        label={t("sidebar.menu.session")}
        closeLabel={t("ui.close")}
        text={lazyText}
        items={items}
        trigger={(ask) => (
          <IconButton
            icon={IconMore}
            label={t("sidebar.menu.session")}
            size="sm"
            disabled={pending}
            data-menu-key={key}
            onClick={ask}
          />
        )}
      />
      {snoozing ? (
        <SnoozeDialog
          onClose={() => {
            setSnoozing(false);
            wantFocus(key);
          }}
          onSubmit={(until) => {
            setSnoozing(false);
            run({ kind: "snooze", until });
          }}
        />
      ) : null}
    </>
  );
}
