import type { SessionSummary } from "@pap/contracts";
import { basename } from "./session-label.ts";

export interface SessionGroup {
  readonly cwd: string;
  readonly label: string;
  readonly sessions: readonly SessionSummary[];
}

const normalize = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const folder = (cwd: string) => basename(cwd) || cwd;

/** The tree until M4's projects: sessions by working directory, newest first, at most `cap` rows shown. */
export function groupSessions(
  sessions: readonly SessionSummary[],
  filter: string,
  cap = 200,
): { groups: SessionGroup[]; hidden: number } {
  const needle = normalize(filter.trim());
  const byCwd = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    if (needle && !normalize(`${session.name ?? ""} ${session.cwd}`).includes(needle)) continue;
    const list = byCwd.get(session.cwd) ?? [];
    list.push(session);
    byCwd.set(session.cwd, list);
  }
  const sorted = [...byCwd.entries()]
    .map(([cwd, list]) => ({
      cwd,
      label: folder(cwd),
      sessions: [...list].sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .sort((a, b) => (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0));
  let left = cap;
  let hidden = 0;
  const groups: SessionGroup[] = [];
  for (const group of sorted) {
    const shown = group.sessions.slice(0, Math.max(0, left));
    hidden += group.sessions.length - shown.length;
    left -= shown.length;
    if (shown.length > 0) groups.push({ ...group, sessions: shown });
  }
  return { groups, hidden };
}
