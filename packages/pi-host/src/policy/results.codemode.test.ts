import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { NO_TAINT } from "@pap/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRedactor } from "./redact.ts";
import { onToolResult, type ResultDeps } from "./results.ts";
import { createExternalRoots, createTaint } from "./taint.ts";
import { classifyTool, CODEMODE_SOURCE } from "./tool-kind.ts";

const FENCE_ID = "a1b2c3d4e5f6";
let quiet: { mockRestore(): void } | undefined;
beforeEach(() => {
  quiet = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => quiet?.mockRestore());

function setup(tainted: boolean, sources: Record<string, string>) {
  const taint = createTaint(NO_TAINT, () => {});
  if (tainted) taint.raise();
  const deps: ResultDeps = {
    secrets: { current: () => createRedactor({ entries: [] }), refresh: () => {} },
    audit: () => {},
    classify: (name) => classifyTool(name, { path: sources[name] ?? `builtin:${name}` }),
    taint,
    roots: createExternalRoots(),
    newFenceId: () => FENCE_ID,
  };
  return deps;
}
const result = (toolName: string, toolCallId: string): ToolResultEvent =>
  ({
    type: "tool_result",
    toolCallId,
    toolName,
    input: {},
    isError: false,
    content: [{ type: "text", text: "from load()" }],
    details: undefined,
  }) as unknown as ToolResultEvent;
const textOf = (out: ReturnType<typeof onToolResult>) =>
  (out?.content?.[0] as { text: string } | undefined)?.text;

// codemode store()/load() hand a stored MCP result back with no nested external call to mark the parent (M7 review I1).
it("fences a codemode result while the session is tainted", () => {
  const out = onToolResult(result("codemode", "cm2"), setup(true, { codemode: CODEMODE_SOURCE }));
  expect(textOf(out)).toBe(
    `<untrusted source="codemode" id="${FENCE_ID}">\nfrom load()\n</untrusted id="${FENCE_ID}">`,
  );
});

it("leaves a codemode result alone while the session is clean and nothing nested was external", () => {
  expect(
    onToolResult(result("codemode", "cm2"), setup(false, { codemode: CODEMODE_SOURCE })),
  ).toBeUndefined();
});
