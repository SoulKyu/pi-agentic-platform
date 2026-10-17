import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALLOW_03, createPipelineBed, interactiveRules } from "../testing/pipeline-bed.ts";
import { DENYLIST_MODEL_REASON } from "./denylist.ts";
import { classifyTool, SANDBOX_SOURCE } from "./tool-kind.ts";

const off = { path: SANDBOX_SOURCE, sandboxNetwork: false };
const on = { path: SANDBOX_SOURCE, sandboxNetwork: true };

describe("classifyTool for pap's sandboxed shell (M11R25, W5-R9, W5-R11)", () => {
  it("pins the source", () => {
    expect(SANDBOX_SOURCE).toBe("<inline:pap-sandbox>");
  });

  it("a network-off shell is an exec tool that taints nothing", () => {
    expect(classifyTool("bash", off)).toEqual({
      category: "exec",
      external: false,
      urlBearing: true,
      mcp: false,
      builtin: false,
      sandboxed: true,
    });
  });

  it("a networked shell is external: its first result taints the thread", () => {
    expect(classifyTool("bash", on)).toMatchObject({ category: "exec", external: true, sandboxed: true });
  });

  it("sets `sandboxed` only for a `bash` from the sandbox source that knows its network", () => {
    expect(classifyTool("bash", { path: "builtin:bash" }).sandboxed).toBeUndefined();
    expect(classifyTool("bash", { path: "/home/u/.pi/agent/extensions/x.js" }).sandboxed).toBeUndefined();
    expect(classifyTool("bash", undefined).sandboxed).toBeUndefined();
    // A source without a sandbox in the worker's init (nothing declared its network): unknown, fail closed.
    expect(classifyTool("bash", { path: SANDBOX_SOURCE })).toMatchObject({
      category: "unknown",
      external: true,
      builtin: false,
    });
    expect(classifyTool("bash", { path: SANDBOX_SOURCE }).sandboxed).toBeUndefined();
    // Only `bash`: another name from the source is not the shell.
    expect(classifyTool("powershell", off)).toMatchObject({ category: "unknown", external: true });
    expect(classifyTool("read", off).sandboxed).toBeUndefined();
  });

  it("a facts object claiming the network from another source is not trusted", () => {
    expect(classifyTool("bash", { path: "/x/ext.js", sandboxNetwork: false }).sandboxed).toBeUndefined();
    const own = classifyTool("bash", { path: "builtin:bash", sandboxNetwork: false });
    expect(own.builtin).toBe(true);
    expect(own.sandboxed).toBeUndefined();
  });
});

describe("the pipeline treats the sandboxed shell's command as a command", () => {
  let bed: Awaited<ReturnType<typeof createPipelineBed>>;
  beforeAll(async () => {
    bed = await createPipelineBed();
  });
  afterAll(() => bed.dispose());

  it("runs the denylist over it", async () => {
    const h = bed.harness({ rules: () => interactiveRules, stages: ALLOW_03, tools: { bash: off } });
    expect(await h.run("bash", { command: "rm -rf /" })).toEqual({
      block: true,
      reason: DENYLIST_MODEL_REASON,
    });
  });

  it("audits and keys the call by its command, like Pi's own bash", async () => {
    const mine = bed.harness({ stages: ALLOW_03, tools: { bash: off } });
    const pi = bed.harness({ stages: ALLOW_03 });
    await mine.run("bash", { command: "echo hello" });
    await pi.run("bash", { command: "echo hello" });
    const args = (entries: readonly { kind: string; args?: string }[]) => entries.at(-1)?.args;
    expect(args(mine.entries as never)).toBe(args(pi.entries as never));
    expect(args(mine.entries as never)).toContain("echo hello");
  });
});
