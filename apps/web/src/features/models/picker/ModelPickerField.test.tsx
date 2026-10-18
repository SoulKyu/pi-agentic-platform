// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../../runtime/index.ts";
import { click, mount, press, text } from "../../../testing/dom.ts";
import { fakeRuntime } from "../../../testing/runtime-bed.ts";
import { ModelPickerField } from "./ModelPickerField.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { to: string; children: ReactNode }) =>
      createElement("a", { href: props.to }, props.children),
  };
});

const answer = {
  models: [
    { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4", reasoning: true },
    { provider: "anthropic", id: "claude-opus-4", name: "Claude Opus 4", reasoning: true },
    { provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: false },
  ],
  providers: [
    { id: "anthropic", name: "Anthropic" },
    { id: "openai", name: "OpenAI" },
  ],
  origin: "signed-in",
  truncated: false,
};

let bed: ReturnType<typeof fakeRuntime>;
const SONNET = { provider: "anthropic", modelId: "claude-sonnet-4" };

beforeAll(async () => {
  // The first transform of the overlay and list chunks is slow: pay it here, not inside a test.
  await import("./PickerList.tsx");
  await import("@pap/ui/overlays");
}, 60_000);
beforeEach(() => {
  bed = fakeRuntime();
  bed.handlers["models.available"] = () => answer;
  current.runtime = bed.runtime;
});
afterEach(() => vi.unstubAllGlobals());

const trigger = (container: HTMLElement) => container.querySelector("button") as HTMLButtonElement;
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
async function open(container: HTMLElement) {
  await click(trigger(container));
  await act(async () => {
    await vi.waitFor(() => expect(options().length).toBeGreaterThan(0), { timeout: 10_000 });
  });
}

describe("ModelPickerField trigger", () => {
  it("shows the chosen model and a provider chip, named by its label", async () => {
    const page = await mount(
      <ModelPickerField label="Model" value={SONNET} cwd={null} onChange={() => {}} />,
    );
    const button = trigger(page.container);
    expect(button.textContent).toContain("claude-sonnet-4");
    expect(button.textContent).toContain("anthropic");
    expect(button.getAttribute("aria-labelledby")).not.toBeNull();
    expect(text(page.container)).toContain("Model");
  });

  it("strips hidden characters from the model id and the provider chip it shows (MPR26)", async () => {
    const page = await mount(
      <ModelPickerField
        label="Model"
        value={{ provider: "ev\u202eil", modelId: "gp\u200bt-\u00075" }}
        cwd={null}
        onChange={() => {}}
      />,
    );
    const shown = trigger(page.container).textContent ?? "";
    expect(shown).toContain("gpt-5");
    expect(shown).toContain("evil");
    for (const hidden of ["\u202e", "\u200b", "\u0007"]) expect(shown).not.toContain(hidden);
  });

  it("is a plain button until the overlays load: haspopup dialog, not expanded", async () => {
    const page = await mount(
      <ModelPickerField label="Model" value={SONNET} cwd={null} onChange={() => {}} />,
    );
    const button = trigger(page.container);
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.className).toContain("pointer-coarse:min-h-11");
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("says what is chosen when nothing is, and shows the default label when it has one", async () => {
    const none = await mount(<ModelPickerField label="Model" value={null} cwd={null} onChange={() => {}} />);
    expect(trigger(none.container).textContent).toContain("Choose a model");
    const withDefault = await mount(
      <ModelPickerField
        label="Model"
        value={null}
        cwd={null}
        defaultLabel="Pi's default"
        onChange={() => {}}
      />,
    );
    expect(trigger(withDefault.container).textContent).toContain("Pi's default");
  });

  it("shows its hint and can be disabled", async () => {
    const page = await mount(
      <ModelPickerField
        label="Model"
        value={null}
        cwd={null}
        hint="Used for new runs"
        disabled
        onChange={() => {}}
      />,
    );
    expect(text(page.container)).toContain("Used for new runs");
    expect(trigger(page.container).disabled).toBe(true);
  });
});

describe("ModelPickerField popover", () => {
  it("calls models.available only once opened, with the folder", async () => {
    const page = await mount(
      <ModelPickerField label="Model" value={SONNET} cwd="/work/a" onChange={() => {}} />,
    );
    expect(bed.called("models.available")).toHaveLength(0);
    await open(page.container);
    expect(bed.called("models.available").map((call) => call.params)).toEqual([{ cwd: "/work/a" }]);
    expect(trigger(page.container).getAttribute("aria-expanded")).toBe("true");
    expect(options().map((one) => one.dataset.modelRow)).toEqual([
      "claude-sonnet-4",
      "claude-opus-4",
      "gpt-5",
    ]);
    expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("picking a row calls onChange with the model and its summary, then closes", async () => {
    const onChange = vi.fn();
    const page = await mount(
      <ModelPickerField label="Model" value={SONNET} cwd={null} onChange={onChange} />,
    );
    await open(page.container);
    await click(options()[2] as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(
      { provider: "openai", modelId: "gpt-5" },
      { provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: false },
    );
    expect(document.querySelector('[data-slot="popover"]')).toBeNull();
  });

  it("Escape closes it and gives the focus back to the trigger", async () => {
    const page = await mount(
      <ModelPickerField label="Model" value={SONNET} cwd={null} onChange={() => {}} />,
    );
    await open(page.container);
    await press(document.activeElement ?? document.body, { key: "Escape" });
    await vi.waitFor(() => expect(document.querySelector('[data-slot="popover"]')).toBeNull());
    expect(trigger(page.container).getAttribute("aria-expanded")).toBe("false");
  });

  it("defaultLabel adds a first row, and picking it calls onChange(null)", async () => {
    const onChange = vi.fn();
    const page = await mount(
      <ModelPickerField
        label="Model"
        value={SONNET}
        cwd={null}
        defaultLabel="Pi's default"
        onChange={onChange}
      />,
    );
    await open(page.container);
    expect(options()[0]?.textContent).toBe("Pi's default");
    await click(options()[0] as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("a value the list does not offer, of a provider it knows, shows as saved, no longer offered, first and pickable", async () => {
    const onChange = vi.fn();
    const page = await mount(
      <ModelPickerField
        label="Model"
        value={{ provider: "anthropic", modelId: "gone-1" }}
        cwd={null}
        onChange={onChange}
      />,
    );
    await open(page.container);
    expect(options()[0]?.dataset.modelRow).toBe("gone-1");
    expect(options()[0]?.textContent).toContain("Saved model, no longer offered");
    await click(options()[0] as HTMLElement);
    // No summary: the row's synthetic one would claim the model does not reason.
    expect(onChange.mock.calls).toEqual([[{ provider: "anthropic", modelId: "gone-1" }]]);
  });

  it("with a saved-but-unoffered value, picking another row still passes that row's summary", async () => {
    const onChange = vi.fn();
    const page = await mount(
      <ModelPickerField
        label="Model"
        value={{ provider: "old", modelId: "gone-1" }}
        cwd={null}
        onChange={onChange}
      />,
    );
    await open(page.container);
    await click(options().find((one) => one.dataset.modelRow === "gpt-5") as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(
      { provider: "openai", modelId: "gpt-5" },
      { provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: false },
    );
  });

  it("a saved model with the same id under another provider is a different row: its summary is passed", async () => {
    const onChange = vi.fn();
    const page = await mount(
      <ModelPickerField
        label="Model"
        value={{ provider: "old", modelId: "gpt-5" }}
        cwd={null}
        onChange={onChange}
      />,
    );
    await open(page.container);
    const rows = options().filter((one) => one.dataset.modelRow === "gpt-5");
    expect(rows).toHaveLength(2); // the saved one (provider old) and the offered one (openai)
    await click(rows.find((one) => one.getAttribute("aria-selected") !== "true") as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(
      { provider: "openai", modelId: "gpt-5" },
      { provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: false },
    );
  });

  it("carries the two footnotes (extension models, command keys)", async () => {
    const page = await mount(
      <ModelPickerField label="Model" value={SONNET} cwd={null} onChange={() => {}} />,
    );
    await open(page.container);
    const body = text(document.body);
    expect(body).toContain("Models added by an extension are listed only when you ask for them.");
    expect(body).toContain("A key that is a command is offered but may fail when used.");
  });

  it("field.in-dialog: from a dialog the popover is modal and portalled to the body, not into the clipped dialog panel", async () => {
    const page = await mount(
      <div role="dialog" data-testid="host">
        <ModelPickerField label="Model" value={SONNET} cwd={null} onChange={() => {}} />
      </div>,
    );
    await open(page.container);
    const host = page.container.querySelector('[data-testid="host"]') as HTMLElement;
    const popover = document.querySelector('[data-slot="popover"]') as HTMLElement;
    expect(host.contains(popover)).toBe(false);
    expect(popover.parentElement?.closest("[data-radix-popper-content-wrapper]")?.parentElement).toBe(
      document.body,
    );
    expect(page.container.getAttribute("aria-hidden")).toBe("true");
  });

  it("outside a dialog the popover is portalled to the body", async () => {
    const page = await mount(
      <ModelPickerField label="Model" value={SONNET} cwd={null} onChange={() => {}} />,
    );
    await open(page.container);
    expect(page.container.contains(document.querySelector('[data-slot="popover"]'))).toBe(false);
  });
});

describe("ModelPickerField source", () => {
  it("field.lazy: the list chunk is a dynamic import, never a static one, and goes through useRetryableLazy", () => {
    const source = readFileSync(join(import.meta.dirname, "ModelPickerField.tsx"), "utf8");
    expect(source).not.toMatch(/from\s+["']\.\/(ModelList|PickerList)\.tsx["']/);
    expect(source).toMatch(/import\(\s*["']\.\/PickerList\.tsx["']\s*\)/);
    expect(source).toContain("useRetryableLazy");
    expect(source).not.toMatch(/\blazy\(/);
  });
});
