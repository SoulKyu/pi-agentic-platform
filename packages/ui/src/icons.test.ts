import { CircleSlash, Layers, Play, Rss, Star, Timer, Webhook, X } from "lucide-react";
import { describe, expect, it } from "vitest";
import {
  IconCancelled,
  IconClose,
  IconFailed,
  IconFeed,
  IconManual,
  IconOpenItems,
  IconSchedule,
  IconStar,
  IconWebhook,
} from "./index.ts";

describe("the icon names", () => {
  it("the new names export lucide's Timer, Webhook, Rss, Play, Star, X, CircleSlash and Layers", () => {
    expect(IconSchedule).toBe(Timer);
    expect(IconWebhook).toBe(Webhook);
    expect(IconFeed).toBe(Rss);
    expect(IconManual).toBe(Play);
    expect(IconStar).toBe(Star);
    expect(IconFailed).toBe(X);
    expect(IconFailed).toBe(IconClose);
    expect(IconCancelled).toBe(CircleSlash);
    expect(IconOpenItems).toBe(Layers);
  });
});
