// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";
import { RoleContext } from "../../lib/role-context.ts";
import type { Runtime } from "../../runtime/index.ts";
import { screenBed } from "../../testing/screen-bed.tsx";
import { button, click, hasButton, settle } from "../../testing/dom.ts";
import { sessionSnapshot } from "../../testing/session-snapshot.ts";
import { preloadMenu } from "../../testing/menu.ts";
import { SessionScreen } from "./SessionScreen.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { to: string; children: unknown }) =>
      createElement("a", { href: props.to }, props.children as never),
    useNavigate: () => vi.fn(),
  };
});

// The dialog is a lazy chunk: load it before the click, as the menu above.
beforeAll(async () => {
  await preloadMenu();
  await import("./dialogs/SaveTemplateDialog.tsx");
});
const screen = screenBed(current);
const user = (entryId: string, content: string, unverified = false) => ({
  entryId,
  message: { role: "user", content, timestamp: Number(entryId.slice(1)) },
  ...(unverified ? { unverified: true } : {}),
});

describe("Save as template", () => {
  it("the owner sees Save as template on their rows; a member does not; an unverified row has none", async () => {
    const container = await screen.remount(
      <StepUpContext.Provider value={(async (run) => run("c")) as StepUpRunner}>
        <SessionScreen sessionId="sess-1" />
      </StepUpContext.Provider>,
    );
    await screen.emit(
      sessionSnapshot({ rows: [user("u1", "Review $1"), user("u2", "typed by the VM", true)] }),
    );
    expect(container.querySelectorAll('button[aria-label="Save as template"]')).toHaveLength(1);
    await click(button(container, "Save as template"));
    await settle();
    await settle();
    expect(document.querySelector("[data-save-template]")).not.toBeNull();

    await screen.remount(
      <RoleContext.Provider value="member">
        <SessionScreen sessionId="sess-1" />
      </RoleContext.Provider>,
    );
    await screen.emit(sessionSnapshot({ rows: [user("u1", "Review $1")] }));
    expect(hasButton(document.body, "Save as template")).toBe(false);
    expect(hasButton(document.body, "Fork from here")).toBe(true);
  });
});
