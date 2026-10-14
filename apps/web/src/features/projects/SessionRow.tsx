import type { ShellSession } from "@pap/contracts";
import { cn, FOCUS_RING, RunStatusChip } from "@pap/ui";
import { Link } from "@tanstack/react-router";
import { useT } from "../../i18n/index.ts";
import { sessionLabel } from "../../lib/session-label.ts";
import { formatAge } from "../../i18n/age.ts";
import { SessionMenu } from "./SessionMenu.tsx";

const CURRENT_CLASSES = "border-agent bg-surface-2";
const IDLE_CLASSES = "border-transparent";

interface SessionRowProps {
  readonly session: ShellSession;
  readonly now: number;
  onPick(id: string): void;
}

/** One session: its label, a chip when it works or waits for the user, its age, its menu. Every string is React text. */
export function SessionRow({ session, now, onPick }: SessionRowProps) {
  const t = useT();
  return (
    <li className="flex items-center gap-s1">
      <Link
        to="/s/$sessionId"
        params={{ sessionId: session.id }}
        onClick={() => onPick(session.id)}
        // The router marks the open session `aria-current="page"`; the agent rule and the raised surface show it (board 05).
        activeProps={{ className: CURRENT_CLASSES }}
        inactiveProps={{ className: IDLE_CLASSES }}
        className={cn(
          "flex min-w-0 flex-1 items-center justify-between gap-s2 rounded-sm border-l-2 px-s2 py-s1 text-ui pointer-coarse:min-h-11",
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
      <SessionMenu session={session} now={now} />
    </li>
  );
}
