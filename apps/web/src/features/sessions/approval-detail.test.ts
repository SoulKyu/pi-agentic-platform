import { describe, expect, it } from "vitest";
import { approvalDetail } from "./approval-detail.ts";

describe("approvalDetail", () => {
  it("puts the question on the policy's header line, so the size line stays pinned", () => {
    const message = "12 characters, 1 line\nbash: echo hello";
    const detail = approvalDetail({ title: "Run a command?", message });
    expect(detail.split("\n")[0]).toBe("Run a command? · 12 characters, 1 line");
    expect(detail.split("\n").slice(1)).toEqual(["bash: echo hello"]);
  });

  it("keeps every other line of the message exactly as sent", () => {
    const message = "4 characters, 3 lines\n→ /etc/hosts (outside the session directory)\n\n\n  write: {}\t";
    const rest = approvalDetail({ title: "Allow this edit?", message }).split("\n").slice(1);
    expect(rest).toEqual(message.split("\n").slice(1));
  });

  it("is the title alone when the dialog has no message", () => {
    expect(approvalDetail({ title: "Allow this tool?" })).toBe("Allow this tool?");
    expect(approvalDetail({ title: "Allow this tool?", message: "" })).toBe("Allow this tool?");
  });
});
