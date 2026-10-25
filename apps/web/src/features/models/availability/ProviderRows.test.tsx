// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import "../../../i18n/register-settings-availability.ts";
import { setLocale } from "../../../i18n/index.ts";
import { button, click, mount } from "../../../testing/dom.ts";
import { segmentedGroup } from "../../../testing/names.ts";
import type { ProviderRow } from "./availability.vm.ts";
import { ProviderRows } from "./ProviderRows.tsx";

const row = (id: string, connected: boolean): ProviderRow => ({
  id,
  name: id.toUpperCase(),
  connected,
  total: 3,
  enabled: 3,
  offered: connected ? 3 : 0,
  models: [],
  modelsTruncated: false,
});
const handlers = { onProvider: () => {}, onModel: () => {} };
const show = () =>
  mount(
    <ProviderRows
      rows={[row("a", true), row("b", false), row("c", true)]}
      disabled={false}
      pending={new Set()}
      stack={false}
      handlers={handlers}
    />,
  );
const shown = (root: ParentNode) =>
  [...root.querySelectorAll("[data-provider-row]")].map((one) => one.getAttribute("data-provider-row"));

describe("ProviderRows", () => {
  it("connected providers show by default and every provider after All", async () => {
    setLocale("en");
    const page = await show();
    expect(segmentedGroup(page.container, "Providers shown")).not.toBeNull();
    expect(shown(page.container)).toEqual(["a", "c"]);
    await click(button(page.container, "All"));
    expect(shown(page.container)).toEqual(["a", "b", "c"]);
    await click(button(page.container, "Connected"));
    expect(shown(page.container)).toEqual(["a", "c"]);
  });

  it("starts on All when no provider is connected, so the list is never empty", async () => {
    const page = await mount(
      <ProviderRows
        rows={[row("b", false)]}
        disabled={false}
        pending={new Set()}
        stack={false}
        handlers={handlers}
      />,
    );
    expect(shown(page.container)).toEqual(["b"]);
  });

  it("chip and count sit in fixed-width cells so the switches line up", async () => {
    const page = await show();
    const meta = page.container.querySelector('[data-slot="switch"] > .ml-auto') as HTMLElement;
    const chip = meta.querySelector(".w-24");
    const count = meta.querySelector(".w-28");
    expect(chip?.querySelector('[data-slot="chip"]')).not.toBeNull();
    expect(count?.className).toContain("text-right");
    expect(count?.className).toContain("tabular-nums");
  });
});
