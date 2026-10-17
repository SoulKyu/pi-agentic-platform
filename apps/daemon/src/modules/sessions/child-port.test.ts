import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PolicyRules } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { narrowTools } from "./child-port.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { fakePolicyPort, initRecordOf } from "./testing/fake-policy.ts";
import { captureLogger, codeOf } from "./testing/helpers.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed?.dispose());

const ROOMY = { maxWorkers: 10, minFreeMemMb: 0 };
const model = { provider: "faux", id: "plain", name: "Plain", reasoning: false };
const loadout = {
  model,
  thinkingLevel: "off",
  levels: ["off"],
  preset: "configured",
  tools: ["read"],
  toolsTruncated: false,
};
const rulesOf = (index: number) => PolicyRules.parse(initRecordOf(bed.spawned[index])?.policy);
const child = (parent: string, profile?: { tools?: string[] | null; prompt?: string; model?: string }) =>
  bed.service.child.createChildSession({
    ownerId: "u1",
    parentSessionId: parent,
    ...(profile
      ? {
          profile: {
            tools: profile.tools ?? null,
            prompt: profile.prompt ?? null,
            model: profile.model ?? null,
          },
        }
      : {}),
  });

describe("narrowTools (M11R136, review I1)", () => {
  const live = (tools: string[], toolsTruncated = false) => ({ tools, toolsTruncated });
  it("keeps the names the parent's worker has active, once each, and drops the others", () => {
    expect(narrowTools(["read", "bash", "grep", "mcp__x", "read"], live(["read", "grep", "mcp__x"]))).toEqual(
      ["read", "grep", "mcp__x"],
    );
    expect(narrowTools(["bash", "edit"], live(["read", "edit"]))).toEqual(["edit"]);
    expect(narrowTools(["mcp__y"], live(["read"]))).toEqual([]);
  });

  it("refuses any list when the parent has said no loadout (fail closed), and keeps only the known prefix of a cut one", () => {
    expect(narrowTools(["read", "bash", "powershell", "mcp__x"], null)).toEqual([]);
    expect(narrowTools(["read", "bash", "mcp__x", "mcp__y"], live(["read", "mcp__x"], true))).toEqual([
      "read",
      "mcp__x",
    ]);
  });
});

describe("a child of a plain session (M11R136)", () => {
  it("is a session in the parent's folder with the parent's id on its row, and no agent", async () => {
    bed = build();
    const parent = await bed.service.create(bed.work, OWNER);
    const made = await child(parent.sessionId);
    expect(bed.store.get(made.sessionId)).toMatchObject({
      parentSessionId: parent.sessionId,
      cwd: bed.work,
      ownerId: "u1",
    });
    expect(bed.store.get(made.sessionId)?.agentId).toBeUndefined();
    expect(bed.store.get(made.sessionId)?.agentRole).toBeUndefined();
    // Its type is `child`: no platform tool at all (depth 1).
    expect(initRecordOf(bed.spawned[1])?.platform).toEqual({ ops: [] });
  });

  it("narrows the profile's tools to the parent's active tools and refuses an empty result", async () => {
    bed = build({ replies: { set_model: {} } });
    const parent = await bed.service.create(bed.work, OWNER, "read-only");
    bed.spawned[0]?.emitRaw({
      type: "loadout",
      loadout: { ...loadout, preset: "read-only", tools: ["read", "grep"] },
    });
    const made = await child(parent.sessionId, { tools: ["read", "bash", "grep"] });
    expect(initRecordOf(bed.spawned[1])?.tools).toEqual({ preset: "read-only", allowlist: ["read", "grep"] });
    expect(rulesOf(1).toolAllowlist).toEqual(["read", "grep"]);
    expect(rulesOf(1).unattended).toBe(false);
    expect(made.sessionId).not.toBe(parent.sessionId);
    expect(await codeOf(child(parent.sessionId, { tools: ["bash", "edit"] }))).toBe("bad_request");
    expect(bed.spawned).toHaveLength(2);
  });

  it("under a configured parent, drops a tool its worker does not have, whatever the profile lists", async () => {
    bed = build({ replies: { set_model: {} } });
    const parent = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.emitRaw({ type: "loadout", loadout: { ...loadout, tools: ["read", "edit"] } });
    await child(parent.sessionId, { tools: ["bash", "edit"] });
    expect(rulesOf(1).toolAllowlist).toEqual(["edit"]);
    expect(initRecordOf(bed.spawned[1])?.tools?.allowlist).toEqual(["edit"]);
    expect(await codeOf(child(parent.sessionId, { tools: ["bash"] }))).toBe("bad_request");
  });

  it("refuses a tool list while the parent has no loadout, and keeps the known prefix of a cut one", async () => {
    bed = build({ limits: ROOMY, replies: { set_model: {} } });
    const parent = await bed.service.create(bed.work, OWNER);
    expect(await codeOf(child(parent.sessionId, { tools: ["bash", "mcp__x"] }))).toBe("bad_request");
    expect(bed.spawned).toHaveLength(1);
    bed.spawned[0]?.emitRaw({
      type: "loadout",
      loadout: { ...loadout, tools: ["read", "mcp__x"], toolsTruncated: true },
    });
    await child(parent.sessionId, { tools: ["bash", "mcp__x", "mcp__z"] });
    expect(rulesOf(1).toolAllowlist).toEqual(["mcp__x"]);
  });

  it("keeps the parent's preset alone when the profile names no tools", async () => {
    bed = build();
    const parent = await bed.service.create(bed.work, OWNER, "full");
    await child(parent.sessionId, { prompt: "p" });
    expect(initRecordOf(bed.spawned[1])?.tools).toEqual({ preset: "full" });
    expect(rulesOf(1).toolAllowlist).toBeNull();
  });

  it("takes the parent's mode, and full-access becomes auto-accept-edits", async () => {
    const policy = fakePolicyPort();
    bed = build({ policy, limits: ROOMY });
    const parent = await bed.service.create(bed.work, OWNER);
    policy.setMode("u1", parent.sessionId, "supervised");
    const first = await child(parent.sessionId);
    expect(rulesOf(1).approvalMode).toBe("supervised");
    expect(policy.sessionPolicy("u1", first.sessionId).mode).toBe("supervised");
    policy.setMode("u1", parent.sessionId, "full-access");
    const second = await child(parent.sessionId);
    expect(rulesOf(2).approvalMode).toBe("auto-accept-edits");
    expect(policy.sessionPolicy("u1", second.sessionId).mode).toBe("auto-accept-edits");
    policy.setMode("u1", parent.sessionId, "read-only");
    await child(parent.sessionId);
    expect(rulesOf(3).approvalMode).toBe("read-only");
  });

  it("starts tainted when the parent is, in its first rules and in its stored policy, and clean otherwise", async () => {
    const policy = fakePolicyPort();
    bed = build({ policy, limits: ROOMY });
    const parent = await bed.service.create(bed.work, OWNER);
    const clean = await child(parent.sessionId);
    expect(clean.tainted).toBe(false);
    expect(rulesOf(1).taint.tainted).toBe(false);
    policy.markTainted("u1", parent.sessionId);
    const tainted = await child(parent.sessionId);
    expect(tainted.tainted).toBe(true);
    expect(rulesOf(2).taint.tainted).toBe(true);
    expect(policy.taintOf(tainted.sessionId).tainted).toBe(true);
    expect(policy.taintOf(clean.sessionId).tainted).toBe(false);
  });

  it("appends the profile's prompt at the first start and at every later one", async () => {
    bed = build();
    const parent = await bed.service.create(bed.work, OWNER);
    const made = await child(parent.sessionId, { prompt: "You scout." });
    expect(initRecordOf(bed.spawned[1])).toMatchObject({ child: { prompt: "You scout." } });
    expect(initRecordOf(bed.spawned[0])).not.toHaveProperty("child");
    expect(bed.service.releaseIdle(OWNER.userId, made.sessionId)).toBe("released");
    await bed.spawned[1]?.exited;
    await bed.service.reopen(made.sessionId, OWNER);
    expect(initRecordOf(bed.spawned[2])).toMatchObject({ child: { prompt: "You scout." } });
  });

  it("keeps the prompt in a 0600 file in a 0700 folder under $PAP_HOME/subagents, written before the row (W5-R62)", async () => {
    bed = build();
    const parent = await bed.service.create(bed.work, OWNER);
    const made = await child(parent.sessionId, { prompt: "You scout." });
    const folder = join(bed.dir, "pap", "subagents");
    const file = join(folder, `${made.sessionId}.prompt`);
    expect(readFileSync(file, "utf8")).toBe("You scout.");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
  });

  it("starts a reopened child with the prompt the file holds, not one in memory (a restart keeps it)", async () => {
    bed = build();
    const parent = await bed.service.create(bed.work, OWNER);
    const made = await child(parent.sessionId, { prompt: "You scout." });
    writeFileSync(join(bed.dir, "pap", "subagents", `${made.sessionId}.prompt`), "Edited on disk.");
    bed.service.releaseIdle(OWNER.userId, made.sessionId);
    await bed.spawned[1]?.exited;
    await bed.service.reopen(made.sessionId, OWNER);
    expect(initRecordOf(bed.spawned[2])).toMatchObject({ child: { prompt: "Edited on disk." } });
  });

  it("makes an existing subagents folder 0700 again (as an agent's home is)", async () => {
    bed = build();
    mkdirSync(join(bed.dir, "pap", "subagents"), { recursive: true, mode: 0o755 });
    chmodSync(join(bed.dir, "pap", "subagents"), 0o755);
    const parent = await bed.service.create(bed.work, OWNER);
    await child(parent.sessionId, { prompt: "p" });
    expect(statSync(join(bed.dir, "pap", "subagents")).mode & 0o777).toBe(0o700);
  });

  it("logs child_prompt_missing and still starts the child, with its limits, when the file is gone", async () => {
    const logs = captureLogger();
    bed = build({ logger: logs.logger });
    const parent = await bed.service.create(bed.work, OWNER);
    const made = await child(parent.sessionId, { prompt: "You scout.", tools: null });
    rmSync(join(bed.dir, "pap", "subagents", `${made.sessionId}.prompt`));
    bed.service.releaseIdle(OWNER.userId, made.sessionId);
    await bed.spawned[1]?.exited;
    await bed.service.reopen(made.sessionId, OWNER);
    expect(initRecordOf(bed.spawned[2])).not.toHaveProperty("child");
    expect(logs.lines.map((line) => JSON.stringify(line)).join("\n")).toContain("child_prompt_missing");
  });

  it("says nothing for a child whose profile had no prompt", async () => {
    const logs = captureLogger();
    bed = build({ logger: logs.logger });
    const parent = await bed.service.create(bed.work, OWNER);
    const made = await child(parent.sessionId);
    bed.service.releaseIdle(OWNER.userId, made.sessionId);
    await bed.spawned[1]?.exited;
    await bed.service.reopen(made.sessionId, OWNER);
    expect(initRecordOf(bed.spawned[2])).not.toHaveProperty("child");
    expect(JSON.stringify(logs.lines)).not.toContain("child_prompt_missing");
  });

  it("removes the file when the child never started", async () => {
    bed = build({ start: (index) => (index === 1 ? { kind: "exit70" } : undefined) });
    const parent = await bed.service.create(bed.work, OWNER);
    await codeOf(child(parent.sessionId, { prompt: "You scout." }));
    const folder = join(bed.dir, "pap", "subagents");
    expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([]);
  });

  it("sets the profile's model, else the parent's, on the child's worker only", async () => {
    bed = build({ replies: { set_model: {} }, limits: ROOMY });
    const parent = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.emitRaw({ type: "loadout", loadout });
    await child(parent.sessionId);
    await child(parent.sessionId, { model: "fast" });
    await child(parent.sessionId, { model: "other/deep" });
    const models = (index: number) => bed.spawned[index]?.requests.filter((r) => r.type === "set_model");
    expect(models(0)).toEqual([]);
    expect(models(1)).toMatchObject([{ provider: "faux", modelId: "plain" }]);
    expect(models(2)).toMatchObject([{ provider: "faux", modelId: "fast" }]);
    expect(models(3)).toMatchObject([{ provider: "other", modelId: "deep" }]);
  });

  it("still makes the child when the model is refused", async () => {
    bed = build({ replies: { set_model: { success: false, error: "no such model" } } });
    const parent = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.emitRaw({ type: "loadout", loadout });
    expect(bed.store.get((await child(parent.sessionId)).sessionId)).toBeDefined();
  });

  it("is not_found for another owner's or an unknown parent, and bad_request for a child as parent", async () => {
    bed = build();
    const parent = await bed.service.create(bed.work, OWNER);
    const made = await child(parent.sessionId);
    expect(
      await codeOf(
        bed.service.child.createChildSession({ ownerId: "u2", parentSessionId: parent.sessionId }),
      ),
    ).toBe("not_found");
    expect(await codeOf(child("nope"))).toBe("not_found");
    expect(await codeOf(child(made.sessionId))).toBe("bad_request");
    expect(bed.spawned).toHaveLength(2);
  });

  it("never takes the owner's last worker (M10R154) and says so before it", async () => {
    bed = build({ limits: { maxWorkers: 2, minFreeMemMb: 0 } });
    const parent = await bed.service.create(bed.work, OWNER);
    expect(bed.service.child.admits("u1")).toBe(false);
    expect(await codeOf(child(parent.sessionId))).toBe("capacity");
    expect(bed.spawned).toHaveLength(1);
    const roomy = build({ limits: { maxWorkers: 4, minFreeMemMb: 0 } });
    await roomy.service.create(roomy.work, OWNER);
    expect(roomy.service.child.admits("u1")).toBe(true);
    roomy.dispose();
  });

  it("reads its last text only for the owner's child", async () => {
    bed = build();
    const parent = await bed.service.create(bed.work, OWNER);
    const made = await child(parent.sessionId);
    expect(await bed.service.child.lastText("u2", made.sessionId, 100)).toBeNull();
    expect(await bed.service.child.lastText("u1", parent.sessionId, 100)).toBeNull();
  });
});
