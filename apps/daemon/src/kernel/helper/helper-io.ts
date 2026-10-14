import { HELPER_MAX_RECORD_BYTES, HelperRun, HelperToDaemon, PapError } from "@pap/contracts";

export { HELPER_MAX_EVENTS, HELPER_MAX_PROMPTS } from "@pap/contracts";
export { clipWorkerString as clipForLog, createTail } from "../supervisor/worker-io.ts";

/** A deadline is a positive number of milliseconds; the longest a Settings action may wait is 15 minutes. */
export const MAX_DEADLINE_MS = 15 * 60_000;

export type ReadRecord =
  | { readonly kind: "record"; readonly record: HelperToDaemon }
  | { readonly kind: "oversized" }
  | { readonly kind: "malformed" };

/**
 * Node hands the daemon a record whole, so the bound is checked on what it parsed to: a helper that sends more than
 * 1 MiB is killed, whatever it meant. Anything that is not a helper record is refused, never guessed at.
 */
export function readHelperRecord(raw: unknown): ReadRecord {
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(raw) ?? "");
  } catch {
    return { kind: "malformed" };
  }
  if (size > HELPER_MAX_RECORD_BYTES) return { kind: "oversized" };
  const record = HelperToDaemon.safeParse(raw);
  return record.success ? { kind: "record", record: record.data } : { kind: "malformed" };
}

/** The run record, checked with the helper's own schema and the same bound; a refusal is the caller's mistake. */
export function buildRunRecord(fields: {
  readonly op: string;
  readonly agentDir: string;
  readonly papHome: string;
  readonly cwd: string | undefined;
  readonly params: unknown;
}): HelperRun {
  const parsed = HelperRun.safeParse({
    type: "helper_run",
    op: fields.op,
    agentDir: fields.agentDir,
    papHome: fields.papHome,
    ...(fields.cwd === undefined ? {} : { cwd: fields.cwd }),
    params: fields.params,
  });
  if (!parsed.success || readHelperRecord(parsed.data).kind === "oversized")
    throw new PapError("bad_request");
  return parsed.data;
}

export function checkedDeadline(deadlineMs: number): number {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new PapError("bad_request");
  return Math.min(Math.ceil(deadlineMs), MAX_DEADLINE_MS);
}
