// @vitest-environment happy-dom
import "./register-session-catalog.ts";
import type { ReactNode } from "react";
import { act } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, field, press, settle, typeInto } from "../../testing/dom.ts";
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

// The command menu is a lazy chunk: its first transform is slow, so it is paid here, not in a test.
beforeAll(async () => {
  await import("./CommandMenu.tsx");
}, 60_000);

const screen = screenBed(current);
const { show } = screen;
const listing = {
  commands: [
    { name: "review", description: "Review the diff", source: "prompt", builtinMcp: false },
    { name: "skill:pdf", description: "Read PDFs", source: "skill", builtinMcp: false },
  ],
  truncated: false,
};

describe("Composer command menu", () => {
  it("renders and sends when the session has no command list (a cold session whose worker fails to start)", async () => {
    screen.bed.handlers["sessions.commands"] = () => {
      throw new Error("capacity");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const container = await show({ status: "idle" });
    await typeInto(field(container, "Message"), "/review this");
    await settle();
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    await click(button(container, "Send"));
    await settle();
    expect(screen.bed.called("sessions.prompt")[0]?.params).toMatchObject({ text: "/review this" });
    warn.mockRestore();
  });

  it("asks nothing for a message that has no / or $ trigger", async () => {
    const container = await show({ status: "idle" });
    await typeInto(field(container, "Message"), "just a message");
    await settle();
    expect(screen.bed.called("sessions.commands")).toEqual([]);
  });

  it("completes a command on Enter through the composer's own key path, without sending", async () => {
    screen.bed.handlers["sessions.commands"] = () => listing;
    const container = await show({ status: "idle" });
    const area = field(container, "Message");
    await typeInto(area, "/rev");
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector('[role="option"]')).not.toBeNull(), {
        timeout: 10_000,
      });
    });
    expect(area.getAttribute("aria-expanded")).toBe("true");
    const enter = await press(area, { key: "Enter" });
    expect(enter.defaultPrevented).toBe(true);
    expect(area.value).toBe("/review ");
    expect(screen.bed.called("sessions.prompt")).toEqual([]);
    expect(area.getAttribute("aria-expanded")).toBeNull();
  });

  it("shows the skill chip for a message that starts with /skill:<name>", async () => {
    localStorage.setItem("pap.draft.sess-1", "/skill:pdf summarise");
    const container = await show({ status: "idle" });
    expect(container.querySelector("[data-skill-chip]")?.textContent).toContain("$pdf");
  });
});
