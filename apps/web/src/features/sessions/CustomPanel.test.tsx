// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { alerts, field, mount, press, settle, text, typeInto, type Mounted } from "../../testing/dom.ts";
import { screenBed } from "../../testing/screen-bed.tsx";
import { CustomPanel } from "./CustomPanel.tsx";

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
let page: Mounted | null = null;

afterEach(async () => {
  await page?.unmount();
  page = null;
});

async function show(panels: Array<{ id: string; lines: string[] }>) {
  page = await mount(<CustomPanel sessionId="sess-1" panels={panels} />);
  await settle();
  return page.container;
}
const sent = (b = screen.bed) =>
  b.called("sessions.panelInput").map((call) => (call.params as { data: string }).data);
const inputOf = (container: ParentNode) =>
  container.querySelector("[data-terminal-input] textarea") as HTMLTextAreaElement;

describe("CustomPanel", () => {
  it("shows the oldest panel, counts the others, and sends keys and pasted text", async () => {
    const container = await show([
      { id: "p1", lines: ["\u001b[7m> alpha\u001b[0m", "  beta"] },
      { id: "p2", lines: ["other"] },
    ]);
    expect(text(container)).toContain("> alpha");
    expect(text(container)).toContain("1 more waiting");
    expect(text(container)).not.toContain("other");
    const input = inputOf(container);
    expect(document.activeElement).toBe(input);
    await press(input, { key: "ArrowDown" });
    await typeInto(input, "pasted text");
    await settle();
    expect(screen.bed.called("sessions.panelInput").map((call) => call.params)).toEqual([
      { sessionId: "sess-1", panelId: "p1", data: "\u001b[B" },
      { sessionId: "sess-1", panelId: "p1", data: "pasted text" },
    ]);
    expect(input.value).toBe("");
  });

  it("splits a long paste into ordered chunks of at most 4096 characters, never inside a surrogate pair", async () => {
    const container = await show([{ id: "p1", lines: ["x"] }]);
    const long = `${"a".repeat(4095)}\u{1f600}${"b".repeat(4096)}c`;
    await typeInto(inputOf(container), long);
    await settle();
    const chunks = sent();
    expect(chunks.map((chunk) => chunk.length)).toEqual([4095, 4096, 3]);
    expect(chunks.join("")).toBe(long);
  });

  it("refuses a paste beyond 64 KiB with a message and sends nothing", async () => {
    const container = await show([{ id: "p1", lines: ["x"] }]);
    const input = inputOf(container);
    await typeInto(input, "a".repeat(65_537));
    await settle();
    expect(sent()).toEqual([]);
    expect(alerts(container)).toEqual(["That text is too long to send to the panel."]);
    expect(input.value).toBe("");
  });

  it("shows a failed send once and never retries it", async () => {
    screen.bed.handlers["sessions.panelInput"] = () => {
      throw new RpcError("not_found");
    };
    const container = await show([{ id: "p1", lines: ["x"] }]);
    await press(inputOf(container), { key: "Enter" });
    await settle();
    expect(alerts(container)).toEqual(["Not found."]);
    expect(sent()).toEqual(["\r"]);
  });

  it("stops sending the remaining chunks of a paste once one fails", async () => {
    let calls = 0;
    screen.bed.handlers["sessions.panelInput"] = () => {
      if (++calls === 2) throw new RpcError("worker_failed");
      return { ok: true };
    };
    const container = await show([{ id: "p1", lines: ["x"] }]);
    await typeInto(inputOf(container), "z".repeat(4096 * 3));
    await settle();
    expect(sent()).toHaveLength(2);
    expect(alerts(container)).toEqual(["The session process failed."]);
  });

  it("renders nothing without a panel", async () => {
    const container = await show([]);
    expect(container.innerHTML).toBe("");
  });
});

describe("CustomPanel in the session screen", () => {
  it("leaves the focus in the composer and says how to reach the panel; Tab gets there (owner R2-7)", async () => {
    const container = await screen.show({ status: "running" });
    const composer = field(container, "Message");
    composer.focus();
    await screen.emit({ kind: "panel", panel: { id: "p1", lines: ["> alpha"] } });
    expect(document.activeElement).toBe(composer);
    expect(text(container)).toContain("Press Tab to reach the panel");
    const tab = await press(composer, { key: "Tab" });
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(inputOf(container));
    expect(text(container)).not.toContain("Press Tab to reach the panel");
  });

  it("takes the focus when the composer does not have it", async () => {
    const container = await screen.show({ status: "running" });
    (document.activeElement as HTMLElement | null)?.blur();
    await screen.emit({ kind: "panel", panel: { id: "p1", lines: ["> alpha"] } });
    expect(document.activeElement).toBe(inputOf(container));
  });

  it("leaves Tab to the browser when there is no panel", async () => {
    const container = await screen.show({ status: "running" });
    const composer = field(container, "Message");
    expect((await press(composer, { key: "Tab" })).defaultPrevented).toBe(false);
  });

  it("sends the panel's keys with the screen's session id", async () => {
    const container = await screen.show({ status: "running" });
    await screen.emit({ kind: "panel", panel: { id: "p1", lines: ["> alpha"] } });
    await press(inputOf(container), { key: "Enter" });
    expect(sent(screen.bed)).toEqual(["\r"]);
  });
});
