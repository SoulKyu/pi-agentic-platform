import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput, type InitRecord, PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { FakeWorker } from "../../kernel/testing/fake-worker.ts";
import { layoutOf } from "../agent-vm/index.ts";
import type { AttachmentsPort } from "../files/index.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

// R33 and T8b: a VM agent's attachments are put into its inbox and the prompt never carries a host path.
const ID = "atlas-1a2b";
const VM = (inbox: string) => ({
  layout: { ...layoutOf("kata", "/pap", { agentId: ID, taskKey: null }), inbox },
  bwrap: "/usr/bin/bwrap",
  relayKey: "d".repeat(64),
  slot: "c".repeat(32),
  rootView: "read-only" as const,
});
let bed: ReturnType<typeof create>;
let answer: "ok" | "fail" = "ok";
function create(attachments: AttachmentsPort) {
  return createServiceBed(
    { createSessionsStore, createSessionsService, loadTranscriptReader },
    {
      attachments,
      vmLaunch: (makeWorker) => ({
        spawn: async () => {
          const handle = makeWorker() as FakeWorker;
          const send = handle.send.bind(handle);
          handle.send = (record) => {
            const ok = send(record);
            if (record.type === "file_put")
              queueMicrotask(() =>
                handle.emit({
                  type: "file_put_result",
                  id: record.id,
                  ok: answer === "ok",
                  ...(answer === "ok" ? {} : { code: "write_failed" as const }),
                }),
              );
            return ok;
          };
          return {
            handle,
            bind: (compose) => {
              const composed = compose();
              const init: InitRecord = { ...composed.init, vm: VM("/agent/inbox") };
              return { ...composed, init };
            },
          };
        },
      }),
    },
  );
}
const hosts: string[] = [];
function hostFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "pap-vm-host-"));
  hosts.push(dir);
  writeFileSync(join(dir, "notes.txt"), "data");
  return join(dir, "notes.txt");
}
afterEach(() => {
  bed.dispose();
  for (const dir of hosts.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function world(host: string) {
  const claimed = { images: [], files: [{ id: "f".repeat(22), path: host, name: "notes.txt", size: 4 }] };
  const released: string[][] = [];
  bed = create({
    claim: async () => claimed,
    release: (_owner, ids) => void released.push([...ids]),
    dropOwner: () => {},
  });
  mkdirSync(join(bed.dir, "pap", "agents", ID), { recursive: true, mode: 0o700 });
  bed.service.agent.setAgentPorts({
    agents: {
      profileOf: () => ({ input: AgentInput.parse({ name: "Atlas" }), name: "Atlas", quarantined: false }),
      vmLayoutOf: () => layoutOf("kata", bed.dir, { agentId: ID, taskKey: null }),
    },
  });
  const { sessionId } = await bed.service.agentSessions.createAgentSession({
    ownerId: OWNER.userId,
    agentId: ID,
    role: "thread",
  });
  return { sessionId, released };
}

describe("sessions.prompt with attachments in a VM", () => {
  it("puts the file into the inbox before the prompt, and the prompt names the VM path only", async () => {
    answer = "ok";
    const { sessionId, released } = await world(hostFile());
    await bed.service.prompt({ sessionId, text: "read it", attachments: ["f".repeat(22)] }, OWNER);
    const worker = bed.spawned[0] as FakeWorker;
    expect(worker.sent.filter((record) => record.type === "file_put")).toHaveLength(1);
    expect(worker.sent.find((record) => record.type === "file_put")).toMatchObject({
      name: "notes.txt",
      data: Buffer.from("data").toString("base64"),
      last: true,
    });
    const prompt = worker.requests.find((request) => request.type === "prompt");
    expect(prompt).toMatchObject({ message: "read it\n\nAttached files:\n- /agent/inbox/notes.txt" });
    expect(JSON.stringify(worker.sent)).not.toContain("pap-vm-host-");
    expect(released).toEqual([["f".repeat(22)]]);
  });

  it("fails the prompt as prompt_rejected when the worker refuses the file, and sends no prompt", async () => {
    answer = "fail";
    const { sessionId, released } = await world(hostFile());
    const error = await bed.service
      .prompt({ sessionId, text: "x", attachments: ["f".repeat(22)] }, OWNER)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PapError);
    expect((error as PapError).code).toBe("prompt_rejected");
    expect(
      (bed.spawned[0] as FakeWorker).requests.filter((request) => request.type === "prompt"),
    ).toHaveLength(0);
    expect(released).toEqual([]);
  });
});
