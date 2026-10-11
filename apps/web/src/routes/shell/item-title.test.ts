import type { SessionSummary } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { translate } from "../../i18n/index.ts";
import { itemTitle } from "./item-title.ts";

const t = (key: Parameters<typeof translate>[1]) => translate("en", key);
const session = (id: string, cwd: string): SessionSummary => ({
  id,
  cwd,
  status: "idle",
  createdAt: 0,
  updatedAt: 0,
});

describe("itemTitle", () => {
  it("titles a session by the basename of its cwd", () => {
    expect(itemTitle({ kind: "session", id: "a" }, [session("a", "/home/ana/pi-agentic/")], t)).toBe(
      "pi-agentic",
    );
    expect(itemTitle({ kind: "session", id: "a" }, [session("a", "/home/ana/work")], t)).toBe("work");
  });
  it("falls back to Session for an unknown id or an empty cwd", () => {
    expect(itemTitle({ kind: "session", id: "zz" }, [session("a", "/x")], t)).toBe("Session");
    expect(itemTitle({ kind: "session", id: "a" }, [session("a", "/")], t)).toBe("Session");
  });
  it("names the fixed items", () => {
    expect(itemTitle({ kind: "home" }, [], t)).toBe("New session");
    expect(itemTitle({ kind: "settings", section: "appearance" }, [], t)).toBe("Settings");
    expect(itemTitle({ kind: "dev-ui" }, [], t)).toBe("UI gallery");
  });
  it("gives a dev-ui item the not-found title in production, so a tab never confirms the gallery exists", () => {
    vi.stubEnv("DEV", false);
    try {
      expect(itemTitle({ kind: "dev-ui" }, [], t)).toBe("This page does not exist");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
