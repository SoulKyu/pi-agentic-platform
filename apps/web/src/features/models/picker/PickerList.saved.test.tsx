// @vitest-environment happy-dom
import type { ReactNode } from "react";
import type { Runtime } from "../../../runtime/index.ts";
import { describe, expect, it, vi } from "vitest";
import { click, hasButton, settle, text } from "../../../testing/dom.ts";
import { readExtensions } from "../extension-read.ts";
import {
  extensionCalls,
  field,
  groupOf,
  openPicker,
  options,
  setUpPickerBed,
  SHOW,
  showExtensions,
} from "./extension-picker-bed.tsx";

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

setUpPickerBed(current);

describe("a saved model an extension may add", () => {
  const BRIDGE = { provider: "claude-bridge", modelId: "claude-opus-4" };

  it("saved.ext-note: before a read it shows as the current value, provider and model, checked when it runs", async () => {
    const { page } = await field(BRIDGE);
    expect(page.container.querySelector("button")?.textContent).toContain("claude-opus-4");
    expect(page.container.querySelector("button")?.textContent).toContain("claude-bridge");
    await openPicker(page);
    const saved = options()[0] as HTMLElement;
    expect(saved.dataset.modelRow).toBe("claude-opus-4");
    expect(saved.getAttribute("aria-selected")).toBe("true");
    expect(text(saved)).toContain("claude-bridge");
    expect(text(saved)).toContain("May come from an extension, checked when it runs");
    expect(text(saved)).not.toContain("no longer offered");
    expect(extensionCalls()).toBe(0);
  });

  it("saved.ext-found: once read and offered, it is the selected row of the extension's group", async () => {
    const { page } = await field(BRIDGE);
    await openPicker(page);
    await showExtensions();
    const rows = options().filter((one) => one.dataset.modelRow === "claude-opus-4");
    expect(rows).toHaveLength(1);
    expect(groupOf("claude-bridge")?.contains(rows[0] as HTMLElement)).toBe(true);
    expect(rows[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("saved.ext-unoffered: once read and not offered, it is saved, no longer offered", async () => {
    const { page, onChange } = await field({ provider: "claude-bridge", modelId: "claude-haiku-4" });
    await openPicker(page);
    await showExtensions();
    const saved = options().find((one) => one.dataset.modelRow === "claude-haiku-4") as HTMLElement;
    expect(text(saved)).toContain("Saved model, no longer offered");
    await click(saved);
    // No summary: re-picking the saved row keeps the thinking level.
    expect(onChange.mock.calls).toEqual([[{ provider: "claude-bridge", modelId: "claude-haiku-4" }]]);
  });

  it("saved.known-provider: a provider the list knows says no longer offered, extensions unread", async () => {
    const { page } = await field({ provider: "anthropic", modelId: "gone-1" });
    await openPicker(page);
    expect(text(options()[0] as HTMLElement)).toContain("Saved model, no longer offered");
  });

  it("m4.pi-provider-not-listed: a provider Pi has, signed out or switched off, says no longer offered, not an extension's", async () => {
    const { page } = await field({ provider: "openai", modelId: "gpt-x" });
    await openPicker(page);
    const saved = options()[0] as HTMLElement;
    expect(text(saved)).toContain("Saved model, no longer offered");
    expect(text(saved)).not.toContain("extension");
  });
});

describe("an agent in Chat only (review I2)", () => {
  const BRIDGE = { provider: "claude-bridge", modelId: "claude-opus-4" };

  it("i2.chat-only: no extension is read nor listed, the picker says why, and a saved one is not offered", async () => {
    // Read elsewhere in the tab (Settings): Chat only still lists none of them.
    readExtensions();
    await settle();
    const before = extensionCalls();
    const { page } = await field(BRIDGE, vi.fn(), { extensionsLoaded: false });
    await openPicker(page);
    expect(hasButton(document.body, SHOW)).toBe(false);
    expect(groupOf("claude-bridge")).toBeNull();
    expect(text(document.body)).toContain("Chat only loads no extension");
    const saved = options()[0] as HTMLElement;
    expect(saved.dataset.modelRow).toBe("claude-opus-4");
    expect(text(saved)).toContain("Saved model, no longer offered");
    expect(extensionCalls()).toBe(before);
  });
});
