// @vitest-environment happy-dom
import { TooltipProvider } from "@pap/ui";
import { describe, expect, it, vi } from "vitest";
import { settingsAppearanceEn, settingsAppearanceFr } from "../../i18n/catalog/settings-appearance.ts";
import { registerCatalog } from "../../i18n/index.ts";
import { RoleContext } from "../../lib/role-context.ts";
import type { Runtime } from "../../runtime/index.ts";
import { mount, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { DetailsSection } from "./DetailsSection.tsx";

registerCatalog({ en: settingsAppearanceEn, fr: settingsAppearanceFr });
const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

async function render(role: "owner" | "member") {
  const bed = fakeRuntime("open");
  bed.handlers["fonts.list"] = () => ({ families: [] });
  current.runtime = bed.runtime;
  await mount(
    <TooltipProvider>
      <RoleContext.Provider value={role}>
        <DetailsSection />
      </RoleContext.Provider>
    </TooltipProvider>,
  );
  await settle();
}

describe("fonts controls by role", () => {
  it("are hidden for a member", async () => {
    await render("member");
    expect(document.querySelector('[data-slot="fonts-block"]')).toBeNull();
  });
  it("stay for the owner", async () => {
    await render("owner");
    expect(document.querySelector('[data-slot="fonts-block"]')).not.toBeNull();
  });
});
