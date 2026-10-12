import { describe, expect, it } from "vitest";
import { splitApproval } from "./approval-detail.ts";

describe("splitApproval", () => {
  it("keeps the policy's header line apart, so the size line stays pinned", () => {
    expect(splitApproval("12 characters, 1 line\nbash: echo hello")).toEqual({
      header: "12 characters, 1 line",
      body: "bash: echo hello",
    });
  });

  it("keeps every other line of the message exactly as sent", () => {
    const message = "4 characters, 3 lines\n→ /etc/hosts (outside the session directory)\n\n\n  write: {}\t";
    expect(splitApproval(message).body).toBe(message.split("\n").slice(1).join("\n"));
  });

  it("has no header for a message of one line or none", () => {
    expect(splitApproval("one line")).toEqual({ header: null, body: "one line" });
    expect(splitApproval(undefined)).toEqual({ header: null, body: "" });
    expect(splitApproval("")).toEqual({ header: null, body: "" });
  });
});
