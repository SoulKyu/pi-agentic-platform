// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { mount } from "../../testing/dom.ts";
import { ShellContext, useShell } from "./shell-context.ts";

function Probe() {
  return <p>{useShell().username}</p>;
}

describe("useShell", () => {
  it("throws a clear error outside the AppShell", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(mount(<Probe />)).rejects.toThrow("useShell must be used inside the AppShell");
    vi.restoreAllMocks();
  });

  it("reads what the provider holds", async () => {
    const page = await mount(
      <ShellContext.Provider value={{ username: "ana", passkeysAvailable: false, onSignedOut: () => {} }}>
        <Probe />
      </ShellContext.Provider>,
    );
    expect(page.container.textContent).toBe("ana");
    await page.unmount();
  });
});
