// @vitest-environment happy-dom
import type { AvailableModelsData, ModelsOverview, SessionLoadout } from "@pap/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, translate } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { alerts, button, click, field, hasButton, mount, settle, text, typeInto } from "../../testing/dom.ts";
import { choose, deferred, menuItems, openMenu } from "../../testing/menus-kit.tsx";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { ModelBar } from "./ModelBar.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { to: string; params?: { section: string }; children: ReactNode }) =>
      createElement("a", { href: props.to.replace("$section", props.params?.section ?? "") }, props.children),
  };
});

const SONNET = { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4", reasoning: true };
const OPUS = { provider: "anthropic", id: "claude-opus-4", name: "Claude Opus 4", reasoning: true };
const GPT = { provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: false };
const loadout = (patch: Partial<SessionLoadout> = {}): SessionLoadout => ({
  model: SONNET,
  thinkingLevel: "high",
  levels: ["off", "low", "high"],
  preset: "configured",
  tools: [],
  toolsTruncated: false,
  ...patch,
});
const available = (models = [SONNET, OPUS, GPT]): AvailableModelsData => ({
  models,
  truncated: false,
  current: { provider: SONNET.provider, id: SONNET.id },
});
const overview = (defaults: Partial<ModelsOverview["defaults"]> = {}): ModelsOverview => ({
  providers: [],
  defaults: { provider: null, model: null, thinkingLevel: null, ...defaults },
  enabled: { patterns: null, scope: "global", settingsPath: "/x/settings.json", warnings: [] },
  offline: false,
  truncated: false,
});

let bed: ReturnType<typeof fakeRuntime>;
async function show(
  props: { loadout?: SessionLoadout | null; running?: boolean } = {},
  models: AvailableModelsData = available(),
) {
  bed.handlers["sessions.models"] ??= () => models;
  bed.handlers["models.overview"] ??= () => overview();
  const page = await mount(
    <ModelBar
      sessionId="sess-1"
      loadout={props.loadout === undefined ? loadout() : props.loadout}
      running={props.running ?? false}
    />,
  );
  return page.container;
}
const rows = () => [...document.querySelectorAll<HTMLElement>("[data-model-row]")];
const rowFor = (id: string) => {
  const found = rows().find((row) => row.dataset.modelRow === id);
  if (!found) throw new Error(`no row ${id}`);
  return found;
};
async function openModelMenu(container: HTMLElement, label = "anthropic · claude-sonnet-4") {
  await click(button(container, label));
  await act(async () => {
    await vi.waitFor(() => expect(rows().length).toBeGreaterThan(0), { timeout: 10_000 });
  });
}

// The menu is a lazy chunk: the first transform of the dialog stack is slow, so it is paid here, not in a test.
beforeAll(async () => {
  await import("./ModelMenu.tsx");
}, 60_000);

beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
});
afterEach(() => {
  vi.useRealTimers();
  setLocale("en");
});

describe("ModelBar pill", () => {
  it("shows provider · model and the level of the loadout", async () => {
    const container = await show();
    expect(button(container, "anthropic · claude-sonnet-4")).toBeTruthy();
    expect(button(container, "thinking: high")).toBeTruthy();
  });

  it("draws both pills as bordered pills in the HUD label style and the agent colour (board 09)", async () => {
    const container = await show();
    for (const name of ["anthropic · claude-sonnet-4", "thinking: high"]) {
      const pill = button(container, name);
      expect(pill.getAttribute("data-variant")).toBe("pill");
      expect(pill.className).toContain("label-hud");
      expect(pill.className).toContain("border-agent");
      expect(pill.className).toContain("text-agent");
    }
  });

  it("marks the current row from the list's own answer when the session is cold", async () => {
    const container = await show({ loadout: null });
    await openModelMenu(container, "Choose a model");
    expect(rows().filter((row) => row.getAttribute("aria-selected") === "true")).toEqual([
      rowFor("claude-sonnet-4"),
    ]);
  });

  it("still renders for a cold session (no loadout): a model button, no reasoning button", async () => {
    const container = await show({ loadout: null });
    expect(button(container, "Choose a model")).toBeTruthy();
    expect([...container.querySelectorAll("button")].map((one) => one.textContent)).toEqual([
      "Choose a model",
      "tools · —",
    ]);
    expect(bed.called("sessions.models")).toHaveLength(0);
  });

  it("loads nothing until the model pill is pressed", async () => {
    await show();
    expect(bed.called("sessions.models")).toHaveLength(0);
    expect(bed.called("models.overview")).toHaveLength(0);
  });

  it("disables the model pill while the agent runs, says why in text, and keeps reasoning enabled", async () => {
    const container = await show({ running: true });
    expect(button(container, "anthropic · claude-sonnet-4").disabled).toBe(true);
    expect(text(container)).toContain("Change the model when the agent is idle");
    expect(button(container, "thinking: high").disabled).toBe(false);
  });

  it("does not show the idle text when the agent is idle", async () => {
    const container = await show();
    expect(text(container)).not.toContain("Change the model when the agent is idle");
  });
});

describe("ModelBar model menu", () => {
  it("lists the session's models grouped by provider in the list's own order, marks the current row", async () => {
    const container = await show();
    await openModelMenu(container);
    expect(bed.called("sessions.models")).toEqual([
      { method: "sessions.models", params: { sessionId: "sess-1" } },
    ]);
    expect(bed.called("models.overview")).toHaveLength(1);
    expect(rows().map((row) => row.dataset.modelRow)).toEqual(["claude-sonnet-4", "claude-opus-4", "gpt-5"]);
    expect(
      [...document.querySelectorAll("[data-model-group]")].map((group) =>
        group.getAttribute("data-model-group"),
      ),
    ).toEqual(["anthropic", "openai"]);
    expect(rows().filter((row) => row.getAttribute("aria-selected") === "true")).toEqual([
      rowFor("claude-sonnet-4"),
    ]);
  });

  it("keeps the menu body a shrinking flex column, so the list scrolls inside the dialog and the search stays put", async () => {
    const container = await show();
    await openModelMenu(container);
    const body = document.querySelector("[data-model-menu]");
    for (const name of ["flex", "flex-col", "min-h-0", "flex-1"])
      expect(body?.classList.contains(name), name).toBe(true);
  });

  it("filters by what is typed in the search field", async () => {
    const container = await show();
    await openModelMenu(container);
    await typeInto(field(document.body, "Search models"), "opus");
    expect(rows().map((row) => row.dataset.modelRow)).toEqual(["claude-opus-4"]);
    await typeInto(field(document.body, "Search models"), "zzz");
    expect(rows()).toHaveLength(0);
    expect(text(document.body)).toContain("No model matches");
  });

  it("choosing a row sends sessions.setModel with a command id, then closes the menu", async () => {
    const container = await show();
    await openModelMenu(container);
    await click(rowFor("claude-opus-4"));
    await settle();
    expect(bed.called("sessions.setModel")).toEqual([
      {
        method: "sessions.setModel",
        params: { sessionId: "sess-1", provider: "anthropic", modelId: "claude-opus-4" },
        options: { commandId: "bed-cmd-00000001" },
      },
    ]);
    expect(rows()).toHaveLength(0);
  });

  it("shows the fixed busy text when the daemon answers session_busy, and keeps the menu open", async () => {
    bed.handlers["sessions.setModel"] = () => {
      throw new RpcError("session_busy");
    };
    const container = await show();
    await openModelMenu(container);
    await click(rowFor("gpt-5"));
    await settle();
    expect(alerts(document.body)).toEqual([
      "The session is working. Wait for it to finish, or stop it first.",
    ]);
    expect(rows()).toHaveLength(3);
  });

  it("disables the rows while a switch is pending, shows the stage label after 3 s, and sends it once", async () => {
    const pending = deferred();
    bed.handlers["sessions.setModel"] = () => pending.promise;
    const container = await show();
    await openModelMenu(container);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    await click(rowFor("gpt-5"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(rowFor("gpt-5").closest("div")?.parentElement?.textContent).toContain("Starting the session…");
    expect(rowFor("claude-opus-4").getAttribute("aria-disabled")).toBe("true");
    await click(rowFor("claude-opus-4"));
    expect(bed.called("sessions.setModel")).toHaveLength(1);
    vi.useRealTimers();
    await act(async () => pending.resolve({ ok: true }));
    await settle();
  });

  it("says how to sign in, with a link to Settings, when the list is empty", async () => {
    const container = await show({}, { models: [], truncated: false, current: null });
    await click(button(container, "anthropic · claude-sonnet-4"));
    await act(async () => {
      await vi.waitFor(() => expect(text(document.body)).toContain("No model available."), {
        timeout: 10_000,
      });
    });
    const link = [...document.querySelectorAll("a")].find(
      (one) => one.getAttribute("href") === "/settings/models",
    );
    expect(link?.textContent).toBe("Open settings");
  });

  it("shows the code's own text and a retry when the list cannot load", async () => {
    bed.handlers["sessions.models"] = () => {
      throw new RpcError("capacity");
    };
    const container = await show();
    await click(button(container, "anthropic · claude-sonnet-4"));
    await act(async () => {
      await vi.waitFor(() => expect(alerts(document.body)).toHaveLength(1), { timeout: 10_000 });
    });
    expect(alerts(document.body)).toEqual(["The server is at capacity. Try again later."]);
    bed.handlers["sessions.models"] = () => available();
    await click(button(document.body, "Try again"));
    await settle();
    expect(rows()).toHaveLength(3);
  });
});

describe("ModelBar while the agent starts to work", () => {
  it("closes an open model menu when the run starts: a model cannot change mid-run", async () => {
    bed.handlers["sessions.models"] = () => available();
    bed.handlers["models.overview"] = () => overview();
    const props = { sessionId: "sess-1", loadout: loadout() };
    const page = await mount(<ModelBar {...props} running={false} />);
    await openModelMenu(page.container);
    await page.rerender(<ModelBar {...props} running />);
    expect(rows()).toHaveLength(0);
  });
});

describe("ModelBar default star", () => {
  it("sends one default at a time: the stars wait for the answer", async () => {
    const pending = deferred();
    bed.handlers["models.setDefault"] = () => pending.promise;
    const container = await show();
    await openModelMenu(container);
    await click(button(document.body, "Make GPT-5 the default"));
    expect(button(document.body, "Make Claude Opus 4 the default").disabled).toBe(true);
    await click(button(document.body, "Make Claude Opus 4 the default"));
    expect(bed.called("models.setDefault")).toHaveLength(1);
    await act(async () => pending.resolve({ ok: true }));
    await settle();
    expect(button(document.body, "Make Claude Opus 4 the default").disabled).toBe(false);
  });

  it("marks the default from models.overview and sets another one with models.setDefault", async () => {
    const container = await show();
    bed.handlers["models.overview"] = () => overview({ provider: "openai", model: "gpt-5" });
    await openModelMenu(container);
    expect(button(document.body, "Make GPT-5 the default").getAttribute("aria-pressed")).toBe("true");
    expect(button(document.body, "Make Claude Opus 4 the default").getAttribute("aria-pressed")).toBe(
      "false",
    );
    await click(button(document.body, "Make Claude Opus 4 the default"));
    await settle();
    expect(bed.called("models.setDefault")).toEqual([
      {
        method: "models.setDefault",
        params: { provider: "anthropic", modelId: "claude-opus-4" },
        options: { commandId: "bed-cmd-00000001" },
      },
    ]);
    expect(button(document.body, "Make Claude Opus 4 the default").getAttribute("aria-pressed")).toBe("true");
    expect(button(document.body, "Make GPT-5 the default").getAttribute("aria-pressed")).toBe("false");
    expect(text(document.body)).toContain("Default model saved.");
    expect(bed.called("sessions.setModel")).toHaveLength(0);
  });

  it("explains project_scope with the fixed copy and does not mark the star", async () => {
    bed.handlers["models.setDefault"] = () => {
      throw new RpcError("project_scope");
    };
    const container = await show();
    await openModelMenu(container);
    await click(button(document.body, "Make GPT-5 the default"));
    await settle();
    expect(alerts(document.body)).toEqual(["This project's settings decide the default."]);
    expect(button(document.body, "Make GPT-5 the default").getAttribute("aria-pressed")).toBe("false");
  });

  it("says the defaults are unknown when models.overview fails, and still lets a model be chosen", async () => {
    const container = await show();
    bed.handlers["models.overview"] = () => {
      throw new RpcError("forbidden");
    };
    await openModelMenu(container);
    expect(text(document.body)).toContain("Defaults could not be read.");
    await click(rowFor("gpt-5"));
    await settle();
    expect(bed.called("sessions.setModel")).toHaveLength(1);
  });
});

describe("ModelBar reasoning menu", () => {
  it("lists only the levels of the loadout and marks the current one", async () => {
    const container = await show();
    await openMenu(button(container, "thinking: high"));
    expect(menuItems()).toEqual(["off", "low", "high (current)", "Make high the default level"]);
  });

  it("choosing a level sends sessions.setThinking with a command id", async () => {
    const container = await show();
    await openMenu(button(container, "thinking: high"));
    await choose("low");
    expect(bed.called("sessions.setThinking")).toEqual([
      {
        method: "sessions.setThinking",
        params: { sessionId: "sess-1", level: "low" },
        options: { commandId: "bed-cmd-00000001" },
      },
    ]);
  });

  it("can make the current level the default (models.setDefaultThinking)", async () => {
    const container = await show();
    await openMenu(button(container, "thinking: high"));
    await choose("Make high the default level");
    expect(bed.called("models.setDefaultThinking")).toEqual([
      {
        method: "models.setDefaultThinking",
        params: { level: "high" },
        options: { commandId: "bed-cmd-00000001" },
      },
    ]);
  });

  it("shows a refused switch in text", async () => {
    bed.handlers["sessions.setThinking"] = () => {
      throw new RpcError("command_failed");
    };
    const container = await show();
    await openMenu(button(container, "thinking: high"));
    await choose("low");
    expect(alerts(container)).toEqual([translate("en", "error.command_failed")]);
  });
});

describe("ModelBar strings", () => {
  it("every string exists in English and French with the same slots", async () => {
    const { sessionModelsEn, sessionModelsFr } = await import("../../i18n/catalog/session-models.ts");
    expect(Object.keys(sessionModelsFr)).toEqual(Object.keys(sessionModelsEn));
    const slots = (message: string) => [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(sessionModelsEn) as Array<keyof typeof sessionModelsEn>)
      expect(slots(sessionModelsFr[key]), key).toEqual(slots(sessionModelsEn[key]));
  });

  it("shows French when the locale is French", async () => {
    setLocale("fr");
    const container = await show();
    expect(hasButton(container, "thinking: high")).toBe(false);
    expect(hasButton(container, "réflexion : élevée")).toBe(true);
  });
});
