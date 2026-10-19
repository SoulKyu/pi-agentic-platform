import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_VM_MAX_FRAME_BYTES,
  type DaemonToWorker,
  FILE_CHUNK_BYTES,
  FILE_LIMITS,
  encodeSocketFrame,
  FilePut,
  FilePutResult,
} from "@pap/contracts";
import type { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createFakeWorker, type FakeWorker } from "../../kernel/testing/fake-worker.ts";
import { codeOf } from "./testing/helpers.ts";
import { putAttachments, vmDelivery } from "./vm-attachments.ts";

type Put = z.infer<typeof FilePut>;
const INBOX = "/agent/inbox";
const clock = createFakeClock();
const nth = <T>(items: readonly T[], index: number): T => {
  const item = items[index];
  if (item === undefined) throw new Error(`no item ${index}`);
  return item;
};
const puts = (worker: FakeWorker): Put[] =>
  worker.sent.filter((record): record is Put & DaemonToWorker => record.type === "file_put");

/** A worker that answers every chunk at once; `answer` decides the result of a chunk. */
function workerAnswering(
  answer: (put: Put, seen: Put[]) => Partial<z.infer<typeof FilePutResult>> = () => ({}),
): FakeWorker {
  const seen: Put[] = [];
  const worker: FakeWorker = createFakeWorker({
    onSend: (record) => {
      if (record.type !== "file_put") return;
      seen.push(record);
      queueMicrotask(() =>
        worker.emit({ type: "file_put_result", id: record.id, ok: true, ...answer(record, seen) }),
      );
    },
  });
  return worker;
}
const put = (worker: FakeWorker, files: Array<{ name: string; bytes: Buffer }>) =>
  putAttachments(worker, files, { inbox: INBOX, clock });

describe("putAttachments (R33)", () => {
  it("sends a 25 MiB attachment in 13 chunks, none over the frame bound, and the bytes reassemble", async () => {
    const bytes = Buffer.alloc(FILE_LIMITS.uploadBytes, 7);
    bytes[bytes.length - 1] = 9;
    const worker = workerAnswering();
    await expect(put(worker, [{ name: "big.bin", bytes }])).resolves.toEqual([`${INBOX}/big.bin`]);
    const sent = puts(worker);
    expect(sent).toHaveLength(13);
    for (const frame of sent)
      expect(encodeSocketFrame(frame).length - 4).toBeLessThanOrEqual(AGENT_VM_MAX_FRAME_BYTES);
    expect(sent.map((frame) => frame.last)).toEqual([...Array(12).fill(false), true]);
    expect(sent.map((frame) => frame.offset)).toEqual(sent.map((_, index) => index * FILE_CHUNK_BYTES));
    expect(new Set(sent.map((frame) => frame.id)).size).toBe(1);
    expect(Buffer.concat(sent.map((frame) => Buffer.from(frame.data, "base64"))).equals(bytes)).toBe(true);
  });

  it("sends an empty file as one last chunk", async () => {
    const worker = workerAnswering();
    await put(worker, [{ name: "empty.txt", bytes: Buffer.alloc(0) }]);
    expect(puts(worker)).toMatchObject([{ name: "empty.txt", offset: 0, data: "", last: true }]);
  });

  it("sends the next chunk only after the worker answered the one before (the wire's backlog is bounded)", async () => {
    const worker = createFakeWorker();
    const done = put(worker, [{ name: "a.bin", bytes: Buffer.alloc(FILE_CHUNK_BYTES + 1) }]);
    await Promise.resolve();
    expect(puts(worker)).toHaveLength(1);
    worker.emit({ type: "file_put_result", id: nth(puts(worker), 0).id, ok: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(puts(worker)).toHaveLength(2);
    worker.emit({ type: "file_put_result", id: nth(puts(worker), 1).id, ok: true });
    await done;
  });

  it("ignores a result for another id", async () => {
    const worker = createFakeWorker();
    const done = put(worker, [{ name: "a.txt", bytes: Buffer.from("hi") }]);
    await Promise.resolve();
    worker.emit({ type: "file_put_result", id: "f".repeat(32), ok: false, code: "write_failed" });
    worker.emit({ type: "file_put_result", id: nth(puts(worker), 0).id, ok: true });
    await expect(done).resolves.toEqual([`${INBOX}/a.txt`]);
  });

  it("retries once on exists with a -<4 hex> suffix before the extension, from offset 0 and under a new id", async () => {
    const worker = workerAnswering((frame) =>
      frame.name === "report.tar.gz" ? { ok: false, code: "exists" } : {},
    );
    const paths = await put(worker, [{ name: "report.tar.gz", bytes: Buffer.from("x") }]);
    const sent = puts(worker);
    expect(sent).toHaveLength(2);
    expect(nth(sent, 1).name).toMatch(/^report\.tar-[0-9a-f]{4}\.gz$/);
    expect(nth(sent, 1).offset).toBe(0);
    expect(nth(sent, 1).id).not.toBe(nth(sent, 0).id);
    expect(FilePut.safeParse(sent[1]).success).toBe(true);
    expect(paths).toEqual([`${INBOX}/${nth(sent, 1).name}`]);
  });

  it("puts the suffix at the end of a name without an extension or with a leading dot, within 128 characters", async () => {
    for (const name of ["README", ".bashrc", `${"n".repeat(127)}.txt`]) {
      let first = true;
      const flaky = createFakeWorker({
        onSend: (record) => {
          if (record.type !== "file_put") return;
          const exists = first;
          first = false;
          queueMicrotask(() =>
            flaky.emit({
              type: "file_put_result",
              id: record.id,
              ok: !exists,
              ...(exists ? { code: "exists" as const } : {}),
            }),
          );
        },
      });
      await put(flaky, [{ name, bytes: Buffer.from("x") }]);
      const retried = nth(puts(flaky), 1);
      expect(FilePut.safeParse(retried).success, name).toBe(true);
      expect(retried.name, name).toMatch(/-[0-9a-f]{4}(\.[a-z]+)?$/);
    }
  });

  it("fails the prompt when the retry answers exists too, without a third try", async () => {
    const worker = workerAnswering(() => ({ ok: false, code: "exists" }));
    expect(await codeOf(put(worker, [{ name: "a.txt", bytes: Buffer.from("x") }]))).toBe("prompt_rejected");
    expect(puts(worker)).toHaveLength(2);
  });

  it.each(["too_large", "order", "write_failed"] as const)(
    "fails the prompt on %s, with no retry",
    async (code) => {
      const worker = workerAnswering(() => ({ ok: false, code }));
      expect(await codeOf(put(worker, [{ name: "a.txt", bytes: Buffer.from("x") }]))).toBe("prompt_rejected");
      expect(puts(worker)).toHaveLength(1);
    },
  );

  it("makes a name the schema refuses one it accepts, so the worker never sees the refused one", async () => {
    const worker = workerAnswering();
    const names = [
      "résumé final.pdf",
      "../../etc/passwd",
      "-rf",
      "",
      "a‮b.txt",
      "x".repeat(300) + ".md",
      "dir/file",
    ];
    const paths = await put(
      worker,
      names.map((name) => ({ name, bytes: Buffer.from("x") })),
    );
    expect(puts(worker)).toHaveLength(names.length);
    for (const frame of puts(worker)) expect(FilePut.safeParse(frame).success, frame.name).toBe(true);
    expect(paths.every((path) => path.startsWith(`${INBOX}/`))).toBe(true);
    expect(nth(puts(worker), 0).name).toBe("resume_final.pdf");
    expect(nth(puts(worker), 5).name.endsWith(".md")).toBe(true);
  });

  it("refuses a file over the attachment limit before sending anything", async () => {
    const worker = workerAnswering();
    const big = Buffer.alloc(FILE_LIMITS.uploadBytes + 1);
    expect(
      await codeOf(
        put(worker, [
          { name: "ok.txt", bytes: Buffer.from("x") },
          { name: "big.bin", bytes: big },
        ]),
      ),
    ).toBe("prompt_rejected");
    expect(puts(worker)).toHaveLength(0);
  });

  it("fails the prompt when send returns false (a worker that is gone), never throws out of it", async () => {
    const worker = workerAnswering();
    await worker.stop();
    expect(await codeOf(put(worker, [{ name: "a.txt", bytes: Buffer.from("x") }]))).toBe("prompt_rejected");
  });

  it("fails the prompt when the worker exits while a chunk waits", async () => {
    const worker = createFakeWorker();
    const done = codeOf(put(worker, [{ name: "a.txt", bytes: Buffer.from("x") }]));
    await Promise.resolve();
    worker.crash({ code: 1, signal: null, cause: "exit_code" });
    expect(await done).toBe("prompt_rejected");
  });

  it("fails the prompt when a chunk is never answered, and stops listening", async () => {
    const worker = createFakeWorker();
    const done = codeOf(put(worker, [{ name: "a.txt", bytes: Buffer.from("x") }]));
    await Promise.resolve();
    await clock.advance(60_000);
    expect(await done).toBe("prompt_rejected");
    expect(() =>
      worker.emit({ type: "file_put_result", id: nth(puts(worker), 0).id, ok: true }),
    ).not.toThrow();
  });
});

describe("vmDelivery", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pap-vm-att-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const announce = (text: string, paths: readonly string[]) => `${text}|${paths.join(",")}`;
  const file = (name: string, body = "data") => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return { id: name.padEnd(22, "f"), path, name, size: body.length };
  };

  it("puts files and images into the inbox and names only VM paths", async () => {
    const worker = workerAnswering();
    const photo = join(dir, "pending-photo");
    writeFileSync(photo, "png");
    const claimed = {
      images: [{ id: "-img12345678901234567", path: photo, mimeType: "image/png" as const }],
      files: [file("notes.txt")],
    };
    const sent = await vmDelivery("look", claimed, announce)({ handle: worker, inbox: INBOX, clock });
    const names = puts(worker).map((frame) => frame.name);
    expect(names).toHaveLength(2);
    expect(sent.images).toEqual([{ path: `${INBOX}/${names[0]}`, mimeType: "image/png" }]);
    expect(names[0]).toMatch(/\.png$/);
    expect(sent.text).toBe(`look|${INBOX}/notes.txt`);
    expect(JSON.stringify(sent)).not.toContain(dir);
  });

  it("sends no images field without images", async () => {
    const worker = workerAnswering();
    const sent = await vmDelivery(
      "t",
      { images: [], files: [file("a.txt")] },
      announce,
    )({ handle: worker, inbox: INBOX, clock });
    expect(sent.images).toBeUndefined();
  });

  it("refuses a symbolic link, a folder and a file over the limit, sending nothing for them", async () => {
    const worker = workerAnswering();
    const target = file("real.txt");
    const link = join(dir, "link.txt");
    symlinkSync(target.path, link);
    const folder = join(dir, "folder");
    mkdirSync(folder);
    const huge = file("huge.bin", "");
    truncateSync(huge.path, FILE_LIMITS.uploadBytes + 1);
    for (const path of [link, folder, huge.path]) {
      const claimed = { images: [], files: [{ id: "f".repeat(22), path, name: "x.txt", size: 1 }] };
      expect(
        await codeOf(vmDelivery("t", claimed, announce)({ handle: worker, inbox: INBOX, clock })),
        path,
      ).toBe("prompt_rejected");
    }
    expect(puts(worker)).toHaveLength(0);
  });
});
