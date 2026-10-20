// @vitest-environment happy-dom
import "../register-session-catalog.ts";
import type { Dialog } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../../runtime/index.ts";
import { button, click, mount, press, settle, type Mounted } from "../../../testing/dom.ts";
import { fakeRuntime } from "../../../testing/runtime-bed.ts";
import { DialogList } from "./DialogList.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
let mounted: Mounted | null = null;
beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const card = (over: Partial<Dialog> = {}): Dialog => ({
  id: "a1",
  method: "approval",
  category: "exec",
  title: "Run a command?",
  message: "1 line\nbash: pnpm test --watch",
  answers: ["deny", "session", "always", "once"],
  tool: "bash",
  alwaysScopes: { prefix: ["pnpm", "test"] },
  ...over,
});
async function show(dialog: Dialog) {
  mounted = await mount(<DialogList sessionId="sess-1" dialogs={[dialog]} hidden={0} />);
  await settle();
  return mounted.container;
}
const radios = (page: HTMLElement) => [...page.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
const nameOf = (radio: HTMLInputElement) => radio.closest("label")?.textContent?.trim();
const choose = (page: HTMLElement, name: string) => {
  const found = radios(page).find((radio) => nameOf(radio) === name);
  if (!found) throw new Error(`no scope "${name}" among ${radios(page).map(nameOf).join(", ")}`);
  return found;
};
const sent = () =>
  bed.called("sessions.respondDialog").map((call) => (call.params as { response: unknown }).response);

describe("the scope of an Always answer (M7R26)", () => {
  it("offers the exact command and the prefix, the exact one chosen, in a named group", async () => {
    const page = await show(card());
    expect(radios(page).map(nameOf)).toEqual(["This exact command", "Commands starting with pnpm test"]);
    expect(radios(page).map((radio) => radio.checked)).toEqual([true, false]);
    const group = page.querySelector('[role="radiogroup"]');
    expect(group?.getAttribute("aria-label")).toBe("What Always covers");
    expect(radios(page).every((radio) => radio.name === radios(page)[0]?.name)).toBe(true);
  });

  it("sends the prefix scope with Always once the person chose it", async () => {
    const page = await show(card());
    await click(choose(page, "Commands starting with pnpm test"));
    expect(choose(page, "Commands starting with pnpm test").checked).toBe(true);
    await click(button(page, "Always"));
    await settle();
    expect(sent()).toEqual([{ answer: "always", scope: "prefix" }]);
  });

  it("sends a plain Always when the exact command stays chosen", async () => {
    const page = await show(card());
    await click(button(page, "Always"));
    await settle();
    expect(sent()).toEqual([{ answer: "always" }]);
  });

  it("offers a tool rule by the tool's name and sends the tool scope", async () => {
    const page = await show(
      card({
        category: "external-write",
        tool: "mcp__fix__write",
        alwaysScopes: { tool: true, toolSource: "mcp" },
      }),
    );
    expect(radios(page).map(nameOf)).toEqual(["This exact call", "Any input to mcp__fix__write"]);
    await click(choose(page, "Any input to mcp__fix__write"));
    await click(button(page, "Always"));
    await settle();
    expect(sent()).toEqual([{ answer: "always", scope: "tool" }]);
  });

  it("never sends a scope with any answer but Always, whatever was chosen", async () => {
    const page = await show(card());
    await click(choose(page, "Commands starting with pnpm test"));
    await click(button(page, "Allow once"));
    await settle();
    expect(sent()).toEqual([{ answer: "once" }]);
  });

  it("shows no choice for a card that offered none, or that has no Always", async () => {
    const plain = await show(card({ alwaysScopes: undefined }));
    expect(radios(plain)).toEqual([]);
    await mounted?.unmount();
    const noAlways = await show(card({ answers: ["deny", "once"] }));
    expect(radios(noAlways)).toEqual([]);
  });

  it("keeps the choice reachable with the keyboard and at least 44 px tall on a touch screen", async () => {
    const page = await show(card());
    for (const radio of radios(page)) {
      expect(radio.closest("label")?.className).toContain("pointer-coarse:min-h-11");
      expect(radio.tabIndex).not.toBe(-1);
    }
    const moved = await press(radios(page)[0] as HTMLInputElement, { key: "ArrowDown" });
    expect(moved.defaultPrevented).toBe(false);
  });

  it("renders the offered words as text, without invisible characters", async () => {
    const page = await show(card({ alwaysScopes: { prefix: ["pnpm", "te‮st"] } }));
    expect(radios(page).map(nameOf)[1]).toBe("Commands starting with pnpm test");
    expect(page.querySelector("img, b")).toBeNull();
  });
});

describe("the card of a VM session (AVM-E33, AVM-E18)", () => {
  // Mutant: the card ignores `vm` -> "hides Always" fails.
  it("hides Always and its scope choice, and keeps the other answers", async () => {
    const page = await show(card({ vm: true }));
    const names = [...page.querySelectorAll("button")].map((el) => el.textContent?.trim());
    expect(names).not.toContain("Always");
    expect(names).toEqual(expect.arrayContaining(["Allow once"]));
    expect(radios(page)).toEqual([]);
  });

  it("still shows Always when the record has no vm flag (it reads as false)", async () => {
    const page = await show(card());
    expect([...page.querySelectorAll("button")].map((el) => el.textContent?.trim())).toContain("Always");
  });
});
