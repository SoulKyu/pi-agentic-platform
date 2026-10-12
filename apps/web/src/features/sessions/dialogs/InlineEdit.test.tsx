// @vitest-environment happy-dom
import type { Dialog } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../../runtime/index.ts";
import { mount, settle, type Mounted } from "../../../testing/dom.ts";
import { fakeRuntime } from "../../../testing/runtime-bed.ts";
import { DialogList } from "./DialogList.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let mounted: Mounted | null = null;
beforeEach(() => {
  current.runtime = fakeRuntime().runtime;
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

async function show(dialog: Dialog): Promise<Element> {
  mounted = await mount(<DialogList sessionId="sess-1" dialogs={[dialog]} hidden={0} />);
  await settle();
  return mounted.container;
}

describe("dialog cards and Escape (final review I3)", () => {
  it("marks the extension card root as inline edit, so Escape cancels it and never stops the run", async () => {
    const page = await show({ id: "i1", method: "input", title: "Your name" });
    expect(page.querySelector('[role="group"]')?.hasAttribute("data-inline-edit")).toBe(true);
  });

  it("marks the approval dialog root as inline edit", async () => {
    const page = await show({
      id: "a1",
      method: "approval",
      category: "exec",
      title: "Run a command?",
      message: "1 line\nbash: ls",
      answers: ["deny", "once"],
    });
    expect(page.querySelector('[role="alertdialog"]')?.hasAttribute("data-inline-edit")).toBe(true);
  });
});
