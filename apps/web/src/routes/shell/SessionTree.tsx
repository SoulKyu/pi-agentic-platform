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
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { getRuntime } from "../../runtime/index.ts";
import { groupSessions } from "./session-groups.ts";
import { useSessionsCache } from "./sessions-cache.ts";
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
  const sessions = useSessionsCache((state) => state.sessions);
  const status = useSessionsCache((state) => state.status);
  const [filter, setFilter] = useState("");
  const palette = useShortcut("palette.toggle");
  const { groups, hidden } = groupSessions(sessions, filter);
  const firstLoad = sessions.length === 0 && (status === "loading" || status === "idle");
  const retry = () => void useSessionsCache.getState().refresh(getRuntime().rpc);
  return (
    <div className="flex flex-col gap-s3 p-s3">
      <TextField label={t("shell.tree.filter")} value={filter} onChange={setFilter} />
      {status === "error" ? (
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
                  <span className="min-w-0 truncate font-mono text-code">{session.id}</span>
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
      {groups.length === 0 && !firstLoad && status !== "error" ? (
        <p className="text-ui text-muted">
          {t(filter.trim() === "" ? "shell.tree.none" : "shell.tree.empty")}
        </p>
      ) : null}
    </div>
  );
}
