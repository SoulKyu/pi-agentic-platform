// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { permissionsOf } from "@pap/contracts";
import { settingsAccessEn, settingsAccessFr } from "../../i18n/catalog/settings-access.ts";
import { registerCatalog } from "../../i18n/index.ts";
import { RoleContext } from "../../lib/role-context.ts";
import { mount } from "../../testing/dom.ts";
import { TokenCreate } from "./TokenCreate.tsx";
import { permissionGrid } from "./tokens.vm.ts";

registerCatalog({ en: settingsAccessEn, fr: settingsAccessFr });
vi.mock("./auth-api.ts", () => ({ confirmPassword: vi.fn() }));

const permissionsOfRows = (role: "owner" | "member") =>
  permissionGrid(undefined, role).flatMap((row) => row.levels.map((level) => level.permission));

describe("token permissions by role", () => {
  it("a member's grid offers no pi permission and no system:admin, and only what the role holds", () => {
    const offered = permissionsOfRows("member");
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.some((permission) => permission.startsWith("pi:") || permission === "system:admin")).toBe(
      false,
    );
    const held = permissionsOf("member");
    expect(offered.every((permission) => held.has(permission))).toBe(true);
  });

  it("the dialog renders the member's grid", async () => {
    await mount(
      <RoleContext.Provider value="member">
        <TokenCreate onCreated={() => {}} onSignedOut={() => {}} />
      </RoleContext.Provider>,
    );
    const boxes = [...document.querySelectorAll("fieldset input[type=checkbox]")];
    expect(boxes.length).toBe(permissionsOfRows("member").length);
    expect(boxes.length).toBeLessThanOrEqual(permissionsOfRows("owner").length);
  });
});
