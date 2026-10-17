import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderScript, scriptedReplies } from "./scripted-provider.ts";

// Test only: a step that sends `platform_call` records as written, the way a compromised worker would.
const ask = { messages: [{ role: "user", content: "go" }] };
const call = (op: string) => ({ op, toolCallId: "tc-1", args: { note: "x" } });

let dir: string;
let sent: unknown[];
const original = Object.getOwnPropertyDescriptor(process, "send");
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-raw-"));
  sent = [];
  Object.defineProperty(process, "send", {
    value: (record: unknown) => sent.push(record),
    configurable: true,
  });
});
afterEach(() => {
  if (original) Object.defineProperty(process, "send", original);
  else Reflect.deleteProperty(process, "send");
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("a step with rawPlatformCalls", () => {
  it("sends each call as written, with ids of its own, and still answers with the step's text", () => {
    const reply = scriptedReplies(
      ProviderScript.parse({
        steps: [
          { text: "sent", rawPlatformCalls: [call("lane.note"), call("agent.notify")] },
          { text: "next" },
        ],
      }),
    );
    const message = reply(ask);
    expect(message.content[0]).toMatchObject({ text: "sent" });
    expect(sent).toEqual([
      { type: "platform_call", id: "r1", op: "lane.note", toolCallId: "tc-1", args: { note: "x" } },
      { type: "platform_call", id: "r2", op: "agent.notify", toolCallId: "tc-1", args: { note: "x" } },
    ]);
    reply(ask);
    expect(sent).toHaveLength(2);
  });

  it("sends an op the table does not have, untouched (the daemon's parser is what drops it)", () => {
    const reply = scriptedReplies(
      ProviderScript.parse({ steps: [{ text: "sent", rawPlatformCalls: [call("agent.explode")] }] }),
    );
    reply(ask);
    expect(sent).toMatchObject([{ op: "agent.explode" }]);
  });

  it("sends nothing from a step without them", () => {
    scriptedReplies(ProviderScript.parse({ steps: [{ text: "plain" }] }))(ask);
    expect(sent).toEqual([]);
  });

  it("appends only the answers to its own calls to the capture file", () => {
    const file = join(dir, "raw.jsonl");
    scriptedReplies(
      ProviderScript.parse({
        captureRawResults: file,
        steps: [{ text: "sent", rawPlatformCalls: [call("lane.note")] }],
      }),
    )(ask);
    process.emit("message", { type: "platform_result", id: "r1", ok: false, error: "forbidden" }, undefined);
    process.emit("message", { type: "platform_result", id: "p1", ok: true, result: {} }, undefined);
    process.emit("message", { type: "vault_update", vault: {}, once: [] }, undefined);
    expect(readFileSync(file, "utf8")).toBe(
      `${JSON.stringify({ type: "platform_result", id: "r1", ok: false, error: "forbidden" })}\n`,
    );
  });
});
