import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipelineBed, idleTaint, interactiveRules } from "../testing/pipeline-bed.ts";
import { createPapPolicyExtension } from "./extension.ts";
import { createRedactor } from "./redact.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

describe("the policy extension restores markers from the secret source", () => {
  it("restores an environment secret and leaves a provider credential (auth.json) as a marker", async () => {
    const redactor = createRedactor({
      entries: [
        { name: "DB_TOKEN", value: "env-value-0123" },
        { name: "AUTH_OPENAI_ACCESS", value: "auth-value-0123", restorable: false },
      ],
    });
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const extension = createPapPolicyExtension({
      taint: idleTaint(),
      rules: () => interactiveRules,
      rulesVersion: () => 0,
      audit: () => {},
      ...bed.config,
      secrets: { current: () => redactor, refresh: () => {} },
      ask: async () => ({ answer: "once", closed: false }),
    });
    await extension.factory({
      on: (name: string, handler: never) => handlers.set(name, handler),
      getAllTools: () => [{ name: "write", sourceInfo: { path: "builtin:write" } }],
      getActiveTools: () => ["write"],
    } as unknown as ExtensionAPI);
    const input = { path: join(bed.cwd, "a.txt"), content: "[SECRET:DB_TOKEN] [SECRET:AUTH_OPENAI_ACCESS]" };
    const result = await handlers.get("tool_call")?.(
      { toolCallId: "c", toolName: "write", input },
      { hasUI: true, cwd: bed.cwd },
    );
    expect(result).toBeUndefined();
    expect(input.content).toBe("env-value-0123 [SECRET:AUTH_OPENAI_ACCESS]");
  });
});
