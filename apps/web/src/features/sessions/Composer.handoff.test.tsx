// @vitest-environment happy-dom
import "./register-session-catalog.ts";
import type { ReactNode } from "react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { useHandOffPorts } from "../../stores/composer-hand-off.ts";
import { useComposerPrefill } from "../../stores/composer-prefill.ts";
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

beforeEach(() => useHandOffPorts.setState({ ports: {} }));

describe("the composer's hand-off port (M11R123)", () => {
  it("gives the message to the port, sends no prompt and clears the draft", async () => {
    const handOff = vi.fn(() => true);
    act(() => useHandOffPorts.getState().register("sess-1", { names: ["Scout"], handOff }));
    const container = await screen.show({ status: "idle" });
    await typeInto(field(container, "Message"), "@Scout do it");
    await click(button(container, "Send"));
    await settle();
    expect(handOff).toHaveBeenCalledWith("@Scout do it");
    expect(screen.bed.called("sessions.prompt")).toEqual([]);
    expect(field(container, "Message").value).toBe("");
  });

  it("sends a normal prompt when the port declines the text", async () => {
    const handOff = vi.fn(() => false);
    act(() => useHandOffPorts.getState().register("sess-1", { names: ["Scout"], handOff }));
    const container = await screen.show({ status: "idle" });
    await typeInto(field(container, "Message"), "@Scouty do it");
    await click(button(container, "Send"));
    await settle();
    expect(screen.bed.called("sessions.prompt")[0]?.params).toMatchObject({ text: "@Scouty do it" });
  });

  it("is a normal prompt in a session without a port (a plain session)", async () => {
    const container = await screen.show({ status: "idle" });
    await typeInto(field(container, "Message"), "@Scout do it");
    await click(button(container, "Send"));
    await settle();
    expect(screen.bed.called("sessions.prompt")[0]?.params).toMatchObject({ text: "@Scout do it" });
  });

  it("also hands off while the agent is working (Steer)", async () => {
    const handOff = vi.fn(() => true);
    act(() => useHandOffPorts.getState().register("sess-1", { names: ["Scout"], handOff }));
    const container = await screen.show({ status: "running" });
    await typeInto(field(container, "Message"), "@Scout do it");
    await click(button(container, "Steer"));
    await settle();
    expect(handOff).toHaveBeenCalledTimes(1);
    expect(screen.bed.called("sessions.prompt")).toEqual([]);
  });

  it("puts a refused hand-off back after what the owner typed meanwhile, never over it", async () => {
    const handOff = vi.fn(() => true);
    act(() => useHandOffPorts.getState().register("sess-1", { names: ["Scout"], handOff }));
    const container = await screen.show({ status: "idle" });
    await typeInto(field(container, "Message"), "@Scout do it");
    await click(button(container, "Send"));
    await settle();
    expect(field(container, "Message").value).toBe("");
    await typeInto(field(container, "Message"), "something else");
    act(() => useComposerPrefill.getState().push("sess-1", "@Scout do it"));
    await settle();
    expect(field(container, "Message").value).toBe("something else\n\n@Scout do it");
  });
});
