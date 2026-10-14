import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostBed } from "./testing/host-bed.ts";
import { writeExtension } from "./testing/extensions.ts";
import { noisePng, solidPng } from "./testing/png.ts";

let bed: ReturnType<typeof createHostBed>;
beforeEach(() => {
  bed = createHostBed();
});
afterEach(() => bed.dispose());

interface Entry {
  message?: { role: string; content: unknown };
}
const userMessages = (file: string) =>
  (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [])
    .map((line) => JSON.parse(line) as Entry)
    .filter((entry) => entry.message?.role === "user")
    .map((entry) => entry.message?.content);
const textsOf = (content: unknown) =>
  typeof content === "string"
    ? content
    : (content as Array<{ type: string; text?: string }>)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");

function pendingFile(name: string, bytes: Buffer): string {
  const dir = join(bed.papHome, "attachments", "pending");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

describe("prompts with images (M8R41, M8R107)", () => {
  it("gives Pi an image part for an image of the pending folder", async () => {
    const ready = await bed.start({ steps: [{ text: "seen" }] });
    const host = bed.host();
    const path = pendingFile("one", solidPng(16, 16));
    const answer = await host.request({
      type: "prompt",
      message: "look",
      images: [{ path, mimeType: "image/png" }],
    });
    expect(answer).toMatchObject({ success: true });
    await host.waitFor((r) => r.type === "agent_settled");
    const [first] = userMessages(String(ready.sessionFile));
    expect(first).toEqual([
      { type: "text", text: "look" },
      { type: "image", data: expect.any(String), mimeType: "image/png" },
    ]);
  });

  it("refuses a path outside the pending folder and writes no user message", async () => {
    const ready = await bed.start({ steps: [{ text: "never" }] });
    const host = bed.host();
    const outside = join(bed.root, "outside.png");
    writeFileSync(outside, solidPng(16, 16));
    const answer = await host.request({
      type: "prompt",
      message: "look",
      images: [{ path: outside, mimeType: "image/png" }],
    });
    expect(answer).toMatchObject({ success: false, error: "pap:image_unreadable" });
    expect(userMessages(String(ready.sessionFile))).toEqual([]);
  });

  it("keeps the arrival order of a slow image prompt and the text prompt after it", async () => {
    const ready = await bed.start({ steps: [{ text: "one" }, { text: "two" }] });
    const host = bed.host();
    const path = pendingFile("big", noisePng(1500, 1500));
    const first = host.request({
      type: "prompt",
      message: "with image",
      streamingBehavior: "followUp",
      images: [{ path, mimeType: "image/png" }],
    });
    const second = host.request({ type: "prompt", message: "plain", streamingBehavior: "followUp" });
    expect(await first).toMatchObject({ success: true });
    expect(await second).toMatchObject({ success: true });
    await host.waitFor((r) => r.type === "agent_settled" && r.aborted === false, { timeoutMs: 30_000 });
    await vi.waitFor(() => expect(userMessages(String(ready.sessionFile))).toHaveLength(2), {
      timeout: 20_000,
    });
    expect(userMessages(String(ready.sessionFile)).map(textsOf)).toEqual(["with image", "plain"]);
  });

  it("drops an image prompt a Stop overtook: pap:aborted and no user message", async () => {
    const ready = await bed.start({ steps: [{ text: "never" }] });
    const host = bed.host();
    const path = pendingFile("big", noisePng(1500, 1500));
    const prompt = host.request({
      type: "prompt",
      message: "late",
      images: [{ path, mimeType: "image/png" }],
    });
    expect(await host.request({ type: "abort" })).toMatchObject({ success: true });
    expect(await prompt).toMatchObject({ success: false, error: "pap:aborted" });
    expect(userMessages(String(ready.sessionFile))).toEqual([]);
  });

  it("does not let a Stop leave the session stuck behind an image prompt Pi never answers", async () => {
    const entered = join(bed.root, "entered.txt");
    writeExtension(
      bed.agentDir,
      "block",
      `import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.registerCommand("block", { handler: () => { writeFileSync(${JSON.stringify(entered)}, "in"); return new Promise(() => {}); } });
}`,
    );
    await bed.start({ steps: [{ text: "after the stop" }] });
    const host = bed.host();
    const path = pendingFile("one", solidPng(16, 16));
    host
      .request({ type: "prompt", message: "/block", images: [{ path, mimeType: "image/png" }] })
      .catch(() => {});
    // The command is running inside Pi: the queue now holds on its answer.
    await vi.waitFor(() => expect(existsSync(entered)).toBe(true), { timeout: 20_000 });
    expect(await host.request({ type: "abort" })).toMatchObject({ success: true });
    expect(await host.request({ type: "prompt", message: "hello" })).toMatchObject({
      success: true,
      data: { disposition: "started" },
    });
  });

  it("forwards the echo of a user message with its images omitted, so it stays within the record cap", async () => {
    const ready = await bed.start({ steps: [{ text: "seen" }] });
    const host = bed.host();
    const images = ["a", "b", "c"].map((name) => ({
      path: pendingFile(name, noisePng(1500, 1500)),
      mimeType: "image/png",
    }));
    await host.request({ type: "prompt", message: "three", images });
    await host.waitFor((r) => r.type === "agent_settled", { timeoutMs: 30_000 });
    expect(host.records.filter((r) => r.type === "extension_error")).toEqual([]);
    const echo = host.records.find(
      (r) => r.type === "message_end" && (r.message as { role?: string }).role === "user",
    );
    const parts = (echo?.message as { content: Array<Record<string, unknown>> }).content;
    expect(parts.filter((part) => part.type === "image")).toEqual([
      { type: "image", mimeType: "image/jpeg", omitted: true, bytes: expect.any(Number) },
      { type: "image", mimeType: "image/jpeg", omitted: true, bytes: expect.any(Number) },
      { type: "image", mimeType: "image/jpeg", omitted: true, bytes: expect.any(Number) },
    ]);
    expect(userMessages(String(ready.sessionFile))).toHaveLength(1);
  });

  it("sends the end of a tool that read an image with the image omitted, within the record cap", async () => {
    await bed.start({
      steps: [
        { toolCalls: [{ name: "read", args: { path: join(bed.cwd, "shot.png") }, id: "call-1" }] },
        { text: "done" },
      ],
    });
    writeFileSync(join(bed.cwd, "shot.png"), noisePng(1500, 1500));
    const host = bed.host();
    await host.request({ type: "prompt", message: "look at shot.png" });
    const end = await host.waitFor((r) => r.type === "tool_execution_end", { timeoutMs: 30_000 });
    await host.waitFor((r) => r.type === "agent_settled", { timeoutMs: 30_000 });
    expect(host.records.filter((r) => r.type === "extension_error")).toEqual([]);
    const parts = (end.result as { content: Array<Record<string, unknown>> }).content;
    expect(parts.filter((part) => part.type === "image")).toEqual([
      {
        type: "image",
        mimeType: expect.stringMatching(/^image\//),
        omitted: true,
        bytes: expect.any(Number),
      },
    ]);
  });
});
