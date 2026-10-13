// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsApprovalsEn, settingsApprovalsFr } from "../../i18n/catalog/settings-approvals.ts";
import { registerCatalog } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { alerts, click, field, mount, settle, text, typeInto, type Mounted } from "../../testing/dom.ts";
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

const rule = (id: string, scope: string, tool: string, label: string, createdAt: number) => ({
  id,
  scope,
  tool,
  label,
  createdAt,
});
const three = [
  rule("r1", "/home/me/work/app", "bash", "yarn test", Date.UTC(2026, 9, 1)),
  rule("r2", "/home/me/work/app", "write", "src/a.ts", Date.UTC(2026, 9, 3)),
  rule("r3", "/home/me/play/site", "bash", "npm run build", Date.UTC(2026, 9, 2)),
];
const deferred = () => {
  let resolve: (value: unknown) => void = () => {};
  const promise = new Promise((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
};
async function show(rules: unknown[] = three, truncated = false) {
  bed.handlers["policy.listRules"] = () => ({ rules, truncated });
  page = await mount(<RulesByProject />);
  await settle();
  return page.container;
}
const listed = () => bed.called("policy.listRules");
const lines = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-rule]")].map(
    (el) => el.querySelector("[data-rule-label]")?.textContent,
  );
const revokes = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].filter((b) => b.textContent === "Revoke");

describe("always rules by project", () => {
  it("asks for every project and groups the rules, newest first, with counts", async () => {
    const container = await show();
    expect(listed()).toEqual([{ method: "policy.listRules", params: {} }]);
    const groups = [...container.querySelectorAll("[data-rule-group]")];
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      "Project /home/me/work/app",
      "Project /home/me/play/site",
    ]);
    expect(groups.map((g) => text(g.firstElementChild as Element))).toEqual([
      "work/appRules: 2",
      "play/siteRules: 1",
    ]);
    expect(lines(container)).toEqual(["src/a.ts", "yarn test", "npm run build"]);
  });

  it("filters on tool, label and path", async () => {
    const container = await show();
    await typeInto(field(container, "Filter rules"), "npm");
    expect(lines(container)).toEqual(["npm run build"]);
    await typeInto(field(container, "Filter rules"), "WRITE");
    expect(lines(container)).toEqual(["src/a.ts"]);
    await typeInto(field(container, "Filter rules"), "play/site");
    expect(lines(container)).toEqual(["npm run build"]);
    await typeInto(field(container, "Filter rules"), "zzz");
    expect(text(container)).toContain("No rule matches the filter.");
  });

  it("revokes with a command id and loads the list again", async () => {
    let rules = three;
    bed.handlers["policy.listRules"] = () => ({ rules, truncated: false });
    bed.handlers["policy.revokeRule"] = () => {
      rules = rules.filter((r) => r.id !== "r2");
      return { ok: true };
    };
    page = await mount(<RulesByProject />);
    await settle();
    const container = page.container;
    await click(revokes(container)[0] as HTMLElement);
    await settle();
    expect(bed.called("policy.revokeRule")).toEqual([
      { method: "policy.revokeRule", params: { ruleId: "r2" }, options: { commandId: "bed-cmd-00000001" } },
    ]);
    expect(listed()).toHaveLength(2);
    expect(lines(container)).toEqual(["npm run build", "yarn test"]); // the group of the newest rule comes first
  });

  it("names each revoke button by its rule", async () => {
    const container = await show();
    expect(revokes(container)[0]?.getAttribute("aria-label")).toBe("Revoke write: src/a.ts");
  });

  it("reloads after a failure, shows it, and does not retry a timeout", async () => {
    const container = await show();
    bed.handlers["policy.revokeRule"] = () => {
      throw new RpcError("timeout");
    };
    await click(revokes(container)[0] as HTMLElement);
    await settle();
    expect(bed.called("policy.revokeRule")).toHaveLength(1);
    expect(listed()).toHaveLength(2);
    expect(alerts(container)[0]).toContain("may still have gone through");
  });

  it("keeps a revoke failure on screen when the reload removes the rule", async () => {
    let rules = three;
    bed.handlers["policy.listRules"] = () => ({ rules, truncated: false });
    bed.handlers["policy.revokeRule"] = () => {
      rules = rules.filter((r) => r.id !== "r2");
      throw new RpcError("not_found");
    };
    page = await mount(<RulesByProject />);
    await settle();
    await click(revokes(page.container)[0] as HTMLElement);
    await settle();
    expect(lines(page.container)).toEqual(["npm run build", "yarn test"]);
    expect(alerts(page.container)).toEqual([expect.stringMatching(/\S/)]);
    await click(revokes(page.container)[0] as HTMLElement);
    await settle();
    expect(alerts(page.container)).toHaveLength(1); // the new attempt replaced it, never stacked
  });

  it("cannot double-send a revoke", async () => {
    const reply = deferred();
    const container = await show();
    bed.handlers["policy.revokeRule"] = () => reply.promise;
    const first = revokes(container)[0] as HTMLButtonElement;
    await click(first);
    await click(first);
    expect(bed.called("policy.revokeRule")).toHaveLength(1);
    expect(first.disabled).toBe(true);
    reply.resolve({ ok: true });
    await settle();
    expect(first.disabled).toBe(false);
  });

  it("shows a stripped, clipped label as text only", async () => {
    const long = `<img src=x onerror=alert(1)>‮${"x".repeat(5000)}`;
    const container = await show([rule("r1", "/p/q", "bash", long, 1)]);
    expect(container.querySelector("img")).toBeNull();
    const shown = container.querySelector("[data-rule-label]")?.textContent ?? "";
    expect(shown.startsWith("<img src=x onerror=alert(1)>x")).toBe(true);
    expect(shown).not.toContain("‮");
    expect([...shown]).toHaveLength(201);
    expect(shown.endsWith("…")).toBe(true);
  });

  it("says when more rules exist than are shown, and when there are none", async () => {
    expect(text(await show(three, true))).toContain("Some rules are not shown");
    await page?.unmount();
    expect(text(await show([]))).toContain("Nothing is always allowed yet.");
  });

  it("shows a list failure", async () => {
    bed.handlers["policy.listRules"] = () => {
      throw new RpcError("internal");
    };
    page = await mount(<RulesByProject />);
    await settle();
    expect(alerts(page.container)).toHaveLength(1);
    expect(text(page.container)).not.toContain("Loading rules…");
  });

  it("drops a list answer that a later reload overtook", async () => {
    const slow = deferred();
    let calls = 0;
    bed.handlers["policy.listRules"] = () => {
      calls += 1;
      if (calls === 1) return { rules: three, truncated: false };
      return calls === 2 ? slow.promise : { rules: [], truncated: false };
    };
    bed.handlers["policy.revokeRule"] = () => ({ ok: true });
    page = await mount(<RulesByProject />);
    await settle();
    const container = page.container;
    await click(revokes(container)[0] as HTMLElement);
    await settle();
    await click(revokes(container)[1] as HTMLElement);
    await settle();
    expect(text(container)).toContain("Nothing is always allowed yet.");
    slow.resolve({ rules: three, truncated: false });
    await settle();
    expect(text(container)).toContain("Nothing is always allowed yet.");
    expect(revokes(container)).toHaveLength(0);
  });
});
