// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../../runtime/index.ts";
import { button, click, hasButton, settle, text } from "../../../testing/dom.ts";
import { current, newBed, show } from "../models-bed.tsx";
import { editableMine, NEXT_REVISION } from "./provider-models-bed.tsx";

vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const KEY_BUTTON = "Remove the stored key";
const keyBox = (container: ParentNode) =>
  [...container.querySelectorAll('[data-slot="checkbox"]')]
    .find((one) => one.textContent?.includes("Also remove the stored key"))
    ?.querySelector('[role="checkbox"]') as HTMLButtonElement;

/** The remove fails after the entry left the file when `gone`; `fail` is what the daemon throws. */
async function removeFailing(options: { gone: boolean; tick: boolean; fail?: "conflict" | "helper_failed" }) {
  const bed = newBed();
  let reads = 0;
  bed.handlers["models.provider.get"] = () => {
    reads += 1;
    return reads === 1 || !options.gone
      ? editableMine()
      : { editable: false, reason: "not_in_file", revision: NEXT_REVISION };
  };
  bed.handlers["models.provider.remove"] = () => {
    throw new RpcError(options.fail ?? "helper_failed");
  };
  const page = await show();
  await settle();
  await click(page.container.querySelector('[data-edit-provider="mine"]') as HTMLElement);
  await vi.waitFor(() => expect(hasButton(page.container, "Remove this provider")).toBe(true), {
    timeout: 2_000,
  });
  await click(button(page.container, "Remove this provider"));
  if (options.tick) await click(keyBox(page.container));
  await click(button(page.container, "Yes, remove it"));
  await settle();
  return { bed, page };
}

describe("an orphaned key after a remove that half worked (MPR-C5)", () => {
  it("offers to remove the stored key when the entry is gone and the key was asked for", async () => {
    const { bed, page } = await removeFailing({ gone: true, tick: true });
    expect(bed.called("models.provider.get").length).toBeGreaterThanOrEqual(2);
    expect(hasButton(page.container, KEY_BUTTON)).toBe(true);
    await click(button(page.container, KEY_BUTTON));
    await settle();
    expect(bed.called("models.logout")[0]?.params).toEqual({ provider: "mine" });
    expect(hasButton(page.container, KEY_BUTTON)).toBe(false);
  });

  it("survives the host closing the form", async () => {
    const { page } = await removeFailing({ gone: true, tick: true });
    await click(button(page.container, "Close"));
    expect(page.container.querySelector("[data-provider-form]")).toBeNull();
    expect(hasButton(page.container, KEY_BUTTON)).toBe(true);
    await click(button(page.container, "Dismiss"));
    expect(hasButton(page.container, KEY_BUTTON)).toBe(false);
  });

  it("is not offered when the key was not asked for, or the entry is still in the file", async () => {
    const first = await removeFailing({ gone: true, tick: false });
    expect(hasButton(first.page.container, KEY_BUTTON)).toBe(false);
    await first.page.unmount();
    const second = await removeFailing({ gone: false, tick: true });
    expect(hasButton(second.page.container, KEY_BUTTON)).toBe(false);
  });

  it("also after a conflict whose reload finds the entry gone", async () => {
    const { bed, page } = await removeFailing({ gone: true, tick: true, fail: "conflict" });
    expect(text(page.container)).toContain(KEY_BUTTON);
    await click(button(page.container, KEY_BUTTON));
    await settle();
    expect(bed.called("models.logout").map((call) => call.params)).toEqual([{ provider: "mine" }]);
    expect(hasButton(page.container, KEY_BUTTON)).toBe(false);
  });
});
