import "../register-catalog.ts";
import { ProviderInput } from "@pap/contracts";
import { vi } from "vitest";
import { button, click, field, hasButton, mount, settle, typeInto } from "../../../testing/dom.ts";
import { current, newBed, stepUp } from "../models-bed.tsx";
import type { StepUpRunner } from "../step-up.ts";
import { ProviderForm } from "./ProviderForm.tsx";

export { current };
export const REVISION = "a".repeat(64);
export const NEXT_REVISION = "b".repeat(64);

export const MINE = ProviderInput.parse({
  id: "mine",
  name: "Mine",
  api: "openai-completions",
  baseUrl: "https://api.example.com/v1",
  auth: { kind: "stored" },
  headers: [
    { name: "X-Org", value: { kind: "keep" } },
    { name: "X-Team", value: { kind: "env", name: "TEAM" } },
  ],
  models: [{ id: "m1", name: "M one", contextWindow: 128000 }],
});

/** A runtime whose `models.provider.get` answers `get` and whose `models.provider.save` answers `save`. */
export function formBed(
  // A new provider is not in the file yet; one that has an id (after the save) is.
  get: (params: { id?: string }) => unknown = (params) =>
    params.id === undefined
      ? { editable: false, reason: "not_in_file", revision: REVISION }
      : editableMine({ revision: NEXT_REVISION }),
  save: (params: unknown) => unknown = () => ({ revision: NEXT_REVISION, enabledModelsSynced: true }),
) {
  const bed = newBed();
  bed.handlers["models.provider.get"] = (params) => get(params as { id?: string });
  bed.handlers["models.provider.save"] = save;
  return bed;
}

export const editableMine = (over: Record<string, unknown> = {}) => ({
  editable: true,
  provider: MINE,
  revision: REVISION,
  advanced: false,
  ...over,
});

export function phone(on: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: on && query.includes("max-width"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

export const newSpies = (): Spies => ({
  closed: [],
  saved: [],
  keyStored: [],
  commented: [],
  raw: [],
  finished: [],
  removed: [],
});

export interface Spies {
  readonly closed: number[];
  readonly saved: Array<{ id: string; stored: boolean }>;
  readonly keyStored: string[];
  readonly commented: boolean[];
  readonly raw: Array<string | null>;
  readonly finished: string[];
  readonly removed: string[];
}

export const MINE_SECRET_HEADER = {
  ...MINE,
  headers: [{ name: "X-Api-Key", value: { kind: "keep" as const } }],
};

export function formElement(
  target: { id?: string },
  over: { existing?: string[]; builtin?: string[]; stepUp?: StepUpRunner } = {},
  spies: Spies = newSpies(),
) {
  return (
    <ProviderForm
      target={target}
      existingIds={new Set(over.existing ?? ["taken"])}
      builtinIds={new Set(over.builtin ?? ["anthropic", "openrouter"])}
      stepUp={over.stepUp ?? stepUp}
      onClose={() => spies.closed.push(1)}
      onSaved={(id, stored) => spies.saved.push({ id, stored })}
      onFinished={(id) => spies.finished.push(id)}
      onKeyStored={(id) => spies.keyStored.push(id)}
      onRemoved={(id) => spies.removed.push(id)}
      onOrphanKey={() => {}}
      onCommented={(blocked) => spies.commented.push(blocked)}
      onDirty={() => {}}
      onRawEditor={(id) => spies.raw.push(id)}
    />
  );
}

export async function showForm(
  target: { id?: string } = {},
  over: { existing?: string[]; builtin?: string[]; stepUp?: StepUpRunner } = {},
) {
  const spies = newSpies();
  const page = await mount(formElement(target, over, spies));
  return { page, spies };
}

export const OLLAMA = "Ollama (this machine)";
export const CUSTOM = "Custom";

export async function openNew(over?: Parameters<typeof formBed>[0]) {
  const bed = formBed(over);
  const shown = await showForm();
  await settle();
  return { bed, ...shown };
}
export const pick = (container: ParentNode, name: string) => click(button(container, name));
export async function validCustom(container: ParentNode) {
  if (hasButton(container, CUSTOM)) await pick(container, CUSTOM);
  await typeInto(field(container, "Identifier") as HTMLInputElement, "mine");
  await typeInto(field(container, "Base URL") as HTMLInputElement, "https://api.example.com/v1");
  await click(button(container, "Add a model"));
  await typeInto(field(container, "Model id") as HTMLInputElement, "m1");
}
