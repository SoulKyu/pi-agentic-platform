import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PolicyRules } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { grantKey, grantPayload } from "./policy/grant-key.ts";
import { createHostBed, isApproval } from "./testing/host-bed.ts";

const WORKER = { timeoutMs: 30_000 };
// A stand-in for pi-mem0: at `session_start` it records what pi-mem0 reads (the newest `pi-web:agent-profile` entry and
// PI_MEM0_CAPTURE), at `agent_end` the custom entries of the session. pi-mem0 itself is never loaded in tests.
const MEMORY_EXTENSION = `import { appendFileSync } from "node:fs";
const log = (line) => appendFileSync(process.env.MEM_REC, JSON.stringify(line) + "\\n");
export default function (pi) {
  pi.on("session_start", (_event, ctx) => {
    let profile = null;
    for (const e of ctx.sessionManager.getEntries())
      if (e.type === "custom" && e.customType === "pi-web:agent-profile" && e.data?.version === 1) profile = e.data;
    log({ at: "session_start", profile, capture: process.env.PI_MEM0_CAPTURE ?? null });
  });
  pi.on("agent_end", (_event, ctx) => {
    log({
      at: "agent_end",
      custom: ctx.sessionManager.getEntries().filter((e) => e.type === "custom").map((e) => [e.customType, e.data]),
    });
  });
}
`;
const LOOKUP_EXTENSION = `export default function (pi) {
  pi.registerTool({
    name: "lookup",
    label: "lookup",
    description: "looks something up",
    parameters: { type: "object", properties: { q: { type: "string" } }, additionalProperties: true },
    execute: async () => ({ content: [{ type: "text", text: "outside words" }], details: {} }),
  });
}
`;
const RULES = PolicyRules.parse({
  profile: "interactive",
  approvalMode: "auto-accept-edits",
  readOnlyCommands: false,
  alwaysAllow: [{ tool: "lookup", key: grantKey("lookup", grantPayload({ q: "x" }, false)) }],
});

let bed: ReturnType<typeof createHostBed>;
let record: string;
beforeEach(() => {
  bed = createHostBed();
  record = join(bed.root, "memory.jsonl");
});
afterEach(() => bed.dispose());

const saw = (): Array<Record<string, unknown>> =>
  readFileSync(record, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

async function run(init: Record<string, unknown>, steps: object[] = [{ text: "ok" }]) {
  await bed.start(
    { steps },
    {
      policy: RULES,
      init,
      env: { MEM_REC: record },
      agentFiles: { "extensions/mem.js": MEMORY_EXTENSION, "extensions/lookup.js": LOOKUP_EXTENSION },
    },
  );
  const host = bed.host();
  host.send({ type: "prompt", id: "p1", message: "go" });
  await host.waitFor((r) => r.type === "agent_settled", WORKER);
  return saw();
}

describe("pi-host worker: what pi-mem0 is told (M11R142)", () => {
  it("an agent thread sees its trusted entry with the policy before extensions start", async () => {
    const seen = await run({
      memory: { profile: "atlas-1a2b", trust: "trusted", memory: { capture: "auto", save: "staged" } },
    });
    expect(seen[0]).toMatchObject({
      at: "session_start",
      profile: {
        version: 1,
        profile: "atlas-1a2b",
        trust: "trusted",
        memory: { capture: "auto", save: "staged" },
      },
      capture: null,
    });
  });

  it("an agent task sees an untrusted entry with its profile", async () => {
    const seen = await run({ memory: { profile: "atlas-1a2b", trust: "untrusted" } });
    expect(seen[0]).toMatchObject({ profile: { profile: "atlas-1a2b", trust: "untrusted" } });
  });

  // PI_MEM0_CAPTURE=0 is the daemon's to set (the bed refuses PI_* variables): security/memory-trust.int.test.ts asserts it.
  it("a session tainted at start sees the empty profile", async () => {
    const seen = await run({ memory: { profile: "", trust: "untrusted" } });
    expect(seen[0]).toMatchObject({ profile: { version: 1, profile: "", trust: "untrusted" } });
  });

  it("an ordinary plain session gets no entry at all", async () => {
    const seen = await run({});
    expect(seen[0]).toMatchObject({ at: "session_start", profile: null });
  });

  it("a session that becomes tainted mid-run gets pap:memory-trust before agent_end", async () => {
    const seen = await run({}, [
      { toolCalls: [{ name: "lookup", args: { q: "x" }, id: "l1" }] },
      { text: "done" },
    ]);
    const end = seen.find((line) => line.at === "agent_end");
    expect(end?.custom).toContainEqual(["pap:memory-trust", { version: 1, trust: "untrusted" }]);
    // The entry is written once, however many times the taint is reported.
    expect((end?.custom as unknown[][]).filter(([name]) => name === "pap:memory-trust")).toHaveLength(1);
  });

  it("a session that started untainted but with no taint raised writes no pap:memory-trust", async () => {
    const seen = await run({ memory: { profile: "atlas-1a2b", trust: "trusted" } });
    const end = seen.find((line) => line.at === "agent_end");
    expect((end?.custom as unknown[][]).map(([name]) => name)).not.toContain("pap:memory-trust");
  });
});

// pi-mem0's explicit tools are plain extension tools to pap (M11R144): nothing to add, only to keep true.
const MEMORY_TOOLS = (names: string[]) =>
  `export default function (pi) {
${names
  .map(
    (name) => `  pi.registerTool({
    name: ${JSON.stringify(name)},
    label: ${JSON.stringify(name)},
    description: "memory",
    parameters: { type: "object", properties: { text: { type: "string" } }, additionalProperties: true },
    execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
  });`,
  )
  .join("\n")}
}
`;

describe("pi-host worker: pi-mem0's explicit tools ask (M11R144)", () => {
  for (const name of ["memory_save", "memory_forget"]) {
    for (const tainted of [false, true]) {
      it(`${name} asks${tainted ? " with Deny / Allow once only in a tainted session" : " in the default mode"}`, async () => {
        const policy = PolicyRules.parse({
          profile: "interactive",
          approvalMode: "auto-accept-edits",
          readOnlyCommands: false,
          ...(tainted ? { taint: { tainted: true, epoch: 1 } } : {}),
        });
        await bed.start(
          { steps: [{ toolCalls: [{ name, args: { text: "x" }, id: "m1" }] }, { text: "done" }] },
          {
            policy,
            agentFiles: { "extensions/memory-tools.js": MEMORY_TOOLS(["memory_save", "memory_forget"]) },
          },
        );
        const host = bed.host();
        host.send({ type: "prompt", id: "p1", message: "go" });
        const ask = await host.waitFor(isApproval, WORKER);
        expect(ask).toMatchObject({ tool: name });
        if (tainted) expect(ask).toMatchObject({ tainted: true, answers: ["deny", "once"] });
        else expect(ask.answers).toContain("once");
      });
    }
  }
});
