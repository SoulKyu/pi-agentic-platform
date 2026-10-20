import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeScript } from "../../security/testing/agent-bed.ts";
import { rows } from "../../security/testing/automation-bed.ts";
import { markOf, waitIdle } from "../../security/testing/fixtures.ts";
import { startVmBed, type VmBed } from "../../testing/vm-bed.ts";
import { FILE_LOST_NOTICE, REPLACED_NOTICE } from "./mirror.ts";

/*
 * T9 through a whole daemon, a real guest and a real worker (J1). Mutants (RT-43), each run for real:
 *  - the mirror stops resuming from its end (`session_resync` never sent) -> "a VM ahead of its mirror" keeps a gap;
 *  - the mirror keeps no old copy on a replacement -> "a rewritten file keeps the old copy" fails;
 *  - `bindMirrorHooks` not called (the hooks only log) -> the notice and the taint cases fail (AVM-E21);
 *  - the provenance accepts any user text -> "marks an extension's message" fails.
 */
let bed: VmBed | undefined;
afterEach(async () => {
  await bed?.stop();
  bed = undefined;
});
const start = (script: object, options: Parameters<typeof startVmBed>[1] = {}) =>
  startVmBed(script, options).then((started) => (bed = started));

const prompt = async (b: VmBed, sessionId: string, text: string) => {
  const mark = markOf(b.owner.client);
  await b.call("sessions.prompt", { sessionId, text });
  await waitIdle(b.owner.client, mark);
};
const mirrorDir = (b: VmBed, agentId: string) => join(b.t.home, "agents", ".mirrors", agentId);
const vmDir = (b: VmBed, agentId: string) => join(b.t.home, "tmp", "agent-vm", agentId, ".pi", "sessions");
const fileOf = (dir: string): string => {
  const [name] = readdirSync(dir).filter((entry) => entry.endsWith(".jsonl"));
  if (name === undefined) throw new Error(`no session file in ${dir}`);
  return name;
};
/** The entries written before the file's last one: `sessions.history` pages backwards from a cursor. */
const history = async (b: VmBed, sessionId: string, file: string) => {
  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  const last = JSON.parse(lines.at(-1) as string) as { id: string };
  return (
    await b.call<{ rows: Array<{ message: { role: string; content: unknown }; unverified?: true }> }>(
      "sessions.history",
      { sessionId, before: last.id },
    )
  ).rows;
};
const textOf = (row: { message: { content: unknown } }): string => JSON.stringify(row.message.content);
const taintedAt = (b: VmBed, sessionId: string): number | null =>
  rows<{ tainted_at: number | null }>(
    b.t.home,
    "SELECT tainted_at FROM session_policy WHERE session_id = ?",
    sessionId,
  )[0]?.tainted_at ?? null;

describe("the mirror of a VM session (T9, R14, R23, R32)", () => {
  it("holds the run's entries byte for byte, and sessions.history reads them with the VM stopped", async () => {
    const b = await start({ steps: [{ text: "Mirror answer." }] });
    const agentId = await b.createAgent();
    const sessionId = await b.openThread(agentId);
    await prompt(b, sessionId, "Say something");
    const name = fileOf(mirrorDir(b, agentId));
    expect(
      readFileSync(join(mirrorDir(b, agentId), name)).equals(readFileSync(join(vmDir(b, agentId), name))),
    ).toBe(true);
    await b.vm.runtime.stop(agentId);
    expect(b.vms.stopped.some((vm) => vm.agentId === agentId)).toBe(true);
    const rowsNow = await history(b, sessionId, join(mirrorDir(b, agentId), name));
    expect(rowsNow.some((row) => row.message.role === "user" && textOf(row).includes("Say something"))).toBe(
      true,
    );
    expect(rowsNow.every((row) => row.unverified === undefined)).toBe(true);
    // Reading history started no VM.
    expect(b.vms.started).toHaveLength(1);
  }, 120_000);

  it("resumes from the mirror's end when the VM is ahead of it, without a replacement (RT-39)", async () => {
    const b = await start({ steps: [{ text: "First answer." }] });
    const agentId = await b.createAgent();
    const sessionId = await b.openThread(agentId);
    await prompt(b, sessionId, "First question");
    const name = fileOf(mirrorDir(b, agentId));
    const mirror = join(mirrorDir(b, agentId), name);
    const vmFile = join(vmDir(b, agentId), name);
    await b.vm.runtime.stop(agentId);
    // The VM wrote one more entry that the daemon never received: its mirror "lost its last line".
    const lines = readFileSync(vmFile, "utf8").trimEnd().split("\n");
    const last = JSON.parse(lines.at(-1) as string) as { id: string };
    const extra = {
      type: "message",
      id: "feedbeef",
      parentId: last.id,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Written while pap was away." }],
        api: "scripted",
        provider: "faux",
        model: "scripted",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    };
    appendFileSync(vmFile, `${JSON.stringify(extra)}\n`);
    expect(readFileSync(mirror).length).toBeLessThan(readFileSync(vmFile).length);
    writeScript(b.t, { steps: [{ text: "Second answer." }] });
    await prompt(b, sessionId, "Second question");
    // The mirror caught up from where it stood: same bytes as the VM's file, nothing kept aside, nothing said, no taint.
    expect(readFileSync(mirror).equals(readFileSync(vmFile))).toBe(true);
    expect(readFileSync(mirror, "utf8").includes("Written while pap was away.")).toBe(true);
    expect(existsSync(join(mirrorDir(b, agentId), "replaced"))).toBe(false);
    expect(JSON.stringify(b.owner.client.events).includes(REPLACED_NOTICE)).toBe(false);
    expect(taintedAt(b, sessionId)).toBeNull();
  }, 120_000);

  it("keeps the old copy of a file the VM cut back for 7 days, posts the notice and taints the session (R14, AVM-E21)", async () => {
    const b = await start({ steps: [{ text: "First answer." }] });
    const agentId = await b.createAgent();
    const sessionId = await b.openThread(agentId);
    await prompt(b, sessionId, "First question");
    const name = fileOf(mirrorDir(b, agentId));
    const mirror = join(mirrorDir(b, agentId), name);
    const vmFile = join(vmDir(b, agentId), name);
    const before = readFileSync(mirror);
    expect(taintedAt(b, sessionId)).toBeNull();
    await b.vm.runtime.stop(agentId);
    // Between two runs the VM rewrote its history: the file is cut back to its first lines (the header stays, so it is the
    // same session). The next hello is behind the mirror, and what the worker then writes is not an extension of the mirror.
    const lines = readFileSync(vmFile, "utf8").split("\n");
    writeFileSync(vmFile, `${lines.slice(0, 3).join("\n")}\n`);
    writeScript(b.t, { steps: [{ text: "Fresh start." }] });
    await prompt(b, sessionId, "Second question");
    const kept = join(mirrorDir(b, agentId), "replaced");
    await vi.waitFor(
      () => expect(existsSync(kept) && readdirSync(kept).some((entry) => entry.startsWith(name))).toBe(true),
      { timeout: 20_000 },
    );
    const copy = readdirSync(kept).find(
      (entry) => entry.startsWith(name) && !entry.endsWith(".ids"),
    ) as string;
    expect(readFileSync(join(kept, copy)).equals(before)).toBe(true);
    expect(readFileSync(mirror).equals(readFileSync(vmFile))).toBe(true);
    await vi.waitFor(
      () => expect(JSON.stringify(b.owner.client.events).includes(REPLACED_NOTICE)).toBe(true),
      {
        timeout: 10_000,
      },
    );
    expect(taintedAt(b, sessionId)).not.toBeNull();
  }, 120_000);

  // I2: the notice of a mirror that cannot be trusted is announced at the mirror's open, before the session is live again.
  it("shows the owner the notice of a recovered mirror (AVM-E29): its index is gone, the copy is kept, the session is tainted", async () => {
    const b = await start({ steps: [{ text: "First answer." }] });
    const agentId = await b.createAgent();
    const sessionId = await b.openThread(agentId);
    await prompt(b, sessionId, "First question");
    const name = fileOf(mirrorDir(b, agentId));
    const mirror = join(mirrorDir(b, agentId), name);
    const before = readFileSync(mirror);
    await b.vm.runtime.stop(agentId);
    rmSync(`${mirror}.ids`);
    writeScript(b.t, { steps: [{ text: "Second answer." }] });
    await prompt(b, sessionId, "Second question");
    await vi.waitFor(
      () => expect(JSON.stringify(b.owner.client.events).includes(REPLACED_NOTICE)).toBe(true),
      {
        timeout: 10_000,
      },
    );
    const kept = join(mirrorDir(b, agentId), "replaced");
    expect(readdirSync(kept).some((entry) => entry.startsWith(name))).toBe(true);
    expect(
      readFileSync(
        join(
          kept,
          readdirSync(kept).find((entry) => entry.startsWith(name) && !entry.endsWith(".ids")) as string,
        ),
      ).equals(before),
    ).toBe(true);
    expect(taintedAt(b, sessionId)).not.toBeNull();
  }, 120_000);

  // M4's own guard (service-launch): a recorded session's file says who it is. A VM that deleted its file and let Pi start
  // another session under the same name is refused before a single entry is taken: nothing is replaced, nothing is lost.
  it("refuses to continue on a file the VM deleted: the mirror stays whole and nothing is kept aside", async () => {
    const b = await start({ steps: [{ text: "First answer." }] });
    const agentId = await b.createAgent();
    const sessionId = await b.openThread(agentId);
    await prompt(b, sessionId, "First question");
    const name = fileOf(mirrorDir(b, agentId));
    const mirror = join(mirrorDir(b, agentId), name);
    const before = readFileSync(mirror);
    await b.vm.runtime.stop(agentId);
    rmSync(join(vmDir(b, agentId), name));
    const answer = await b.owner.client.call("sessions.prompt", { sessionId, text: "Second question" });
    expect(answer).toMatchObject({ ok: false, error: { code: "worker_failed" } });
    // AVM-E40 M1: it still fails closed, and the owner is told why.
    await vi.waitFor(() =>
      expect(JSON.stringify(b.owner.client.events).includes(FILE_LOST_NOTICE)).toBe(true),
    );
    expect(readFileSync(mirror).equals(before)).toBe(true);
    expect(existsSync(join(mirrorDir(b, agentId), "replaced"))).toBe(false);
    expect(taintedAt(b, sessionId)).toBeNull();
  }, 120_000);

  it("marks a user message an extension sent as unverified, and the owner's prompt is not (R32)", async () => {
    const INJECT = `export default function (pi) {
  let done = false;
  pi.on("agent_end", async () => {
    if (done) return;
    done = true;
    setImmediate(() => { void pi.sendUserMessage("Injected by an extension."); });
  });
}
`;
    const b = await start(
      { steps: [{ text: "First reply." }, { text: "Reply to the injected message." }] },
      { imageFiles: { "extensions/inject.js": INJECT } },
    );
    const agentId = await b.createAgent();
    const sessionId = await b.openThread(agentId);
    await prompt(b, sessionId, "Owner question");
    const name = fileOf(mirrorDir(b, agentId));
    const mirror = join(mirrorDir(b, agentId), name);
    await vi.waitFor(
      () => expect(readFileSync(mirror, "utf8").includes("Reply to the injected message.")).toBe(true),
      {
        timeout: 30_000,
      },
    );
    await b.vm.runtime.stop(agentId);
    const lines = readFileSync(mirror, "utf8").trimEnd().split("\n");
    const last = JSON.parse(lines.at(-1) as string) as { id: string };
    const listed = (
      await b.call<{ rows: Array<{ message: { role: string; content: unknown }; unverified?: true }> }>(
        "sessions.history",
        { sessionId, before: last.id },
      )
    ).rows;
    const users = listed.filter((row) => row.message.role === "user");
    const owner = users.find((row) => textOf(row).includes("Owner question"));
    const injected = users.find((row) => textOf(row).includes("Injected by an extension."));
    expect(owner).toBeDefined();
    expect(injected).toBeDefined();
    expect(owner?.unverified).toBeUndefined();
    expect(injected?.unverified).toBe(true);
  }, 120_000);
});
