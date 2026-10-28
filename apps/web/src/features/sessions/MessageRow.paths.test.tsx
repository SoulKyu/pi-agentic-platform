// @vitest-environment happy-dom
import "./register-session-catalog.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFilesTarget } from "../../stores/files-target.ts";
import { useReplyPorts } from "../../stores/reply-ports.ts";
import type { Runtime } from "../../runtime/index.ts";
import { click, mount, type Mounted } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { MessageRow } from "./MessageRow.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => Promise.resolve() }));

let page: Mounted | null = null;
let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
  useFilesTarget.getState().reset();
  useReplyPorts.getState().reset();
  useReplyPorts.getState().register("s1", {
    scope: { base: "/w/p", roots: ["/w/p"], filesRoot: "/w/p", agentId: null },
    openFile: (path, line) => useFilesTarget.getState().push("/w/p", path, line),
  });
});
afterEach(async () => {
  await page?.unmount();
  page = null;
});

const agent = (text: string) => ({
  kind: "message" as const,
  key: "m",
  author: "agent" as const,
  text,
  thinking: "",
  entryId: null,
});
const partial = (text: string) => ({ kind: "partial" as const, key: "p", text, thinking: "" });
const links = () => document.querySelectorAll("button[data-path-link]");

describe("paths in a reply", () => {
  it("an agent reply links a path under the project root, and a click pushes the Files target", async () => {
    page = await mount(<MessageRow sessionId="s1" item={agent("Edit src/app.py:12 and /etc/passwd")} />);
    await vi.waitFor(() => expect(links()).toHaveLength(1), { timeout: 2_000 });
    expect(links()[0]?.getAttribute("aria-label")).toBe("Open src/app.py:12 in Files");
    await click(links()[0] as Element);
    expect(useFilesTarget.getState().targets["/w/p"]).toMatchObject({ path: "/w/p/src/app.py", line: 12 });
  });

  it("your own message links nothing", async () => {
    page = await mount(
      <MessageRow sessionId="s1" item={{ ...agent("Edit src/app.py"), author: "you" as const }} />,
    );
    expect(links()).toHaveLength(0);
    expect(page.container.textContent).toContain("src/app.py");
  });

  it("no RPC call is made while a reply with paths streams", async () => {
    const steps = [
      "Edit src/a",
      "Edit src/app.py",
      "Edit src/app.py:1",
      "Edit src/app.py:12 and",
      "Edit src/app.py:12 and README.md",
    ];
    page = await mount(<MessageRow sessionId="s1" item={partial(steps[0] ?? "")} />);
    for (const step of steps.slice(1))
      await page.rerender(<MessageRow sessionId="s1" item={partial(step)} />);
    await vi.waitFor(() => expect(links()).toHaveLength(2), { timeout: 2_000 });
    expect(bed.calls).toEqual([]);
  });
});
