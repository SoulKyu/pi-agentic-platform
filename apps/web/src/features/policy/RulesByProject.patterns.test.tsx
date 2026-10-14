// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsApprovalsEn, settingsApprovalsFr } from "../../i18n/catalog/settings-approvals.ts";
import { registerCatalog } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { mount, settle, type Mounted } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { RulesByProject } from "./RulesByProject.tsx";

registerCatalog({ en: settingsApprovalsEn, fr: settingsApprovalsFr });

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed = fakeRuntime();
let page: Mounted | null = null;
beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

const base = { scope: "/home/me/app", label: "bash: pnpm test --watch", createdAt: Date.UTC(2026, 9, 1) };
const rules = [
  { ...base, id: "r1", tool: "bash", kind: "exact" },
  { ...base, id: "r2", tool: "bash", kind: "prefix", pattern: ["pnpm", "test"] },
  { ...base, id: "r3", tool: "mcp__fix__write", kind: "tool", label: "mcp__fix__write: {}" },
  { ...base, id: "r4", tool: "bash", kind: "prefix", pattern: ["pnpm", "te‮st"] },
];
async function show() {
  bed.handlers["policy.listRules"] = () => ({ rules, truncated: false });
  page = await mount(<RulesByProject />);
  await settle();
  return page.container;
}
const shown = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-rule]")].map((el) => ({
    tool: el.querySelector("span")?.textContent,
    what: el.querySelector("[data-rule-label]")?.textContent,
    kind: el.getAttribute("data-rule-kind"),
  }));

describe("the rules list names what each rule covers", () => {
  it("labels a prefix rule 'pnpm test …', a tool rule 'any input', and keeps an exact rule's label", async () => {
    const container = await show();
    expect(shown(container)).toEqual([
      { tool: "bash", what: "bash: pnpm test --watch", kind: "exact" },
      { tool: "bash", what: "pnpm test …", kind: "prefix" },
      { tool: "mcp__fix__write", what: "any input", kind: "tool" },
      { tool: "bash", what: "pnpm test …", kind: "prefix" },
    ]);
  });

  it("names the covered scope in the revoke button, so two rules of one tool differ", async () => {
    const container = await show();
    const names = [...container.querySelectorAll("button")]
      .map((b) => b.getAttribute("aria-label"))
      .filter(Boolean);
    expect(names).toContain("Revoke bash: pnpm test …");
    expect(names).toContain("Revoke mcp__fix__write: any input");
  });
});
