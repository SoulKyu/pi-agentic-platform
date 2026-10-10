import { describe, expect, it } from "vitest";
import { EventFrame, HelloFrame, RequestFrame, ResponseFrame } from "./index.ts";

describe("ws frames", () => {
  it("accepts a request with a commandId and rejects a negative id", () => {
    expect(
      RequestFrame.safeParse({ id: 1, method: "sessions.prompt", params: {}, commandId: "c-12345678" })
        .success,
    ).toBe(true);
    expect(RequestFrame.safeParse({ id: -1, method: "x" }).success).toBe(false);
  });

  it("accepts error responses only with a known code", () => {
    expect(ResponseFrame.safeParse({ id: 1, ok: false, error: { code: "not_found" } }).success).toBe(true);
    expect(ResponseFrame.safeParse({ id: 1, ok: false, error: { code: "teapot" } }).success).toBe(false);
  });

  it("requires epoch and seq on event frames, and protocol on hello", () => {
    expect(EventFrame.safeParse({ sub: "s1", seq: 3, event: {} }).success).toBe(false);
    expect(EventFrame.safeParse({ sub: "s1", epoch: "e", seq: 3, event: {} }).success).toBe(true);
    expect(HelloFrame.safeParse({ protocol: 1, capabilities: ["rpc"], serverVersion: "0.0.0" }).success).toBe(
      true,
    );
  });
});
