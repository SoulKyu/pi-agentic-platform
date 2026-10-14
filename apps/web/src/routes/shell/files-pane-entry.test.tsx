// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import "../../i18n/register-files.ts";
import { RpcError } from "../../runtime/rpc.ts";
import { click, mount, settle, typeInto } from "../../testing/dom.ts";
import type { StepUp } from "../../features/files/FilesPane.tsx";
import { FilesPaneEntry } from "./files-pane-entry.tsx";
import { ShellContext } from "./shell-context.ts";

const seen = vi.hoisted(() => ({ props: undefined as { root: string; stepUp: StepUp } | undefined }));
vi.mock("../../features/files/FilesPane.tsx", () => ({
  FilesPane: (props: { root: string; stepUp: StepUp }) => {
    seen.props = props;
    return <div data-stub="files-pane">{props.stepUp.prompt}</div>;
  },
}));
const auth = vi.hoisted(() => ({ confirmPassword: vi.fn() }));
vi.mock("../../features/auth/auth-api.ts", async (original) => ({
  ...(await original<typeof import("../../features/auth/auth-api.ts")>()),
  confirmPassword: auth.confirmPassword,
}));

const shell = { username: "me", passkeysAvailable: true, onSignedOut: vi.fn() };

describe("FilesPaneEntry", () => {
  it("gives the pane its root and a step-up whose prompt is the auth feature's password dialog", async () => {
    const page = await mount(
      <ShellContext.Provider value={shell}>
        <FilesPaneEntry root="/w/api" />
      </ShellContext.Provider>,
    );
    await settle();
    expect(seen.props?.root).toBe("/w/api");
    expect(document.querySelector('input[type="password"]')).toBeNull();

    const attempt = vi
      .fn<(commandId: string) => Promise<string>>()
      .mockRejectedValueOnce(new RpcError("step_up_required"))
      .mockResolvedValueOnce("written");
    auth.confirmPassword.mockResolvedValue({ ok: true });
    let outcome: Promise<string> | undefined;
    await act(async () => {
      outcome = seen.props?.stepUp.run(attempt, "cmd-1");
    });
    const password = document.querySelector('input[type="password"]') as HTMLInputElement;
    expect(password).not.toBeNull();
    await typeInto(password, "secret");
    await click(document.querySelector('button[type="submit"]') as HTMLElement);
    await settle();
    expect(await outcome).toBe("written");
    expect(attempt.mock.calls).toEqual([["cmd-1"], ["cmd-1"]]);
    await page.unmount();
  });

  it("runs an attempt that needs no password once, without a prompt", async () => {
    await mount(
      <ShellContext.Provider value={shell}>
        <FilesPaneEntry root="/w/api" />
      </ShellContext.Provider>,
    );
    await settle();
    const attempt = vi.fn(async () => "ok");
    expect(await seen.props?.stepUp.run(attempt, "cmd-2")).toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });
});
