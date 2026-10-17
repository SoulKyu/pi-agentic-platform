import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const ID = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,64}$/)
  .refine((id) => id !== "." && id !== "..");

/** What an update has done so far, written BEFORE each step, so a killed `pap update` can be finished by `pap update recover`. */
export const PendingSchema = z.strictObject({
  format: z.literal(1),
  from: ID,
  to: ID,
  step: z.enum(["stopping", "switched", "started", "rolling_back"]),
  /** Basename inside `$PAP_HOME/backups`, or null while no snapshot exists yet. */
  snapshot: z
    .string()
    .regex(/^pre-update-[A-Za-z0-9._-]{1,120}\.db$/)
    .nullable(),
  /** Migration ids the database held when the old daemon stopped (what a rollback compares against). */
  schemaBefore: z.array(z.string().max(200)).max(5000).nullable(),
  startedAt: z.string().datetime(),
});
export type Pending = z.infer<typeof PendingSchema>;

const dirOf = (home: string): string => join(home, "update");
export const pendingPath = (home: string): string => join(dirOf(home), "pending.json");

export function writePending(home: string, pending: Pending): void {
  PendingSchema.parse(pending);
  mkdirSync(dirOf(home), { recursive: true, mode: 0o700 });
  const temp = `${pendingPath(home)}.${process.pid}.tmp`;
  try {
    const fd = openSync(temp, "w", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(pending)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, pendingPath(home));
    const dir = openSync(dirOf(home), "r");
    try {
      fsyncSync(dir); // the rename itself survives a power cut
    } finally {
      closeSync(dir);
    }
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** null: none. A file that does not parse is reported as `"damaged"`, never ignored (doctor and recover both show it). */
export function readPending(home: string): Pending | "damaged" | null {
  let text: string;
  try {
    const info = statSync(pendingPath(home)); // the size is checked before a byte is read
    if (!info.isFile() || info.size > 64 * 1024) return "damaged";
    text = readFileSync(pendingPath(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return "damaged";
  }
  if (text.length > 64 * 1024) return "damaged";
  try {
    const parsed = PendingSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : "damaged";
  } catch {
    return "damaged";
  }
}

export const clearPending = (home: string): void => rmSync(pendingPath(home), { force: true });
