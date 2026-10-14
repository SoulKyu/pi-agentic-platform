// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/index.ts";
import { button, click, field, settle, text, typeInto } from "../../testing/dom.ts";
import { current, newBed, PROJECT, PROTECTED_ASK, pluginOf, prompt, show, switchOf } from "./skills-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

beforeEach(() => {
  prompt.answer = true;
  prompt.asked = 0;
});
afterEach(() => vi.restoreAllMocks());

const OWN = pluginOf();
const MINE = pluginOf({ source: "git:github.com/acme/proj", scope: "project", installedPath: null });
const FILTERED = pluginOf({ source: "npm:fancy", filtered: true, enabled: true });
const group = (container: ParentNode, id: string) =>
  container.querySelector(`[data-plugin-group="${id}"]`) as HTMLElement;
const form = (container: ParentNode) => container.querySelector("[data-plugin-install]") as HTMLElement;

describe("plugin list", () => {
  it("groups packages by scope with their state", async () => {
    newBed(undefined, [OWN, MINE, FILTERED]);
    const page = await show();
    await settle();
    expect(text(group(page.container, "user"))).toContain("npm:@acme/tools");
    expect(text(group(page.container, "user"))).toContain("npm:fancy");
    expect(text(group(page.container, "user"))).toContain("custom filter");
    expect(text(group(page.container, "project"))).toContain("git:github.com/acme/proj");
    expect(switchOf(page.container, "Enable npm:fancy").disabled).toBe(true);
    await page.unmount();
  });

  it("switches a user package without a password and without Save anyway?", async () => {
    const bed = newBed(undefined, [OWN]);
    bed.handlers["plugins.setEnabled"] = () => ({
      results: [{ source: OWN.source, scope: "user", ok: true }],
    });
    const page = await show();
    await settle();
    await click(switchOf(page.container, "Enable npm:@acme/tools"));
    await settle();
    expect(prompt.asked).toBe(0);
    expect(text(page.container)).not.toContain(PROTECTED_ASK);
    expect(bed.called("plugins.setEnabled").map((call) => call.params)).toEqual([
      { items: [{ source: OWN.source, scope: "user" }], enabled: false, cwd: PROJECT.root },
    ]);
    await page.unmount();
  });

  it("shows the group switch refusal for a filtered package under its heading", async () => {
    const bed = newBed(undefined, [OWN, FILTERED]);
    bed.handlers["plugins.setEnabled"] = () => ({
      results: [
        { source: OWN.source, scope: "user", ok: true },
        { source: FILTERED.source, scope: "user", ok: false, code: "filtered" },
      ],
    });
    const page = await show();
    await settle();
    await click(switchOf(page.container, "Packages: All my projects"));
    await settle();
    expect(bed.called("plugins.setEnabled")[0]?.params).toMatchObject({
      items: [
        { source: OWN.source, scope: "user" },
        { source: FILTERED.source, scope: "user" },
      ],
      enabled: false,
    });
    expect(text(group(page.container, "user"))).toContain("npm:fancy: has a hand-written filter");
    await page.unmount();
  });

  it("asks Save anyway? before a project package changes", async () => {
    const bed = newBed(undefined, [MINE]);
    bed.handlers["plugins.setEnabled"] = () => ({
      results: [{ source: MINE.source, scope: "project", ok: true }],
    });
    const page = await show();
    await settle();
    await click(switchOf(page.container, "Enable git:github.com/acme/proj"));
    expect(bed.called("plugins.setEnabled")).toHaveLength(0);
    await click(button(page.container, "Save"));
    await settle();
    expect(bed.called("plugins.setEnabled")[0]?.params).toMatchObject({
      confirmProtected: true,
      cwd: PROJECT.root,
    });
    await page.unmount();
  });

  it("removes a package, asking Save anyway? for a project one", async () => {
    const bed = newBed(undefined, [OWN, MINE]);
    const page = await show();
    await settle();
    await click(button(group(page.container, "user"), "Remove npm:@acme/tools"));
    await settle();
    expect(bed.called("plugins.remove").map((call) => call.params)).toEqual([
      { source: OWN.source, scope: "user", cwd: PROJECT.root },
    ]);
    await click(button(group(page.container, "project"), "Remove git:github.com/acme/proj"));
    expect(text(page.container)).toContain(PROTECTED_ASK);
    await click(button(page.container, "Save"));
    await settle();
    expect(bed.called("plugins.remove")[1]?.params).toEqual({
      source: MINE.source,
      scope: "project",
      cwd: PROJECT.root,
      confirmProtected: true,
    });
    await page.unmount();
  });

  it("updates the owner's packages through the step-up and says what was updated", async () => {
    const bed = newBed(undefined, [OWN]);
    let tries = 0;
    bed.handlers["plugins.update"] = () => {
      tries += 1;
      if (tries === 1) throw new RpcError("step_up_required");
      return { updated: [{ source: OWN.source, scope: "user" }] };
    };
    const page = await show();
    await settle();
    await click(button(group(page.container, "user"), "Update"));
    await settle();
    expect(prompt.asked).toBe(1);
    expect(bed.called("plugins.update").map((call) => call.params)).toEqual([
      { scope: "user", cwd: PROJECT.root },
      { scope: "user", cwd: PROJECT.root },
    ]);
    expect(text(page.container)).toContain("Updated 1.");
    await page.unmount();
  });
});

describe("plugin install", () => {
  it("starts on the project, names that Pi installs with npm, and installs after Save anyway?", async () => {
    const bed = newBed();
    const page = await show();
    await settle();
    expect(text(form(page.container))).toContain("Pi installs the package with npm");
    expect(button(form(page.container), "This project (app)").getAttribute("aria-pressed")).toBe("true");
    await typeInto(field(form(page.container), "Package (npm:…, git:…, or an https address)"), "npm:@acme/x");
    await click(button(form(page.container), "Install package"));
    expect(bed.called("plugins.install")).toHaveLength(0);
    await click(button(page.container, "Save"));
    await settle();
    expect(bed.called("plugins.install").map((call) => call.params)).toEqual([
      { source: "npm:@acme/x", scope: "project", cwd: PROJECT.root, confirmProtected: true },
    ]);
    await page.unmount();
  });

  it("installs for All my projects through the step-up, as scope user", async () => {
    const bed = newBed();
    let tries = 0;
    bed.handlers["plugins.install"] = () => {
      tries += 1;
      if (tries === 1) throw new RpcError("step_up_required");
      return { ok: true };
    };
    const page = await show();
    await settle();
    await click(button(form(page.container), "All my projects"));
    await typeInto(field(form(page.container), "Package (npm:…, git:…, or an https address)"), "npm:@acme/x");
    await click(button(form(page.container), "Install package"));
    await settle();
    expect(prompt.asked).toBe(1);
    expect(bed.called("plugins.install").map((call) => call.params)).toEqual([
      { source: "npm:@acme/x", scope: "user" },
      { source: "npm:@acme/x", scope: "user" },
    ]);
    await page.unmount();
  });
});
