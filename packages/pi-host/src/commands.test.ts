import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { GetStateData } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { handleAbort, handleGetState, handlePrompt } from "./commands.ts";
import type { Outbound } from "./ipc.ts";

type PromptFn = (text: string, options?: Record<string, unknown>) => Promise<void>;

const asSession = (fake: object) => fake as unknown as AgentSession;
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("handlePrompt", () => {
  it("answers with the disposition as soon as Pi has classified the prompt, and only once", async () => {
    const sent: Outbound[] = [];
    let finish: () => void = () => {};
    const prompt: PromptFn = (_text, options) => {
      (options?.preflightResult as (d: string) => void)("started");
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    };
    handlePrompt(asSession({ prompt }), { id: "p1", message: "go" }, (r) => sent.push(r));
    expect(sent).toEqual([
      { type: "response", id: "p1", command: "prompt", success: true, data: { disposition: "started" } },
    ]);
    finish();
    await settle();
    expect(sent).toHaveLength(1);
  });

  it("answers handled when the prompt ends without a preflight result", async () => {
    const sent: Outbound[] = [];
    handlePrompt(asSession({ prompt: async () => {} }), { id: "p1", message: "/cmd" }, (r) => sent.push(r));
    await settle();
    expect(sent).toEqual([
      { type: "response", id: "p1", command: "prompt", success: true, data: { disposition: "handled" } },
    ]);
  });

  it("answers a rejected prompt with a failure whose message is capped", async () => {
    const sent: Outbound[] = [];
    const prompt: PromptFn = () => Promise.reject(new Error("x".repeat(5000)));
    handlePrompt(asSession({ prompt }), { id: "p1", message: "go" }, (r) => sent.push(r));
    await settle();
    expect(sent).toEqual([
      { type: "response", id: "p1", command: "prompt", success: false, error: "x".repeat(2000) },
    ]);
  });

  it("does not turn a late rejection into a second answer, but logs it", async () => {
    const sent: Outbound[] = [];
    const logged: string[] = [];
    const prompt: PromptFn = (_text, options) => {
      (options?.preflightResult as (d: string) => void)("queued");
      return Promise.reject(new Error("late"));
    };
    handlePrompt(
      asSession({ prompt }),
      { id: "p1", message: "go" },
      (r) => sent.push(r),
      (line) => logged.push(line),
    );
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ success: true, data: { disposition: "queued" } });
    expect(logged).toEqual(["pi-host: prompt p1 failed after it was accepted: late\n"]);
  });

  it("bounds the log line of a late failure and keeps it to one line", async () => {
    const logged: string[] = [];
    const prompt: PromptFn = (_text, options) => {
      (options?.preflightResult as (d: string) => void)("started");
      return Promise.reject(new Error(`first\nforged: ${"y".repeat(5000)}`));
    };
    handlePrompt(
      asSession({ prompt }),
      { id: "p1", message: "go" },
      () => {},
      (line) => logged.push(line),
    );
    await settle();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^pi-host: prompt p1 failed after it was accepted: first forged: y+\n$/);
    expect(logged[0]?.length).toBeLessThanOrEqual(2100);
  });

  it("does not log a failure that the response already carried", async () => {
    const logged: string[] = [];
    const prompt: PromptFn = () => Promise.reject(new Error("early"));
    handlePrompt(
      asSession({ prompt }),
      { id: "p1", message: "go" },
      () => {},
      (line) => logged.push(line),
    );
    await settle();
    expect(logged).toEqual([]);
  });

  it("passes the streaming behaviour on only when it is set", () => {
    const prompt = vi.fn<PromptFn>(async () => {});
    handlePrompt(asSession({ prompt }), { id: "p1", message: "a" }, () => {});
    handlePrompt(asSession({ prompt }), { id: "p2", message: "b", streamingBehavior: "steer" }, () => {});
    expect(prompt.mock.calls[0]?.[1]).not.toHaveProperty("streamingBehavior");
    expect(prompt.mock.calls[1]?.[1]).toMatchObject({ streamingBehavior: "steer" });
  });
});

describe("handleAbort", () => {
  it("answers success once Pi has aborted", async () => {
    const sent: Outbound[] = [];
    await handleAbort(asSession({ abort: async () => {} }), { id: "a1" }, (r) => sent.push(r));
    expect(sent).toEqual([{ type: "response", id: "a1", command: "abort", success: true }]);
  });

  it("answers a failure when aborting throws", async () => {
    const sent: Outbound[] = [];
    const abort = () => Promise.reject(new Error("stuck"));
    await handleAbort(asSession({ abort }), { id: "a1" }, (r) => sent.push(r));
    expect(sent).toEqual([{ type: "response", id: "a1", command: "abort", success: false, error: "stuck" }]);
  });
});

describe("handleGetState", () => {
  it("answers the state the contract describes", () => {
    const sent: Outbound[] = [];
    const session = asSession({
      isStreaming: true,
      isCompacting: false,
      pendingMessageCount: 2,
      sessionFile: undefined,
      sessionId: "s-1",
    });
    handleGetState(session, { id: "g1" }, (r) => sent.push(r));
    expect(sent).toEqual([
      {
        type: "response",
        id: "g1",
        command: "get_state",
        success: true,
        data: {
          isStreaming: true,
          isCompacting: false,
          pendingMessageCount: 2,
          sessionFile: "",
          sessionId: "s-1",
        },
      },
    ]);
    expect(GetStateData.parse(sent[0]?.data).pendingMessageCount).toBe(2);
  });
});
