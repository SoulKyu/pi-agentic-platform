import type { ShellSession } from "@pap/contracts";
import { cn, FOCUS_RING, RunStatusChip } from "@pap/ui";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useT } from "../../i18n/index.ts";
import { sessionLabel } from "../../lib/session-label.ts";
import { formatAge } from "./age.ts";

interface SessionRowProps {
  readonly session: ShellSession;
  readonly now: number;
  onPick(id: string): void;
  /** The row menu (Task 23). */
  readonly menu?: ReactNode;
}

/** One session: its label, a chip when it works or waits for the user, its age. Every string is React text. */
export function SessionRow({ session, now, onPick, menu }: SessionRowProps) {
  const t = useT();
  return (
    <li className="flex items-center gap-s1">
      <Link
        to="/s/$sessionId"
        params={{ sessionId: session.id }}
        onClick={() => onPick(session.id)}
        className={cn(
          "flex min-w-0 flex-1 items-center justify-between gap-s2 rounded-sm px-s2 py-s1 text-ui pointer-coarse:min-h-11",
          FOCUS_RING,
        )}
      >
        <span data-session-label className="min-w-0 truncate text-ui">
          {sessionLabel(session) || t("shell.tab.session")}
        </span>
        {session.needsInput ? (
          <RunStatusChip status="needs-input" label={t("sidebar.needsInput")} />
        ) : session.status === "running" ? (
          <RunStatusChip status="working" label={t("sidebar.working")} />
        ) : null}
        <span className="font-mono text-label text-muted tabular-nums">
          {formatAge(now, session.updatedAt, t)}
        </span>
      </Link>
      {menu}
    </li>
  );
}
