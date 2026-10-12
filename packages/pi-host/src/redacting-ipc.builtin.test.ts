import { describe, expect, it } from "vitest";
import type { Ipc, Outbound } from "./ipc.ts";
import { createRedactor } from "./policy/redact.ts";
import { createRedactingIpc } from "./redacting-ipc.ts";

const redactor = createRedactor({ entries: [{ name: "GH", value: "ghp_testsecret_01" }] });
const record = {
  type: "tool_execution_end",
  toolCallId: "c",
  toolName: "grep",
  result: { content: [{ type: "text", text: "a.ts:3: ghp_testsec... [truncated]" }] },
};

function send(isBuiltin: (name: string) => boolean): Outbound[] {
  const records: Outbound[] = [];
  const ipc: Ipc = {
    send: (next) => (records.push(next), true),
    onMessage: () => () => {},
    onDisconnect: () => {},
  };
  createRedactingIpc(ipc, () => redactor, isBuiltin).send(record);
  return records;
}

describe("the grep truncation notice in a record needs Pi's own grep, as stage 06 does for a result", () => {
  it("masks the cut line end of the built-in grep", () => {
    expect(JSON.stringify(send((name) => name === "grep"))).toContain("a.ts:3: [SECRET:GH]... [truncated]");
  });

  it("leaves it for a tool named grep that an extension registered", () => {
    expect(send(() => false)).toEqual([record]);
  });
});
