import type { ExtensionProviders } from "@pap/contracts";
import { act } from "react";
import { afterEach, beforeAll, beforeEach, expect, type Mock, vi } from "vitest";
import { setLocale } from "../../../i18n/index.ts";
import type { Runtime } from "../../../runtime/index.ts";
import { button, click, type Mounted, mount, press, settle } from "../../../testing/dom.ts";
import { fakeRuntime } from "../../../testing/runtime-bed.ts";
import { forgetExtensions } from "../extension-read.ts";
import { ModelPickerField, type ModelPickerFieldProps } from "./ModelPickerField.tsx";

// The picker's extension tests (`PickerList.*.test.tsx`): the answers, the field and the steps they share. Each test
// file mocks `getRuntime` over its own hoisted slot and the router's Link itself (a mock lives in the file that needs it).
export const SHOW = "Show models added by extensions";
/** The field's own label: test data, not UI text. */
const FIELD_LABEL = "Model";
export const available = {
  models: [{ provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4", reasoning: true }],
  providers: [{ id: "anthropic", name: "Anthropic" }],
  // Pi's own providers without extensions, offered or not: openai is signed out here.
  providerIds: ["anthropic", "openai"],
  origin: "signed-in",
  truncated: false,
};
export const row = (id: string, offered = true, name = id) => ({
  provider: "claude-bridge",
  id,
  name,
  reasoning: true,
  offered,
  enabled: offered,
});
export const answer = (over: Partial<ExtensionProviders> = {}): ExtensionProviders => ({
  providers: [
    {
      id: "claude-bridge",
      name: "Claude bridge",
      models: [row("claude-opus-4", true, "Opus via bridge"), row("claude-haiku-4", false)],
      modelsTruncated: false,
    },
  ],
  truncated: false,
  failed: false,
  ...over,
});

let bed: ReturnType<typeof fakeRuntime>;
/** The fake daemon of the current test. */
export const daemon = () => bed;

/** The hooks every picker extension test file runs: a fresh fake daemon in `slot`, and a fresh tab after each test. */
export function setUpPickerBed(slot: { runtime: Runtime | undefined }): void {
  beforeAll(async () => {
    // The first transform of the overlay and list chunks is slow: pay it here, not inside a test.
    await import("./PickerList.tsx");
    await import("@pap/ui/overlays");
  }, 60_000);
  beforeEach(() => {
    bed = fakeRuntime();
    bed.handlers["models.available"] = () => available;
    bed.handlers["models.extensions"] = () => answer();
    slot.runtime = bed.runtime;
  });
  afterEach(() => {
    setLocale("en");
    forgetExtensions();
  });
}

export const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
export const search = () => document.querySelector<HTMLInputElement>('[role="combobox"]') as HTMLInputElement;
export const groupOf = (provider: string) =>
  document.querySelector<HTMLElement>(`[data-extension-group="${provider}"]`);
export const extensionCalls = () => bed.called("models.extensions").length;

export async function field(
  value: { provider: string; modelId: string } | null = null,
  onChange: Mock = vi.fn(),
  extra: Partial<ModelPickerFieldProps> = {},
): Promise<{ page: Mounted; onChange: Mock }> {
  const page = await mount(
    <ModelPickerField label={FIELD_LABEL} value={value} cwd={null} onChange={onChange} {...extra} />,
  );
  return { page, onChange };
}
export async function openPicker(page: { container: HTMLElement }) {
  await click(page.container.querySelector("button") as HTMLButtonElement);
  await act(async () => {
    await vi.waitFor(() => expect(options().length).toBeGreaterThan(0), { timeout: 10_000 });
  });
}
export async function close() {
  await press(document.activeElement ?? document.body, { key: "Escape" });
  await vi.waitFor(() => expect(document.querySelector('[data-slot="popover"]')).toBeNull());
}
export async function showExtensions() {
  await click(button(document.body, SHOW));
  await settle();
}
