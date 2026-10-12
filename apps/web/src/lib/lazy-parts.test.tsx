// @vitest-environment happy-dom
import { act, useState, type ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { button, click, mount } from "../testing/dom.ts";
import { LazyMenu } from "./LazyMenu.tsx";
import { LazyPanel } from "./LazyPanel.tsx";
import { notifyLazyFailure } from "./lazy.tsx";

const toasts = vi.hoisted(() => [] as Array<{ message: string }>);
vi.mock("@pap/ui", async (original) => ({
  ...(await original<typeof import("@pap/ui")>()),
  toast: (input: { message: string }) => toasts.push(input),
}));
const issues = vi.hoisted(() => [] as string[]);
vi.mock("./report.ts", () => ({ reportClientIssue: (code: string) => issues.push(code) }));

const text = { stale: "stale copy", broken: "broken copy", reload: "Reload" };
afterEach(() => {
  toasts.length = 0;
  issues.length = 0;
  vi.restoreAllMocks();
});

describe("notifyLazyFailure", () => {
  it("calls a gone chunk stale and anything else a broken screen (m7)", () => {
    notifyLazyFailure(new TypeError("Failed to fetch dynamically imported module: x.js"), text);
    notifyLazyFailure(new Error("boom"), text);
    expect(issues).toEqual(["lazy_chunk_failed", "render_failed"]);
    expect(toasts.map((one) => one.message)).toEqual(["stale copy", "broken copy"]);
  });
});

describe("LazyPanel", () => {
  it("a panel that throws a render bug is closed and reported as broken, not stale", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Broken = () => {
      throw new Error("render bug");
    };
    const onFailed = vi.fn();
    const load = () => Promise.resolve({ default: Broken as ComponentType });
    function Owner() {
      const [open, setOpen] = useState(true);
      return (
        <LazyPanel
          load={load}
          open={open}
          props={{}}
          text={text}
          onFailed={() => {
            onFailed();
            setOpen(false); // as every owner does
          }}
        />
      );
    }
    const page = await mount(<Owner />);
    await act(async () => {
      await vi.waitFor(() => expect(onFailed).toHaveBeenCalledOnce(), { timeout: 2_000 });
    });
    expect(toasts.map((one) => one.message)).toEqual(["broken copy"]);
    expect(issues).toEqual(["render_failed"]);
    await page.unmount();
  });
});

describe("LazyMenu", () => {
  it("shows only the trigger until it is pressed, then loads the menu open", async () => {
    const page = await mount(
      <LazyMenu
        label="Account"
        closeLabel="Close"
        text={text}
        items={[{ id: "a", label: "Item", onSelect: () => {} }]}
        trigger={(ask) => (
          <button type="button" onClick={ask}>
            open menu
          </button>
        )}
      />,
    );
    expect(page.container.textContent).toBe("open menu");
    await click(button(page.container, "open menu"));
    await vi.waitFor(() => expect(document.querySelector('[role="menu"], [role="dialog"]')).not.toBeNull(), {
      timeout: 2_000,
    });
    await page.unmount();
  });
});
