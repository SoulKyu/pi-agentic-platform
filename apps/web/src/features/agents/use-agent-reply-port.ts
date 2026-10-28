import { useEffect, useRef } from "react";
import { useFilesTarget } from "../../stores/files-target.ts";
import { useReplyPorts } from "../../stores/reply-ports.ts";

/** The agent thread's reply port (UX1-R11): the VM's `/agent/...` paths open in the agent's Files tab at `/agents/<id>`. */
export function useAgentReplyPort(agentId: string, sessionId: string | null, openFilesTab: () => void): void {
  const open = useRef(openFilesTab);
  useEffect(() => {
    open.current = openFilesTab;
  });
  useEffect(() => {
    if (sessionId === null) return;
    const filesRoot = `/agents/${agentId}`;
    return useReplyPorts.getState().register(sessionId, {
      scope: {
        base: "/agent/home",
        roots: ["/agent/home", "/agent/inbox", "/agent/knowledge"],
        filesRoot,
        agentId,
      },
      openFile(path, line) {
        useFilesTarget.getState().push(filesRoot, path, line);
        open.current();
      },
    });
  }, [agentId, sessionId]);
}
