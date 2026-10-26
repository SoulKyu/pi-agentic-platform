import { afterEach, describe, expect, it, vi } from "vitest";
import { type BoxBed, startBoxBed } from "./testing/box-bed.ts";
import { httpRequest } from "./testing/http-client.ts";

// An agent's files in the explorer, on the process backend: the real guest as a local process, the scripted model, everything
// asked over RPC like the web does. A stopped VM is asked, never started; `agents.startBox` starts it with no worker.

let bed: BoxBed | undefined;
afterEach(async () => {
  await bed?.stop();
  bed = undefined;
});

const KUBE = "apiVersion: v1\nkind: Config\n";
const NOTES = "# Notes\nfound it\n";

const codeOf = (frame: { ok: boolean; error?: { code: string } }): string =>
  frame.ok ? "ok" : (frame.error?.code ?? "?");

describe("an agent's files in the explorer, end to end", () => {
  it("is refused while the VM is stopped, starts with no worker, then lists, writes and reads the agent's folder", async () => {
    const b = (bed = await startBoxBed({ steps: [{ text: "ok" }] }));
    const agentId = await b.createAgent({ name: "Filer" });
    const root = `/agents/${agentId}`;
    const put = await httpRequest(
      `${b.t.base}/agent-files?agentId=${agentId}&path=${encodeURIComponent(".kube/config")}`,
      {
        method: "PUT",
        headers: {
          origin: b.t.origin,
          cookie: b.owner.cookie,
          "content-length": String(Buffer.byteLength(KUBE)),
        },
        body: KUBE,
      },
    );
    expect(put.status, put.body).toBe(200);

    // Stopped: asked, never started.
    expect(codeOf(await b.owner.client.call("files.list", { path: root }))).toBe("box_stopped");
    expect(b.vms.started).toHaveLength(0);

    await b.call("agents.startBox", { agentId });
    expect(b.vms.started).toHaveLength(1);
    expect(b.vms.started[0]).toMatchObject({ box: { kind: "agent", id: agentId }, kind: "thread" });

    const top = await b.call<{ entries: Array<{ name: string }> }>("files.list", { path: root });
    // The process backend's folder also holds its own scaffolding (`image-agent`, `run`); a Kata disk does not.
    const names = top.entries.map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining(["home", "inbox", "knowledge"]));
    expect(names).not.toContain(".pi");
    expect(names).not.toContain("lost+found");

    await b.call("files.write", { path: `${root}/home/notes.md`, text: NOTES, baseEtag: null });
    const read = await b.call<{ text: string }>("files.read", { path: `${root}/home/notes.md` });
    expect(read.text).toBe(NOTES);

    // The imported credential is the VM home's only once a worker starts: the path never shows and never reads.
    expect(codeOf(await b.owner.client.call("files.read", { path: `${root}/home/.kube/config` }))).toBe(
      "not_found",
    );

    // A token reaches no agent folder, and says nothing about why.
    const minted = await b.call<{ value: string }>("auth.tokens.create", {
      name: "ci",
      permissions: ["files:read"],
      expiresInDays: 7,
    });
    const bot = await b.t.connectBearer(minted.value);
    try {
      expect(codeOf(await bot.call("files.list", { path: root }))).toBe("not_found");
      expect(codeOf(await bot.call("agents.startBox", { agentId } as never))).toBe("forbidden");
    } finally {
      bot.close();
    }

    // A second start finds the VM running: no second VM.
    const opened = vi.spyOn(b.vm.launches, "open");
    const started = vi.spyOn(b.vm.runtime, "start");
    await b.call("agents.startBox", { agentId });
    expect(opened).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    expect(b.vms.started).toHaveLength(1);

    // Once a worker has delivered the file, the home holds it, and the explorer still hides it.
    const sessionId = await b.openThread(agentId);
    await b.prompt(sessionId, "hello");
    const home = await b.call<{ entries: Array<{ name: string }> }>("files.list", { path: `${root}/home` });
    expect(home.entries.map((entry) => entry.name).sort()).toEqual([".kube", "notes.md"]);
    const kube = await b.call<{ entries: unknown[] }>("files.list", { path: `${root}/home/.kube` });
    expect(kube.entries).toEqual([]);
    expect(codeOf(await b.owner.client.call("files.read", { path: `${root}/home/.kube/config` }))).toBe(
      "not_found",
    );
  }, 180_000);

  it("keeps a removed credential out of sight until the VM has heard of the removal", async () => {
    const b = (bed = await startBoxBed({ steps: [{ text: "ok" }] }));
    const agentId = await b.createAgent({ name: "Rotator" });
    const root = `/agents/${agentId}`;
    const put = await httpRequest(
      `${b.t.base}/agent-files?agentId=${agentId}&path=${encodeURIComponent(".kube/config")}`,
      {
        method: "PUT",
        headers: {
          origin: b.t.origin,
          cookie: b.owner.cookie,
          "content-length": String(Buffer.byteLength(KUBE)),
        },
        body: KUBE,
      },
    );
    expect(put.status, put.body).toBe(200);
    await b.call("agents.files.remove", { agentId, path: ".kube/config" });
    // No worker has run: the removal is still to deliver, so the path stays hidden although pap holds no copy.
    await b.call("agents.startBox", { agentId });
    const write = await b.owner.client.call("files.write", {
      path: `${root}/home/.kube/config`,
      text: "x",
      baseEtag: null,
    });
    expect(codeOf(write)).toBe("not_found");
  }, 120_000);

  it("refuses an unknown agent and an agent the owner paused", async () => {
    const b = (bed = await startBoxBed({ steps: [{ text: "ok" }] }));
    expect(codeOf(await b.owner.client.call("agents.startBox", { agentId: "nobody-0001" }))).toBe(
      "not_found",
    );
    const agentId = await b.createAgent({ name: "Idle" });
    await b.call("agents.setPaused", { agentId, paused: true });
    expect(codeOf(await b.owner.client.call("agents.startBox", { agentId }))).toBe("agent_paused");
    expect(b.vms.started).toHaveLength(0);
  }, 120_000);
});
