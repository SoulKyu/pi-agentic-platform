import { EntryRef } from "@pap/contracts";

/** What a worker may send as a summary: pi-host clips to the same size, this keeps a worker that does not honest. */
const SUMMARY_CHARS = 65_536;

/** The entry as a client is told of it, or null when it is malformed or an id is longer than the contract allows. */
export function slimEntryRef(raw: unknown): EntryRef | null {
  const parsed = EntryRef.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const timeOf = (timestamp: unknown): number => {
  const time = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
};

/**
 * The message a compaction or branch summary entry shows as, built like Pi's `createCompactionSummaryMessage` and
 * `createBranchSummaryMessage` (a branch summary with no text is not shown), so a row seen live and the same row read
 * from the file compare equal in the client. Null for any other entry.
 */
export function summaryRow(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw) || typeof raw.summary !== "string") return null;
  const summary = raw.summary.slice(0, SUMMARY_CHARS);
  if (raw.type === "compaction") {
    return {
      role: "compactionSummary",
      summary,
      tokensBefore:
        typeof raw.tokensBefore === "number" && Number.isFinite(raw.tokensBefore) ? raw.tokensBefore : 0,
      timestamp: timeOf(raw.timestamp),
    };
  }
  if (raw.type === "branch_summary" && summary !== "") {
    return {
      role: "branchSummary",
      summary,
      fromId: typeof raw.fromId === "string" && raw.fromId.length <= 128 ? raw.fromId : null,
      timestamp: timeOf(raw.timestamp),
    };
  }
  return null;
}
