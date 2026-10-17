// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { button, click, field, mount, press, text, typeInto } from "../../../testing/dom.ts";
import ModelList, { type ModelListProps } from "./ModelList.tsx";
import { modelKey, toPickerModel, type PickerModel } from "./model-picker.vm.ts";
import type { AvailableState } from "./use-available-models.ts";

vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { to: string; params?: { section: string }; children: ReactNode }) =>
      createElement("a", { href: props.to.replace("$section", props.params?.section ?? "") }, props.children),
  };
});

const model = (provider: string, id: string, name = id): PickerModel => ({
  provider,
  id,
  name,
  reasoning: false,
});
const SONNET = model("anthropic", "claude-sonnet-4", "Claude Sonnet 4");
const OPUS = model("anthropic", "claude-opus-4", "Claude Opus 4");
const GPT = model("openai", "gpt-5", "GPT-5");
const ready = (
  models: readonly PickerModel[],
  extra: Partial<Extract<AvailableState, { status: "ready" }>> = {},
) =>
  ({
    status: "ready",
    models,
    labels: new Map([
      ["anthropic", "Anthropic"],
      ["openai", "OpenAI"],
    ]),
    origin: "signed-in",
    truncated: false,
    ...extra,
  }) satisfies AvailableState;

async function show(props: Partial<ModelListProps> & { state: AvailableState }) {
  const picked: PickerModel[] = [];
  const page = await mount(
    <ModelList
      value={null}
      onPick={(one) => {
        picked.push(one);
      }}
      {...props}
    />,
  );
  return { ...page, picked };
}

const search = () => field(document.body, "Search models") as HTMLInputElement;
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const listbox = () => document.querySelector<HTMLElement>('[role="listbox"]') as HTMLElement;
const activeRow = () => {
  const id = search().getAttribute("aria-activedescendant");
  return id === null ? null : (document.getElementById(id)?.dataset.modelRow ?? null);
};
const many = (count: number, provider = "big") =>
  Array.from({ length: count }, (_, i) => model(provider, `m-${String(i).padStart(4, "0")}`));

describe("ModelList combobox", () => {
  it("the search input is a combobox that controls the listbox and follows the active row", async () => {
    await show({ state: ready([SONNET, OPUS, GPT]) });
    const input = search();
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-controls")).toBe(listbox().id);
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    expect(activeRow()).toBe("claude-sonnet-4");
    await press(input, { key: "ArrowDown" });
    expect(activeRow()).toBe("claude-opus-4");
    expect(input.getAttribute("aria-activedescendant")).toBe(options()[1]?.id);
  });

  it("the list is a listbox of options; aria-selected marks the current model and aria-current is never used", async () => {
    await show({ state: ready([SONNET, OPUS, GPT]), value: { provider: "openai", modelId: "gpt-5" } });
    expect(options().map((one) => one.dataset.modelRow)).toEqual([
      "claude-sonnet-4",
      "claude-opus-4",
      "gpt-5",
    ]);
    expect(options().map((one) => one.getAttribute("aria-selected"))).toEqual(["false", "false", "true"]);
    expect(document.querySelectorAll("[aria-current]")).toHaveLength(0);
    expect(listbox().getAttribute("aria-label")).toBe("Models");
  });

  it("starts on the current model so Enter keeps it", async () => {
    await show({ state: ready([SONNET, OPUS, GPT]), value: { provider: "openai", modelId: "gpt-5" } });
    expect(activeRow()).toBe("gpt-5");
  });

  it("groups by provider in the source's order, with the provider's display name", async () => {
    await show({ state: ready([GPT, SONNET, OPUS]) });
    const groups = [...document.querySelectorAll<HTMLElement>('[role="group"]')];
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(["OpenAI", "Anthropic"]);
    expect(text(groups[1] as HTMLElement)).toContain("Claude Opus 4");
  });

  it("focuses the search on open, and typing filters", async () => {
    await show({ state: ready([SONNET, OPUS, GPT]) });
    expect(document.activeElement).toBe(search());
    await typeInto(search(), "opus");
    expect(options().map((one) => one.dataset.modelRow)).toEqual(["claude-opus-4"]);
    await typeInto(search(), "zzz");
    expect(options()).toHaveLength(0);
    expect(text(document.body)).toContain("No model matches");
  });
});

describe("ModelList keyboard", () => {
  it("ArrowDown and ArrowUp move the active row and stop at the ends", async () => {
    await show({ state: ready([SONNET, OPUS, GPT]) });
    const down = await press(search(), { key: "ArrowDown" });
    expect(down.defaultPrevented).toBe(true);
    await press(search(), { key: "ArrowDown" });
    await press(search(), { key: "ArrowDown" });
    expect(activeRow()).toBe("gpt-5");
    await press(search(), { key: "ArrowUp" });
    expect(activeRow()).toBe("claude-opus-4");
    await press(search(), { key: "ArrowUp" });
    await press(search(), { key: "ArrowUp" });
    expect(activeRow()).toBe("claude-sonnet-4");
  });

  it("Enter picks the active row", async () => {
    const page = await show({ state: ready([SONNET, OPUS, GPT]) });
    await press(search(), { key: "ArrowDown" });
    await press(search(), { key: "Enter" });
    expect(page.picked.map((one) => one.id)).toEqual(["claude-opus-4"]);
  });

  it("Enter while an input method is composing picks nothing", async () => {
    const page = await show({ state: ready([SONNET]) });
    await press(search(), { key: "Enter", isComposing: true });
    expect(page.picked).toEqual([]);
  });

  it("PageDown and PageUp jump a page; Ctrl+End and Ctrl+Home go to the ends", async () => {
    await show({ state: ready(many(60)) });
    await press(search(), { key: "PageDown" });
    expect(activeRow()).toBe("m-0010");
    await press(search(), { key: "PageDown" });
    expect(activeRow()).toBe("m-0020");
    await press(search(), { key: "PageUp" });
    expect(activeRow()).toBe("m-0010");
    await press(search(), { key: "End", ctrlKey: true });
    expect(activeRow()).toBe("m-0059");
    await press(search(), { key: "Home", ctrlKey: true });
    expect(activeRow()).toBe("m-0000");
  });

  it("plain Home and End are left to the caret of the search input", async () => {
    await show({ state: ready(many(5)) });
    for (const key of ["Home", "End"]) {
      const event = await press(search(), { key });
      expect(event.defaultPrevented, key).toBe(false);
    }
    expect(activeRow()).toBe("m-0000");
  });

  it("Escape is not swallowed, so the popover or dialog around it closes", async () => {
    await show({ state: ready([SONNET]) });
    const event = await press(search(), { key: "Escape" });
    expect(event.defaultPrevented).toBe(false);
  });

  it("a click on a row picks it, and a disabled list picks nothing", async () => {
    const page = await show({ state: ready([SONNET, GPT]) });
    await click(options()[1] as HTMLElement);
    expect(page.picked.map((one) => one.id)).toEqual(["gpt-5"]);
    await page.unmount();
    const locked = await show({ state: ready([SONNET, GPT]), disabled: true });
    await click(options()[1] as HTMLElement);
    await press(search(), { key: "Enter" });
    expect(locked.picked).toEqual([]);
    expect(options().every((one) => one.getAttribute("aria-disabled") === "true")).toBe(true);
  });
});

describe("ModelList touch and scroll", () => {
  it("rows are 44 px tall on a coarse pointer and the search input does not zoom iOS", async () => {
    await show({ state: ready([SONNET]) });
    expect(options()[0]?.className).toContain("pointer-coarse:min-h-11");
    expect(search().className).toContain("pointer-coarse:text-base");
    expect(search().className).toContain("pointer-coarse:min-h-11");
  });

  it("the list element is the one that scrolls, bounded by the popover's room", async () => {
    await show({ state: ready(many(2000)) });
    expect(listbox().classList.contains("overflow-y-auto")).toBe(true);
    expect(listbox().classList.contains("max-h-popover")).toBe(true);
  });

  it("shows 200 rows of a group and the rest on demand", async () => {
    await show({ state: ready(many(450)) });
    expect(options()).toHaveLength(200);
    await click(button(document.body, "Show 250 more"));
    expect(options()).toHaveLength(450);
  });

  it("keeps the keyboard on the visible rows only", async () => {
    await show({ state: ready(many(450)) });
    await press(search(), { key: "End", ctrlKey: true });
    expect(activeRow()).toBe("m-0199");
  });
});

describe("ModelList states", () => {
  it("loading is announced", async () => {
    await show({ state: { status: "loading" } });
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Loading models");
    expect(options()).toHaveLength(0);
  });

  it("failed shows the message and a retry that calls reload", async () => {
    const reload = vi.fn();
    await show({ state: { status: "failed", stale: false, reload } });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("The models could not be loaded.");
    await click(button(document.body, "Try again"));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("a stale page asks for a reload instead of a raw error", async () => {
    await show({ state: { status: "failed", stale: true, reload: () => {} } });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Reload the page: pap was updated.");
  });

  it("empty shows the link to Settings > Models", async () => {
    await show({ state: ready([]) });
    const link = [...document.querySelectorAll("a")].find(
      (one) => one.getAttribute("href") === "/settings/models",
    );
    expect(link?.textContent).toBe("Open settings");
    expect(text(document.body)).toContain("No model available. Connect a provider in settings.");
  });

  it("truncated says so", async () => {
    await show({ state: ready([SONNET], { truncated: true }) });
    expect(text(document.body)).toContain("The list is cut short: narrow your search.");
  });

  it("list.footnote shows the footnote it is given", async () => {
    await show({ state: ready([SONNET]), footnote: "Extension models appear in a session." });
    expect(text(document.body)).toContain("Extension models appear in a session.");
  });

  it("list.hostile-name renders a name without its bidi override", async () => {
    const name = `Safe${String.fromCodePoint(0x202e)}Name`;
    await show({
      state: ready([toPickerModel({ provider: "anthropic", id: "x", name, reasoning: false })]),
    });
    expect(options()[0]?.textContent).toContain("SafeName");
    expect(document.body.textContent).not.toContain(String.fromCodePoint(0x202e));
  });
});

describe("ModelList extra rows", () => {
  it("savedUnavailable is the first row, says it is no longer offered, and can still be picked", async () => {
    const page = await show({
      state: ready([SONNET, GPT]),
      value: { provider: "old", modelId: "gone-1" },
      savedUnavailable: { provider: "old", modelId: "gone-1" },
    });
    const first = options()[0] as HTMLElement;
    expect(first.dataset.modelRow).toBe("gone-1");
    expect(first.textContent).toContain("Saved model, no longer offered");
    expect(first.getAttribute("aria-selected")).toBe("true");
    await click(first);
    expect(page.picked).toEqual([{ provider: "old", id: "gone-1", name: "gone-1", reasoning: false }]);
  });

  it("a default row comes first and picking it calls onPickDefault", async () => {
    const onPickDefault = vi.fn();
    const page = await show({
      state: ready([SONNET]),
      defaultLabel: "Pi's default",
      onPickDefault,
    });
    expect(options()[0]?.textContent).toContain("Pi's default");
    expect(options()[0]?.hasAttribute("data-model-row")).toBe(false);
    await press(search(), { key: "Enter" });
    expect(onPickDefault).toHaveBeenCalledOnce();
    expect(page.picked).toEqual([]);
  });

  it("renderRowEnd puts its content beside the row, not inside the option", async () => {
    await show({
      state: ready([SONNET]),
      renderRowEnd: (one) => <button type="button">{`star ${one.id}`}</button>,
    });
    expect(button(document.body, "star claude-sonnet-4")).toBeTruthy();
    expect(options()[0]?.querySelector("button")).toBeNull();
  });

  it("list.keys: a/b + c and a + b/c are two rows with two keys", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await show({ state: ready([model("a/b", "c"), model("a", "b/c")]) });
    expect(options()).toHaveLength(2);
    expect(new Set(options().map((one) => one.id)).size).toBe(2);
    expect(modelKey(model("a/b", "c"))).not.toBe(modelKey(model("a", "b/c")));
    expect(error.mock.calls.flat().join(" ")).not.toContain("same key");
    error.mockRestore();
  });

  it("list.hostile-id: an id with a bidi override shows without it", async () => {
    const hostile = `x${String.fromCodePoint(0x202e)}y`;
    await show({ state: ready([model("p", hostile, "Named")]) });
    expect(options()[0]?.textContent).toContain("xy");
    expect(document.body.textContent).not.toContain(String.fromCodePoint(0x202e));
  });
});
