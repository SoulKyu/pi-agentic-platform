import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  LoadExtensionsResult,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import type { AuditEntry, PolicyRules } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPapPolicyExtension,
  DENIED_REASON,
  evaluateToolCall,
  FAIL_CLOSED_REASON,
  movePolicyLast,
  POLICY_EXTENSION_PATH,
} from "./extension.ts";

const rules: PolicyRules = { profile: "interactive", approvalMode: "auto-accept-edits" };

let base: string;
let cwd: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "pap-policy-")));
  cwd = join(base, "proj");
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(join(base, "outside"), { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

interface HarnessOptions {
  confirm?: () => Promise<boolean>;
  rules?: () => PolicyRules | null;
  hasUI?: boolean;
  audit?: (entry: AuditEntry) => void;
}

function harness(options: HarnessOptions = {}) {
  const audits: AuditEntry[] = [];
  const asked: string[] = [];
  const run = (toolName: string, input: unknown) =>
    evaluateToolCall(
      { toolCallId: "c1", toolName, input },
      {
        hasUI: options.hasUI ?? true,
        cwd,
        ui: {
          confirm: async (title: string, message: string) => {
            asked.push(`${title}|${message}`);
            return (options.confirm ?? (async () => true))();
          },
        },
      },
      { rules: options.rules ?? (() => rules), audit: options.audit ?? ((entry) => audits.push(entry)) },
    );
  return { audits, asked, run };
}

describe("pap-policy approval stage", () => {
  it("allows read tools and edits inside the session directory without asking", async () => {
    const h = harness();
    expect(await h.run("read", { path: "a.ts" })).toBeUndefined();
    expect(await h.run("write", { path: "src/a.ts", content: "x" })).toBeUndefined();
    expect(await h.run("edit", { path: join(cwd, "src", "b.ts"), edits: [] })).toBeUndefined();
    expect(h.asked).toEqual([]);
    expect(h.audits.map((a) => a.decision)).toEqual(["allow", "allow", "allow"]);
  });

  it("asks before bash and lets it run when approved", async () => {
    const h = harness();
    expect(await h.run("bash", { command: "echo hi" })).toBeUndefined();
    expect(h.asked).toEqual(["Run a command?|bash: echo hi"]);
    expect(h.audits[0]).toEqual({ toolCallId: "c1", tool: "bash", category: "exec", decision: "approved" });
  });

  it("asks before a tool it does not know, and audits it as unknown", async () => {
    const h = harness();
    expect(await h.run("mcp__github__create_issue", { title: "t" })).toBeUndefined();
    expect(h.asked).toEqual(['Allow this tool?|mcp__github__create_issue: {"title":"t"}']);
    expect(h.audits[0]).toMatchObject({ category: "unknown", decision: "approved" });
  });

  it("blocks with the user's reason when denied", async () => {
    const h = harness({ confirm: async () => false });
    expect(await h.run("bash", { command: "rm -rf build" })).toEqual({ block: true, reason: DENIED_REASON });
    expect(h.audits[0]?.decision).toBe("denied");
  });

  it("blocks every call, even reads, when the rules are missing (fail closed)", async () => {
    const h = harness({ rules: () => null });
    expect(await h.run("read", { path: "a.ts" })).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
    expect(h.asked).toEqual([]);
    expect(h.audits).toEqual([
      {
        toolCallId: "c1",
        tool: "read",
        category: "read",
        decision: "block",
        reason: "no valid policy rules",
      },
    ]);
  });

  it("reads the rules again on every call, so a policy update applies at once", async () => {
    let current: PolicyRules | null = null;
    const h = harness({ rules: () => current });
    expect((await h.run("read", { path: "a" }))?.block).toBe(true);
    current = rules;
    expect(await h.run("read", { path: "a" })).toBeUndefined();
    current = null;
    expect((await h.run("read", { path: "a" }))?.block).toBe(true);
  });

  it("blocks every category under rules it does not understand", async () => {
    const future = { profile: "isolated-task", approvalMode: "auto-accept-edits" } as unknown as PolicyRules;
    const h = harness({ rules: () => future });
    for (const tool of ["read", "write", "bash", "web_fetch", "something_else"]) {
      expect((await h.run(tool, { path: "a", command: "ls" }))?.block).toBe(true);
    }
    expect(h.asked).toEqual([]);
    expect(h.audits.every((a) => a.decision === "block")).toBe(true);
  });

  it("blocks when the dialog throws, when no UI is bound, or when the audit line fails", async () => {
    const throwing = harness({
      confirm: async () => {
        throw new Error("ui gone");
      },
    });
    expect(await throwing.run("bash", { command: "ls" })).toEqual({
      block: true,
      reason: FAIL_CLOSED_REASON,
    });
    expect(throwing.audits).toEqual([
      { toolCallId: "c1", tool: "bash", category: "exec", decision: "block", reason: "evaluation error" },
    ]);
    expect((await harness({ hasUI: false }).run("bash", { command: "ls" }))?.block).toBe(true);
    const failingAudit = harness({
      audit: () => {
        throw new Error("disk full");
      },
    });
    expect(await failingAudit.run("read", { path: "a" })).toEqual({
      block: true,
      reason: FAIL_CLOSED_REASON,
    });
  });

  it("blocks when the rules function throws or the input cannot be described", async () => {
    const brokenRules = harness({
      rules: () => {
        throw new Error("boom");
      },
    });
    expect(await brokenRules.run("read", { path: "a" })).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const h = harness();
    expect(await h.run("some_tool", circular)).toEqual({ block: true, reason: FAIL_CLOSED_REASON });
    expect(h.asked).toEqual([]);
  });

  it("blocks without asking when there is no UI to ask", async () => {
    const h = harness({ hasUI: false });
    expect(await h.run("bash", { command: "ls" })).toEqual({
      block: true,
      reason: "pap-policy blocked this exec call.",
    });
    expect(h.asked).toEqual([]);
    expect(h.audits[0]).toMatchObject({ decision: "block", reason: "no UI to ask" });
  });

  it("truncates very long payloads in the approval message", async () => {
    const h = harness();
    await h.run("bash", { command: "x".repeat(10_000) });
    expect(h.asked[0]?.length).toBeLessThan(4200);
    expect(h.asked[0]).toContain("(10000 characters)");
  });
});

describe("pap-policy edits outside the session directory", () => {
  it("asks before a path that leaves the directory by absolute path or by ..", async () => {
    const h = harness();
    expect(await h.run("write", { path: join(base, "outside", "a.txt"), content: "x" })).toBeUndefined();
    expect(await h.run("edit", { path: "../outside/b.txt", edits: [] })).toBeUndefined();
    expect(h.asked.map((m) => m.split("|")[0])).toEqual(["Allow this edit?", "Allow this edit?"]);
    expect(h.audits).toEqual([
      {
        toolCallId: "c1",
        tool: "write",
        category: "edit",
        decision: "approved",
        reason: "outside the session directory",
      },
      {
        toolCallId: "c1",
        tool: "edit",
        category: "edit",
        decision: "approved",
        reason: "outside the session directory",
      },
    ]);
  });

  it("asks before a path that leaves the directory through a symlink", async () => {
    await symlink(join(base, "outside"), join(cwd, "link"), "dir");
    const h = harness({ confirm: async () => false });
    expect(await h.run("write", { path: "link/new.txt", content: "x" })).toEqual({
      block: true,
      reason: DENIED_REASON,
    });
    expect(h.asked).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({ decision: "denied", reason: "outside the session directory" });
  });

  it("asks when the edit has no usable path", async () => {
    for (const input of [{}, { path: 7 }, { path: "" }, null, "src/a.ts"]) {
      const h = harness({ confirm: async () => false });
      expect(await h.run("edit", input)).toEqual({ block: true, reason: DENIED_REASON });
      expect(h.asked).toHaveLength(1);
    }
  });

  it("blocks without asking when there is no UI", async () => {
    const h = harness({ hasUI: false });
    expect((await h.run("write", { path: "../outside/a.txt", content: "x" }))?.block).toBe(true);
    expect(h.asked).toEqual([]);
  });

  it("blocks when the session directory cannot be resolved", async () => {
    const h = harness();
    await rm(cwd, { recursive: true });
    expect(await h.run("write", { path: "a.txt", content: "x" })).toEqual({
      block: true,
      reason: FAIL_CLOSED_REASON,
    });
  });
});

describe("createPapPolicyExtension", () => {
  it("registers a tool_call handler that judges calls with its rules and audit", async () => {
    const audits: AuditEntry[] = [];
    const extension = createPapPolicyExtension({ rules: () => rules, audit: (entry) => audits.push(entry) });
    const handlers = new Map<
      string,
      (event: unknown, ctx: unknown) => Promise<ToolCallEventResult | undefined>
    >();
    await extension.factory({
      on: (name: string, handler: never) => handlers.set(name, handler),
    } as unknown as ExtensionAPI);
    expect([extension.name, extension.hidden, [...handlers.keys()]]).toEqual([
      "pap-policy",
      true,
      ["tool_call"],
    ]);
    const ctx = { hasUI: true, cwd, ui: { confirm: async () => false } };
    const blocked = await handlers.get("tool_call")?.(
      { toolCallId: "c9", toolName: "bash", input: { command: "ls" } },
      ctx,
    );
    expect(blocked).toEqual({ block: true, reason: DENIED_REASON });
    expect(audits).toEqual([{ toolCallId: "c9", tool: "bash", category: "exec", decision: "denied" }]);
  });
});

describe("movePolicyLast", () => {
  const ext = (path: string) => ({ path }) as unknown as LoadExtensionsResult["extensions"][number];
  const loaded = (paths: string[]) =>
    ({ extensions: paths.map(ext), errors: [], runtime: {} }) as unknown as LoadExtensionsResult;

  it("uses the path Pi reports for the inline extension", () => {
    expect(POLICY_EXTENSION_PATH).toBe("<inline:pap-policy>");
  });

  it("moves pap-policy after every other extension", () => {
    const result = movePolicyLast(loaded([POLICY_EXTENSION_PATH, "/user/a.ts", "/user/b.ts"]));
    expect(result.extensions.map((e) => e.path)).toEqual(["/user/a.ts", "/user/b.ts", POLICY_EXTENSION_PATH]);
  });

  it("keeps everything but the extension order", () => {
    const input = loaded(["/user/a.ts", POLICY_EXTENSION_PATH]);
    const result = movePolicyLast(input);
    expect(result.runtime).toBe(input.runtime);
    expect(result.errors).toBe(input.errors);
    expect(input.extensions.map((e) => e.path)).toEqual(["/user/a.ts", POLICY_EXTENSION_PATH]);
  });

  it("refuses to start a session without pap-policy", () => {
    expect(() => movePolicyLast(loaded(["/user/a.ts"]))).toThrow(/pap-policy/);
  });

  it("does not take a user extension whose path mentions pap-policy for the policy", () => {
    expect(() => movePolicyLast(loaded(["/user/pap-policy.ts", "/user/<inline:pap-policy>/x.ts"]))).toThrow(
      /pap-policy/,
    );
    const result = movePolicyLast(loaded(["/user/pap-policy.ts", POLICY_EXTENSION_PATH, "/user/b.ts"]));
    expect(result.extensions.map((e) => e.path)).toEqual([
      "/user/pap-policy.ts",
      "/user/b.ts",
      POLICY_EXTENSION_PATH,
    ]);
  });
});
