// @vitest-environment happy-dom
import type { ExtensionProviders } from "@pap/contracts";
import type { ReactNode } from "react";
import type { Runtime } from "../../../runtime/index.ts";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { setLocale, t } from "../../../i18n/index.ts";
import { RpcError } from "../../../runtime/index.ts";
import {
  alerts,
  button,
  click,
  hasButton,
  mount,
  press,
  settle,
  text,
  typeInto,
  useLoadingClock,
  pastLoadingDelay,
} from "../../../testing/dom.ts";
import { forgetExtensions, refreshExtensions } from "../extension-read.ts";
import {
  answer,
  close,
  daemon,
  extensionCalls,
  field,
  groupOf,
  openPicker,
  options,
  row,
  search,
  setUpPickerBed,
  SHOW,
  showExtensions,
} from "./extension-picker-bed.tsx";
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

setUpPickerBed(current);

describe("the picker's extension models", () => {
  it("ext.click-gated: opening the picker runs no extension code; the button has a name and says what it runs", async () => {
    const { page } = await field();
    await openPicker(page);
    await settle();
    expect(extensionCalls()).toBe(0);
    expect(hasButton(document.body, SHOW)).toBe(true);
    expect(text(document.body)).toContain("runs your global extensions");
    expect(text(document.body)).not.toMatch(/offline|without (a )?network|no network/i);
  });

  it("ext.lists: a click reads them, shows the busy state, then a group marked as an extension's", async () => {
    useLoadingClock();
    let finish: (value: ExtensionProviders) => void = () => {};
    daemon().handlers["models.extensions"] = () =>
      new Promise<ExtensionProviders>((resolve) => (finish = resolve));
    const { page } = await field();
    await openPicker(page);
    // A browser click focuses the button, which then leaves the page with the busy state.
    const show = button(document.body, SHOW);
    show.focus();
    await click(show);
    await settle();
    expect(extensionCalls()).toBe(1);
    await pastLoadingDelay();
    expect(text(document.querySelector('[data-slot="loading-line"]') as HTMLElement)).toContain(
      "Reading the extensions",
    );
    expect(hasButton(document.body, SHOW)).toBe(false);
    // The focus went back to the search box, where the arrows reach the rows.
    expect(document.activeElement).toBe(search());
    finish(answer());
    await settle();
    const group = groupOf("claude-bridge") as HTMLElement;
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("aria-label")).toBe("Claude bridge, from an extension");
    expect(text(group)).toContain("from an extension");
    expect(
      [...group.querySelectorAll<HTMLElement>('[role="option"]')].map((one) => one.dataset.modelRow),
    ).toEqual(["claude-opus-4"]);
    const status = text(document.body);
    expect(status).toContain("1 model added by an extension is listed.");
    expect(status).toContain("1 model added by an extension is not offered");
    // ...and where to change that.
    const settings = document.querySelector<HTMLAnchorElement>("[data-extension-settings] a");
    expect(settings?.textContent).toBe("Choose them in Settings › Models › Available models");
    expect(settings?.getAttribute("href")).toBe("/settings/$section");
  });

  it("m8.read-again-elsewhere: while Settings reads them again the picker shows the busy line and no button", async () => {
    useLoadingClock();
    const { page } = await field();
    await openPicker(page);
    await showExtensions();
    let finish: (value: ReturnType<typeof answer>) => void = () => {};
    daemon().handlers["models.extensions"] = () => new Promise((resolve) => (finish = resolve));
    refreshExtensions();
    await settle();
    await pastLoadingDelay();
    expect(text(document.querySelector('[data-slot="loading-line"]') as HTMLElement)).toContain(
      "Reading the extensions",
    );
    expect(hasButton(document.body, "Read again")).toBe(false);
    // The last answer stays listed meanwhile.
    expect(groupOf("claude-bridge")).not.toBeNull();
    finish(answer());
    await settle();
    expect(hasButton(document.body, "Read again")).toBe(true);
  });

  it("ext.no-link: with every model of the extensions offered there is nothing to point to", async () => {
    daemon().handlers["models.extensions"] = () =>
      answer({
        providers: [
          { id: "claude-bridge", name: "Claude bridge", models: [row("a")], modelsTruncated: false },
        ],
      });
    const { page } = await field();
    await openPicker(page);
    await showExtensions();
    expect(document.querySelector("[data-extension-settings]")).toBeNull();
  });

  it("ext.pick: picking an extension model stores provider and model id like any other, with its summary", async () => {
    const { page, onChange } = await field();
    await openPicker(page);
    await showExtensions();
    await click(options().find((one) => one.dataset.modelRow === "claude-opus-4") as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(
      { provider: "claude-bridge", modelId: "claude-opus-4" },
      { provider: "claude-bridge", id: "claude-opus-4", name: "Opus via bridge", reasoning: true },
    );
  });

  it("ext.keyboard: the arrows and Enter reach the extension rows, and the search filters them", async () => {
    const { page, onChange } = await field();
    await openPicker(page);
    await showExtensions();
    await press(search(), { key: "End", ctrlKey: true });
    const active = () => document.getElementById(search().getAttribute("aria-activedescendant") ?? "");
    expect(active()?.dataset.modelRow).toBe("claude-opus-4");
    await typeInto(search(), "opus");
    expect(options().map((one) => one.dataset.modelRow)).toEqual(["claude-opus-4"]);
    await press(search(), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(
      { provider: "claude-bridge", modelId: "claude-opus-4" },
      expect.objectContaining({ id: "claude-opus-4" }),
    );
  });

  it("ext.remembered: a second opening shows them with no new read; Read again reads again", async () => {
    const { page } = await field();
    await openPicker(page);
    await showExtensions();
    await close();
    await openPicker(page);
    await settle();
    expect(extensionCalls()).toBe(1);
    expect(groupOf("claude-bridge")).not.toBeNull();
    await click(button(document.body, "Read again"));
    await settle();
    expect(extensionCalls()).toBe(2);
  });

  it("ext.forbidden: without the Pi administration permission the button goes, the reason shows, the rest works", async () => {
    daemon().handlers["models.extensions"] = () => {
      throw new RpcError("forbidden");
    };
    const { page, onChange } = await field();
    await openPicker(page);
    await showExtensions();
    expect(hasButton(document.body, SHOW)).toBe(false);
    expect(hasButton(document.body, "Try again")).toBe(false);
    // Announced: the reason replaces the button the owner just pressed (review M9).
    const reason = document.querySelector<HTMLElement>("[data-extension-controls]");
    expect(reason?.getAttribute("role")).toBe("status");
    expect(text(reason as HTMLElement)).toContain("need the Pi administration permission");
    await click(options().find((one) => one.dataset.modelRow === "claude-sonnet-4") as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(
      { provider: "anthropic", modelId: "claude-sonnet-4" },
      expect.objectContaining({ id: "claude-sonnet-4" }),
    );
  });

  it("ext.errors: a failure in catalog words with a retry, a reload when stale, an extension that did not load", async () => {
    daemon().handlers["models.extensions"] = () => {
      throw new RpcError("timeout");
    };
    const { page } = await field();
    await openPicker(page);
    await showExtensions();
    // The timeout's own catalog sentence, not just any alert.
    expect(alerts(document.body)).toEqual([t("error.timeout")]);
    daemon().handlers["models.extensions"] = () => {
      throw new RpcError("unknown_method");
    };
    await click(button(document.body, "Try again"));
    await settle();
    expect(alerts(document.body).join(" ")).toContain("Reload the page");
    forgetExtensions();
    daemon().handlers["models.extensions"] = () => answer({ providers: [], failed: true });
    await settle();
    await showExtensions();
    expect(alerts(document.body).join(" ")).toContain("An extension did not load");
  });

  it("ext.empty-and-cut: no model, then the flags the Settings view shows", async () => {
    daemon().handlers["models.extensions"] = () => answer({ providers: [] });
    const { page } = await field();
    await openPicker(page);
    await showExtensions();
    expect(text(document.body)).toContain("No extension adds a model.");
    daemon().handlers["models.extensions"] = () =>
      answer({
        truncated: true,
        providers: [
          { id: "claude-bridge", name: "Claude bridge", models: [row("a")], modelsTruncated: true },
        ],
      });
    await click(button(document.body, "Read again"));
    await settle();
    expect(text(document.body)).toContain("Some providers added by extensions are not shown");
    expect(text(groupOf("claude-bridge") as HTMLElement)).toContain(
      "Some models of this provider are not shown.",
    );
  });

  it("ext.untrusted-text: ids and names are cleaned of hidden characters and shown as text", async () => {
    daemon().handlers["models.extensions"] = () =>
      answer({
        providers: [
          {
            id: "ev\u202eil",
            name: "<b>N\u200bm</b>",
            models: [
              {
                provider: "ev\u202eil",
                id: "i\u200bd",
                name: "Na\u200bme",
                reasoning: false,
                offered: true,
                enabled: true,
              },
            ],
            modelsTruncated: false,
          },
        ],
      });
    const { page } = await field();
    await openPicker(page);
    await showExtensions();
    const group = groupOf("ev\u202eil") as HTMLElement;
    expect(text(group)).not.toMatch(/[\u202e\u200b]/);
    expect(text(group)).toContain("<b>Nm</b>");
    expect(group.querySelector("b")).toBeNull();
    expect(text(group)).toContain("Name");
  });

  it("ext.dedupe: a model the list already offers is not listed twice", async () => {
    daemon().handlers["models.extensions"] = () =>
      answer({
        providers: [
          {
            id: "anthropic-x",
            name: "X",
            models: [
              { ...row("claude-sonnet-4"), provider: "anthropic" },
              { ...row("z"), provider: "anthropic-x" },
            ],
            modelsTruncated: false,
          },
        ],
      });
    const { page } = await field();
    await openPicker(page);
    await showExtensions();
    expect(options().filter((one) => one.dataset.modelRow === "claude-sonnet-4")).toHaveLength(1);
  });

  it("ext.fixed-list: the gallery's fixed list reads no extension and shows no button", async () => {
    const page = await mount(
      <ModelPickerField
        label="Model"
        value={null}
        cwd={null}
        available={{ status: "ready", models: [], labels: new Map(), origin: "signed-in", truncated: false }}
        onChange={() => {}}
      />,
    );
    await click(page.container.querySelector("button") as HTMLButtonElement);
    await act(async () => {
      await vi.waitFor(() => expect(document.querySelector('[role="combobox"]')).not.toBeNull(), {
        timeout: 10_000,
      });
    });
    expect(hasButton(document.body, SHOW)).toBe(false);
  });

  it("is in French with vous", async () => {
    setLocale("fr");
    const { page } = await field();
    await openPicker(page);
    await click(button(document.body, "Afficher les modèles ajoutés par des extensions"));
    await settle();
    expect(text(document.body)).toContain("d'une extension");
    expect(text(document.body)).toContain("Leur lecture exécute vos extensions globales");
  });
});
