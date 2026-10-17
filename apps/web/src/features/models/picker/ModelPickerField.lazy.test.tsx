// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../../runtime/index.ts";
import { click, mount, text } from "../../../testing/dom.ts";
import { fakeRuntime } from "../../../testing/runtime-bed.ts";
import { ModelPickerField } from "./ModelPickerField.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

// The list chunk is gone (a tab open across a pap update) until `chunk.gone` is switched off.
const chunk = vi.hoisted(() => ({ gone: true, loads: 0 }));
vi.mock("./ModelList.tsx", async (importOriginal) => {
  chunk.loads += 1;
  if (chunk.gone)
    throw new TypeError("Failed to fetch dynamically imported module: /assets/ModelList-old.js");
  return importOriginal();
});

const toasts = vi.hoisted(() => [] as Array<{ message: string; action?: { label: string } }>);
vi.mock("@pap/ui", async (original) => ({
  ...(await original<typeof import("@pap/ui")>()),
  toast: (input: { message: string; action?: { label: string } }) => toasts.push(input),
}));
const issues = vi.hoisted(() => [] as string[]);
vi.mock("../../../lib/report.ts", () => ({ reportClientIssue: (code: string) => issues.push(code) }));

beforeAll(async () => {
  await import("@pap/ui/overlays");
}, 60_000);
beforeEach(() => {
  const bed = fakeRuntime();
  bed.handlers["models.available"] = () => ({
    models: [{ provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: false }],
    providers: [{ id: "openai", name: "OpenAI" }],
    origin: "signed-in",
    truncated: false,
  });
  current.runtime = bed.runtime;
});
afterEach(() => {
  toasts.length = 0;
  issues.length = 0;
});

describe("ModelPickerField lazy failure", () => {
  it("field.lazy-failure: a gone chunk says to reload, closes, and the next press imports again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const page = await mount(<ModelPickerField label="Model" value={null} cwd={null} onChange={() => {}} />);
    const trigger = () => page.container.querySelector("button") as HTMLButtonElement;
    await click(trigger());
    await act(async () => {
      await vi.waitFor(() => expect(toasts).toHaveLength(1), { timeout: 10_000 });
    });
    expect(issues).toEqual(["lazy_chunk_failed"]);
    expect(toasts[0]?.message).toBe(
      "This part of pap did not load. pap may have been updated: reload the page.",
    );
    expect(toasts[0]?.action?.label).toBe("Reload");
    expect(document.querySelector('[data-slot="popover"]')).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    const loadsBefore = chunk.loads;

    chunk.gone = false;
    await click(trigger());
    await vi.waitFor(
      async () => {
        await act(async () => {});
        expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
      },
      { timeout: 10_000 },
    );
    expect(chunk.loads).toBeGreaterThan(loadsBefore);
    expect(text(document.body)).toContain("GPT-5");
    chunk.gone = true;
  });
});
