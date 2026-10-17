import { z } from "zod";
import { Dialog } from "./dialog.ts";
import { ChildSummary } from "./subagents.ts";

/** The most children a parent's stream shows: the newest (M11R140). */
export const CHILD_VIEWS = 8;
/**
 * One child as its parent's stream shows it (M11R140): the subagents module's summary and the child's own open approval and
 * input dialogs, as the child's stream would show them. `hiddenDialogs` counts the open ones that did not fit the event.
 */
export const ChildView = ChildSummary.extend({
  dialogs: z.array(Dialog).max(64).default([]),
  hiddenDialogs: z.number().int().nonnegative().default(0),
}).strict();
export type ChildView = z.infer<typeof ChildView>;
