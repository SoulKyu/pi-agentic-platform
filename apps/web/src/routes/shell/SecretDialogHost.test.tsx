// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { useSecretDialog } from "../../stores/secret-dialog-store.ts";
import type { Runtime } from "../../runtime/index.ts";
import { mount } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { SecretDialogHost } from "./SecretDialogHost.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => {
  useSecretDialog.getState().close();
  useAgentsStore.getState().reset();
});

describe("SecretDialogHost", () => {
  it("mounts the lazy dialog while a request is open, and unmounts it when the store closes (sign-out)", async () => {
    current.runtime = fakeRuntime("open").runtime;
    await mount(<SecretDialogHost />);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    act(() => useSecretDialog.getState().open("r1"));
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull(), {
      timeout: 2_000,
    });
    act(() => useSecretDialog.getState().close());
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  });
});
