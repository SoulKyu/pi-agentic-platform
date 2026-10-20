import { constants } from "node:fs";
import { type FileHandle, open, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { imageSize, withinPixelBudget } from "./image-size.ts";

export const MAX_PROMPT_IMAGE_BYTES = 10 * 1024 * 1024;
export interface PromptImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

/** At most the cap plus one byte, whatever the file grows to; null when it is over the cap. */
async function readCapped(handle: FileHandle): Promise<Uint8Array | null> {
  const buffer = Buffer.alloc(MAX_PROMPT_IMAGE_BYTES + 1);
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled > MAX_PROMPT_IMAGE_BYTES ? null : new Uint8Array(buffer.buffer, buffer.byteOffset, filled);
}

/**
 * An image the daemon claimed for this prompt, read only from pap's pending uploads (M8R41), or in a VM only from the
 * agent's inbox (RT-06: the host's folder is not in the guest). Null when refused.
 */
export async function readPromptImage(
  papHome: string,
  image: { readonly path: string; readonly mimeType: string },
  inbox?: string,
): Promise<PromptImage | null> {
  let pending: string;
  let real: string;
  try {
    pending = await realpath(inbox ?? join(papHome, "attachments", "pending"));
    real = await realpath(image.path);
  } catch {
    return null;
  }
  if (dirname(real) !== pending) return null;
  let handle;
  try {
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    // The store writes single-link files: another name for the inode is a file that came from elsewhere.
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_PROMPT_IMAGE_BYTES) return null;
    const bytes = await readCapped(handle);
    if (bytes === null) return null;
    // M8R108: the header's size first; Photon decodes the whole bitmap.
    if (!withinPixelBudget(imageSize(bytes, image.mimeType))) return null;
    const resized = await resizeImage(bytes, image.mimeType);
    return resized === null ? null : { type: "image", data: resized.data, mimeType: resized.mimeType };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** Every image of one prompt, or null when one is refused: a prompt never goes with part of its images. */
export async function readPromptImages(
  papHome: string,
  images: readonly { readonly path: string; readonly mimeType: string }[],
  inbox?: string,
): Promise<PromptImage[] | null> {
  const read: PromptImage[] = [];
  for (const image of images) {
    const one = await readPromptImage(papHome, image, inbox);
    if (one === null) return null;
    read.push(one);
  }
  return read;
}
