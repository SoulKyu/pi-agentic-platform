// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { screenBed } from "../../testing/screen-bed.tsx";
import { sessionSnapshot } from "../../testing/session-snapshot.ts";
import { click } from "../../testing/dom.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { to: string; children: ReactNode }) =>
      createElement("a", { href: props.to }, props.children),
    useNavigate: () => () => Promise.resolve(),
  };
});

const screen = screenBed(current);
afterEach(() => setLocale("en"));

const TITLE = "Another Pi process may be using this session";
const notice = (container: HTMLElement) => container.querySelector("[data-slot='banner']");

describe("SessionScreen, a Pi file changed outside pap (owner Q13)", () => {
  it("says so in a status region above the transcript, with what is at stake", async () => {
    const container = await screen.show({ outsideWrite: true });
    const region = notice(container);
    expect(region?.getAttribute("role")).toBe("status");
    expect(region?.textContent).toContain(TITLE);
    expect(region?.textContent).toContain(
      "Its file changed in the last 2 minutes outside pap, from the pi CLI or pi-web for example. Messages sent from both can interleave: close the other one before you continue here.",
    );
    const transcript = container.querySelector("ol");
    expect(transcript).not.toBeNull();
    expect(region?.compareDocumentPosition(transcript as Element)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("hides on Dismiss until the next snapshot that says so again", async () => {
    const container = await screen.show({ outsideWrite: true });
    const dismiss = [...(notice(container)?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "Dismiss",
    );
    expect(dismiss).toBeDefined();
    await click(dismiss as HTMLElement);
    expect(notice(container)).toBeNull();
    await screen.emit(sessionSnapshot({ outsideWrite: true }));
    expect(notice(container)?.textContent).toContain(TITLE);
  });

  it("shows nothing when the file did not change outside pap", async () => {
    expect(notice(await screen.show({ outsideWrite: false }))).toBeNull();
  });

  it("speaks French", async () => {
    setLocale("fr");
    const container = await screen.show({ outsideWrite: true });
    expect(notice(container)?.textContent).toContain("Un autre processus Pi utilise peut-être cette session");
    expect(notice(container)?.textContent).toContain("Masquer");
  });
});
