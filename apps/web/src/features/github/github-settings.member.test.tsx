// @vitest-environment happy-dom
import { TooltipProvider } from "@pap/ui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RoleContext } from "../../lib/role-context.ts";
import type { StepUpRunner } from "../../lib/step-up-context.tsx";
import type { Runtime } from "../../runtime/index.ts";
import { hasButton, mount, settle, text } from "../../testing/dom.ts";
import { githubStatus } from "../../testing/github-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { GithubSettings } from "./GithubSettings.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

async function show(status: ReturnType<typeof githubStatus>) {
  const bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["github.status"] = () => ({ status });
  const page = await mount(
    <TooltipProvider>
      <RoleContext.Provider value="member">
        <GithubSettings stepUp={vi.fn() as unknown as StepUpRunner} go={vi.fn()} />
      </RoleContext.Provider>
    </TooltipProvider>,
  );
  await settle();
  return page.container;
}
beforeEach(() => setLocale("en"));

describe("Settings › GitHub, as a member", () => {
  it("shows Authorize, Disconnect and the install link, and no App creation or deletion", async () => {
    const connected = await show(githubStatus({ state: "connected" }));
    expect(hasButton(connected, "Disconnect")).toBe(true);
    expect(hasButton(connected, "Install on GitHub")).toBe(true);
    expect(hasButton(connected, "Delete the app")).toBe(false);
    const created = await show(githubStatus({ state: "created", login: null }));
    expect(hasButton(created, "Authorize")).toBe(true);
    expect(hasButton(created, "Delete the app")).toBe(false);
  });

  it("offers no App creation while none exists", async () => {
    const absent = await show(githubStatus({ state: "absent", app: null, login: null }));
    expect(hasButton(absent, "Create the GitHub App")).toBe(false);
    expect(text(absent)).toContain("has not created the GitHub App");
  });

  it("opens the installation page of the App", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const connected = await show(githubStatus({ state: "connected" }));
    (
      [...connected.querySelectorAll("button")].find(
        (one) => one.textContent === "Install on GitHub",
      ) as HTMLElement
    ).click();
    expect(open).toHaveBeenCalledWith(
      "https://github.com/apps/pap-host-ab12/installations/new",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
