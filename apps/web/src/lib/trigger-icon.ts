import { IconFeed, IconManual, IconSchedule, IconWebhook, type IconGlyph } from "@pap/ui";

export type TriggerSourceType = "schedule" | "webhook" | "feed" | "manual";

/** The lucide icon of a trigger's source (decorative: the source chip or the row carries the word). */
export const TRIGGER_ICON: Record<TriggerSourceType, IconGlyph> = {
  schedule: IconSchedule,
  webhook: IconWebhook,
  feed: IconFeed,
  manual: IconManual,
};
