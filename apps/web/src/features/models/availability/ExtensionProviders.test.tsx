// @vitest-environment happy-dom
import type { ExtensionProviders as Answer } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../i18n/index.ts";
import { RpcError } from "../../../runtime/index.ts";
import { alerts, button, click, hasButton, settle, text } from "../../../testing/dom.ts";
import { availabilityBed, BASE, current, showAvailability } from "./availability-models-bed.tsx";

vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => setLocale("en"));

const READ = "Read providers added by extensions";
const model = (id: string, name = id) => ({ provider: "x", id, name, reasoning: false });
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

  it("shows providers and models read-only with the session-menu note and no switch", async () => {
    const { page, bed } = await read(() => answer());
    expect(bed.called("models.extensions")).toHaveLength(1);
    const box = page.container.querySelector("[data-extensions]") as HTMLElement;
    expect(text(box)).toContain("Ext");
    expect(text(box)).toContain("Ext one");
    expect(text(box)).toContain("session's model menu only");
    expect(box.querySelectorAll('[role="switch"]')).toHaveLength(0);
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
    expect(alerts(stale.page.container).join(" ")).toContain("Reload the page");
    await stale.page.unmount();
    const slow = await read(() => {
      throw new RpcError("timeout");
    });
    expect(alerts(slow.page.container)).not.toEqual([]);
    expect(alerts(slow.page.container).join(" ")).not.toContain("Reload the page");
  });

  it("is in French with vous", async () => {
    setLocale("fr");
    const { bed } = availabilityBed();
    bed.handlers["models.extensions"] = () => answer();
    const page = await showAvailability();
    await settle();
    await click(button(page.container, "Lire les fournisseurs ajoutés par des extensions"));
    await settle();
    expect(text(page.container)).toContain("menu des modèles d'une session");
  });
});
