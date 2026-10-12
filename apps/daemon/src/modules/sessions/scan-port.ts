import type { ShellSession } from "@pap/contracts";

/** What the search module reads from sessions (extended when the scanner joins, Task 14). */
export interface SessionsScanPort {
  /** A session's sidebar summary, only when `ownerId` owns it. */
  summary(sessionId: string, ownerId: string): ShellSession | null;
}
