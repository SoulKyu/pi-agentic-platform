import { useT } from "../../i18n/index.ts";
import { useRole } from "../../lib/role-context.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { itemKey, type ItemRef } from "../../features/workspace/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useReplyPort } from "./reply-port-host.ts";
import { useTerminalReady } from "./surface-view.ts";
import { placeOf, showSurface, terminalAllowed, useTerminalFeed, type Surface } from "./surface.ts";
import { surfaceItemClass } from "./SurfaceSwitch.tsx";

interface SurfaceBarProps {
  readonly tabKey: string;
  readonly sessionId: string;
  readonly split: ItemRef | null;
}

/** Above a session tab on desktop (M8R72): Changes, Terminal and Files each split the tab, or focus the split they are. */
export function SurfaceBar({ tabKey, sessionId, split }: SurfaceBarProps) {
  const t = useT();
  const role = useRole();
  useTerminalFeed();
  useReplyPort(tabKey, sessionId);
  const ready = useTerminalReady((state) => state.ready);
  const place = placeOf(
    useShellStore((state) => state.view),
    sessionId,
  );
  const rows: ReadonlyArray<{
    which: Surface;
    label: string;
    off: boolean;
    busy?: boolean;
    current: boolean;
  }> = [
    {
      which: "changes",
      label: t("shell.surface.changes"),
      off: place?.root == null,
      current:
        place?.root != null &&
        split !== null &&
        itemKey(split) === itemKey({ kind: "changes", root: place.root }),
    },
    {
      which: "terminal",
      label: t("shell.surface.terminal"),
      off: place?.cwd == null || !ready,
      busy: !ready,
      current: split?.kind === "terminal",
    },
    {
      which: "files",
      label: t("shell.surface.files"),
      off: place?.root == null,
      current:
        place?.root != null &&
        split !== null &&
        itemKey(split) === itemKey({ kind: "files", root: place.root }),
    },
  ];
  return (
    <div
      role="group"
      aria-label={t("shell.surface.label")}
      data-slot="surface-bar"
      className="flex h-bar shrink-0 items-center gap-s1 border-b border-border bg-bg-side px-s2"
    >
      {rows
        .filter((row) => row.which !== "terminal" || role === "owner" || terminalAllowed(place, role))
        .map(({ which, label, off, busy, current }) => (
          <button
            key={which}
            type="button"
            disabled={off}
            aria-busy={busy === true && place?.cwd != null ? true : undefined}
            aria-current={current ? "true" : undefined}
            onClick={() => {
              showSurface(tabKey, sessionId, which).catch(() => reportClientIssue("command_failed"));
            }}
            className={surfaceItemClass(current)}
          >
            {label}
          </button>
        ))}
    </div>
  );
}
