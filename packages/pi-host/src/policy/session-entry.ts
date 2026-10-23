import type { ApprovalMode, SessionAuditEntry } from "@pap/contracts";
import type { Outbound } from "../ipc.ts";
import { clipUnits } from "./trail.ts";

const MAX_TOOLS = 256;
const MAX_TOOL_NAME = 256;

/** What a session reports about itself when it opens and when its tools change (M5R15). */
export function sessionEntry(toolNames: readonly string[], mode: ApprovalMode): SessionAuditEntry {
  return {
    kind: "session",
    stages: [
      { stage: "00", outcome: "pass", reason: `${toolNames.length} tools` },
      { stage: "05", outcome: "skip", reason: "no sandbox profile for interactive sessions" },
    ],
    tools: toolNames.slice(0, MAX_TOOLS).map((name) => clipUnits(name, MAX_TOOL_NAME)),
    toolsTruncated: toolNames.length > MAX_TOOLS,
    mode,
  };
}

const sameNames = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((name, index) => name === b[index]);

/** The entry at open and one more at each `agent_start` whose active tools differ from the last one sent. */
export function createSessionEntries(send: (record: Outbound) => boolean) {
  let last: readonly string[] | null = null;
  const emit = (names: readonly string[], mode: ApprovalMode): void => {
    if (last && sameNames(last, names)) return;
    if (send({ type: "audit", entry: sessionEntry(names, mode) })) last = [...names];
    else process.stderr.write("pi-host: session entry not sent\n");
  };
  return { opened: emit, agentStart: emit };
}
