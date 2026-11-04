// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { alerts, button, click, mount, press, settle, text } from "../../testing/dom.ts";
import { StopBoxDialog } from "./StopBoxDialog.tsx";

const ACTIVITIES = [
  { kind: "task", id: "t1", title: "Tidy", since: 1, stoppable: true },
  { kind: "thread", id: "s1", title: "", since: null, stoppable: false },
] as const;

const open = (onConfirm: () => Promise<void>, onClose = vi.fn(), alwaysOn = false) =>
  mount(
    <StopBoxDialog
      name="Atlas"
      activities={ACTIVITIES}
      alwaysOn={alwaysOn}
      onConfirm={onConfirm}
      onClose={onClose}
    />,
  );

describe("StopBoxDialog", () => {
  it("says what is interrupted and what stays, with Cancel secondary and the confirm primary", async () => {
    await open(async () => {});
    const dialog = document.body;
    expect(text(dialog)).toContain("Stop Atlas's box?");
    expect(text(dialog)).toContain(
      "What runs in it will be interrupted: Task · Tidy, Thread. Transcripts and the box's files are intact; tasks can be retried.",
    );
    expect(button(dialog, "Cancel").getAttribute("data-variant")).toBe("secondary");
    expect(button(dialog, "Stop the box").getAttribute("data-variant")).toBe("primary");
  });

  it("says an always-on box comes back at the next pap start, and says nothing otherwise", async () => {
    await open(async () => {}, vi.fn(), true);
    expect(text(document.body)).toContain("It stays always on: pap starts it again when pap next starts.");
  });

  it("has no always-on line for a box that is not", async () => {
    await open(async () => {});
    expect(text(document.body)).not.toContain("always on");
  });

  it("speaks French", async () => {
    setLocale("fr");
    try {
      await open(async () => {});
      expect(text(document.body)).toContain("Arrêter la box de Atlas");
      expect(button(document.body, "Arrêter la box").getAttribute("data-variant")).toBe("primary");
    } finally {
      setLocale("en");
    }
  });

  it("Cancel closes and confirms nothing", async () => {
    const onConfirm = vi.fn(async () => {});
    const onClose = vi.fn();
    await open(onConfirm, onClose);
    await click(button(document.body, "Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("confirm calls onConfirm then closes", async () => {
    const onConfirm = vi.fn(async () => {});
    const onClose = vi.fn();
    await open(onConfirm, onClose);
    await click(button(document.body, "Stop the box"));
    await settle();
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("a refused stop stays open and says why in an action alert", async () => {
    const onClose = vi.fn();
    await open(async () => {
      throw new Error("The box was not stopped. Nothing was changed. Try again.");
    }, onClose);
    await click(button(document.body, "Stop the box"));
    await settle();
    expect(alerts(document.body)).toEqual(["The box was not stopped. Nothing was changed. Try again."]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("while the stop is pending, Cancel is disabled and Escape does not dismiss", async () => {
    let finish: () => void = () => {};
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const onClose = vi.fn();
    await open(onConfirm, onClose);
    await click(button(document.body, "Stop the box"));
    expect(button(document.body, "Cancel").disabled).toBe(true);
    await click(button(document.body, "Cancel"));
    const dialog = document.body.querySelector("[role=dialog]");
    await press(dialog ?? document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    finish();
    await settle();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
