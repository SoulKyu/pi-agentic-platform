// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { button, click, hasButton, mount, settle, text } from "../../testing/dom.ts";
import { current, inShell, newBed } from "./lanes-bed.tsx";
import { ScriptLogDialog } from "./ScriptLogDialog.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const open = async (handler: (params: { offset: number }) => unknown) => {
  const bed = newBed();
  bed.handlers["lanes.scriptLog"] = (params) => handler(params as { offset: number });
  await mount(inShell(<ScriptLogDialog laneId="a-1a2b" onClose={() => {}} />));
  await settle();
  return bed;
};

describe("setup log", () => {
  it("reads the setup log from offset 0 and shows it as plain mono text", async () => {
    const bed = await open(() => ({
      text: "npm i\n<img src=x>‮evil",
      nextOffset: null,
      size: 20,
      capped: false,
    }));
    expect(bed.called("lanes.scriptLog")[0]?.params).toEqual({ laneId: "a-1a2b", kind: "setup", offset: 0 });
    const pre = document.querySelector("pre") as HTMLElement;
    expect(pre.textContent).toContain("npm i");
    expect(pre.textContent).toContain("<img src=x>");
    expect(pre.textContent).toContain("\\u202E");
    expect(pre.querySelector("img")).toBeNull();
    expect(hasButton(document.body, "Load more")).toBe(false);
  });

  it("loads more by offset until the end", async () => {
    const bed = await open(({ offset }) =>
      offset === 0
        ? { text: "first\n", nextOffset: 6, size: 11, capped: false }
        : { text: "second", nextOffset: null, size: 11, capped: false },
    );
    expect(text(document.body)).toContain("first");
    await click(button(document.body, "Load more"));
    await settle();
    expect(bed.called("lanes.scriptLog")[1]?.params).toEqual({ laneId: "a-1a2b", kind: "setup", offset: 6 });
    expect(document.querySelector("pre")?.textContent).toBe("first\nsecond");
    expect(hasButton(document.body, "Load more")).toBe(false);
  });

  it("says when the script wrote past what the log keeps", async () => {
    await open(() => ({ text: "x", nextOffset: null, size: 1, capped: true }));
    expect(text(document.body)).toContain("The script wrote more than the log keeps");
  });

  it("says when nothing was logged", async () => {
    await open(() => ({ text: "", nextOffset: null, size: 0, capped: false }));
    expect(text(document.body)).toContain("Nothing was logged");
  });

  it("shows a failed read with a way to try again", async () => {
    let fail = true;
    await open(() => {
      if (fail) throw new Error("x");
      return { text: "ok", nextOffset: null, size: 2, capped: false };
    });
    expect(text(document.body)).toContain("The log could not be read");
    fail = false;
    await click(button(document.body, "Try again"));
    await settle();
    expect(document.querySelector("pre")?.textContent).toBe("ok");
  });
});
