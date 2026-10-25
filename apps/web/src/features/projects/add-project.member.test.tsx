// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoleContext } from "../../lib/role-context.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { mount, text } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { AddProjectDialog } from "./AddProjectDialog.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
beforeEach(() => {
  current.runtime = fakeRuntime("open").runtime;
  useShellStore.getState().reset();
});

describe("New project, as a member", () => {
  it("offers Empty and From GitHub only", async () => {
    await mount(
      <RoleContext.Provider value="member">
        <AddProjectDialog onClose={() => {}} onAdded={() => {}} />
      </RoleContext.Provider>,
    );
    const options = [...document.querySelectorAll('[data-add-project] [role="radio"]')].map(
      (one) => one.textContent,
    );
    expect(options).toHaveLength(2);
    expect(text(document.body)).not.toMatch(/folder|host|this machine path/i);
  });
});
