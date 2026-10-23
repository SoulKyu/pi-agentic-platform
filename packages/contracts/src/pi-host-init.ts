import { z } from "zod";
import { AbsolutePath } from "./text-rules.ts";

/** A subagent's child: the profile's prompt (M11R136). */
export const InitChild = z.object({ prompt: z.string().max(32_768) }).strict();

/** The session's OKF bundle: its folder, appended to the system prompt once at the worker's start. Missing: no OKF. */
export const InitKnowledge = z.object({ path: AbsolutePath }).strict();
export type InitKnowledge = z.input<typeof InitKnowledge>;
