// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { button, click, hasButton, mount, settle, text } from "../../testing/dom.ts";
import { TrustBanner } from "./TrustBanner.tsx";
import { current, CWD, newBed, withStepUp } from "./trust-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => setLocale("en"));

const show = (trust: { required: boolean; trusted: boolean } | null | undefined, cwd = CWD) =>
  mount(withStepUp(<TrustBanner sessionId="s1" cwd={cwd} trust={trust ?? null} />));
const COPY = "This project has Pi resources pap does not load until you trust it.";

describe("trust banner (M7R109)", () => {
  it("shows the copy and Review when trust is required and not given", async () => {
    newBed();
    const page = await show({ required: true, trusted: false });
    expect(text(page.container)).toContain(COPY);
    expect(hasButton(page.container, "Review")).toBe(true);
  });

  it.each([
    ["trusted", { required: true, trusted: true }],
    ["not required", { required: false, trusted: false }],
    ["unknown (older worker)", null],
  ])("hides when %s", async (_name, trust) => {
    newBed();
    const page = await show(trust);
    expect(page.container.textContent).toBe("");
  });

  it("hides before the snapshot gave a folder", async () => {
    newBed();
    const page = await show({ required: true, trusted: false }, "");
    expect(page.container.textContent).toBe("");
  });

  it("Review opens the dialog (lazy), which reads trust.status", async () => {
    const bed = newBed();
    const page = await show({ required: true, trusted: false });
    expect(bed.called("trust.status")).toEqual([]);
    await click(button(page.container, "Review"));
    await vi.waitFor(() => expect(bed.called("trust.status")).toHaveLength(1), { timeout: 4000 });
    await settle();
    expect(text(document.body)).toContain("Trust this project?");
  });

  it("after a decision it says when it applies instead of offering Review again", async () => {
    newBed();
    const page = await show({ required: true, trusted: false });
    await click(button(page.container, "Review"));
    await vi.waitFor(() => expect(text(document.body)).toContain("Trust this project?"), { timeout: 4000 });
    await settle();
    await click(button(document.body, "Keep untrusted"));
    await settle();
    expect(text(page.container)).toContain("Kept untrusted");
    expect(text(page.container)).toContain("when Pi restarts for the session");
    expect(hasButton(page.container, "Review")).toBe(false);
  });

  it("starts over for another session: a decision made in one is not shown in the next", async () => {
    newBed();
    const trust = { required: true, trusted: false };
    const page = await show(trust);
    await click(button(page.container, "Review"));
    await vi.waitFor(() => expect(text(document.body)).toContain("Trust this project?"), { timeout: 4000 });
    await settle();
    await click(button(document.body, "Keep untrusted"));
    await settle();
    expect(hasButton(page.container, "Review")).toBe(false);
    await page.rerender(withStepUp(<TrustBanner sessionId="s2" cwd={CWD} trust={trust} />));
    expect(hasButton(page.container, "Review")).toBe(true);
  });

  it("speaks French", async () => {
    setLocale("fr");
    newBed();
    const page = await show({ required: true, trusted: false });
    expect(text(page.container)).toContain("Ce projet a des ressources Pi que pap ne charge pas");
    expect(hasButton(page.container, "Examiner")).toBe(true);
  });
});
