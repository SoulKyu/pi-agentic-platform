import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { z } from "zod";

/** null: absent. "damaged": not a regular file, above `maxBytes`, not JSON or not the shape. Never throws for content. */
export function readJsonBounded<T>(
  path: string,
  schema: z.ZodType<T>,
  maxBytes: number,
): T | "damaged" | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "damaged";
  }
  try {
    if (!fstatSync(fd).isFile()) return "damaged";
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > maxBytes) return "damaged";
    }
    const parsed = schema.safeParse(JSON.parse(buffer.toString("utf8", 0, length)));
    return parsed.success ? parsed.data : "damaged";
  } catch {
    return "damaged";
  } finally {
    closeSync(fd);
  }
}
