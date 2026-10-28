import { useEffect } from "react";
import { reportClientIssue } from "../../lib/report.ts";
import { useRole } from "../../lib/role-context.ts";
import { useFilesTarget } from "../../stores/files-target.ts";
import { useReplyPorts } from "../../stores/reply-ports.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { placeOf, showSurface, terminalAllowed } from "./surface.ts";
import { toTerminal } from "./terminal-hand-off.ts";

/** A session tab's reply port (UX1-R11): its paths resolve in the session's folder and open in the project's Files. Lane chats register none. */
export function useReplyPort(tabKey: string, sessionId: string): void {
  const place = placeOf(
    useShellStore((state) => state.view),
    sessionId,
  );
  const role = useRole();
  // A subagent's session never types into a terminal (UX1-R21).
  const child = useShellStore((state) => state.view.sessions.get(sessionId)?.parentId != null);
  const typing = terminalAllowed(place, role) && !child;
  const root = place?.root ?? null;
  const cwd = place?.cwd ?? null;
  useEffect(() => {
    if (root === null) return;
    const base = cwd ?? root;
    return useReplyPorts.getState().register(sessionId, {
      scope: { base, roots: cwd === null ? [root] : [cwd, root], filesRoot: root, agentId: null },
      openFile(path, line) {
        useFilesTarget.getState().push(root, path, line);
        showSurface(tabKey, sessionId, "files").catch(() => reportClientIssue("command_failed"));
      },
      ...(typing ? { toTerminal: (text: string) => toTerminal(tabKey, sessionId, text) } : {}),
    });
  }, [tabKey, sessionId, root, cwd, typing]);
}
