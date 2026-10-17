import { createHash } from "node:crypto";
import { APPROVAL_MODES, PLATFORM_OPS, PolicyRules } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { PLATFORM_SOURCE } from "./tool-kind.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeAll(async () => {
  bed = await createPipelineBed();
});
afterAll(() => bed.dispose());

const tools = Object.fromEntries(
  Object.values(PLATFORM_OPS).map((spec) => [spec.tool, { path: PLATFORM_SOURCE }]),
);
const rulesOf = (extra: object) =>
  PolicyRules.parse({
    profile: "agent-thread",
    approvalMode: "supervised",
    sandbox: { required: true, network: true },
    ...extra,
  });
const NO_NETWORK = "This agent has no network: a host grant would change nothing.";
const HOST = "api.example.com";

describe("network_request after the owner is asked (owner a2, M11R239)", () => {
  it.each(APPROVAL_MODES)("asks Deny / Allow this host in %s, tainted or not", async (approvalMode) => {
    for (const taint of [false, true]) {
      const h = bed.harness({ rules: () => rulesOf({ approvalMode }), tools, taint });
      await h.run("network_request", { host: HOST });
      expect(h.asks).toHaveLength(1);
      expect(h.asks[0]).toMatchObject({
        title: "pap: allow a host for this thread?",
        answers: ["deny", "host"],
        host: HOST,
        tool: "network_request",
      });
      expect(h.asks[0]?.message).toContain(
        `network_request asks for ${HOST}. If you allow it, this agent's shell can reach that host until the thread is reset, and can send it data.`,
      );
      expect(h.asks[0]?.alwaysScopes).toBeUndefined();
    }
  });

  it.each([
    ["network off", { sandbox: { required: true, network: false } }],
    ["sandbox off", { sandbox: { required: false, network: true } }],
    ["no sandbox profile", { sandbox: null }],
  ])("blocks with a fixed sentence and raises no card when the agent has %s", async (_name, extra) => {
    for (const taint of [false, true]) {
      const h = bed.harness({ rules: () => rulesOf(extra), tools, taint });
      expect(await h.run("network_request", { host: HOST })).toMatchObject({
        block: true,
        reason: expect.stringContaining(NO_NETWORK),
      });
      expect(h.asks).toHaveLength(0);
    }
  });

  it("a guard-tripped card offers Allow once and says that nothing is granted", async () => {
    const h = bed.harness({
      rules: () => ({ ...rulesOf({}), guard: { identicalCalls: 2, toolCalls: 150, turns: 60 } }),
      tools,
      answers: [
        { answer: "deny", closed: false },
        { answer: "once", closed: false },
      ],
    });
    h.runStart();
    await h.run("network_request", { host: HOST });
    await h.run("network_request", { host: HOST });
    const tripped = h.asks.at(1);
    expect(tripped).toMatchObject({
      guard: "identical-calls",
      answers: ["deny", "once"],
      tool: "network_request",
    });
    expect(tripped?.host).toBeUndefined();
    expect(tripped?.message).toContain(`network_request asks for ${HOST}.`);
    expect(tripped?.message).toContain("Allow once runs this call only: no host is granted");
    expect(tripped?.message).not.toContain("can reach that host");
  });

  it("blocks a host already granted all the same when the agent has no network", async () => {
    const h = bed.harness({
      rules: () => rulesOf({ hostGrants: [HOST], sandbox: { required: true, network: false } }),
      tools,
    });
    expect(await h.run("network_request", { host: HOST })).toMatchObject({ block: true });
    expect(h.asks).toHaveLength(0);
  });

  it("audits the requested host as a hash and a length, while the card keeps the exact host (W5-R54)", async () => {
    const h = bed.harness({ rules: () => rulesOf({}), tools, answers: [{ answer: "host", closed: false }] });
    await h.run("network_request", { host: HOST, reason: "docs" });
    expect(h.asks[0]).toMatchObject({ host: HOST });
    expect(h.asks[0]?.message).toContain(HOST);
    const hash = createHash("sha256").update(HOST).digest("hex").slice(0, 12);
    const call = h.entries.find((entry) => entry.kind === "call");
    expect(call).toMatchObject({ args: expect.stringContaining(`h:${hash} (len ${HOST.length})`) });
    expect(JSON.stringify(h.entries)).not.toContain(HOST);
  });

  it("runs after the host answer, with the reason answer: host", async () => {
    const h = bed.harness({
      rules: () => rulesOf({}),
      tools,
      answers: [{ answer: "host", closed: false }],
    });
    expect(await h.run("network_request", { host: HOST })).toBeUndefined();
    expect(h.entries.at(-1)).toMatchObject({ decision: "approved", reason: "answer: host" });
  });

  it("blocks after a deny", async () => {
    const h = bed.harness({ rules: () => rulesOf({}), tools, answers: [{ answer: "deny", closed: false }] });
    expect(await h.run("network_request", { host: HOST })).toMatchObject({ block: true });
  });

  it("does not remember the answer as a session or always rule: the next call asks again", async () => {
    const h = bed.harness({
      rules: () => rulesOf({}),
      tools,
      answers: [
        { answer: "host", closed: false },
        { answer: "host", closed: false },
      ],
    });
    await h.run("network_request", { host: HOST });
    await h.run("network_request", { host: HOST });
    expect(h.asks).toHaveLength(2);
  });

  it("asks again even when an always rule holds the call's key: no stored rule skips this card", async () => {
    const first = bed.harness({ rules: () => rulesOf({}), tools });
    await first.run("network_request", { host: HOST });
    const key = first.asks[0]?.key ?? "";
    const h = bed.harness({
      rules: () => rulesOf({ alwaysAllow: [{ tool: "network_request", key }] }),
      tools,
    });
    await h.run("network_request", { host: HOST });
    expect(h.asks).toHaveLength(1);
  });

  it("allows a host already granted, without a card", async () => {
    const h = bed.harness({ rules: () => rulesOf({ hostGrants: [HOST] }), tools, taint: true });
    expect(await h.run("network_request", { host: HOST })).toBeUndefined();
    expect(h.asks).toHaveLength(0);
    expect(h.entries.at(-1)).toMatchObject({ decision: "allow" });
  });

  it("asks for a host the grants do not hold", async () => {
    const h = bed.harness({ rules: () => rulesOf({ hostGrants: ["other.example.com"] }), tools });
    await h.run("network_request", { host: HOST });
    expect(h.asks).toHaveLength(1);
  });

  it.each(["93.184.216.34", "*.x.example", "localhost", "ex\u0430mple.com", "Api.example.com", ""])(
    "blocks %j before any card",
    async (host) => {
      const h = bed.harness({ rules: () => rulesOf({}), tools });
      expect(await h.run("network_request", { host })).toMatchObject({ block: true });
      expect(h.asks).toHaveLength(0);
    },
  );

  it("blocks an input without a host before any card", async () => {
    const h = bed.harness({ rules: () => rulesOf({}), tools });
    expect(await h.run("network_request", {})).toMatchObject({ block: true });
    expect(await h.run("network_request", "api.example.com")).toMatchObject({ block: true });
    expect(h.asks).toHaveLength(0);
  });
});
