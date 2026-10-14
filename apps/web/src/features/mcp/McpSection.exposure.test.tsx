// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { button, click, settle, text } from "../../testing/dom.ts";
import { CWD, current, newBed, overviewOf, PROJECT_FILE, rowButton, show } from "./mcp-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
// Radix Select needs pointer events happy-dom lacks: a native select stands in for it.
vi.mock("@pap/ui", async (importOriginal) => {
  const original = await importOriginal<typeof import("@pap/ui")>();
  const { createElement } = await import("react");
  return {
    ...original,
    Select: (props: {
      label: string;
      value: string;
      options: ReadonlyArray<{ value: string; label: string }>;
      disabled?: boolean;
      onChange(value: string): void;
    }) =>
      createElement(
        "select",
        {
          "aria-label": props.label,
          value: props.value,
          disabled: props.disabled,
          onChange: (event: { target: { value: string } }) => props.onChange(event.target.value),
        },
        props.options.map((option) =>
          createElement("option", { key: option.value, value: option.value }, option.label),
        ),
      ),
  };
});

async function choose(select: HTMLSelectElement, value: string) {
  const { act } = await import("react");
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const exposure = (container: ParentNode) =>
  container.querySelector('select[aria-label="Exposure"]') as HTMLSelectElement;

describe("exposure", () => {
  it("sends a global change at once, without a confirmation", async () => {
    const bed = newBed();
    const page = await show();
    await settle();
    await click(rowButton(page.container, "global/fs"));
    await choose(exposure(page.container), "hidden");
    await settle();
    expect(bed.called("mcp.setExposure").map((call) => call.params)).toEqual([
      { scope: "global", name: "fs", exposure: "hidden", cwd: CWD },
    ]);
  });

  it("asks 'Save anyway?' for a project server, and Save sends confirmProtected", async () => {
    const bed = newBed(overviewOf());
    const page = await show();
    await settle();
    await click(rowButton(page.container, "project/local"));
    await choose(exposure(page.container), "deferred");
    expect(text(page.container)).toContain(`This changes ${PROJECT_FILE}`);
    expect(bed.called("mcp.setExposure")).toHaveLength(0);
    await click(button(page.container, "Save"));
    await settle();
    expect(bed.called("mcp.setExposure").map((call) => call.params)).toEqual([
      { scope: "project", name: "local", exposure: "deferred", cwd: CWD, confirmProtected: true },
    ]);
  });
});
