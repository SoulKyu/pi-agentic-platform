// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoleContext } from "../../lib/role-context.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { EMPTY_TASKS } from "../../stores/tasks-reducer.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { button, click, field, mount, settle, text, typeInto } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import "./register-automation-settings-catalog.ts";
import { AutomationForm } from "./AutomationForm.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed = fakeRuntime();
beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
  bed.handlers["settings.get"] = () => ({
    value: { slots: 3, dailyBudgetUsd: 5, timezone: "UTC" },
    revision: 1,
  });
  bed.handlers["settings.set"] = () => {
    throw new RpcError("budget_cap");
  };
  useTasksStore.setState({ view: EMPTY_TASKS });
});

async function open(role: "owner" | "member") {
  const page = await mount(
    <RoleContext.Provider value={role}>
      <AutomationForm serverZone="UTC" browserZone={() => "UTC"} />
    </RoleContext.Provider>,
  );
  await settle();
  return page;
}

describe("Automation budget cap", () => {
  it("a member typing above the effective budget sees the capped line", async () => {
    const page = await open("member");
    expect(text(page.container)).not.toContain("Capped at");
    await typeInto(field(page.container, "Daily budget (USD)"), "20");
    expect(text(page.container)).toContain("Capped at 5 USD by the owner.");
  });

  it("a refused save shows the capped line and the refusal", async () => {
    const page = await open("member");
    await typeInto(field(page.container, "Daily budget (USD)"), "20");
    await click(button(page.container, "Save"));
    await settle();
    expect(text(page.container)).toContain("Capped at 5 USD by the owner.");
    expect(text(page.container)).toContain("capped by the owner");
  });

  it("the owner never sees the line", async () => {
    const page = await open("owner");
    await typeInto(field(page.container, "Daily budget (USD)"), "20");
    expect(text(page.container)).not.toContain("Capped at");
  });
});
