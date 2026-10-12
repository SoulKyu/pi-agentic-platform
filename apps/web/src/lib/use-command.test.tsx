// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { mount } from "../testing/dom.ts";
import { hasCommand, runCommand } from "./command-registry.ts";
import { useCommand } from "./use-command.ts";
import type { CommandHandler } from "./command-registry.ts";

function Probe({ handler, enabled = true }: { handler: CommandHandler; enabled?: boolean }) {
  useCommand("x.probe", handler, enabled);
  return null;
}

describe("useCommand", () => {
  it("registers while mounted and enabled, and always calls the latest handler", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const page = await mount(<Probe handler={first} />);
    expect(hasCommand("x.probe")).toBe(true);
    await page.rerender(<Probe handler={second} />);
    runCommand("x.probe");
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([0, 1]);
    await page.unmount();
    expect(hasCommand("x.probe")).toBe(false);
    const off = await mount(<Probe handler={first} enabled={false} />);
    expect(hasCommand("x.probe")).toBe(false);
    await off.unmount();
  });

  it("removes the registration when it becomes disabled", async () => {
    const page = await mount(<Probe handler={() => {}} />);
    await page.rerender(<Probe handler={() => {}} enabled={false} />);
    expect(hasCommand("x.probe")).toBe(false);
    await page.unmount();
  });
});
