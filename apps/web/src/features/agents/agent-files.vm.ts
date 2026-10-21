import { AGENT_FILE_LIMITS, AgentFilePath } from "@pap/contracts";
import type { MessageKey } from "../../i18n/index.ts";
import { UploadError } from "../../runtime/upload.ts";

const KIB = 1024;

/** A size for the table: bytes under 1 KiB, else one decimal in KiB or MiB. */
export function fileSize(bytes: number): string {
  if (bytes < KIB) return `${bytes} B`;
  if (bytes < KIB * KIB) return `${(bytes / KIB).toFixed(1)} KiB`;
  return `${(bytes / (KIB * KIB)).toFixed(1)} MiB`;
}

export const isAllowedPath = (path: string): boolean => AgentFilePath.safeParse(path).success;
export const isTooBig = (file: Pick<File, "size">): boolean => file.size > AGENT_FILE_LIMITS.maxBytes;

/** What a failed import says: the server's reason when the page has words for it, else the general one. */
export function importFailure(failure: unknown): MessageKey {
  const code = failure instanceof UploadError ? failure.code : "";
  if (code === "payload_too_large") return "agentFiles.error.payload_too_large";
  if (code === "limit_reached") return "agentFiles.error.limit_reached";
  if (code === "bad_request") return "agentFiles.error.bad_request";
  return "agentFiles.error.failed";
}
