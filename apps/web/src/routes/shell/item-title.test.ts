import { describe, expect, it, vi } from "vitest";
import { EMPTY_VIEW } from "../../stores/session-reducer.ts";
import { shellSession } from "../../testing/shell-snapshot.ts";
import { translate } from "../../i18n/index.ts";
import { itemTitle } from "./item-title.ts";

const t = (key: Parameters<typeof translate>[1]) => translate("en", key);
const store = (...sessions: ReturnType<typeof shellSession>[]) =>
  new Map(sessions.map((session) => [session.id, session]));
const none = new Map<string, ReturnType<typeof shellSession>>();
const session = (id: string, cwd: string) => store(shellSession({ id, cwd }));

describe("itemTitle", () => {
  it("titles a session by the basename of its cwd", () => {
    expect(itemTitle({ kind: "session", id: "a" }, session("a", "/home/ana/pi-agentic/"), {}, t)).toBe(
      "pi-agentic",
    );
    expect(itemTitle({ kind: "session", id: "a" }, session("a", "/home/ana/work"), {}, t)).toBe("work");
  });
  it("titles a named session by its name, not its folder", () => {
    const named = store(shellSession({ id: "a", cwd: "/home/ana/work", name: "Fix login" }));
    expect(itemTitle({ kind: "session", id: "a" }, named, {}, t)).toBe("Fix login");
  });
  it("takes the title of a session the store lacks from that session's own view", () => {
    const views = { a: { ...EMPTY_VIEW, name: "From view", cwd: "/x/y" } };
    expect(itemTitle({ kind: "session", id: "a" }, none, views, t)).toBe("From view");
    expect(itemTitle({ kind: "session", id: "a" }, none, { a: { ...EMPTY_VIEW, cwd: "/x/y" } }, t)).toBe("y");
  });
  it("titles an unnamed session by the start of its first message", () => {
    const held = store(shellSession({ id: "a", cwd: "/w/api", preview: "fix the tests" }));
    expect(itemTitle({ kind: "session", id: "a" }, held, {}, t)).toBe("fix the tests");
  });
  it("prefers the store over the view", () => {
    const views = { a: { ...EMPTY_VIEW, name: "From view", cwd: "/x/y" } };
    expect(itemTitle({ kind: "session", id: "a" }, session("a", "/home/ana/work"), views, t)).toBe("work");
  });
  it("falls back to Session for an unknown id or an empty cwd", () => {
    expect(itemTitle({ kind: "session", id: "zz" }, session("a", "/x"), {}, t)).toBe("Session");
    expect(itemTitle({ kind: "session", id: "a" }, session("a", "/"), {}, t)).toBe("Session");
  });
  it("names the fixed items", () => {
    expect(itemTitle({ kind: "home" }, none, {}, t)).toBe("New session");
    expect(itemTitle({ kind: "settings", section: "appearance" }, none, {}, t)).toBe("Settings");
    expect(itemTitle({ kind: "dev-ui" }, none, {}, t)).toBe("UI gallery");
  });
  it("gives a dev-ui item the not-found title in production, so a tab never confirms the gallery exists", () => {
    vi.stubEnv("DEV", false);
    try {
      expect(itemTitle({ kind: "dev-ui" }, none, {}, t)).toBe("This page does not exist");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
