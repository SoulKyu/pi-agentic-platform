// @vitest-environment happy-dom
import "./register-session-catalog.ts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, field, settle, typeInto } from "../../testing/dom.ts";
import { screenBed } from "../../testing/screen-bed.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { to: string; children: ReactNode }) =>
      createElement("a", { href: props.to }, props.children),
    useNavigate: () => () => Promise.resolve(),
  };
});

const screen = screenBed(current);

describe("Composer while the agent works (D6)", () => {
  it("Stop comes first, Steer | Follow up is one radiogroup, and Send is the only primary", async () => {
    const container = await screen.show({ status: "running" });
    const row = container.querySelector("[data-composer] form > div:last-child") as HTMLElement;
    const controls = [...row.querySelectorAll("button")];
    expect(controls[0]?.textContent).toBe("Stop");
    expect(controls[0]?.dataset.variant).toBe("secondary");
    const group = row.querySelector("[data-slot='segmented']") as HTMLElement;
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect([...group.querySelectorAll("[role='radio']")].map((one) => one.textContent)).toEqual([
      "Steer",
      "Follow up",
    ]);
    expect(row.querySelector("[data-slot='segmented-field'] .sr-only")?.textContent).toBe(
      "While the agent works",
    );
    const primaries = [...container.querySelectorAll("[data-composer] button[data-variant='primary']")];
    expect(primaries.map((one) => one.textContent)).toEqual(["Send"]);
    const all = [...row.querySelectorAll("button")].map((one) => one.textContent);
    expect(all.indexOf("Stop")).toBeLessThan(all.indexOf("Steer"));
    expect(all.indexOf("Follow up")).toBeLessThan(all.indexOf("Send"));
  });

  it("choosing Follow up then Send sends followUp and remembers it", async () => {
    const container = await screen.show({ status: "running" });
    await typeInto(field(container, "Message"), "then this");
    await click(button(container, "Follow up"));
    expect(screen.bed.called("sessions.prompt")).toEqual([]);
    await click(button(container, "Send"));
    await settle();
    expect(screen.bed.called("sessions.prompt")[0]?.params).toMatchObject({ streamingBehavior: "followUp" });
    expect(localStorage.getItem("pap.sessions.streaming")).toBe("followUp");
  });
});
