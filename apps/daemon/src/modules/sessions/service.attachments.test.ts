import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentsPort } from "../files/index.ts";
import { fakePolicyPort } from "./testing/fake-policy.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = (options: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const IMAGE = { id: "i".repeat(22), path: "/pap/attachments/pending/iiii", mimeType: "image/png" as const };
const FILE = { id: "f".repeat(22), path: "/pap/attachments/s/ffff/report.pdf", name: "report.pdf", size: 9 };

function port(overrides: Partial<AttachmentsPort> = {}) {
  const claim = vi.fn<AttachmentsPort["claim"]>(async () => ({ images: [IMAGE], files: [FILE] }));
  const release = vi.fn<AttachmentsPort["release"]>();
  return { claim, release, port: { claim, release, ...overrides } satisfies AttachmentsPort };
}
const promptRequests = () => bed.spawned[0]?.requests.filter((request) => request.type === "prompt") ?? [];

describe("sessions.prompt with attachments (M8R42, M8R43)", () => {
  it("claims for the caller and the session, sends the image refs and cites the files, then releases the images and the sent files (MC38 m3)", async () => {
    const attachments = port();
    bed = build({ attachments: attachments.port });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const input = { sessionId, text: "look", attachments: [IMAGE.id, FILE.id] };
    await expect(bed.service.prompt(input, OWNER)).resolves.toEqual({ disposition: "started" });
    expect(attachments.claim).toHaveBeenCalledWith(OWNER.userId, sessionId, [IMAGE.id, FILE.id]);
    expect(promptRequests()).toMatchObject([
      {
        message: `look\n\nAttached files:\n- ${FILE.path}`,
        images: [{ path: IMAGE.path, mimeType: "image/png" }],
      },
    ]);
    expect(attachments.release).toHaveBeenCalledWith(OWNER.userId, [IMAGE.id, FILE.id]);
  });

  it("writes no blank lines before the list when the text is empty, and sends no images field without images", async () => {
    const attachments = port({ claim: async () => ({ images: [], files: [FILE] }) });
    bed = build({ attachments: attachments.port });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await bed.service.prompt({ sessionId, text: "", attachments: [FILE.id] }, OWNER);
    const [request] = promptRequests();
    expect(request).toMatchObject({ message: `Attached files:\n- ${FILE.path}` });
    expect(request).not.toHaveProperty("images");
  });

  it("never reaches the worker when the claim fails", async () => {
    const attachments = port({ claim: () => Promise.reject(new PapError("not_found")) });
    bed = build({ attachments: attachments.port });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await expect(
      bed.service.prompt({ sessionId, text: "x", attachments: [IMAGE.id] }, OWNER),
    ).rejects.toThrow(new PapError("not_found"));
    expect(promptRequests()).toEqual([]);
    expect(attachments.release).not.toHaveBeenCalled();
  });

  it("does not claim for a session the caller does not own", async () => {
    const attachments = port();
    bed = build({ attachments: attachments.port });
    await bed.service.create(bed.work, OWNER);
    await expect(
      bed.service.prompt({ sessionId: "nope", text: "x", attachments: [IMAGE.id] }, OWNER),
    ).rejects.toThrow(new PapError("not_found"));
    expect(attachments.claim).not.toHaveBeenCalled();
  });

  it("keeps the pending image when Pi refuses the prompt, so the composer can send it again", async () => {
    const attachments = port();
    bed = build({
      attachments: attachments.port,
      replies: { prompt: { success: false, error: "pap:image_unreadable" } },
    });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await expect(
      bed.service.prompt({ sessionId, text: "x", attachments: [IMAGE.id] }, OWNER),
    ).rejects.toThrow(new PapError("prompt_rejected"));
    expect(attachments.release).not.toHaveBeenCalled();
  });

  it("raises no taint: what the owner attaches is the owner's own content (M8R99)", async () => {
    const policy = fakePolicyPort();
    const attachments = port();
    bed = build({ attachments: attachments.port, policy });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const before = policy.taintOf(sessionId);
    await bed.service.prompt({ sessionId, text: "x", attachments: [IMAGE.id, FILE.id] }, OWNER);
    expect(policy.taintOf(sessionId)).toEqual(before);
    expect(before.tainted).toBe(false);
  });
});
