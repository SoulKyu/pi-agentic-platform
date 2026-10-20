import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NO_TAINT, PolicyRules, type ApprovalAnswer } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPipelineBed, NO_SECRETS } from "../testing/pipeline-bed.ts";
import { createPapPolicyExtension } from "./extension.ts";
import { createTaint } from "./taint.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
const TODO = "/x/ext/todo.ts";
const OTHER = "/x/ext/other.ts";
let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeEach(async () => {
  bed = await createPipelineBed();
});
afterEach(() => bed.dispose());

/** The real policy extension on a fake Pi, with the rules the daemon composes for an owner who vouched for `todo`. */
async function wire(localTools: Array<{ tool: string; source: string }>, extra: object = {}) {
  const handlers = new Map<string, Handler>();
  const taint = createTaint(NO_TAINT, () => {});
  const offered: Array<readonly ApprovalAnswer[]> = [];
  const rules = PolicyRules.parse({
    profile: "interactive",
    approvalMode: "auto-accept-edits",
    localTools,
    ...extra,
  });
  const extension = createPapPolicyExtension({
    ...bed.config,
    taint,
    secrets: NO_SECRETS,
    rules: () => rules,
    rulesVersion: () => 0,
    audit: () => {},
    ask: async (request) => {
      offered.push(request.answers);
      return { answer: "deny", closed: false };
    },
  });
  await extension.factory({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getAllTools: () => [
      { name: "todo", sourceInfo: { path: TODO } },
      { name: "other", sourceInfo: { path: OTHER } },
      { name: "bash", sourceInfo: { path: "builtin:bash" } },
    ],
    getActiveTools: () => ["todo", "other", "bash"],
  } as unknown as ExtensionAPI);
  let id = 0;
  const result = (toolName: string) =>
    handlers.get("tool_result")?.(
      {
        type: "tool_result",
        toolCallId: `r${++id}`,
        toolName,
        input: {},
        isError: false,
        content: [{ type: "text", text: "done" }],
        details: undefined,
      },
      {},
    );
  const call = (toolName: string, input: object) =>
    handlers.get("tool_call")?.(
      { toolCallId: `c${++id}`, toolName, input },
      { hasUI: true, cwd: join(bed.base, "proj"), signal: undefined },
    ) as Promise<{ block?: boolean } | undefined>;
  const bash = (command: string) => call("bash", { command });
  return { taint, offered, result, bash, call };
}

// Mutants (run for real, A2 report): extension.ts classifies results without the rules' list -> the first case fails;
// pipeline.ts classifies calls without it -> the own-call case fails.
describe("owner-declared local tools in the policy extension (decision 117, A2)", () => {
  it("does not taint on a local tool's result, so a later command gets the untainted card", async () => {
    const { taint, offered, result, bash } = await wire([{ tool: "todo", source: TODO }]);
    await result("todo");
    expect(taint.current()).toBe(false);
    await bash("npm run build");
    expect(offered).toEqual([["deny", "session", "always", "once"]]);
  });

  it("still taints on the result of an extension tool the owner did not list", async () => {
    const { taint, offered, result, bash } = await wire([{ tool: "todo", source: TODO }]);
    await result("other");
    expect(taint.current()).toBe(true);
    await bash("npm run build");
    expect(offered).toEqual([["deny", "once"]]);
  });

  it("runs the local tool's own call unasked, and asks for the same tool when it is not listed", async () => {
    const listed = await wire([{ tool: "todo", source: TODO }]);
    expect(await listed.call("todo", { items: [] })).toBeUndefined();
    expect(listed.offered).toEqual([]);
    const unlisted = await wire([]);
    await unlisted.call("todo", { items: [] });
    expect(unlisted.offered).toEqual([["deny", "session", "once"]]);
  });

  // The trade-off the consent copy states: a local tool's calls ask nothing in any mode, after external content too.
  it("runs a local tool's call unasked in a tainted session and in read-only mode", async () => {
    const tainted = await wire([{ tool: "todo", source: TODO }]);
    await tainted.result("other");
    expect(tainted.taint.current()).toBe(true);
    expect(await tainted.call("todo", { items: [] })).toBeUndefined();
    expect(tainted.offered).toEqual([]);
    const readOnly = await wire([{ tool: "todo", source: TODO }], { approvalMode: "read-only" });
    expect(await readOnly.call("todo", { items: [] })).toBeUndefined();
    expect(readOnly.offered).toEqual([]);
  });

  it("still blocks a local tool a trigger's allowlist does not name (APR-7)", async () => {
    const rules = { toolAllowlist: ["read"], unattended: true };
    const unlisted = await wire([{ tool: "todo", source: TODO }], rules);
    expect(await unlisted.call("todo", {})).toMatchObject({ block: true });
    const named = await wire([{ tool: "todo", source: TODO }], { ...rules, toolAllowlist: ["todo"] });
    expect(await named.call("todo", {})).toBeUndefined();
  });

  it("does not let an isolated task run a local tool: a non-built-in read is never inside its reach", async () => {
    const home = join(bed.papHome, "agents", "atlas-1a2b");
    const scratch = join(bed.papHome, "agents", ".runs", "t1");
    await mkdir(home, { recursive: true });
    await mkdir(scratch, { recursive: true });
    const task = await wire([{ tool: "todo", source: TODO }], {
      profile: "isolated-task",
      agentHome: home,
      agentScratch: scratch,
      sandbox: { required: true, network: false },
    });
    expect(await task.call("todo", {})).toMatchObject({ block: true });
  });

  it("taints on a tool that shares the name of a listed one but not its source", async () => {
    const { taint, result } = await wire([{ tool: "other", source: TODO }]);
    await result("other");
    expect(taint.current()).toBe(true);
  });

  it("taints on todo when no rule lists it", async () => {
    const { taint, result } = await wire([]);
    await result("todo");
    expect(taint.current()).toBe(true);
  });
});
