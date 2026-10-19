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
import { silentLogger } from "../../kernel/logger.ts";
import { captureLogger, codeOf } from "./testing/helpers.ts";
import { putAttachments, readOpened, type VmTarget, vmDelivery } from "./vm-attachments.ts";

/*
 * Mutants (each was run for real; the case that kills it):
 * - M1 no size check in putAttachments: "refuses a file over the attachment limit before sending anything".
 * - M2 no retry on exists: the "retries once on exists" cases.
 * - M3 no name sanitising: "makes a name the schema refuses one it accepts".
 * - M4 no vmTargets.set (service.vm-attachments.test.ts): both service cases.
 * - M5 open without O_NOFOLLOW: "a good file then a link/folder/oversize file leaves puts empty".
 * - M6 ignore the worker's result: the failure-code cases.
 * - M7 timeout never fires: "fails the prompt when a chunk is never answered".
 * - M8 validate while sending (read+put one at a time): "a good file then a link/folder/oversize file leaves puts empty".
 * - M9 no shrink check: "refuses a file that shrank".
 * - M10 suffix keeps a long extension: "keeps the retry name inside the schema with a very long extension".
 * - M11 listener never removed: "stops listening".
 */
type Put = z.infer<typeof FilePut>;
const INBOX = "/agent/inbox";
const clock = createFakeClock();
const nth = <T>(items: readonly T[], index: number): T => {
  const item = items[index];
  if (item === undefined) throw new Error(`no item ${index}`);
  return item;
};
const target = (worker: FakeWorker, logger: VmTarget["logger"] = silentLogger): VmTarget => ({
  handle: worker,
  inbox: INBOX,
  clock,
  logger,
});
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

  it("gives the second of two names that sanitise alike the suffix, keeping its extension", async () => {
    const taken = new Set<string>();
    const worker = workerAnswering((frame) => {
      if (taken.has(frame.name)) return { ok: false, code: "exists" };
      taken.add(frame.name);
      return {};
    });
    const paths = await put(worker, [
      { name: "a b.txt", bytes: Buffer.from("1") },
      { name: "a_b.txt", bytes: Buffer.from("2") },
    ]);
    expect(paths[0]).toBe(`${INBOX}/a_b.txt`);
    expect(paths[1]).toMatch(/^\/agent\/inbox\/a_b-[0-9a-f]{4}\.txt$/);
  });

  it("keeps the retry name inside the schema with a very long extension", async () => {
    const name = `a.${"e".repeat(125)}`;
    let first = true;
    const worker = createFakeWorker({
      onSend: (record) => {
        if (record.type !== "file_put") return;
        const exists = first;
        first = false;
        queueMicrotask(() =>
          worker.emit({
            type: "file_put_result",
            id: record.id,
            ok: !exists,
            ...(exists ? { code: "exists" as const } : {}),
          }),
        );
      },
    });
    await put(worker, [{ name, bytes: Buffer.from("x") }]);
    const retried = nth(puts(worker), 1);
    expect(FilePut.safeParse(retried).success).toBe(true);
    expect(retried.name).toMatch(/-[0-9a-f]{4}/);
  });

  it("fails the prompt when a chunk is never answered, and stops listening", async () => {
    const worker = createFakeWorker();
    let listening = 0;
    const subscribe = worker.onRecord.bind(worker);
    worker.onRecord = (listener) => {
      listening++;
      const off = subscribe(listener);
      return () => {
        listening--;
        off();
      };
    };
    const done = codeOf(put(worker, [{ name: "a.txt", bytes: Buffer.from("x") }]));
    await Promise.resolve();
    expect(listening).toBe(1);
    await clock.advance(60_000);
    expect(await done).toBe("prompt_rejected");
    expect(listening).toBe(0);
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
    const sent = await vmDelivery("look", claimed, announce)(target(worker));
    const names = puts(worker).map((frame) => frame.name);
    expect(names).toHaveLength(2);
    expect(sent.images).toEqual([{ path: `${INBOX}/${names[0]}`, mimeType: "image/png" }]);
    expect(names[0]).toMatch(/\.png$/);
    expect(sent.text).toBe(`look|${INBOX}/notes.txt`);
    expect(JSON.stringify(sent)).not.toContain(dir);
  });

  it("sends no images field without images", async () => {
    const worker = workerAnswering();
    const sent = await vmDelivery("t", { images: [], files: [file("a.txt")] }, announce)(target(worker));
    expect(sent.images).toBeUndefined();
  });

  it("refuses a symbolic link, a folder and a file over the limit, sending nothing for them", async () => {
    const worker = workerAnswering();
    const real = file("real.txt");
    const link = join(dir, "link.txt");
    symlinkSync(real.path, link);
    const folder = join(dir, "folder");
    mkdirSync(folder);
    const huge = file("huge.bin", "");
    truncateSync(huge.path, FILE_LIMITS.uploadBytes + 1);
    for (const path of [link, folder, huge.path]) {
      const claimed = { images: [], files: [{ id: "f".repeat(22), path, name: "x.txt", size: 1 }] };
      expect(await codeOf(vmDelivery("t", claimed, announce)(target(worker))), path).toBe("prompt_rejected");
    }
    expect(puts(worker)).toHaveLength(0);
  });
  it("a good file followed by a link, a folder or an oversize file leaves puts empty", async () => {
    const real = file("real.txt");
    const link = join(dir, "link.txt");
    symlinkSync(real.path, link);
    const folder = join(dir, "folder");
    mkdirSync(folder);
    const huge = file("huge.bin", "");
    truncateSync(huge.path, FILE_LIMITS.uploadBytes + 1);
    for (const bad of [link, folder, huge.path]) {
      const worker = workerAnswering();
      const claimed = {
        images: [],
        files: [file("good.txt"), { id: "f".repeat(22), path: bad, name: "bad.txt", size: 1 }],
      };
      expect(await codeOf(vmDelivery("t", claimed, announce)(target(worker))), bad).toBe("prompt_rejected");
      expect(puts(worker), bad).toHaveLength(0);
    }
  });

  it("logs the class of a refused open and never the path", async () => {
    const logs = captureLogger();
    const worker = workerAnswering();
    const link = join(dir, "secret-link.txt");
    symlinkSync(file("real.txt").path, link);
    const missing = join(dir, "secret-missing.txt");
    for (const path of [link, missing]) {
      const claimed = { images: [], files: [{ id: "f".repeat(22), path, name: "x.txt", size: 1 }] };
      await codeOf(vmDelivery("t", claimed, announce)(target(worker, logs.logger)));
    }
    const text = JSON.stringify(logs.lines);
    expect(text).toContain('"link"');
    expect(text).toContain('"missing"');
    expect(text).not.toContain("secret-");
    expect(text).not.toContain(dir);
  });

  it("refuses a file that shrank between the check and the read", async () => {
    const logs = captureLogger();
    let calls = 0;
    const shrunk = { handle: { read: async () => ({ bytesRead: calls++ === 0 ? 3 : 0 }) } as never, size: 5 };
    expect(await codeOf(readOpened(shrunk, logs.logger))).toBe("prompt_rejected");
    expect(JSON.stringify(logs.lines)).toContain("shrunk");
  });

  it("logs a worker refusal and leaves the files already sent", async () => {
    const logs = captureLogger();
    const worker = workerAnswering((frame) =>
      frame.name === "two.txt" ? { ok: false, code: "write_failed" } : {},
    );
    const claimed = { images: [], files: [file("one.txt"), file("two.txt")] };
    expect(await codeOf(vmDelivery("t", claimed, announce)(target(worker, logs.logger)))).toBe(
      "prompt_rejected",
    );
    expect(puts(worker).map((frame) => frame.name)).toEqual(["one.txt", "two.txt"]);
    expect(JSON.stringify(logs.lines)).toContain("worker");
  });
});
