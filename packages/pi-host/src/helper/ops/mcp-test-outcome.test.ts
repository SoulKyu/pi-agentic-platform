import { McpTestOutcome } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { classifyTestOutcome } from "./mcp-test-outcome.ts";
import { HANDLER_FAILED_NOTICE } from "./mcp-test.ts";

/** The SDK's own wording (extensions/mcp/index.js, `reportProblems` and `describeState`), pinned here and against the SDK in mcp-test.signin.test.ts. */
const SIGN_IN = "MCP servers need attention:\n  remote: needs sign-in\nRun /mcp to fix.";
const failure = (line: string) => `MCP servers need attention:\n  fix: failed: ${line}\nRun /mcp to fix.`;

describe("classifyTestOutcome", () => {
  it("answers connected, with the tool names, when tools are present", () => {
    expect(classifyTestOutcome([], ["echo", "ping"], false)).toEqual({
      state: "connected",
      tools: ["echo", "ping"],
      toolsTruncated: false,
      message: null,
    });
  });

  it("answers connected for a server that connected and offers no tool (nothing to report, in time)", () => {
    expect(classifyTestOutcome([], [], false)).toMatchObject({ state: "connected", tools: [] });
  });

  it("answers needs-sign-in for the SDK's sign-in notice, with no message", () => {
    expect(classifyTestOutcome([SIGN_IN], [], false)).toEqual({
      state: "needs-sign-in",
      tools: [],
      toolsTruncated: false,
      message: null,
    });
  });

  it("does not take a failure whose own text ends in the sign-in words for a sign-in", () => {
    const outcome = classifyTestOutcome([failure("the proxy says: needs sign-in")], [], false);
    expect(outcome.state).toBe("failed");
  });

  it("answers failed with the failure line, without the notice's header and footer", () => {
    const outcome = classifyTestOutcome([failure("spawn nope ENOENT")], [], false);
    expect(outcome).toEqual({
      state: "failed",
      tools: [],
      toolsTruncated: false,
      message: "fix: failed: spawn nope ENOENT",
    });
  });

  it("masks credentials in the message, word by word (M7R95)", () => {
    const outcome = classifyTestOutcome(
      [failure("refused --api-key sk-live-ABCDEF123456 and Authorization: Bearer abc123def token=hunter2")],
      [],
      false,
    );
    expect(outcome.message).toBe(
      "fix: failed: refused --api-key ••• and Authorization: Bearer ••• token=•••",
    );
    expect(JSON.stringify(outcome)).not.toMatch(/sk-live|abc123def|hunter2/);
  });

  it("masks a token-like word and a URL's credentials", () => {
    const outcome = classifyTestOutcome(
      [
        failure(
          "GET https://user:pw@h.example/mcp?access_token=zzz failed with abcdefghijklmnopqrstuvwx1234",
        ),
      ],
      [],
      false,
    );
    expect(outcome.message).toBe(
      "fix: failed: GET https://•••@h.example/mcp?access_token=••• failed with •••",
    );
  });

  it("clips the message to 512 characters", () => {
    const outcome = classifyTestOutcome([failure("x ".repeat(2000))], [], false);
    expect(outcome.message).toHaveLength(512);
    expect(McpTestOutcome.safeParse(outcome).success).toBe(true);
  });

  it("answers timeout when nothing was reported by the deadline", () => {
    expect(classifyTestOutcome([], [], true)).toEqual({
      state: "timeout",
      tools: [],
      toolsTruncated: false,
      message: null,
    });
  });

  it("keeps a failure notice ahead of the deadline, and tools ahead of both", () => {
    expect(classifyTestOutcome([failure("boom")], [], true).state).toBe("failed");
    expect(classifyTestOutcome([failure("boom")], ["a"], true).state).toBe("connected");
  });

  it("lists at most 200 tool names, each clipped to 128, and says so", () => {
    const tools = Array.from({ length: 201 }, (_, i) => `t${i}${"x".repeat(200)}`);
    const outcome = classifyTestOutcome([], tools, false);
    expect(outcome.tools).toHaveLength(200);
    expect(outcome.toolsTruncated).toBe(true);
    expect(outcome.tools.every((name) => name.length === 128)).toBe(true);
    expect(McpTestOutcome.safeParse(outcome).success).toBe(true);
    expect(classifyTestOutcome([], tools.slice(0, 200), false).toolsTruncated).toBe(false);
  });

  it("takes the fixed notice of a rejected /mcp handler for a failure, never a connection (MC45 I2)", () => {
    expect(classifyTestOutcome([HANDLER_FAILED_NOTICE], [], false)).toMatchObject({
      state: "failed",
      message: HANDLER_FAILED_NOTICE,
    });
  });
});
