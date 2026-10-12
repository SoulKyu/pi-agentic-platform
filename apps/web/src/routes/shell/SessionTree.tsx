import {
  Banner,
  Button,
  cn,
  FOCUS_RING,
  RunStatusChip,
  Spinner,
  TextField,
  usePendingFeedback,
} from "@pap/ui";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { sessionLabel } from "../../lib/session-label.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { groupSessions } from "./session-groups.ts";
import { useShortcut } from "./shortcut.ts";

/** Nothing for the first moments of a first load, then a spinner (DESIGN.md §7.3). Mounted only while loading. */
function LoadingSessions({ label }: { readonly label: string }) {
  const [since] = useState(() => performance.now());
  const phase = usePendingFeedback(since);
  return phase === "spinner" || phase === "stage" ? <Spinner label={label} /> : null;
}

/** Sessions by working directory (project → lane → session arrives with M4 and M9). Shared with the phone "Lists" tab. */
export function SessionTree({ onPick }: { onPick(id: string): void }) {
  const t = useT();
  const held = useShellStore((state) => state.view.sessions);
  const loaded = useShellStore((state) => state.view.loaded);
  const broken = useShellStore((state) => state.view.unreadable || state.view.failed !== null);
  const sessions = useMemo(() => [...held.values()], [held]);
  const [filter, setFilter] = useState("");
  const palette = useShortcut("palette.toggle");
  const { groups, hidden } = groupSessions(sessions, filter);
  const firstLoad = !loaded && !broken;
  // A person's click asks the stream for a fresh snapshot; nothing retries by itself.
  const retry = () => getRuntime().subscriptions.resync("shell", "me");
  return (
    <div className="flex flex-col gap-s3 p-s3">
      <TextField label={t("shell.tree.filter")} value={filter} onChange={setFilter} />
      {broken ? (
        <Banner
          tone="capacity"
          title={t("shell.tree.error")}
          actions={
            <Button variant="secondary" size="sm" onClick={retry}>
              {t("shell.tree.retry")}
            </Button>
          }
        />
      ) : null}
      {firstLoad ? <LoadingSessions label={t("shell.tree.loading")} /> : null}
      {groups.map((group) => (
        <section key={group.cwd} data-group={group.cwd} className="flex flex-col gap-s1">
          <h3 className="label-hud text-muted">{group.label}</h3>
          <p className="break-all font-mono text-code text-dim">{group.cwd}</p>
          <ul className="flex flex-col gap-s1">
            {group.sessions.map((session) => (
              <li key={session.id}>
                <Link
                  to="/s/$sessionId"
                  params={{ sessionId: session.id }}
                  onClick={() => onPick(session.id)}
                  className={cn(
                    "flex items-center justify-between gap-s2 rounded-sm px-s2 py-s1 text-ui pointer-coarse:min-h-11",
                    FOCUS_RING,
                  )}
                >
                  <span className="min-w-0 truncate font-mono text-code">
                    {sessionLabel(session) || t("shell.tab.session")}
                  </span>
                  {session.status === "running" ? (
                    <RunStatusChip status="working" label={t("session.status.running")} />
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {hidden > 0 ? (
        <p className="text-ui text-muted">
          {palette.keys.length > 0
            ? t("shell.tree.more", { count: hidden, chord: palette.keys.join(palette.joiner) })
            : t("shell.tree.moreNoChord", { count: hidden })}
        </p>
      ) : null}
      {groups.length === 0 && !firstLoad && !broken ? (
        <p className="text-ui text-muted">
          {t(filter.trim() === "" ? "shell.tree.none" : "shell.tree.empty")}
        </p>
      ) : null}
    </div>
  );
}
