// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, mount } from "../testing/dom.ts";
import { dismissToast, resetToastsForTests, toast, Toaster } from "./Toast.tsx";

const shown = () =>
  [...document.querySelectorAll('[data-slot="toast"]')].map((t) =>
    (t.textContent ?? "").replace("Dismiss", "").trim(),
  );

describe("Toast", () => {
  beforeEach(() => {
    resetToastsForTests();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("shows a message with Undo for 5 s; Undo runs once and closes it", async () => {
    const page = await mount(<Toaster closeLabel="Dismiss" regionLabel="Notifications" />);
    const undo = vi.fn();
    await act(async () => {
      toast({ message: "Appearance reset", action: { label: "Undo", altText: "Undo the reset", run: undo } });
    });
    expect(document.body.textContent).toContain("Appearance reset");
    const undoButton = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Undo",
    ) as HTMLButtonElement;
    await click(undoButton);
    expect(undo).toHaveBeenCalledOnce();
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(document.body.textContent).not.toContain("Appearance reset");
    await page.unmount();
  });

  it("keeps at most three toasts, dropping the oldest", async () => {
    const page = await mount(<Toaster closeLabel="Dismiss" regionLabel="Notifications" />);
    await act(async () => {
      for (const n of [1, 2, 3, 4]) toast({ message: `Toast ${n}` });
    });
    expect(shown()).toEqual(["Toast 2", "Toast 3", "Toast 4"]);
    await act(async () => {
      for (const n of [5, 6, 7, 8, 9]) toast({ message: `Toast ${n}` });
    });
    expect(shown()).toEqual(["Toast 7", "Toast 8", "Toast 9"]);
    await page.unmount();
  });

  it("closes by itself after 5 s", async () => {
    const page = await mount(<Toaster closeLabel="Dismiss" regionLabel="Notifications" />);
    await act(async () => {
      toast({ message: "Saved" });
    });
    await act(async () => {
      vi.advanceTimersByTime(4900);
    });
    expect(document.body.textContent).toContain("Saved");
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(document.body.textContent).not.toContain("Saved");
    await page.unmount();
  });

  it("dismissToast removes a toast by id and ignores an unknown id; reset clears the store", async () => {
    const page = await mount(<Toaster closeLabel="Dismiss" regionLabel="Notifications" />);
    let id = "";
    await act(async () => {
      id = toast({ message: "One" });
      toast({ message: "Two" });
    });
    await act(async () => {
      dismissToast("nope");
      dismissToast(id);
    });
    expect(shown()).toEqual(["Two"]);
    await act(async () => {
      resetToastsForTests();
    });
    expect(shown()).toEqual([]);
    await page.unmount();
  });

  it("names the notifications region with the given text, not Radix's English default (m1)", async () => {
    const page = await mount(<Toaster closeLabel="Fermer" regionLabel="Notifications FR" />);
    const region = document.querySelector('[data-slot="toast-viewport"]')?.closest("[role=region]");
    expect(region?.getAttribute("aria-label")).toBe("Notifications FR");
    await page.unmount();
  });

  it("labels the close button with the given text", async () => {
    const page = await mount(<Toaster closeLabel="Fermer" regionLabel="Notifications" />);
    await act(async () => {
      toast({ message: "Hello" });
    });
    expect(document.querySelector('[data-slot="toast"] button[aria-label="Fermer"]')).not.toBeNull();
    await page.unmount();
  });
});
