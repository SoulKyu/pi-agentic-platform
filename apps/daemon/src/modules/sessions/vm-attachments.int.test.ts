import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { markOf, waitIdle } from "../../security/testing/fixtures.ts";
import { startVmBed, type VmBed } from "../../testing/vm-bed.ts";

/*
 * T10 through a whole daemon and a real guest and worker (J1). Mutants (RT-43), each run for real: the chunk loop in
 * vm-attachments.ts stops after the first chunk -> the digest of the inbox file differs; the prompt text names the host path
 * instead of the VM's -> "names its VM path" fails.
 */
let bed: VmBed | undefined;
afterEach(async () => {
  await bed?.stop();
  bed = undefined;
});

const MIB = 1024 * 1024;

function upload(
  b: VmBed,
  sessionId: string,
  name: string,
  body: Buffer,
): Promise<{ id: string; kind: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${b.t.base}/upload?sessionId=${sessionId}&name=${name}`,
      {
        method: "POST",
        headers: { origin: b.t.origin, cookie: b.owner.cookie, "content-length": String(body.length) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode !== 201) return reject(new Error(`upload ${res.statusCode}`));
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string; kind: string });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("an attachment of a VM agent's prompt (T10, R33)", () => {
  it("arrives whole in the VM's inbox, and the prompt names its VM path", async () => {
    bed = await startVmBed({ steps: [{ text: "Got the file." }] });
    const agentId = await bed.createAgent();
    const sessionId = await bed.openThread(agentId);
    // 5 MiB: three chunks of at most 2 MiB (R33), a PDF so the upload is a file and not an image.
    const file = Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(5 * MIB), Buffer.from("\n%%EOF\n")]);
    const uploaded = await upload(bed, sessionId, "report.pdf", file);
    expect(uploaded.kind).not.toBe("image");
    const mark = markOf(bed.owner.client);
    await bed.call("sessions.prompt", { sessionId, text: "read this", attachments: [uploaded.id] });
    await waitIdle(bed.owner.client, mark);

    const inbox = join(bed.t.home, "tmp", "agent-vm", agentId, "inbox");
    expect(readdirSync(inbox)).toEqual(["report.pdf"]);
    const arrived = readFileSync(join(inbox, "report.pdf"));
    expect(arrived.length).toBe(file.length);
    expect(createHash("sha256").update(arrived).digest("hex")).toBe(
      createHash("sha256").update(file).digest("hex"),
    );
    // The user message the VM's transcript holds names the file where the VM has it, not where the daemon kept the upload.
    const mirrors = join(bed.t.home, "agents", ".mirrors", agentId);
    const transcript = readdirSync(mirrors)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => readFileSync(join(mirrors, name), "utf8"))
      .join("\n");
    expect(transcript.includes(`Attached files:\\n- ${join(inbox, "report.pdf")}`)).toBe(true);
    expect(transcript.includes(join(bed.t.home, "attachments"))).toBe(false);
  }, 120_000);
});
