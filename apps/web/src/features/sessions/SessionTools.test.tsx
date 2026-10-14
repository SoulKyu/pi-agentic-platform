// @vitest-environment happy-dom
import type { SessionLoadout, ToolPreset } from "@pap/contracts";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { alerts, button, click, hasButton, mount, press, settle, text } from "../../testing/dom.ts";
import { choose, menuItems, openMenu } from "../../testing/menus-kit.tsx";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { EMPTY_VIEW } from "../../stores/session-reducer.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { SessionTools } from "./SessionTools.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: (props: { children: ReactNode }) => createElement("a", {}, props.children) };
});

const loadout = (preset: ToolPreset): SessionLoadout => ({
  model: null,
  thinkingLevel: "off",
  levels: ["off"],
  preset,
  tools: [],
  toolsTruncated: false,
});
let bed: ReturnType<typeof fakeRuntime>;
const show = (props: { loadout?: SessionLoadout | null; running?: boolean } = {}) =>
  mount(
    <SessionTools
      sessionId="sess-1"
      loadout={props.loadout === undefined ? loadout("default") : props.loadout}
      running={props.running ?? false}
    />,
  );
const item = (name: string) => menuItems().find((label) => label?.startsWith(`${name}:`)) ?? "";
const sent = () => bed.called("sessions.setTools").map((call) => [call.params, call.options]);

beforeEach(() => {
  setLocale("en");
  bed = fakeRuntime();
  current.runtime = bed.runtime;
  useSessionStore.setState({ views: {} });
});
afterEach(() => setLocale("en"));

describe("SessionTools chip", () => {
  it("shows the loadout's preset as an agent pill in the HUD label style", async () => {
    const { container } = await show();
    const pill = button(container, "tools · Default");
    expect(pill.getAttribute("data-variant")).toBe("pill");
    expect(pill.className).toContain("label-hud");
    expect(pill.className).toContain("text-agent");
  });

  it("shows every preset the loadout can carry by name", async () => {
    const names: Record<ToolPreset, string> = {
      configured: "Configured",
      default: "Default",
      full: "Full",
      "read-only": "Read-only",
      none: "None",
      chat: "Chat only",
    };
    for (const [preset, name] of Object.entries(names)) {
      const { container, unmount } = await show({ loadout: loadout(preset as ToolPreset) });
      expect(hasButton(container, `tools · ${name}`)).toBe(true);
      await unmount();
    }
  });

  it("shows a dash, not a guessed default, for a cold session that has no loadout", async () => {
    const { container } = await show({ loadout: null });
    expect(hasButton(container, "tools · —")).toBe(true);
  });

  it("shows the stored preset of a cold session that has no loadout (MC37)", async () => {
    useSessionStore.setState({
      views: { "sess-1": { ...EMPTY_VIEW, loaded: true, toolPreset: "read-only" } },
    });
    const { container } = await show({ loadout: null });
    expect(hasButton(container, "tools · Read-only")).toBe(true);
    expect(text(container)).toContain("Reads run. Anything else asks every time, even in full access.");
  });

  it("prefers the live loadout over the stored preset", async () => {
    useSessionStore.setState({
      views: { "sess-1": { ...EMPTY_VIEW, loaded: true, toolPreset: "read-only" } },
    });
    const { container } = await show({ loadout: loadout("full") });
    expect(hasButton(container, "tools · Full")).toBe(true);
  });

  it("is disabled while the agent runs", async () => {
    const { container } = await show({ running: true });
    expect(button(container, "tools · Default").disabled).toBe(true);
  });

  it("lists the six presets with one line each and marks the current one", async () => {
    const { container } = await show();
    await openMenu(button(container, "tools · Default"));
    expect(menuItems()).toEqual([
      "Default: Read, bash, edit and write. (current)",
      "Full: Read, bash, edit, write, grep, find and ls.",
      "Read-only: Reads run. Anything else asks every time, even in full access.",
      "None: No coding tools. MCP and extension tools stay.",
      "Chat only: No tools at all: no coding tools, extensions, skills or MCP.",
      "Configured: Whatever Pi's settings and extensions enable.",
    ]);
  });

  it("explains the read-only preset under the chip in en and fr", async () => {
    const { container } = await show({ loadout: loadout("read-only") });
    expect(text(container)).toContain("Reads run. Anything else asks every time, even in full access.");
    setLocale("fr");
    const fr = await show({ loadout: loadout("read-only") });
    expect(text(fr.container)).toContain(
      "Les lectures s'exécutent. Tout le reste demande à chaque fois, même en accès complet.",
    );
    expect(hasButton(fr.container, "outils · Lecture seule")).toBe(true);
  });
});

describe("SessionTools change", () => {
  it("sends sessions.setTools with a command id for a preset other than chat", async () => {
    const { container } = await show();
    await openMenu(button(container, "tools · Default"));
    await choose(item("Full"));
    expect(sent()).toEqual([[{ sessionId: "sess-1", preset: "full" }, { commandId: "bed-cmd-00000001" }]]);
    expect(text(container)).not.toContain("The session restarts");
  });

  it("asks before switching into chat, sends only on Switch, and Cancel sends nothing", async () => {
    const { container } = await show();
    await openMenu(button(container, "tools · Default"));
    await choose(item("Chat only"));
    expect(sent()).toEqual([]);
    expect(text(container)).toContain("The session restarts; the transcript is kept.");
    await click(button(container, "Cancel"));
    expect(sent()).toEqual([]);
    expect(text(container)).not.toContain("The session restarts");
    await openMenu(button(container, "tools · Default"));
    await choose(item("Chat only"));
    await click(button(container, "Switch to Chat only"));
    await settle();
    expect(sent()).toEqual([[{ sessionId: "sess-1", preset: "chat" }, { commandId: "bed-cmd-00000001" }]]);
  });

  it("asks before switching out of chat; Escape closes the question and nothing else", async () => {
    const { container } = await show({ loadout: loadout("chat") });
    await openMenu(button(container, "tools · Chat only"));
    await choose(item("Full"));
    expect(text(container)).toContain("The session restarts; the transcript is kept.");
    const key = await press(button(container, "Cancel"), { key: "Escape", cancelable: true });
    expect(key.defaultPrevented).toBe(true);
    expect(text(container)).not.toContain("The session restarts");
    expect(sent()).toEqual([]);
  });

  it("does not ask for a cold session: the daemon only stores the choice, and the chip then shows it", async () => {
    const { container } = await show({ loadout: null });
    await openMenu(button(container, "tools · —"));
    await choose(item("Chat only"));
    expect(sent()).toEqual([[{ sessionId: "sess-1", preset: "chat" }, { commandId: "bed-cmd-00000001" }]]);
    expect(hasButton(container, "tools · Chat only")).toBe(true);
  });

  it("shows the fixed busy text on session_busy and keeps the preset shown", async () => {
    bed.handlers["sessions.setTools"] = () => {
      throw new RpcError("session_busy");
    };
    const { container } = await show();
    await openMenu(button(container, "tools · Default"));
    await choose(item("Full"));
    expect(alerts(container)).toEqual(["The session is working. Wait for it to finish, or stop it first."]);
    expect(hasButton(container, "tools · Default")).toBe(true);
  });

  it("treats a timeout as an outcome unknown: the cold choice is dropped and nothing is sent twice", async () => {
    const { container } = await show({ loadout: null });
    await openMenu(button(container, "tools · —"));
    await choose(item("Full"));
    expect(hasButton(container, "tools · Full")).toBe(true);
    bed.handlers["sessions.setTools"] = () => {
      throw new RpcError("timeout");
    };
    await openMenu(button(container, "tools · Full"));
    await choose(item("None"));
    expect(hasButton(container, "tools · —")).toBe(true);
    expect(alerts(container)).toHaveLength(1);
    expect(sent()).toHaveLength(2);
  });

  it("follows the loadout when the worker reports another preset", async () => {
    const { container, rerender } = await show();
    await rerender(<SessionTools sessionId="sess-1" loadout={loadout("none")} running={false} />);
    expect(hasButton(container, "tools · None")).toBe(true);
  });
});
