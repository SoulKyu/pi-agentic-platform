import type { QueueView } from "@pap/contracts";

/**
 * How many queued messages have no preview here. The previews are a contiguous prefix cut by a budget and the view
 * carries no flag for it, so the count minus what is shown is the only honest figure (an empty follow-up list may
 * just mean the steering previews used the whole budget).
 */
export const queueMore = (queue: QueueView): number =>
  Math.max(0, queue.count - queue.steering.length - queue.followUp.length);
