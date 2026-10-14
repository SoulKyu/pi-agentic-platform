// @vitest-environment happy-dom
import type { AttachmentView } from "@pap/contracts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UploadError } from "../../../runtime/upload.ts";
import { mount, settle } from "../../../testing/dom.ts";
import "./register-files-catalog.ts";
import { useAttachments, type Attachments } from "./use-attachments.ts";

const idOf = (n: number) => String(n).padStart(22, "x");
const file = (name: string, type = "") => new File(["data"], name, { type });

interface Call {
  name: string;
  signal: AbortSignal;
  resolve(view: AttachmentView): void;
  reject(failure: unknown): void;
}

function setup() {
  const calls: Call[] = [];
  const upload = vi.fn((_session: string, f: File, signal: AbortSignal) => {
    return new Promise<AttachmentView>((resolve, reject) => {
      calls.push({ name: f.name, signal, resolve, reject });
    });
  });
  const timers = {
    jobs: new Map<number, () => void>(),
    n: 0,
    set(fn: () => void) {
      this.jobs.set(++this.n, fn);
      return this.n;
    },
    clear(id: number) {
      this.jobs.delete(id);
    },
  };
  let latest: Attachments | null = null;
  function Probe() {
    latest = useAttachments("s1", { upload, timers });
    return <p>{latest.items.map((item) => `${item.name}:${item.status}`).join(",")}</p>;
  }
  return {
    calls,
    upload,
    timers,
    get a(): Attachments {
      if (!latest) throw new Error("not mounted");
      return latest;
    },
    mountIt: () => mount(<Probe />),
    answer(index: number, n: number, kind: "image" | "file" = "file") {
      const call = calls[index];
      call?.resolve({
        id: idOf(n),
        name: call.name,
        size: 4,
        kind,
        mimeType: kind === "image" ? "image/png" : null,
      });
    },
  };
}

beforeEach(() => {
  let n = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:t/${++n}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("useAttachments", () => {
  it("uploads a dropped PNG and PDF once each, and lists the ready ids in order", async () => {
    const bed = setup();
    await bed.mountIt();
    await act(async () => bed.a.add([file("a.png", "image/png"), file("b.pdf", "application/pdf")], 0));
    expect(bed.upload).toHaveBeenCalledTimes(2);
    expect(bed.a.uploading).toBe(true);
    await act(async () => bed.answer(1, 2));
    await act(async () => bed.answer(0, 1, "image"));
    expect(bed.a.uploading).toBe(false);
    expect(bed.a.ids()).toEqual([idOf(1), idOf(2)]);
    expect(bed.a.hasImage).toBe(true);
    expect(bed.a.items[0]?.previewUrl).toBe("blob:t/1");
    expect(bed.a.items[1]?.previewUrl).toBeNull();
  });

  it("refuses the 11th file with the note, and skips a folder with its note", async () => {
    const bed = setup();
    await bed.mountIt();
    await act(async () =>
      bed.a.add(
        Array.from({ length: 11 }, (_, i) => file(`f${i}.txt`)),
        0,
      ),
    );
    expect(bed.a.items).toHaveLength(10);
    expect(bed.a.note).toBe("At most 10 files per message");
    await act(async () => bed.a.add([], 1));
    expect(bed.a.note).toBe("Folders are not uploaded");
    expect(bed.upload.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("uploads at most four at a time and starts the next as one settles", async () => {
    const bed = setup();
    await bed.mountIt();
    await act(async () =>
      bed.a.add(
        Array.from({ length: 6 }, (_, i) => file(`f${i}.txt`)),
        0,
      ),
    );
    expect(bed.upload).toHaveBeenCalledTimes(4);
    await act(async () => bed.answer(0, 1));
    expect(bed.upload).toHaveBeenCalledTimes(5);
    await act(async () => bed.answer(1, 2));
    expect(bed.upload).toHaveBeenCalledTimes(6);
  });

  it("shows Retry for a failed upload and retries it", async () => {
    const bed = setup();
    await bed.mountIt();
    await act(async () => bed.a.add([file("a.txt")], 0));
    await act(async () => bed.calls[0]?.reject(new UploadError("forbidden")));
    expect(bed.a.items[0]).toMatchObject({
      status: "failed",
      error: "You do not have permission for this action.",
    });
    const key = bed.a.items[0]?.key ?? "";
    await act(async () => bed.a.retry(key));
    expect(bed.upload).toHaveBeenCalledTimes(2);
    await act(async () => bed.answer(1, 1));
    expect(bed.a.ids()).toEqual([idOf(1)]);
  });

  it("retries a capacity answer after another upload settles, and never shows it as an error", async () => {
    const bed = setup();
    await bed.mountIt();
    await act(async () => bed.a.add([file("a.txt"), file("b.txt")], 0));
    await act(async () => bed.calls[1]?.reject(new UploadError("capacity")));
    expect(bed.a.items[1]).toMatchObject({ status: "queued", error: null });
    expect(bed.upload).toHaveBeenCalledTimes(2);
    await act(async () => bed.answer(0, 1));
    expect(bed.upload).toHaveBeenCalledTimes(3);
    await act(async () => bed.answer(2, 2));
    expect(bed.a.ids()).toEqual([idOf(1), idOf(2)]);
  });

  it("retries a capacity answer on a timer when nothing of this tray is running, a bounded number of times", async () => {
    const bed = setup();
    await bed.mountIt();
    await act(async () => bed.a.add([file("a.txt")], 0));
    for (let attempt = 0; attempt < 5; attempt++) {
      await act(async () => bed.calls[attempt]?.reject(new UploadError("capacity")));
      expect(bed.a.items[0]?.status).toBe("queued");
      expect(bed.timers.jobs.size).toBe(1);
      await act(async () => [...bed.timers.jobs.values()].forEach((job) => job()));
      bed.timers.jobs.clear();
    }
    await act(async () => bed.calls[5]?.reject(new UploadError("capacity")));
    expect(bed.a.items[0]?.status).toBe("failed");
    expect(bed.timers.jobs.size).toBe(0);
  });

  it("explains an interrupted upload and offers Retry", async () => {
    const bed = setup();
    await bed.mountIt();
    await act(async () => bed.a.add([file("a.txt")], 0));
    await act(async () => bed.calls[0]?.reject(new UploadError("interrupted")));
    expect(bed.a.items[0]).toMatchObject({
      status: "failed",
      error: "The upload stopped before the end: a slow or dropped connection. Try again on a faster link.",
    });
  });

  it("says a picture the daemon classed as a file is sent as a file", async () => {
    const bed = setup();
    await bed.mountIt();
    await act(async () => bed.a.add([file("a.png", "image/png")], 0));
    await act(async () => bed.answer(0, 1, "file"));
    expect(bed.a.items[0]?.asFile).toBe(true);
    expect(bed.a.hasImage).toBe(false);
  });

  it("removes a chip: aborts its upload, revokes its preview, drops the late answer", async () => {
    const bed = setup();
    await bed.mountIt();
    await act(async () => bed.a.add([file("a.png", "image/png")], 0));
    const key = bed.a.items[0]?.key ?? "";
    await act(async () => bed.a.remove(key));
    expect(bed.calls[0]?.signal.aborted).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:t/1");
    await act(async () => bed.answer(0, 1, "image"));
    expect(bed.a.items).toEqual([]);
    expect(bed.a.ids()).toEqual([]);
  });

  it("clears the tray on request and on unmount, revoking every preview and aborting what runs", async () => {
    const bed = setup();
    const page = await bed.mountIt();
    await act(async () => bed.a.add([file("a.png", "image/png"), file("b.png", "image/png")], 0));
    await act(async () => bed.answer(0, 1, "image"));
    await act(async () => bed.a.clear());
    expect(bed.a.items).toEqual([]);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    await act(async () => bed.a.add([file("c.png", "image/png")], 0));
    await page.unmount();
    expect(bed.calls[2]?.signal.aborted).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
  });

  it("takes a pasted image, and leaves a paste with text alone", async () => {
    const bed = setup();
    await bed.mountIt();
    const shot = file("shot.png", "image/png");
    const paste = (text: string) => {
      const preventDefault = vi.fn();
      bed.a.onPaste({
        preventDefault,
        clipboardData: { files: [shot], items: [], getData: () => text },
      } as never);
      return preventDefault;
    };
    await act(async () => void expect(paste("some words")).not.toHaveBeenCalled());
    expect(bed.upload).not.toHaveBeenCalled();
    await act(async () => void expect(paste("")).toHaveBeenCalled());
    expect(bed.upload).toHaveBeenCalledTimes(1);
  });

  it("shows drag-over feedback that fades when the drag stops", async () => {
    const bed = setup();
    await bed.mountIt();
    const preventDefault = vi.fn();
    await act(async () => bed.a.onDragOver({ preventDefault, dataTransfer: { types: ["Files"] } } as never));
    expect(preventDefault).toHaveBeenCalled();
    expect(bed.a.dragging).toBe(true);
    await act(async () => [...bed.timers.jobs.values()].forEach((job) => job()));
    expect(bed.a.dragging).toBe(false);
  });

  it("lets an explorer row be dropped without the file hint", async () => {
    const bed = setup();
    await bed.mountIt();
    const preventDefault = vi.fn();
    await act(async () =>
      bed.a.onDragOver({ preventDefault, dataTransfer: { types: ["application/x-pap-path"] } } as never),
    );
    expect(preventDefault).toHaveBeenCalled();
    expect(bed.a.dragging).toBe(false);
  });

  it("takes ready attachments out by id, and renews them for fresh ids", async () => {
    const bed = setup();
    await bed.mountIt();
    await act(async () => bed.a.add([file("a.png", "image/png"), file("b.txt")], 0));
    await act(async () => bed.answer(0, 1, "image"));
    await act(async () => bed.answer(1, 2));
    await act(async () => bed.a.renew([idOf(1)]));
    expect(bed.upload).toHaveBeenCalledTimes(3);
    expect(bed.a.ids()).toEqual([idOf(2)]);
    await act(async () => bed.a.drop([idOf(2)]));
    expect(bed.a.items.map((item) => item.name)).toEqual(["a.png"]);
    expect(bed.a.failed).toBe(0);
  });

  it("ignores a text drag", async () => {
    const bed = setup();
    await bed.mountIt();
    const preventDefault = vi.fn();
    await act(async () =>
      bed.a.onDragOver({ preventDefault, dataTransfer: { types: ["text/plain"] } } as never),
    );
    expect(preventDefault).not.toHaveBeenCalled();
    expect(bed.a.dragging).toBe(false);
    await settle();
  });
});
