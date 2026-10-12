import type { SessionSummary } from "@pap/contracts";

export const basename = (cwd: string): string => cwd.split("/").filter(Boolean).at(-1) ?? "";

/** What tabs, palette and tree show for a session: its name, else the folder it works in. Empty when neither exists. */
export const sessionLabel = (session: Pick<SessionSummary, "name" | "cwd">): string =>
  session.name ?? basename(session.cwd);
