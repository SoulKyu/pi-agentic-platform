// @vitest-environment happy-dom
import type { ExtensionProviders as Answer } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../i18n/index.ts";
import { RpcError } from "../../../runtime/index.ts";
import { useShellStore } from "../../../stores/shell-store.ts";
import { alerts, statuses, button, click, hasButton, settle, text } from "../../../testing/dom.ts";
import { forgetExtensions, useExtensionRead } from "../extension-read.ts";
import { availabilityBed, BASE, current, showAvailability } from "./availability-models-bed.tsx";

vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => {
  setLocale("en");
  forgetExtensions();
});

const READ = "Read providers added by extensions";
const AGAIN = "Read again";
const model = (id: string, name = id, offered = true) => ({
  provider: "x",
  id,
  name,
  reasoning: false,
  offered,
  enabled: offered,
});
const answer = (over: Partial<Answer> = {}): Answer => ({
  providers: [{ id: "ext", name: "Ext", models: [model("e1", "Ext one")], modelsTruncated: false }],
  truncated: false,
  failed: false,
  ...over,
});

async function read(reply: () => unknown, world = {}) {
  const { bed } = availabilityBed(world);
  bed.handlers["models.extensions"] = reply;
  const page = await showAvailability();
  await settle();
  const before = bed.called("models.extensions").length;
  await click(button(page.container, READ));
  await settle();
  return { bed, page, before };
}

describe("extension providers", () => {
  it("calls nothing until the button is pressed", async () => {
    const { bed } = availabilityBed();
    bed.handlers["models.extensions"] = () => answer();
    const page = await showAvailability();
    await settle();
    expect(bed.called("models.extensions")).toEqual([]);
    expect(hasButton(page.container, READ)).toBe(true);
  });

  it("shows providers and models with the switches the other providers have, and the pickers' note", async () => {
    const { page, bed } = await read(() => answer());
    expect(bed.called("models.extensions")).toHaveLength(1);
    const box = page.container.querySelector("[data-extensions]") as HTMLElement;
    expect(text(box)).toContain("Ext");
    expect(text(box)).toContain("Ext one");
    expect(text(box)).toContain("the agent and lane pickers offer what your selection offers");
    // The provider's switch and one per model.
    expect(box.querySelectorAll('[role="switch"]')).toHaveLength(2);
  });

  it("ext.shared-read: a second opening shows the answer it read, runs nothing, and Read again runs it again", async () => {
    const first = await read(() => answer());
    expect(first.bed.called("models.extensions")).toHaveLength(1);
    await first.page.unmount();
    const again = await showAvailability();
    await settle();
    expect(first.bed.called("models.extensions")).toHaveLength(1);
    expect(text(again.container.querySelector("[data-extensions]") as HTMLElement)).toContain("Ext one");
    expect(hasButton(again.container, READ)).toBe(false);
    await click(button(again.container, AGAIN));
    await settle();
    expect(first.bed.called("models.extensions")).toHaveLength(2);
  });

  it("ext.joins-run: a second press while a read runs starts no second call", async () => {
    let finish: (value: Answer) => void = () => {};
    const { bed, page } = await read(() => new Promise<Answer>((resolve) => (finish = resolve)));
    expect(useExtensionRead.getState().status).toBe("reading");
    expect(button(page.container, AGAIN).disabled).toBe(true);
    // A picker's click while Settings' read runs joins it too: the store is the one entry.
    const { readExtensions } = await import("../extension-read.ts");
    readExtensions();
    expect(bed.called("models.extensions")).toHaveLength(1);
    finish(answer());
    await settle();
    expect(useExtensionRead.getState().status).toBe("ready");
  });

  it("ext.sign-out: the shell store's reset (sign-out) forgets the answer and drops a read in flight", async () => {
    const { bed, page } = await read(() => answer());
    expect(useExtensionRead.getState().status).toBe("ready");
    useShellStore.getState().reset();
    expect(useExtensionRead.getState().status).toBe("idle");
    await settle();
    // A read still running when the account goes: its answer never lands.
    let finish: (value: Answer) => void = () => {};
    bed.handlers["models.extensions"] = () => new Promise<Answer>((resolve) => (finish = resolve));
    await click(button(page.container, READ));
    expect(useExtensionRead.getState().status).toBe("reading");
    useShellStore.getState().reset();
    finish(answer());
    await settle();
    expect(useExtensionRead.getState().status).toBe("idle");
  });

  it("marks a model the pickers do not offer", async () => {
    const { page } = await read(() =>
      answer({
        providers: [
          {
            id: "ext",
            name: "Ext",
            models: [model("e1", "Ext one"), model("e2", "Ext two", false)],
            modelsTruncated: false,
          },
        ],
      }),
    );
    const rows = [...page.container.querySelectorAll<HTMLElement>("[data-extension-model]")];
    expect(rows.map((row) => [row.dataset.extensionModel, row.dataset.offered])).toEqual([
      ["e1", "true"],
      ["e2", "false"],
    ]);
    expect(text(rows[1] as HTMLElement)).toContain("Not offered to the pickers and agents");
    expect(text(rows[0] as HTMLElement)).not.toContain("Not offered");
  });

  it("never claims the load is offline", async () => {
    const { page } = await read(() => answer());
    const box = text(page.container.querySelector("[data-extensions]") as HTMLElement);
    expect(box).not.toMatch(/offline|without (a )?network|no network/i);
    expect(box).toContain("network");
  });

  it("says an extension did not load when the answer is failed", async () => {
    const { page } = await read(() => answer({ providers: [], failed: true }));
    expect(alerts(page.container).join(" ")).toContain("An extension did not load");
  });

  it("says the list is cut short, per answer and per provider", async () => {
    const { page } = await read(() =>
      answer({
        truncated: true,
        providers: [{ id: "ext", name: "Ext", models: [model("e1")], modelsTruncated: true }],
      }),
    );
    const box = text(page.container.querySelector("[data-extensions]") as HTMLElement);
    expect(box).toContain("Some providers are not shown");
    expect(box).toContain("Some models of this provider are not shown");
  });

  it("marks a provider that re-registers one of models.json as overrides", async () => {
    const { page } = await read(() =>
      answer({
        providers: [
          { id: "mine", name: "Mine", models: [model("e1")], modelsTruncated: false },
          { id: "ext", name: "Ext", models: [model("e2")], modelsTruncated: false },
        ],
      }),
    );
    const rows = [...page.container.querySelectorAll("[data-extension-provider]")];
    expect(rows.map((row) => row.getAttribute("data-overrides"))).toEqual(["true", "false"]);
    expect(text(rows[0] as HTMLElement)).toContain("overrides");
    expect(BASE.find((one) => one.id === "mine")?.origin).toBe("models.json");
  });

  it("cleans ids and names of hidden characters", async () => {
    const { page } = await read(() =>
      answer({
        providers: [
          { id: "e\u202ex", name: "N\u200bm", models: [model("i\u200bd", "Nm")], modelsTruncated: false },
        ],
      }),
    );
    const box = page.container.querySelector("[data-extensions]") as HTMLElement;
    expect(text(box)).not.toMatch(/[\u202e\u200b]/);
    expect(box.querySelector('[data-extension-model="id"]')).not.toBeNull();
  });

  it("says to reload on unknown_method and shows the code's text otherwise", async () => {
    const stale = await read(() => {
      throw new RpcError("unknown_method");
    });
    expect(statuses(stale.page.container).join(" ")).toContain("Reload the page");
    await stale.page.unmount();
    forgetExtensions();
    const slow = await read(() => {
      throw new RpcError("timeout");
    });
    expect(statuses(slow.page.container)).not.toEqual([]);
    expect(statuses(slow.page.container).join(" ")).not.toContain("Reload the page");
  });

  it("is in French with vous", async () => {
    setLocale("fr");
    const { bed } = availabilityBed();
    bed.handlers["models.extensions"] = () => answer();
    const page = await showAvailability();
    await settle();
    await click(button(page.container, "Lire les fournisseurs ajoutés par des extensions"));
    await settle();
    expect(text(page.container)).toContain("les sélecteurs d'agent et de lane proposent");
  });
});
