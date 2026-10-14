import { MCP_TEST_LIMITS, type McpTestOutcome } from "@pap/contracts";
import { maskArgs } from "../mask.ts";

/**
 * Pi's MCP extension reports a server that needs a sign-in as `<name>: needs sign-in` (a line of its "MCP servers need
 * attention" notice, extensions/mcp/index.js `describeState`), and a failed one as `<name>: failed: <first line of the
 * error>`. The wording is pinned against the SDK by mcp-test.signin.test.ts (M7R96).
 */
const SIGN_IN_LINE = /^(.+): needs sign-in$/;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The lines the notice is about: the indented ones of the "need attention" notice, else the whole text. */
function linesOf(notice: string): string[] {
  const lines = notice.split("\n");
  const body = lines.filter((line) => line.startsWith("  ")).map((line) => line.trim());
  return (body.length > 0 ? body : lines.map((line) => line.trim())).filter((line) => line !== "");
}

const isSignIn = (line: string): boolean => SIGN_IN_LINE.test(line) && !line.includes(": failed");

/** Every word through `maskArgs`, line by line (M7R95): a credential flag, header, pair, URL or token-like word becomes `•••`. */
const maskLine = (line: string): string =>
  maskArgs(line.split(/\s+/).filter((word) => word !== "")).join(" ");

/**
 * What a Test saw, as the panel may show it (M7R93, M7R95, M7R96). `notices` are the warnings and errors Pi's extension
 * raised, `tools` the server's tool names, `timedOut` whether the deadline passed first. Tools win (the server answered);
 * then a sign-in, then any other notice (the failure, masked and clipped), then the deadline. Nothing reported in time is
 * a server that connected and offers no tool.
 */
export function classifyTestOutcome(
  notices: readonly string[],
  tools: readonly string[],
  timedOut: boolean,
): McpTestOutcome {
  const listed = {
    tools: tools.slice(0, MCP_TEST_LIMITS.tools).map((name) => clip(name, MCP_TEST_LIMITS.toolName)),
    toolsTruncated: tools.length > MCP_TEST_LIMITS.tools,
  };
  const outcome = (state: McpTestOutcome["state"], message: string | null): McpTestOutcome => ({
    state,
    ...listed,
    message,
  });
  if (tools.length > 0) return outcome("connected", null);
  const lines = notices.flatMap(linesOf);
  if (lines.some(isSignIn)) return outcome("needs-sign-in", null);
  if (lines.length > 0)
    return outcome("failed", clip(lines.map(maskLine).join("\n"), MCP_TEST_LIMITS.message));
  return outcome(timedOut ? "timeout" : "connected", null);
}
