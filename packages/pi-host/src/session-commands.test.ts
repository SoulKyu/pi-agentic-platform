import { WORKER_BUSY } from "@pap/contracts";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  fitTexts,
  handleClearQueue,
  handleCompact,
  handleExportHtml,
  handleNavigateTree,
  handleSetSessionName,
  MAX_CLEARED_BYTES,
} from "./session-commands.ts";

type Sent = Record<string, unknown>;
const recorder = () => {
  const sent: Sent[] = [];
  return { sent, send: (record: Sent) => void sent.push(record) };
};
const fake = (fields: Record<string, unknown>) => fields as unknown as AgentSession;

describe("session commands", () => {
  it("clears the queue and hands back what fits", () => {
    const { sent, send } = recorder();
    handleClearQueue(
      fake({ clearQueue: () => ({ steering: ["left"], followUp: ["after"] }) }),
      { id: "r1" },
      send,
    );
    expect(sent).toEqual([
      {
        type: "response",
        id: "r1",
        command: "clear_queue",
        success: true,
        data: { steering: ["left"], followUp: ["after"], truncated: false },
      },
    ]);
    const big = "x".repeat(MAX_CLEARED_BYTES);
    expect(fitTexts(["a", big], ["b"])).toEqual({ steering: ["a"], followUp: ["b"], truncated: true });
    // 450 000 newlines are 450 000 UTF-8 bytes but 900 002 once JSON-encoded (M2-RT-28).
    expect(fitTexts(["\n".repeat(450_000)], ["c"])).toEqual({
      steering: [],
      followUp: ["c"],
      truncated: true,
    });
  });

  it("compacts and reports the sizes, or the failure", async () => {
    const { sent, send } = recorder();
    await handleCompact(
      fake({ compact: async () => ({ tokensBefore: 900, estimatedTokensAfter: 120 }) }),
      { id: "r1" },
      send,
    );
    await handleCompact(
      fake({
        compact: async () => {
          throw new Error("Nothing to compact");
        },
      }),
      { id: "r2" },
      send,
    );
    expect(sent).toEqual([
      {
        type: "response",
        id: "r1",
        command: "compact",
        success: true,
        data: { tokensBefore: 900, estimatedTokensAfter: 120 },
      },
      { type: "response", id: "r2", command: "compact", success: false, error: "Nothing to compact" },
    ]);
  });

  it("navigates and reports the new leaf and the text to edit", async () => {
    const { sent, send } = recorder();
    const session = fake({
      navigateTree: async (targetId: string) => ({ cancelled: false, editorText: `edit ${targetId}` }),
      sessionManager: { getLeafId: () => "a1" },
    });
    await handleNavigateTree(session, { id: "r1", targetId: "u2" }, send);
    expect(sent[0]).toEqual({
      type: "response",
      id: "r1",
      command: "navigate_tree",
      success: true,
      data: { cancelled: false, leafId: "a1", editorText: "edit u2" },
    });
  });

  it("names the session and exports it", async () => {
    const { sent, send } = recorder();
    const names: string[] = [];
    handleSetSessionName(
      fake({ setSessionName: (name: string) => void names.push(name) }),
      { id: "r1", name: "Fix login" },
      send,
    );
    await handleExportHtml(
      fake({ exportToHtml: async (path: string) => path }),
      { id: "r2", outputPath: "/pap/exports/x.html" },
      send,
    );
    expect(names).toEqual(["Fix login"]);
    expect(sent.map((record) => record.data ?? null)).toEqual([null, { path: "/pap/exports/x.html" }]);
  });

  it("refuses compact and navigate_tree while Pi is not idle, without touching the session", async () => {
    const { sent, send } = recorder();
    let touched = 0;
    const busy = fake({
      isIdle: false,
      compact: async () => void touched++,
      navigateTree: async () => void touched++,
    });
    await handleCompact(busy, { id: "r1" }, send);
    await handleNavigateTree(busy, { id: "r2", targetId: "u1" }, send);
    expect(touched).toBe(0);
    expect(sent).toEqual([
      { type: "response", id: "r1", command: "compact", success: false, error: WORKER_BUSY },
      { type: "response", id: "r2", command: "navigate_tree", success: false, error: WORKER_BUSY },
    ]);
  });
});
