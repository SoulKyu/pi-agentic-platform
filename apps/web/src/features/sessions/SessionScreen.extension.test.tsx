// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { alerts, button, click, field, settle, text } from "../../testing/dom.ts";
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

describe("extension decorations in the session screen", () => {
  it("shows the title in the header and leaves document.title alone (M2R139)", async () => {
    document.title = "pap";
    const container = await screen.show({ title: "\u001b[31mRelease\u202E 1.2\u001b[0m" });
    expect(container.querySelector("header [data-session-title]")?.textContent).toBe("Release 1.2");
    expect(document.title).toBe("pap");
    await screen.emit({ kind: "title", title: "Next" });
    expect(container.querySelector("[data-session-title]")?.textContent).toBe("Next");
    expect(document.title).toBe("pap");
  });

  it("labels extension notices and only those (M2R138)", async () => {
    const container = await screen.show({
      notices: [
        { level: "info", text: "Deployed", source: "extension" },
        { level: "warning", text: "Disk is nearly full", source: "pap" },
        { level: "info", text: "Plain notice" },
      ],
    });
    const notices = [...container.querySelectorAll("[data-notice]")].map((notice) => notice.textContent);
    expect(notices).toEqual(["from an extensionDeployed", "Disk is nearly full", "Plain notice"]);
  });

  it("sends a status command as a prompt, and shows its failure", async () => {
    const container = await screen.show({
      status: "idle",
      statuses: [{ key: "command:/mode build", text: "Build" }],
    });
    await click(button(container, "Build /mode build"));
    await settle();
    expect(screen.bed.called("sessions.prompt")).toEqual([
      {
        method: "sessions.prompt",
        params: { sessionId: "sess-1", text: "/mode build" },
        options: { commandId: expect.any(String) },
      },
    ]);
    screen.bed.handlers["sessions.prompt"] = () => {
      throw new RpcError("session_busy");
    };
    await click(button(container, "Build /mode build"));
    await settle();
    expect(alerts(container)).toEqual(["The session is working. Wait for it to finish, or stop it first."]);
  });

  it("disables the status buttons while the session works", async () => {
    const container = await screen.show({
      status: "running",
      statuses: [{ key: "command:/mode build", text: "Build" }],
    });
    expect(button(container, "Build /mode build").disabled).toBe(true);
  });

  it("puts widgets above and below the composer and the status bar under it", async () => {
    const container = await screen.show({
      statuses: [{ key: "ci", text: "green" }],
      widgets: [
        { key: "a", lines: ["above line"], placement: "aboveEditor" },
        { key: "b", lines: ["below line"], placement: "belowEditor" },
      ],
    });
    const html = container.innerHTML;
    const at = (needle: string) => html.indexOf(needle);
    const composer = at("data-composer");
    expect(at("above line")).toBeGreaterThan(-1);
    expect(at("above line")).toBeLessThan(composer);
    expect(at("below line")).toBeGreaterThan(composer);
    expect(at("green")).toBeGreaterThan(at("below line"));
    expect(field(container, "Message")).toBeTruthy();
    expect(text(container)).toContain("from an extension");
  });

  it("sends a status command once when the button is clicked twice before the call returns", async () => {
    let release: (value: unknown) => void = () => {};
    const container = await screen.show({
      status: "idle",
      statuses: [{ key: "command:/mode build", text: "Build" }],
    });
    screen.bed.handlers["sessions.prompt"] = () => new Promise((resolve) => (release = resolve));
    const run = button(container, "Build /mode build");
    await click(run);
    await click(run);
    expect(screen.bed.called("sessions.prompt")).toHaveLength(1);
    release({ disposition: "started" });
    await settle();
    await click(run);
    expect(screen.bed.called("sessions.prompt")).toHaveLength(2);
  });
});
