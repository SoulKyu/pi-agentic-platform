import { cn, FOCUS_RING } from "@pap/ui";
import { useT } from "../../i18n/index.ts";
import { useRole } from "../../lib/role-context.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { placeOf, showSurface, terminalAllowed, useTerminalFeed } from "./surface.ts";
import { useSurfaceView, useTerminalReady } from "./surface-view.ts";

/** One look for the bar and the switch: the current item gets the agent underline of `Segmented` (DESIGN.md §9.1). */
export const surfaceItemClass = (current: boolean): string =>
  cn(
    "h-control border-b-2 px-s2 label-hud transition-colors duration-fast pointer-coarse:min-h-11 pointer-coarse:min-w-11 disabled:cursor-not-allowed disabled:opacity-50",
    current ? "border-agent text-fg" : "border-transparent text-muted can-hover:hover:text-fg",
    FOCUS_RING,
  );

export type SwitchChoice = "chat" | "review" | "term";

interface SurfaceSwitchProps {
  readonly tabKey: string;
  readonly sessionId: string;
  /** What the pane shows now. */
  readonly selected: SwitchChoice | "files";
}

/** The phone's Chat / Review / Term switch at the top of a session tab (DESIGN.md §8): one pane at a time. */
export function SurfaceSwitch({ tabKey, sessionId, selected }: SurfaceSwitchProps) {
  const t = useT();
  const role = useRole();
  useTerminalFeed();
  const ready = useTerminalReady((state) => state.ready);
  const place = placeOf(
    useShellStore((state) => state.view),
    sessionId,
  );
  const choose = (choice: SwitchChoice | "files") => {
    if (choice === "chat") useSurfaceView.getState().show(tabKey, "chat");
    else if (choice !== "files")
      showSurface(tabKey, sessionId, choice === "review" ? "changes" : "terminal").catch(() =>
        reportClientIssue("command_failed"),
      );
  };
  // The files pane has no item of its own here; while it is shown it appears as the selected one.
  const items: ReadonlyArray<{ id: SwitchChoice | "files"; label: string; off: boolean; busy?: boolean }> = [
    { id: "chat", label: t("shell.surface.chat"), off: false },
    { id: "review", label: t("shell.surface.review"), off: place?.root == null },
    ...(role === "owner" || terminalAllowed(place, role)
      ? [
          {
            id: "term" as const,
            label: t("shell.surface.term"),
            off: place?.cwd == null || !ready,
            busy: !ready,
          },
        ]
      : []),
    ...(selected === "files" ? [{ id: "files" as const, label: t("shell.surface.files"), off: false }] : []),
  ];
  return (
    <div
      role="group"
      aria-label={t("shell.surface.label")}
      data-slot="surface-switch"
      className="flex h-bar shrink-0 items-center gap-s1 border-b border-border bg-bg-side px-s2"
    >
      {items.map(({ id, label, off, busy }) => (
        <button
          key={id}
          type="button"
          disabled={off}
          aria-busy={busy === true && place?.cwd != null ? true : undefined}
          aria-current={selected === id ? "true" : undefined}
          onClick={() => choose(id)}
          className={surfaceItemClass(selected === id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
