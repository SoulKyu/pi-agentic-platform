// @vitest-environment happy-dom
import "../register-session-catalog.ts";
import type { Dialog } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../i18n/index.ts";
import type { Runtime } from "../../../runtime/index.ts";
import { button, click, mount, settle, type Mounted } from "../../../testing/dom.ts";
import { fakeRuntime } from "../../../testing/runtime-bed.ts";
import { DialogList } from "./DialogList.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const HOST = "xn--bcher-kva.example";
const request = (over: Partial<Dialog> = {}): Dialog => ({
  id: "n1",
  method: "approval",
  category: "exec",
  title: "Reach a host?",
  message: "1 line\nnetwork_request",
  answers: ["deny", "host"],
  host: HOST,
  ...over,
});

let bed: ReturnType<typeof fakeRuntime>;
let mounted: Mounted | null = null;
async function show(dialog: Dialog) {
  mounted = await mount(<DialogList sessionId="sess-1" dialogs={[dialog]} hidden={0} />);
  await settle();
  return mounted.container;
}

beforeEach(() => {
  setLocale("en");
  bed = fakeRuntime();
  current.runtime = bed.runtime;
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

describe("ApprovalCardFor on a network_request card (owner a2)", () => {
  it("labels the host answer and shows the whole ASCII host on a line of its own", async () => {
    const page = await show(request());
    expect([...page.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Deny",
      "Allow this host for this thread",
    ]);
    const line = page.querySelector("[data-approval-host]");
    expect(line?.textContent).toBe(`Host: ${HOST}`);
    expect(line?.className).toContain("font-mono");
    expect(line?.className).toContain("break-all");
    expect(line?.hasAttribute("title")).toBe(false);
  });

  it("sends the host answer", async () => {
    const page = await show(request());
    await click(button(page, "Allow this host for this thread"));
    await settle();
    expect(bed.called("sessions.respondDialog").map((call) => call.params)).toEqual([
      { sessionId: "sess-1", dialogId: "n1", response: { answer: "host" } },
    ]);
  });

  it("speaks French", async () => {
    setLocale("fr");
    const page = await show(request());
    expect(button(page, "Autoriser cet hôte pour ce fil")).toBeTruthy();
    expect(page.querySelector("[data-approval-host]")?.textContent).toBe(`Hôte\u202f: ${HOST}`);
  });

  it("has no host line on a card without a host", async () => {
    const page = await show(request({ answers: ["deny", "once"], host: undefined }));
    expect(page.querySelector("[data-approval-host]")).toBeNull();
  });
});
