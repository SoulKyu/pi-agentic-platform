import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PROMPT_IMAGE_BYTES, readPromptImage, readPromptImages } from "./prompt-images.ts";
import { bombPng, solidPng } from "./testing/png.ts";

vi.mock("@earendil-works/pi-coding-agent", async (original) => {
  const real = await original<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...real, resizeImage: vi.fn(real.resizeImage) };
});

// `mkfifo` makes the FIFO a test needs; a constant keeps knip from reading it as a dependency.
const MKFIFO = "mkfifo";
let home: string;
let pending: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "pap-images-")));
  pending = join(home, "attachments", "pending");
  mkdirSync(pending, { recursive: true });
  vi.mocked(sdk.resizeImage).mockClear();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const png = (path: string) => ({ path, mimeType: "image/png" });

describe("readPromptImage (M8R41)", () => {
  it("reads a PNG of the pending folder into image content", async () => {
    const path = join(pending, "good");
    writeFileSync(path, solidPng(8, 8));
    const image = await readPromptImage(home, png(path));
    expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(
      Buffer.from(image?.data ?? "", "base64")
        .subarray(1, 4)
        .toString(),
    ).toBe("PNG");
  });

  it("refuses a path that climbs out of the pending folder", async () => {
    mkdirSync(join(home, "secrets"));
    writeFileSync(join(home, "secrets", "x"), solidPng(8, 8));
    expect(await readPromptImage(home, png(join(pending, "..", "..", "secrets", "x")))).toBeNull();
  });

  it("refuses a link in the pending folder to a file outside it", async () => {
    const outside = join(home, "outside.png");
    writeFileSync(outside, solidPng(8, 8));
    symlinkSync(outside, join(pending, "link"));
    expect(await readPromptImage(home, png(join(pending, "link")))).toBeNull();
  });

  it("refuses a hard link to a file outside the pending folder", async () => {
    const outside = join(home, "outside.png");
    writeFileSync(outside, solidPng(8, 8));
    linkSync(outside, join(pending, "hard"));
    expect(await readPromptImage(home, png(join(pending, "hard")))).toBeNull();
  });

  it("refuses a file in a sub-folder of the pending folder", async () => {
    mkdirSync(join(pending, "sub"));
    writeFileSync(join(pending, "sub", "x"), solidPng(8, 8));
    expect(await readPromptImage(home, png(join(pending, "sub", "x")))).toBeNull();
  });

  it("refuses a FIFO without hanging", async () => {
    const fifo = join(pending, "fifo");
    execFileSync(MKFIFO, [fifo]);
    expect(await readPromptImage(home, png(fifo))).toBeNull();
  });

  it("refuses a file over 10 MiB, a missing file and the folder itself", async () => {
    const big = join(pending, "big");
    writeFileSync(big, Buffer.alloc(MAX_PROMPT_IMAGE_BYTES + 1));
    expect(await readPromptImage(home, png(big))).toBeNull();
    expect(await readPromptImage(home, png(join(pending, "missing")))).toBeNull();
    expect(await readPromptImage(home, png(pending))).toBeNull();
  });

  it("refuses a PNG that declares 50 000 x 50 000 pixels before anything decodes it", async () => {
    const path = join(pending, "bomb");
    writeFileSync(path, bombPng(50_000, 50_000));
    expect(await readPromptImage(home, png(path))).toBeNull();
    expect(sdk.resizeImage).not.toHaveBeenCalled();
  });
});

describe("readPromptImages", () => {
  it("returns null when one image is refused: a prompt never goes with part of its images", async () => {
    const good = join(pending, "good");
    writeFileSync(good, solidPng(8, 8));
    expect(await readPromptImages(home, [png(good), png(join(pending, "missing"))])).toBeNull();
    expect(await readPromptImages(home, [png(good)])).toHaveLength(1);
  });
});

/*
 * Mutants (RT-06), each killed by the named case:
 *  V1 the inbox is not consulted (the pending folder is still the only one) -> "reads a PNG of the inbox"
 *  V2 the pending folder stays accepted in a VM                              -> "refuses the host pending folder"
 *  V3 the folder check is dropped or compares unresolved paths               -> "refuses a file outside the inbox" and "reads through a link to the inbox folder"
 *  V4 the link count is not checked                                          -> "refuses a file with two links"
 */
describe("readPromptImage in a VM (RT-06)", () => {
  let inbox: string;
  beforeEach(() => {
    inbox = join(home, "inbox");
    mkdirSync(inbox);
  });

  it("reads a PNG of the inbox", async () => {
    const path = join(inbox, "photo.png");
    writeFileSync(path, solidPng(8, 8));
    expect(await readPromptImage(home, png(path), inbox)).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
  });

  it("reads through a link to the inbox folder: the real folder is compared", async () => {
    writeFileSync(join(inbox, "photo.png"), solidPng(8, 8));
    symlinkSync(inbox, join(home, "via"));
    expect(await readPromptImage(home, png(join(home, "via", "photo.png")), inbox)).not.toBeNull();
  });

  it("refuses a file outside the inbox", async () => {
    const outside = join(home, "outside.png");
    writeFileSync(outside, solidPng(8, 8));
    expect(await readPromptImage(home, png(outside), inbox)).toBeNull();
    expect(await readPromptImage(home, png(join(inbox, "..", "outside.png")), inbox)).toBeNull();
  });

  it("refuses the host pending folder", async () => {
    const path = join(pending, "good");
    writeFileSync(path, solidPng(8, 8));
    expect(await readPromptImage(home, png(path), inbox)).toBeNull();
  });

  it("refuses a file with two links", async () => {
    const path = join(inbox, "photo.png");
    writeFileSync(path, solidPng(8, 8));
    linkSync(path, join(home, "second"));
    expect(await readPromptImage(home, png(path), inbox)).toBeNull();
  });

  it("refuses a link in the inbox to a file outside it", async () => {
    const outside = join(home, "outside.png");
    writeFileSync(outside, solidPng(8, 8));
    symlinkSync(outside, join(inbox, "link.png"));
    expect(await readPromptImage(home, png(join(inbox, "link.png")), inbox)).toBeNull();
  });

  it("readPromptImages passes the inbox on", async () => {
    writeFileSync(join(inbox, "photo.png"), solidPng(8, 8));
    expect(await readPromptImages(home, [png(join(inbox, "photo.png"))], inbox)).toHaveLength(1);
    expect(await readPromptImages(home, [png(join(inbox, "photo.png"))])).toBeNull();
  });
});
