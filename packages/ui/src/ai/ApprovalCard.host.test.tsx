// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { button, click, mount } from "../testing/dom.ts";
import { APPROVAL_ORDER, ApprovalCard } from "./ApprovalCard.tsx";

const LABELS = {
  deny: "Deny",
  session: "Session",
  always: "Always",
  host: "Allow this host for this thread",
  once: "Allow once",
} as const;
const names = (container: HTMLElement) => [...container.querySelectorAll("button")].map((b) => b.textContent);

describe("ApprovalCard host answer (owner a2)", () => {
  it("orders host between Always and Allow once", () => {
    expect(APPROVAL_ORDER).toEqual(["deny", "session", "always", "host", "once"]);
  });

  it("shows the host answer between Always and Allow once when it is offered", async () => {
    const page = await mount(
      <ApprovalCard
        title="A"
        detail="x"
        answers={["once", "host", "deny", "always"]}
        labels={LABELS}
        onChoose={() => {}}
      />,
    );
    expect(names(page.container)).toEqual([
      "Deny",
      "Always",
      "Allow this host for this thread",
      "Allow once",
    ]);
    await page.unmount();
  });

  it("sends host when it is clicked", async () => {
    const onChoose = vi.fn();
    const page = await mount(
      <ApprovalCard title="A" detail="x" answers={["deny", "host"]} labels={LABELS} onChoose={onChoose} />,
    );
    await click(button(page.container, "Allow this host for this thread"));
    expect(onChoose).toHaveBeenCalledWith("host");
    await page.unmount();
  });

  it("is absent when not offered, and by default", async () => {
    const asked = await mount(
      <ApprovalCard title="A" detail="x" answers={["deny", "once"]} labels={LABELS} onChoose={() => {}} />,
    );
    expect(names(asked.container)).toEqual(["Deny", "Allow once"]);
    await asked.unmount();
    const byDefault = await mount(<ApprovalCard title="A" detail="x" labels={LABELS} onChoose={() => {}} />);
    expect(names(byDefault.container)).toEqual(["Deny", "Session", "Always", "Allow once"]);
    await byDefault.unmount();
  });
});
