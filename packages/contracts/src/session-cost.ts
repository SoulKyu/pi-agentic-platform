import { z } from "zod";

/** What a session has cost so far, as the stream carries it (UX-1 §4.4). Figures are USD. */
export const SessionCost = z.object({
  /** Every run of the session, its children's included, the open ones too (RunsPort.sessionCost). USD. */
  sessionUsd: z.number().nonnegative().max(1e9),
  /** The session's own open run so far (RunsService.peek); null between runs. */
  runUsd: z.number().nonnegative().max(1e9).nullable(),
  /** How its finished runs were billed (RunsPort.sessionBilling); `unknown` while only an open run exists. */
  billing: z.enum(["api", "subscription", "unknown"]),
});
export type SessionCost = z.infer<typeof SessionCost>;
