// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { button, click, mount, text } from "../../testing/dom.ts";
import { TaintedConfirm } from "./TaintedConfirm.tsx";

describe("TaintedConfirm", () => {
  it("is one inline confirmation with the warning and two answers, never a modal", async () => {
    const confirm = vi.fn();
    const cancel = vi.fn();
    const page = await mount(<TaintedConfirm onConfirm={confirm} onCancel={cancel} />);
    expect(text(page.container)).toContain(
      "Runs this lane's files, which an agent that read external content may have changed",
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click(button(page.container, "Run anyway"));
    expect(confirm).toHaveBeenCalledTimes(1);
    await click(button(page.container, "Cancel"));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("disables both answers while the call is in flight", async () => {
    const page = await mount(<TaintedConfirm busy onConfirm={() => {}} onCancel={() => {}} />);
    expect(button(page.container, "Run anyway").disabled).toBe(true);
    expect(button(page.container, "Cancel").disabled).toBe(true);
  });
});
