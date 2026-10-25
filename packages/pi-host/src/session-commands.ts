import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { UI_LIMITS, WORKER_BUSY } from "@pap/contracts/pi-host";
import { messageOf } from "./bounded.ts";
import type { Outbound } from "./ipc.ts";

type Send = (record: Outbound) => unknown;

const ok = (send: Send, id: string, command: string, data?: unknown) =>
  send({ type: "response", id, command, success: true, ...(data === undefined ? {} : { data }) });
const failed = (send: Send, id: string, command: string, error: unknown) =>
  send({ type: "response", id, command, success: false, error: messageOf(error) });

/**
 * Pi's queue may hold up to 32 MiB; a response stays below the 1 MiB frame once JSON-encoded (quotes, backslashes and
 * newlines grow when escaped: M2-RT-28), and what does not fit is said.
 */
export const MAX_CLEARED_BYTES = 900_000;

export function fitTexts(steering: readonly string[], followUp: readonly string[], max = MAX_CLEARED_BYTES) {
  let left = max;
  let truncated = false;
  const take = (texts: readonly string[]) =>
    texts.filter((text) => {
      const size = Buffer.byteLength(JSON.stringify(text)) + 1;
      if (size > left) {
        truncated = true;
        return false;
      }
      left -= size;
      return true;
    });
  return { steering: take(steering), followUp: take(followUp), truncated };
}

export function handleClearQueue(session: AgentSession, command: { id: string }, send: Send): void {
  try {
    const cleared = session.clearQueue();
    ok(send, command.id, "clear_queue", fitTexts(cleared.steering, cleared.followUp));
  } catch (error) {
    failed(send, command.id, "clear_queue", error);
  }
}

// Pi's `compact()` aborts what is running and `navigateTree` moves the leaf under it. The daemon checks its own view
// first; this is the check that cannot race with Pi's event loop (a run an extension started, a slow hook).
const refuseWhileBusy = (session: AgentSession, send: Send, id: string, command: string): boolean => {
  if (session.isIdle !== false) return false;
  send({ type: "response", id, command, success: false, error: WORKER_BUSY });
  return true;
};

export async function handleCompact(
  session: AgentSession,
  command: { id: string; customInstructions?: string | undefined },
  send: Send,
): Promise<void> {
  if (refuseWhileBusy(session, send, command.id, "compact")) return;
  try {
    const result = await session.compact(command.customInstructions);
    ok(send, command.id, "compact", {
      tokensBefore: result.tokensBefore,
      estimatedTokensAfter: result.estimatedTokensAfter ?? null,
    });
  } catch (error) {
    failed(send, command.id, "compact", error);
  }
}

// No summary of the abandoned branch: that would call the model, and the UI does not offer it yet (deferred).
export async function handleNavigateTree(
  session: AgentSession,
  command: { id: string; targetId: string },
  send: Send,
): Promise<void> {
  if (refuseWhileBusy(session, send, command.id, "navigate_tree")) return;
  try {
    const result = await session.navigateTree(command.targetId, { summarize: false });
    ok(send, command.id, "navigate_tree", {
      cancelled: result.cancelled,
      leafId: session.sessionManager.getLeafId(),
      ...(result.editorText === undefined
        ? {}
        : { editorText: result.editorText.slice(0, UI_LIMITS.editorText) }),
    });
  } catch (error) {
    failed(send, command.id, "navigate_tree", error);
  }
}

/** True when the name was set: Pi appended a `session_info` entry, which advances its leaf. */
export function handleSetSessionName(
  session: AgentSession,
  command: { id: string; name: string },
  send: Send,
): boolean {
  try {
    session.setSessionName(command.name);
    ok(send, command.id, "set_session_name");
    return true;
  } catch (error) {
    failed(send, command.id, "set_session_name", error);
    return false;
  }
}

export async function handleExportHtml(
  session: AgentSession,
  command: { id: string; outputPath: string },
  send: Send,
): Promise<void> {
  try {
    ok(send, command.id, "export_html", { path: await session.exportToHtml(command.outputPath) });
  } catch (error) {
    failed(send, command.id, "export_html", error);
  }
}
