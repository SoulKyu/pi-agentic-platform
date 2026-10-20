import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NO_TAINT, PolicyRules } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApprovalAsk } from "../approvals.ts";
import { createPipelineBed, NO_SECRETS } from "../testing/pipeline-bed.ts";
import { createPapPolicyExtension } from "./extension.ts";
import { createTaint } from "./taint.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeEach(async () => {
  bed = await createPipelineBed();
});
afterEach(() => bed.dispose());

async function wire(taintedAtStart = false) {
  const handlers = new Map<string, Handler>();
  const taint = createTaint(
    taintedAtStart ? { tainted: true, epoch: 1 } : NO_TAINT,
    () => {},
    () => 42,
  );
  const asked: ApprovalAsk[] = [];
  const rules = PolicyRules.parse({ profile: "interactive", approvalMode: "auto-accept-edits" });
  const extension = createPapPolicyExtension({
    ...bed.config,
    taint,
    secrets: NO_SECRETS,
    rules: () => rules,
    rulesVersion: () => 0,
    audit: () => {},
    ask: async (request) => {
      asked.push(request);
      return { answer: "deny", closed: false };
    },
  });
  await extension.factory({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getAllTools: () => [
      { name: "todo", sourceInfo: { path: "/x/ext/todo.ts" } },
      { name: "bash", sourceInfo: { path: "builtin:bash" } },
    ],
    getActiveTools: () => ["todo", "bash"],
  } as unknown as ExtensionAPI);
  const result = (toolName: string) =>
    handlers.get("tool_result")?.(
      {
        type: "tool_result",
        toolCallId: "r1",
        toolName,
        input: {},
        isError: false,
        content: [{ type: "text", text: "done" }],
        details: undefined,
      },
      {},
    );
  const bash = (command: string) =>
    handlers.get("tool_call")?.(
      { toolCallId: "c1", toolName: "bash", input: { command } },
      { hasUI: true, cwd: join(bed.base, "proj"), signal: undefined },
    );
  return { asked, result, bash };
}

// Decision 117, A3: a card in a tainted session carries the causes the worker saw, and only those.
describe("the card names what tainted the session", () => {
  it("carries the cause of the external result", async () => {
    const { asked, result, bash } = await wire();
    await result("todo");
    await bash("npm run build");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      tainted: true,
      taintCauses: {
        list: [{ tool: "todo", source: "/x/ext/todo.ts", at: 42, count: 1, markable: true }],
        older: 0,
      },
    });
  });

  it("carries none in a clean session", async () => {
    const { asked, bash } = await wire();
    await bash("npm run build");
    expect(asked[0]?.tainted).toBe(false);
    expect(asked[0]).not.toHaveProperty("taintCauses");
  });

  it("carries none when the session was tainted before the worker saw it", async () => {
    const { asked, result, bash } = await wire(true);
    await result("todo");
    await bash("npm run build");
    expect(asked[0]?.tainted).toBe(true);
    expect(asked[0]).not.toHaveProperty("taintCauses");
  });
});
