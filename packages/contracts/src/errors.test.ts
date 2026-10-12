import { describe, expect, it } from "vitest";
import { ERROR_CODES, ERROR_MESSAGES, PapError, ResponseFrame } from "./index.ts";

describe("error codes", () => {
  it("gives every code a fixed message of its own", () => {
    const messages = ERROR_CODES.map((code) => ERROR_MESSAGES[code]);
    expect(messages.every((message) => message.length > 0)).toBe(true);
    expect(new Set(messages).size).toBe(ERROR_CODES.length);
  });

  it("keeps a slow answer apart from a dead worker", () => {
    expect(ERROR_CODES).toContain("timeout");
    expect(new PapError("timeout").code).toBe("timeout");
    expect(new PapError("timeout").message).toBe("The session process did not answer in time.");
    expect(ERROR_MESSAGES.timeout).not.toBe(ERROR_MESSAGES.worker_failed);
  });

  it("has a fixed message for a command the worker refused, which names nothing the worker said", () => {
    expect(new PapError("command_failed").message).toBe("The session could not complete this command.");
  });

  it("has one shared message for a full list", () => {
    expect(ERROR_MESSAGES.limit_reached).toBe("This list is full. Remove an entry first.");
  });

  it("asks for the password again with a fixed message", () => {
    expect(ERROR_MESSAGES.step_up_required).toBe("Confirm your password to continue.");
  });

  it("has the shared full-list message, fixed (agreement 4)", () => {
    expect(ERROR_MESSAGES.limit_reached).toBe("This list is full. Remove an entry first.");
    expect(ERROR_CODES.indexOf("limit_reached")).toBe(ERROR_CODES.indexOf("command_failed") + 1);
  });

  it("travels in an error response frame", () => {
    expect(ResponseFrame.safeParse({ id: 1, ok: false, error: { code: "timeout" } }).success).toBe(true);
  });
});
