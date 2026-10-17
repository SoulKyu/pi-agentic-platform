// @vitest-environment happy-dom
import { act, useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { click, mount } from "../testing/dom.ts";
import { LazyPopover } from "./LazyPopover.tsx";

// The overlays chunk is gone (a tab open across a pap update) until `chunk.gone` is switched off.
const chunk = vi.hoisted(() => ({ gone: true, loads: 0 }));
vi.mock("@pap/ui/overlays", async (importOriginal) => {
  chunk.loads += 1;
  if (chunk.gone) throw new TypeError("Failed to fetch dynamically imported module: /assets/overlays-old.js");
  return importOriginal();
});
const toasts = vi.hoisted(() => [] as Array<{ message: string }>);
vi.mock("@pap/ui", async (original) => ({
  ...(await original<typeof import("@pap/ui")>()),
  toast: (input: { message: string }) => toasts.push(input),
}));
const issues = vi.hoisted(() => [] as string[]);
vi.mock("./report.ts", () => ({ reportClientIssue: (code: string) => issues.push(code) }));

const text = { stale: "stale copy", broken: "broken copy", reload: "Reload" };

function Owner() {
  const [open, setOpen] = useState(false);
  return (
    <LazyPopover
      open={open}
      onOpenChange={setOpen}
      label="Pick"
      closeLabel="Close"
      text={text}
      trigger={(ask) => (
        <button type="button" aria-expanded={open} onClick={ask}>
          trigger
        </button>
      )}
    >
      <p>inside</p>
    </LazyPopover>
  );
}

afterEach(() => {
  toasts.length = 0;
  issues.length = 0;
  chunk.gone = true;
});
beforeAll(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("LazyPopover", () => {
  it("a gone overlays chunk closes it, says to reload, and the next press imports again", async () => {
    const page = await mount(<Owner />);
    const trigger = () => page.container.querySelector("button") as HTMLButtonElement;
    expect(chunk.loads).toBe(0);
    await click(trigger());
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(toasts).toEqual([{ message: "stale copy", tone: "error", action: expect.anything() }]);
    });
    expect(issues).toEqual(["lazy_chunk_failed"]);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[data-slot="popover"]')).toBeNull();

    chunk.gone = false;
    await click(trigger());
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(document.querySelector('[data-slot="popover"]')?.textContent).toBe("inside");
    });
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });
});
