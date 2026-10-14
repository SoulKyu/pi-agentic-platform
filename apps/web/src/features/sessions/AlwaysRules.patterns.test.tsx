// @vitest-environment happy-dom
import "./register-session-catalog.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { mount, settle, type Mounted } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { AlwaysRules } from "./AlwaysRules.tsx";

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

const base = { scope: "/work/project", label: "bash: pnpm test --watch", createdAt: Date.UTC(2026, 9, 1) };

describe("the session's rules list names what each rule covers", () => {
  it("shows a prefix rule as 'pnpm test …' and a tool rule as 'any input'", async () => {
    bed.handlers["policy.listRules"] = () => ({
      truncated: false,
      rules: [
        { ...base, id: "r1", tool: "bash", kind: "exact" },
        { ...base, id: "r2", tool: "bash", kind: "prefix", pattern: ["pnpm", "test"] },
        { ...base, id: "r3", tool: "mcp__fix__write", kind: "tool", label: "mcp__fix__write: {}" },
      ],
    });
    page = await mount(<AlwaysRules cwd="/work/project" />);
    await settle();
    const whats = [...page.container.querySelectorAll("[data-rule-label]")].map((el) => el.textContent);
    expect(whats).toEqual(["bash: pnpm test --watch", "pnpm test …", "any input"]);
  });
});
