// @vitest-environment happy-dom
import { AgentInput, EGRESS_UNKNOWN, type AgentView } from "@pap/contracts";
import { TooltipProvider } from "@pap/ui";
import type { ReactNode } from "react";
import { act } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, field, mount, press, settle, text, typeInto } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { AgentForm } from "./AgentForm.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { to: string; children: ReactNode }) =>
      createElement("a", { href: props.to }, props.children),
  };
});

const current: { runtime: Runtime | undefined } = { runtime: undefined };
const probe = {
  usable: true,
  path: "/usr/bin/bwrap",
  reason: null,
  checkedAt: 5,
  egress: EGRESS_UNKNOWN,
} as const;
const view = (patch: Partial<Parameters<typeof AgentInput.parse>[0]> = {}): AgentView => ({
  id: "atlas-1a2b",
  name: "atlas",
  input: AgentInput.parse({ name: "atlas", ...patch }),
  state: "active",
  threadSessionId: null,
  unread: 0,
  paused: false,
  quarantinedAt: null,
  revision: 3,
  createdAt: 1,
  updatedAt: 2,
});

const pickable = {
  models: [
    { provider: "anthropic", id: "haiku", name: "Haiku", reasoning: false },
    { provider: "anthropic", id: "sonnet", name: "Sonnet", reasoning: true },
  ],
  providers: [{ id: "anthropic", name: "Anthropic" }],
  origin: "signed-in",
  truncated: false,
};
// The whole catalog, as the old form read it: it also lists an openai model that is not pickable.
const overview = {
  providers: [
    {
      id: "openai",
      models: [{ provider: "openai", id: "gpt-x", name: "GPT X", reasoning: true, enabled: true }],
    },
  ],
  truncated: false,
};

beforeAll(async () => {
  // The first transform of the overlay and list chunks is slow: pay it here, not inside a test.
  await import("../models/picker/PickerList.tsx");
  await import("@pap/ui/overlays");
}, 60_000);
beforeEach(() => setLocale("en"));

async function open(agent: AgentView | null, available: unknown = pickable) {
  const bed = fakeRuntime();
  current.runtime = bed.runtime;
  bed.handlers["models.available"] = () => available;
  bed.handlers["models.overview"] = () => overview;
  bed.handlers["agents.update"] = () => view();
  await mount(
    <TooltipProvider>
      <StepUpContext.Provider value={vi.fn() as unknown as StepUpRunner}>
        <AgentForm agent={agent} probe={probe} presetField={() => null} onSaved={vi.fn()} />
      </StepUpContext.Provider>
    </TooltipProvider>,
  );
  await settle();
  return bed;
}
const trigger = () => document.querySelector('[data-slot="agent-model"] button') as HTMLButtonElement;
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
async function openPicker() {
  await click(trigger());
  await act(async () => {
    await vi.waitFor(() => expect(options().length).toBeGreaterThan(0), { timeout: 10_000 });
  });
}
const pick = async (id: string) => {
  await click(options().find((node) => node.dataset.modelRow === id) as HTMLElement);
  await settle();
};
const sentInput = (bed: ReturnType<typeof fakeRuntime>) =>
  (bed.called("agents.update")[0]?.params as { input: AgentInput }).input;

describe("agent form: the model picker", () => {
  it("agent-form.uses-available-not-overview: lists the pickable models, never the whole catalog", async () => {
    const bed = await open(view());
    expect(document.querySelector('[data-slot="agent-model"] [role="combobox"]')).toBeNull();
    expect(trigger().getAttribute("aria-haspopup")).toBe("dialog");
    expect(bed.called("models.available")).toHaveLength(0);
    await openPicker();
    expect(bed.called("models.available").map((call) => call.params)).toEqual([{}]);
    expect(bed.called("models.overview")).toEqual([]);
    expect(options().map((node) => node.dataset.modelRow ?? "default")).toEqual([
      "default",
      "haiku",
      "sonnet",
    ]);
    expect(text(document.body)).not.toContain("GPT X");
    expect(text(document.body)).not.toContain("openai");
  });

  it("picking the first row sends the default model (null)", async () => {
    const bed = await open(view({ model: { provider: "anthropic", modelId: "sonnet" } }));
    await openPicker();
    expect(options()[0]?.textContent).toBe("Default model");
    await click(options()[0] as HTMLElement);
    await click(button(document.body, "Save"));
    await settle();
    expect(sentInput(bed).model).toBeNull();
  });

  it("saved-model-stays-visible: a saved model the answer does not offer is shown, and the save carries it", async () => {
    const bed = await open(view({ model: { provider: "anthropic", modelId: "gpt-x" } }));
    expect(trigger().textContent).toContain("gpt-x");
    await openPicker();
    const saved = options().find((node) => node.dataset.modelRow === "gpt-x");
    expect(saved?.textContent).toContain("Saved model, no longer offered");
    await press(document.activeElement ?? document.body, { key: "Escape" });
    await vi.waitFor(() => expect(document.querySelector('[data-slot="popover"]')).toBeNull());
    await click(button(document.body, "Save"));
    await settle();
    expect(sentInput(bed).model).toEqual({ provider: "anthropic", modelId: "gpt-x" });
  });

  it("says the saved model is no longer offered in French", async () => {
    setLocale("fr");
    await open(view({ model: { provider: "anthropic", modelId: "gpt-x" } }));
    await openPicker();
    expect(text(document.body)).toContain("Modèle enregistré, plus proposé");
  });
});

describe("agent form: a model an extension adds (ADR 0070 as amended)", () => {
  // An id with characters a careless round trip would change: the save must send it as it was saved.
  const BRIDGE = { provider: "claude-bridge", modelId: "claude-opus-4[1m]" };

  it("saved.ext-kept: an edit of another field saves the extension's model byte for byte, picker opened or not", async () => {
    const bed = await open(view({ model: BRIDGE, thinking: "high" }));
    expect(trigger().textContent).toContain("claude-opus-4[1m]");
    expect(trigger().textContent).toContain("claude-bridge");
    await typeInto(field(document.body, "Name"), "atlas2");
    await click(button(document.body, "Save"));
    await settle();
    expect(JSON.stringify(sentInput(bed).model)).toBe(JSON.stringify(BRIDGE));
    expect(sentInput(bed).thinking).toBe("high");
    expect(sentInput(bed).name).toBe("atlas2");
    expect(bed.called("models.extensions")).toEqual([]);
  });

  it("saved.ext-note: opening the picker shows it as the current value with the extension note, and keeps it", async () => {
    const bed = await open(view({ model: BRIDGE, thinking: "high" }));
    await openPicker();
    const saved = options().find((node) => node.dataset.modelRow === BRIDGE.modelId) as HTMLElement;
    expect(saved.getAttribute("aria-selected")).toBe("true");
    expect(text(saved)).toContain("claude-bridge");
    expect(text(saved)).toContain("May come from an extension, checked when it runs");
    await press(document.activeElement ?? document.body, { key: "Escape" });
    await vi.waitFor(() => expect(document.querySelector('[data-slot="popover"]')).toBeNull());
    await typeInto(field(document.body, "Name"), "atlas3");
    await click(button(document.body, "Save"));
    await settle();
    expect(JSON.stringify(sentInput(bed).model)).toBe(JSON.stringify(BRIDGE));
    expect(sentInput(bed).thinking).toBe("high");
  });
});

describe("agent form: a saved model the list does not offer (fix round 1)", () => {
  const closePicker = async () => {
    await press(document.activeElement ?? document.body, { key: "Escape" });
    await vi.waitFor(() => expect(document.querySelector('[data-slot="popover"]')).toBeNull());
  };
  const hint = () => document.querySelector('[data-slot="agent-model"] [data-model-not-offered]');

  it("saved.not-offered-hint: once the list says it is not offered, the field says so and the save still sends it", async () => {
    const bed = await open(view({ model: { provider: "anthropic", modelId: "gone-x" } }));
    expect(hint()).toBeNull();
    await openPicker();
    await closePicker();
    expect(hint()?.textContent).toContain("Not offered now: a run uses Pi's default model instead.");
    await typeInto(field(document.body, "Name"), "atlas4");
    await click(button(document.body, "Save"));
    await settle();
    expect(sentInput(bed).model).toEqual({ provider: "anthropic", modelId: "gone-x" });
  });

  it("i2.chat-only: an agent in Chat only gets no extension models, and its saved one is not offered", async () => {
    await open(view({ model: { provider: "claude-bridge", modelId: "claude-opus-4" }, preset: "chat" }));
    await openPicker();
    expect(text(document.body)).toContain("Chat only loads no extension");
    expect(text(document.body)).not.toContain("Show models added by extensions");
    await closePicker();
    // Under Chat only the preset keeps it out: the line says so, never "Settings decides" (review N2).
    expect(hint()?.textContent).toContain("Not offered in Chat only, which loads no extension");
    expect(hint()?.textContent).not.toContain("Settings");
  });

  it("n2.chat-only-pi-model: in Chat only a model of Pi's own provider keeps the line that points to Settings", async () => {
    await open(view({ model: { provider: "anthropic", modelId: "gone-x" }, preset: "chat" }));
    await openPicker();
    await closePicker();
    expect(hint()?.textContent).toContain("Settings › Models › Available models decides what is offered.");
    expect(hint()?.textContent).not.toContain("Chat only");
  });

  it("n2.chat-only-fr: the Chat only line is in French with vous", async () => {
    setLocale("fr");
    await open(view({ model: { provider: "claude-bridge", modelId: "claude-opus-4" }, preset: "chat" }));
    await openPicker();
    await closePicker();
    expect(hint()?.textContent).toContain("Pas proposé en Chat seul");
    expect(hint()?.textContent).toContain("Choisissez un modèle de Pi");
  });

  it("says nothing while the model may be an extension's, nor for an offered one", async () => {
    await open(view({ model: { provider: "claude-bridge", modelId: "claude-opus-4" } }));
    await openPicker();
    await closePicker();
    expect(hint()).toBeNull();
    await openPicker();
    await pick("sonnet");
    expect(hint()).toBeNull();
  });
});

describe("agent form: thinking follows the model (carry 3)", () => {
  it("thinking.follows-model: picking a model that does not reason resets a level above off", async () => {
    const bed = await open(view({ model: { provider: "anthropic", modelId: "sonnet" }, thinking: "high" }));
    await openPicker();
    await pick("haiku");
    expect(text(document.body)).toContain("This model does not reason: thinking stays off.");
    await click(button(document.body, "Save"));
    await settle();
    expect(sentInput(bed).model).toEqual({ provider: "anthropic", modelId: "haiku" });
    expect(sentInput(bed).thinking).toBeNull();
  });

  it("keeps the level when the picked model reasons", async () => {
    const bed = await open(view({ model: { provider: "anthropic", modelId: "haiku" }, thinking: "off" }));
    await openPicker();
    await pick("sonnet");
    expect(text(document.body)).not.toContain("does not reason");
    await click(button(document.body, "Save"));
    await settle();
    expect(sentInput(bed).thinking).toBe("off");
  });

  it("re-picking the saved-but-unoffered model keeps the thinking level and shows no hint", async () => {
    const bed = await open(view({ model: { provider: "openai", modelId: "gpt-x" }, thinking: "high" }));
    await openPicker();
    await pick("gpt-x");
    expect(text(document.body)).not.toContain("does not reason");
    await click(button(document.body, "Save"));
    await settle();
    expect(sentInput(bed).model).toEqual({ provider: "openai", modelId: "gpt-x" });
    expect(sentInput(bed).thinking).toBe("high");
  });

  it("a saved model nobody has listed yet shows every level and no hint", async () => {
    await open(view({ model: { provider: "anthropic", modelId: "haiku" } }));
    expect(text(document.body)).not.toContain("does not reason");
  });
});
