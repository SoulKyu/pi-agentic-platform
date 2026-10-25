// @vitest-environment happy-dom
import { TooltipProvider } from "@pap/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, type Mounted } from "../../../testing/dom.ts";
import CommandPalette from "./CommandPalette.tsx";

vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => ({ rpc: { call: vi.fn() } }),
}));

let page: Mounted | null = null;
afterEach(async () => {
  await page?.unmount();
  page = null;
});

describe("CommandPalette field", () => {
  it("the field shows its prompt as a placeholder and an agent bottom rule when focused", async () => {
    page = await mount(
      <TooltipProvider>
        <CommandPalette open onOpenChange={() => {}} items={[]} openSession={() => {}} />
      </TooltipProvider>,
    );
    const field = document.querySelector("input") as HTMLInputElement;
    expect(field.getAttribute("placeholder")).toBe(field.getAttribute("aria-label"));
    expect(field.getAttribute("placeholder")).toBeTruthy();
    expect(field.className).toContain("focus:border-agent");
  });
});
