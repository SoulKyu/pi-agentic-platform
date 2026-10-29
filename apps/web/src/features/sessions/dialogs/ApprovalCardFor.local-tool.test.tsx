// @vitest-environment happy-dom
import "../register-session-catalog.ts";
import { DEFAULT_POLICY_SETTINGS, type Dialog, type TaintCause } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../i18n/index.ts";
import type { Runtime } from "../../../runtime/index.ts";
import { button, click, hasButton, mount, settle, text, type Mounted } from "../../../testing/dom.ts";
import { fakeRuntime } from "../../../testing/runtime-bed.ts";
import { DialogList } from "./DialogList.tsx";

// Decision 143: the card of an extension tool of unknown kind offers to declare that tool local, tainted or not.
const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const todoRule = { tool: "todo", source: "/agent/.pi/agent/npm/node_modules/rpiv-todo/index.ts" };
const cause = (tool: string, markable: boolean): TaintCause => ({
  tool,
  source: markable ? `/x/ext/${tool}.ts` : `builtin:${tool}`,
  at: 1,
  count: 1,
  markable,
});
const dialog = (over: Partial<Dialog> = {}): Dialog => ({
  id: "a1",
  method: "approval",
  category: "unknown",
  title: "Allow this tool?",
  message: 'todo: {"op":"update"}',
  answers: ["deny", "once"],
  tool: "todo",
  localTool: todoRule,
  ...over,
});

let bed: ReturnType<typeof fakeRuntime>;
let mounted: Mounted | null = null;
async function show(card: Dialog) {
  mounted = await mount(<DialogList sessionId="sess-1" dialogs={[card]} hidden={0} />);
  await settle();
  return mounted.container;
}
beforeEach(() => {
  setLocale("en");
  bed = fakeRuntime();
  current.runtime = bed.runtime;
  bed.handlers["policy.getSettings"] = () => ({ value: DEFAULT_POLICY_SETTINGS, revision: 2 });
  bed.handlers["policy.setSettings"] = () => ({ revision: 3 });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});
const methods = () => bed.calls.map((call) => call.method).filter((method) => method.startsWith("policy."));
const localToolsWritten = () =>
  (bed.called("policy.setSettings")[0]?.params as { value: { localTools: unknown } }).value.localTools;

describe("Mark as local on the card of the asked tool", () => {
  it("saves the asked tool's rule on an untainted card, clears no mark and leaves the question open", async () => {
    const page = await show(dialog());
    await click(button(page, "Mark as local tool"));
    expect(text(page)).toContain(`todo · source ${todoRule.source}`);
    expect(text(page)).not.toContain("This session's mark will be cleared.");
    await click(button(page, "Mark as local"));
    await settle();
    expect(methods()).toEqual(["policy.getSettings", "policy.setSettings"]);
    expect(localToolsWritten()).toEqual([todoRule]);
    expect(bed.called("sessions.respondDialog")).toEqual([]);
    expect(text(page)).toContain("Marked as local. This question still needs your answer.");
  });

  it("offers the asked tool alone when a cause of the taint is not markable, and clears no mark", async () => {
    const page = await show(
      dialog({ tainted: true, taintCauses: { list: [cause("web_search", false)], older: 0 } }),
    );
    await click(button(page, "Mark as local tool"));
    await click(button(page, "Mark as local"));
    await settle();
    expect(localToolsWritten()).toEqual([todoRule]);
    expect(bed.called("policy.clearTaint")).toEqual([]);
  });

  it("saves the causes and the asked tool together, then clears the mark, when every cause is markable", async () => {
    const page = await show(
      dialog({ tainted: true, taintCauses: { list: [cause("plan", true)], older: 0 } }),
    );
    await click(button(page, "Mark as local tool"));
    expect(text(page)).toContain("This session's mark will be cleared.");
    await click(button(page, "Mark as local"));
    await settle();
    expect(localToolsWritten()).toEqual([{ tool: "plan", source: "/x/ext/plan.ts" }, todoRule]);
    expect(bed.called("policy.clearTaint")[0]?.params).toEqual({ sessionId: "sess-1" });
  });

  it("is not offered without the rule, nor on a card that has no session", async () => {
    expect(hasButton(await show(dialog({ localTool: undefined })), "Mark as local tool")).toBe(false);
    await mounted?.unmount();
    mounted = await mount(<DialogList sessionId="" dialogs={[dialog()]} hidden={0} />);
    await settle();
    expect(hasButton(mounted.container, "Mark as local tool")).toBe(false);
  });
});
