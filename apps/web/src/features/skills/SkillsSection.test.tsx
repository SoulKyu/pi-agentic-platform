// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { button, click, hasButton, settle, text } from "../../testing/dom.ts";
import {
  current,
  newBed,
  PROJECT,
  PROTECTED_ASK,
  show,
  SKILLS,
  switchOf,
  trustStatus,
} from "./skills-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

afterEach(() => {
  setLocale("en");
  vi.restoreAllMocks();
});

const group = (container: ParentNode, id: string) =>
  container.querySelector(`[data-skill-group="${id}"]`) as HTMLElement;
const REVIEW = "/home/a/.pi/agent/skills/review/SKILL.md";
const LINT = "/home/a/.pi/agent/skills/lint/SKILL.md";
const DEPLOY = "/work/app/.pi/skills/deploy/SKILL.md";

describe("list", () => {
  it("reads skills and plugins for the project's folder and groups skills by where they live", async () => {
    const bed = newBed();
    const page = await show();
    await settle();
    expect(bed.called("skills.list").map((call) => call.params)).toEqual([{ cwd: PROJECT.root }]);
    expect(bed.called("plugins.list").map((call) => call.params)).toEqual([{ cwd: PROJECT.root }]);
    expect(text(group(page.container, "user"))).toContain("review");
    expect(text(group(page.container, "user"))).toContain("lint");
    expect(text(group(page.container, "user"))).toContain("All my projects");
    expect(text(group(page.container, "project"))).toContain("deploy");
    expect(text(page.container)).toContain("Skills live in your Pi folder or in the project");
    await page.unmount();
  });

  it("reads without a folder when there is no project, and shows no project group", async () => {
    const bed = newBed(SKILLS.filter((skill) => skill.scope === "user"));
    const page = await show(null);
    await settle();
    expect(bed.called("skills.list").map((call) => call.params)).toEqual([{}]);
    expect(group(page.container, "project")).toBeNull();
    expect(bed.called("trust.status")).toHaveLength(0);
    await page.unmount();
  });

  it("says a list failed in fixed words and offers to try again", async () => {
    const bed = newBed();
    bed.handlers["skills.list"] = () => {
      throw new Error("raw helper text");
    };
    const page = await show();
    await settle();
    expect(text(page.container)).not.toContain("raw helper text");
    expect(hasButton(page.container, "Try again")).toBe(true);
    await page.unmount();
  });
});

describe("invocation switches (M7R118)", () => {
  it("shows the group switch off while a row is off, and one write names every row of the group", async () => {
    const bed = newBed();
    bed.handlers["skills.setInvocation"] = (params) => ({
      results: (params as { items: Array<{ path: string }> }).items.map((item) => ({
        path: item.path,
        ok: true,
      })),
    });
    const page = await show();
    await settle();
    const all = switchOf(page.container, "Model invocation: All my projects");
    expect(all.getAttribute("aria-checked")).toBe("false");
    expect(text(group(page.container, "user"))).toContain("1/2");
    await click(all);
    await settle();
    expect(bed.called("skills.setInvocation").map((call) => call.params)).toEqual([
      {
        items: [
          { path: REVIEW, disabled: false },
          { path: LINT, disabled: false },
        ],
        cwd: PROJECT.root,
      },
    ]);
    expect(bed.called("skills.list")).toHaveLength(2);
    await page.unmount();
  });

  it("shows a refused row under its group heading while the other rows are switched", async () => {
    const bed = newBed();
    bed.handlers["skills.setInvocation"] = () => ({
      results: [
        { path: REVIEW, ok: true },
        { path: LINT, ok: false, code: "not_found" },
      ],
    });
    const page = await show();
    await settle();
    await click(switchOf(page.container, "Model invocation: All my projects"));
    await settle();
    expect(text(group(page.container, "user"))).toContain("lint: not a listed skill any more.");
    expect(text(group(page.container, "project"))).not.toContain("not a listed skill");
    await page.unmount();
  });

  it("asks Save anyway? before a project skill changes, and sends confirmProtected only after Save", async () => {
    const bed = newBed();
    bed.handlers["skills.setInvocation"] = () => ({ results: [{ path: DEPLOY, ok: true }] });
    const page = await show();
    await settle();
    await click(switchOf(page.container, "Model may use deploy"));
    expect(text(page.container)).toContain(PROTECTED_ASK);
    expect(bed.called("skills.setInvocation")).toHaveLength(0);
    await click(button(page.container, "Save"));
    await settle();
    expect(bed.called("skills.setInvocation").map((call) => call.params)).toEqual([
      { items: [{ path: DEPLOY, disabled: true }], cwd: PROJECT.root, confirmProtected: true },
    ]);
    expect(text(page.container)).not.toContain(PROTECTED_ASK);
    await page.unmount();
  });

  it("sends nothing when the ask is cancelled, and asks nothing for the owner's own skills", async () => {
    const bed = newBed();
    bed.handlers["skills.setInvocation"] = () => ({ results: [{ path: REVIEW, ok: true }] });
    const page = await show();
    await settle();
    await click(switchOf(page.container, "Model may use deploy"));
    await click(button(page.container, "Cancel"));
    expect(bed.called("skills.setInvocation")).toHaveLength(0);
    await click(switchOf(page.container, "Model may use review"));
    await settle();
    expect(text(page.container)).not.toContain(PROTECTED_ASK);
    expect(bed.called("skills.setInvocation")[0]?.params).toEqual({
      items: [{ path: REVIEW, disabled: true }],
      cwd: PROJECT.root,
    });
    await page.unmount();
  });

  it("freezes every switch and Save while a write is on its way", async () => {
    const bed = newBed();
    let release: (value: unknown) => void = () => {};
    bed.handlers["skills.setInvocation"] = () => new Promise((resolve) => (release = resolve));
    const page = await show();
    await settle();
    await click(switchOf(page.container, "Model may use review"));
    expect(switchOf(page.container, "Model may use lint").disabled).toBe(true);
    expect(switchOf(page.container, "Model may use deploy").disabled).toBe(true);
    release({ results: [{ path: REVIEW, ok: true }] });
    await settle();
    expect(switchOf(page.container, "Model may use lint").disabled).toBe(false);
    await page.unmount();
  });
});

describe("trust notice (MC49)", () => {
  it("offers Review when the project needs trust, and Review opens the trust dialog", async () => {
    const bed = newBed();
    bed.handlers["trust.status"] = () => trustStatus(true);
    const page = await show();
    await settle();
    expect(text(page.container)).toContain("This project's skills and packages need your trust");
    await click(button(page.container, "Review"));
    await vi.waitFor(() => expect(text(document.body)).toContain("deploy.ts"), { timeout: 4000 });
    expect(bed.called("trust.status")[0]?.params).toEqual({ cwd: PROJECT.root });
    await page.unmount();
  });

  it("offers no Review when the project is trusted", async () => {
    newBed();
    const page = await show();
    await settle();
    expect(hasButton(page.container, "Review")).toBe(false);
    await page.unmount();
  });
});

describe("French", () => {
  it("shows the section in French", async () => {
    setLocale("fr");
    newBed();
    const page = await show();
    await settle();
    expect(text(page.container)).toContain("Tous mes projets");
    expect(text(page.container)).toContain("Les skills vivent dans votre dossier Pi ou dans le projet");
    await page.unmount();
  });
});
