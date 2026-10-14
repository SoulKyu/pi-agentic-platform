import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { PolicyAuditEntry } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPipelineBed, idleTaint, interactiveRules } from "../testing/pipeline-bed.ts";
import { SAFE_SHELL } from "./cover-bed.ts";
import { createPapPolicyExtension, type PolicyConfig } from "./extension.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeEach(async () => {
  bed = await createPipelineBed();
  writeFileSync(join(bed.cwd, "README.md"), "x\n");
});
afterEach(() => bed.dispose());

async function callCat(extra: Partial<PolicyConfig>) {
  const audits: PolicyAuditEntry[] = [];
  const asked: string[] = [];
  const extension = createPapPolicyExtension({
    taint: idleTaint(),
    rules: () => interactiveRules,
    rulesVersion: () => 0,
    audit: (entry) => audits.push(entry),
    ...bed.config,
    ask: async (request) => {
      asked.push(request.title);
      return { answer: "deny", closed: false };
    },
    ...extra,
  });
  let handler: ((event: unknown, ctx: unknown) => Promise<ToolCallEventResult | undefined>) | undefined;
  await extension.factory({
    on: (name: string, h: never) => void (name === "tool_call" && (handler = h)),
    getAllTools: () => [{ name: "bash", sourceInfo: { path: "builtin:bash" } }],
  } as unknown as ExtensionAPI);
  const result = await handler?.(
    { toolCallId: "c1", toolName: "bash", input: { command: "cat README.md" } },
    { hasUI: true, cwd: bed.cwd },
  );
  return { result, asked, audits };
}

describe("createPapPolicyExtension: shell facts for read-only commands", () => {
  it("covers nothing when the config gives no shell facts", async () => {
    const { result, asked } = await callCat({});
    expect(asked).toEqual(["Run a command?"]);
    expect(result).toMatchObject({ block: true });
  });

  it("runs a read-only command unasked when the config gives safe shell facts and a home", async () => {
    const { result, asked, audits } = await callCat({ shell: () => SAFE_SHELL, home: bed.base });
    expect(result).toBeUndefined();
    expect(asked).toEqual([]);
    expect(audits[0]).toMatchObject({ decision: "allow", reason: "read-only command" });
  });
});
