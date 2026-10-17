// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "../testing/dom.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";

const LABELS = { deny: "Deny", session: "Session", always: "Always", once: "Allow once" } as const;
const show = (wide?: boolean) =>
  mount(
    <ApprovalCard
      title="Approval"
      detail={"header\nbody"}
      answers={["deny", "session", "once"]}
      labels={LABELS}
      wide={wide}
      onChoose={() => {}}
    />,
  );

describe("ApprovalCard wide", () => {
  it("fills its row and lays the answers out as a full-width grid of 44 px touch targets", async () => {
    const page = await show(true);
    const card = page.container.querySelector('[role="alertdialog"]');
    expect(card?.className).toContain("w-full");
    const actions = card?.querySelector("[data-approval-actions]");
    expect(actions?.className).toContain("grid");
    expect(actions?.className).toContain("w-full");
    for (const one of actions?.querySelectorAll("button") ?? []) {
      expect(one.className).toContain("h-control");
      expect(one.className).not.toContain("h-6");
      expect(one.className).toContain("pointer-coarse:min-h-11");
    }
    await page.unmount();
  });

  it("is the compact card unless asked", async () => {
    const page = await show();
    const card = page.container.querySelector('[role="alertdialog"]');
    expect(card?.className).not.toContain("w-full");
    expect(card?.querySelector("[data-approval-actions]")?.className).not.toContain("grid");
    for (const one of card?.querySelectorAll("[data-approval-actions] button") ?? [])
      expect(one.className).toContain("h-6");
    await page.unmount();
  });
});
