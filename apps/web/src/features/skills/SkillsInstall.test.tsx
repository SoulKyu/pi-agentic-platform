// @vitest-environment happy-dom
import { SKILLS_CLI } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/index.ts";
import { button, click, field, hasButton, settle, text, typeInto } from "../../testing/dom.ts";
import { current, newBed, PROJECT, PROTECTED_ASK, prompt, show, trustStatus } from "./skills-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

beforeEach(() => {
  prompt.answer = true;
  prompt.asked = 0;
});
afterEach(() => vi.restoreAllMocks());

const pressed = (container: ParentNode, name: string) => button(container, name).getAttribute("aria-pressed");
const card = (container: ParentNode) => container.querySelector("[data-skill-install]") as HTMLElement;

describe("skill install card (M7R118, M7R140)", () => {
  it("starts on This project (name) when the owner came from one, and names the command without -g", async () => {
    newBed();
    const page = await show();
    await settle();
    expect(pressed(card(page.container), "This project (app)")).toBe("true");
    expect(pressed(card(page.container), "All my projects")).toBe("false");
    expect(text(card(page.container))).toContain(`pap runs npx ${SKILLS_CLI} add o/r -y --agent pi`);
    expect(text(card(page.container))).not.toContain("-y --agent pi -g");
    await page.unmount();
  });

  it("starts on All my projects without a project, and shows exactly the contracts constant with -g", async () => {
    newBed();
    const page = await show(null);
    await settle();
    expect(pressed(card(page.container), "All my projects")).toBe("true");
    expect(button(card(page.container), "This project").disabled).toBe(true);
    expect(text(card(page.container))).toContain(`pap runs npx ${SKILLS_CLI} add o/r -y --agent pi -g`);
    await page.unmount();
  });

  it("puts the typed source into the command", async () => {
    newBed();
    const page = await show();
    await settle();
    await typeInto(field(card(page.container), "Source (owner/repo or GitHub address)"), "acme/skills");
    expect(text(card(page.container))).toContain(`npx ${SKILLS_CLI} add acme/skills -y --agent pi`);
    await page.unmount();
  });

  it("asks Save anyway? for This project and sends confirmProtected: true after Save", async () => {
    const bed = newBed();
    const page = await show();
    await settle();
    await typeInto(field(card(page.container), "Source (owner/repo or GitHub address)"), "acme/skills");
    await click(button(card(page.container), "Install"));
    expect(text(page.container)).toContain(PROTECTED_ASK);
    expect(bed.called("skills.install")).toHaveLength(0);
    await click(button(page.container, "Save"));
    await settle();
    expect(bed.called("skills.install").map((call) => call.params)).toEqual([
      { source: "acme/skills", scope: "project", cwd: PROJECT.root, confirmProtected: true },
    ]);
    expect(prompt.asked).toBe(0);
    expect(text(page.container)).toContain("Installed acme/skills.");
    expect(bed.called("skills.list").length).toBeGreaterThan(1);
    await page.unmount();
  });

  it("goes through the password step-up for All my projects and asks no Save anyway?", async () => {
    const bed = newBed();
    let tries = 0;
    bed.handlers["skills.install"] = () => {
      tries += 1;
      if (tries === 1) throw new RpcError("step_up_required");
      return { ok: true };
    };
    const page = await show();
    await settle();
    await click(button(card(page.container), "All my projects"));
    await typeInto(field(card(page.container), "Source (owner/repo or GitHub address)"), "acme/skills");
    await click(button(card(page.container), "Install"));
    await settle();
    expect(text(page.container)).not.toContain(PROTECTED_ASK);
    expect(prompt.asked).toBe(1);
    expect(bed.called("skills.install").map((call) => call.params)).toEqual([
      { source: "acme/skills", scope: "global" },
      { source: "acme/skills", scope: "global" },
    ]);
    await page.unmount();
  });

  it("installs nothing when the password prompt is cancelled", async () => {
    const bed = newBed();
    bed.handlers["skills.install"] = () => {
      throw new RpcError("step_up_required");
    };
    prompt.answer = false;
    const page = await show(null);
    await settle();
    await typeInto(field(card(page.container), "Source (owner/repo or GitHub address)"), "acme/skills");
    await click(button(card(page.container), "Install"));
    await settle();
    expect(text(page.container)).not.toContain("Installed");
    await page.unmount();
  });

  it("needs a source before Install, and disables This project while the project needs trust", async () => {
    const bed = newBed();
    bed.handlers["trust.status"] = () => trustStatus(true);
    const page = await show();
    await settle();
    expect(button(card(page.container), "Install").disabled).toBe(true);
    expect(button(card(page.container), "This project (app)").disabled).toBe(true);
    expect(pressed(card(page.container), "All my projects")).toBe("true");
    await page.unmount();
  });

  it("says a refusal in fixed words, never the server's", async () => {
    const bed = newBed();
    bed.handlers["skills.install"] = () => {
      throw new Error("raw npx output");
    };
    const page = await show(null);
    await settle();
    await typeInto(field(card(page.container), "Source (owner/repo or GitHub address)"), "acme/skills");
    await click(button(card(page.container), "Install"));
    await settle();
    expect(text(page.container)).not.toContain("raw npx output");
    expect(page.container.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    await page.unmount();
  });
});

describe("skills.sh search", () => {
  const answer = {
    results: [
      {
        name: "<img src=x onerror=alert(1)>",
        source: "evil/repo",
        installs: 12,
        url: "https://skills.sh/evil/repo",
      },
      { name: "plain", source: "ok/repo", installs: null, url: null },
      { name: "weird", source: "w/r", installs: 1, url: "javascript:alert(1)" },
    ],
  };

  it("sends the query once, shows the results as text, and opens links in a new tab without opener", async () => {
    const bed = newBed();
    bed.handlers["skills.search"] = () => answer;
    const page = await show();
    await settle();
    await typeInto(field(page.container, "Search skills.sh"), "review");
    await click(button(page.container, "Search"));
    await settle();
    expect(bed.called("skills.search").map((call) => call.params)).toEqual([{ query: "review" }]);
    const list = page.container.querySelector("[data-skill-results]") as HTMLElement;
    expect(text(list)).toContain("<img src=x onerror=alert(1)>");
    expect(list.querySelector("img")).toBeNull();
    const links = [...list.querySelectorAll("a")];
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("https://skills.sh/evil/repo");
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    await page.unmount();
  });

  it("puts a result's source into the install card", async () => {
    const bed = newBed();
    bed.handlers["skills.search"] = () => answer;
    const page = await show();
    await settle();
    await typeInto(field(page.container, "Search skills.sh"), "review");
    await click(button(page.container, "Search"));
    await settle();
    await click(button(page.container, "Use ok/repo"));
    expect(field(card(page.container), "Source (owner/repo or GitHub address)").value).toBe("ok/repo");
    await page.unmount();
  });

  it("does not search an empty query", async () => {
    newBed();
    const page = await show();
    await settle();
    expect(hasButton(page.container, "Search")).toBe(true);
    expect(button(page.container, "Search").disabled).toBe(true);
    await page.unmount();
  });
});
