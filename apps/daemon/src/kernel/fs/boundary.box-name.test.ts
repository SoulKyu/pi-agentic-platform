import { describe, expect, it } from "vitest";
import { judgeBoxName } from "./boundary.ts";

describe("judgeBoxName", () => {
  it("lets a token see a project's own dev/, run/, proc/ and sys/ folders", () => {
    for (const folder of ["dev", "run", "proc", "sys"]) {
      expect(judgeBoxName(`/${folder}`, "token")).toBeNull();
      expect(judgeBoxName(`/${folder}/a/b.ts`, "token")).toBeNull();
    }
    expect(judgeBoxName("/", "token")).toBeNull();
  });

  it("still hides the real hidden names from a token, at any depth, and judges a session by no name", () => {
    expect(judgeBoxName("/.mcp.json", "token")).toBe("token_hidden");
    expect(judgeBoxName("/dev/.pi/mcp.json", "token")).toBe("token_hidden");
    expect(judgeBoxName("/dev/.mcp.json", "session")).toBeNull();
  });
});
