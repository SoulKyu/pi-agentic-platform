import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TriggerInput } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeScript } from "../../security/testing/agent-bed.ts";
import { rows } from "../../security/testing/automation-bed.ts";
import { startVmBed, type VmBed } from "../../testing/vm-bed.ts";
import { processRootOf } from "../agent-vm/index.ts";

/*
 * K2 in a whole daemon on the process backend: a manual trigger on an agent's isolated task with "keep its folder" runs twice
 * on the same folder (the process root keyed by the trigger), every run starts tainted, a trigger without it does not see the
 * folder, and deleting the trigger removes it.
 */
let bed: VmBed | undefined;
afterEach(async () => {
  await bed?.stop();
  bed = undefined;
});

const write = (path: string, content: string, id: string) => ({
  toolCalls: [{ name: "write", args: { path, content }, id }],
});
const triggerInput = (agentId: string, name: string, keep: boolean) =>
  TriggerInput.parse({
    name,
    enabled: true,
    source: { type: "manual" },
    execution: {
      agent: { agentId, target: "isolated", ...(keep ? { keep: true } : {}) },
      tools: ["read", "write"],
      mode: "auto-accept-edits",
    },
    prompt: "Update the state.",
  });
const taskStates = (b: VmBed): string[] =>
  rows<{ state: string }>(b.t.home, "SELECT state FROM tasks ORDER BY created_at, id").map(
    (row) => row.state,
  );

describe("a trigger's isolated task keeps its folder between runs (K2)", () => {
  it("reuses the folder, taints every run, hides it from other triggers and removes it with the trigger", async () => {
    const b = (bed = await startVmBed({ steps: [{ text: "ready" }] }));
    const agentId = await b.createAgent({ sandbox: { required: true, network: false } });
    const created = await b.call<{ trigger: { id: string } }>("automation.triggers.create", {
      input: triggerInput(agentId, "Pulse", true),
    });
    const triggerId = created.trigger.id;
    const keepKey = triggerId.replaceAll("-", "");
    const root = processRootOf(b.t.home, { agentId, taskKey: keepKey });
    const run = async (steps: object[], expected: number, id = triggerId) => {
      writeScript(b.t, { steps });
      await b.call("automation.fire", { triggerId: id });
      await vi.waitFor(() => expect(taskStates(b)).toHaveLength(expected), { timeout: 60_000 });
      await vi.waitFor(
        () => expect(taskStates(b).filter((state) => state === "queued" || state === "running")).toEqual([]),
        { timeout: 120_000 },
      );
    };

    await run([write(join(root, "home", "state.txt"), "run one", "w1"), { text: "done" }], 1);
    expect(taskStates(b)).toEqual(["done"]);
    expect(readFileSync(join(root, "home", "state.txt"), "utf8")).toBe("run one");

    await run([write(join(root, "home", "state-2.txt"), "run two", "w2"), { text: "done" }], 2);
    expect(taskStates(b)).toEqual(["done", "done"]);
    // The second run found the folder the first left, and added to it.
    expect(readdirSync(join(root, "home")).sort()).toEqual(["state-2.txt", "state.txt"]);
    // A start refused `conflict` while the previous VM is going down is recorded too: only the key is asserted.
    expect(new Set(b.vms.started.map((spec) => spec.keepKey))).toEqual(new Set([keepKey]));
    const taints = rows<{ tainted_at: number | null }>(
      b.t.home,
      "SELECT p.tainted_at FROM tasks t JOIN session_policy p ON p.session_id = t.session_id ORDER BY t.created_at, t.id",
    );
    expect(taints.map((row) => row.tainted_at !== null)).toEqual([true, true]);

    // A trigger without the setting gets a folder of its own.
    const plain = await b.call<{ trigger: { id: string } }>("automation.triggers.create", {
      input: triggerInput(agentId, "Plain", false),
    });
    await run([{ text: "done" }], 3, plain.trigger.id);
    const plainSpec = b.vms.started.find((spec) => !spec.keepKey);
    expect(plainSpec).not.toHaveProperty("keepKey");
    const plainRoot = processRootOf(b.t.home, { agentId, taskKey: plainSpec?.taskKey ?? "" });
    expect(plainRoot).not.toBe(root);
    expect(existsSync(join(plainRoot, "home", "state.txt"))).toBe(false);

    // Two runs fired back to back: the second waits for the first's VM, runs after it, and never shares its folder live.
    writeScript(b.t, { steps: [{ text: "done" }] });
    await b.call("automation.fire", { triggerId });
    await b.call("automation.fire", { triggerId });
    await vi.waitFor(() => expect(taskStates(b)).toHaveLength(5), { timeout: 60_000 });
    await vi.waitFor(
      () => expect(taskStates(b).filter((state) => state === "queued" || state === "running")).toEqual([]),
      { timeout: 180_000 },
    );
    expect(taskStates(b).slice(3)).toEqual(["done", "done"]);

    await b.call("automation.triggers.delete", { triggerId });
    await vi.waitFor(() => expect(existsSync(root)).toBe(false), { timeout: 30_000 });
    expect(existsSync(plainRoot)).toBe(true);
  }, 300_000);
});
