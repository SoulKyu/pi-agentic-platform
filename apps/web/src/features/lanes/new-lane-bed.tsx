import type { IssueView, LanePreview, ProjectSummary } from "@pap/contracts";
import { act, type ComponentProps } from "react";
import { expect, type Mock, vi } from "vitest";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";
import { click, field, mount, press, settle, text, typeInto } from "../../testing/dom.ts";
import { inShell, newBed } from "./lanes-bed.tsx";
import { NewLaneDialog } from "./NewLaneDialog.tsx";

const oid = "a".repeat(40);
export const sha = (n: string) => n.repeat(64).slice(0, 64);
export const project: ProjectSummary = { id: "p1", root: "/w/proj", name: "proj", position: 1, sessions: 0 };
export const other: ProjectSummary = { id: "p2", root: "/w/other", name: "other", position: 2, sessions: 0 };
export const preview = (patch: Partial<LanePreview> = {}): LanePreview => ({
  repo: true,
  current: "main",
  refs: [
    { ref: "refs/heads/main", label: "main", oid, at: 2, inLineage: true },
    { ref: "refs/remotes/origin/main", label: "origin/main", oid, at: 2, inLineage: true },
    { ref: "refs/remotes/origin/theirs", label: "origin/theirs", oid, at: 1, inLineage: false },
  ],
  config: {
    found: true,
    error: null,
    warnings: [],
    branchPrefix: "pi/",
    waitForSetup: true,
    copy: [],
    link: [],
    scripts: [],
  },
  remote: { host: "github.com", path: "o/r" },
  forge: "github",
  ...patch,
});
export const issue: IssueView = {
  forge: "github",
  url: "https://github.com/o/r/issues/412",
  number: 412,
  title: "HighMemory on api pods after 1.18",
  body: '<img src=x onerror="alert(1)"> line two\nline three\nline four\nline five',
  state: "open",
  labels: ["bug"],
  truncated: false,
};
/** What `models.available` answers: only the models Pi would let a lane of this project use (MPR4). */
const available = {
  models: [{ provider: "anthropic", id: "sonnet", name: "Sonnet", reasoning: true }],
  providers: [{ id: "anthropic", name: "Anthropic" }],
  origin: "signed-in",
  truncated: false,
};

/** What the dialog called back with; `stepUp` runs the call under a fixed command id, as the shell's prompt would. */
export const calls: {
  closed: Mock<() => void>;
  created: Mock<(created: { laneIds: string[]; fanoutId: string | null }) => void>;
  stepUp: Mock<(run: (commandId: string) => Promise<unknown>) => Promise<unknown>>;
} = { closed: vi.fn(), created: vi.fn(), stepUp: vi.fn() };
export function resetCalls() {
  calls.closed = vi.fn();
  calls.created = vi.fn();
  calls.stepUp = vi.fn(async (run: (commandId: string) => Promise<unknown>) => run("step-cmd-1"));
}

export async function open(
  view: LanePreview = preview(),
  projects: ProjectSummary[] = [project],
  prefill: ComponentProps<typeof NewLaneDialog>["prefill"] = null,
) {
  const bed = newBed();
  bed.handlers["lanes.preview"] = () => view;
  bed.handlers["models.available"] = () => available;
  bed.handlers["lanes.create"] = () => ({ laneIds: ["fix-it-1a2b"], fanoutId: null });
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  const page = await mount(
    inShell(
      <StepUpContext.Provider value={calls.stepUp as unknown as StepUpRunner}>
        <NewLaneDialog
          projects={projects}
          initialProjectId={projects[0]?.id ?? null}
          prefill={prefill}
          onClose={calls.closed}
          onCreated={calls.created}
        />
      </StepUpContext.Provider>,
    ),
  );
  await settle();
  return { bed, page, trigger };
}
export const body = () => text(document.body);
export const say = async (label: string, value: string) => {
  await typeInto(field(document.body, label), value);
};
/** Pays the first transform of the picker's lazy chunks before a test, not inside it. */
export async function warmPicker() {
  await import("../models/picker/PickerList.tsx");
  await import("@pap/ui/overlays");
}
/** The trigger of the model picker of a lane, found by the label it is named with. */
export const modelField = (label: string) =>
  [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[data-slot="model-slots"] button[aria-haspopup="dialog"]',
    ),
  ].find((node) =>
    (node.getAttribute("aria-labelledby") ?? "")
      .split(" ")
      .some((id) => document.getElementById(id)?.textContent === label),
  ) as HTMLButtonElement;
export const modelRows = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
export async function openModelField(label: string) {
  await click(modelField(label));
  await act(async () => {
    await vi.waitFor(() => expect(modelRows().length).toBeGreaterThan(0), { timeout: 10_000 });
  });
}
export async function chooseModel(label: string, row: string) {
  await openModelField(label);
  const item = modelRows().find((node) => node.dataset.modelRow === row || node.textContent === row);
  if (item === undefined) throw new Error(`no model row ${row}`);
  await click(item);
  await settle();
}
export const select = (label: string) =>
  [...document.querySelectorAll('[role="combobox"]')].find((node) =>
    (node.getAttribute("aria-labelledby") ?? "")
      .split(" ")
      .some((id) => document.getElementById(id)?.textContent === label),
  ) as HTMLElement;
export async function openSelect(label: string) {
  await press(select(label), { key: "Enter" });
  await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull(), {
    timeout: 2000,
  });
}
export async function choose(label: string, option: string) {
  await openSelect(label);
  const item = [...document.querySelectorAll('[role="option"]')].find((node) => node.textContent === option);
  if (item === undefined) throw new Error(`no option ${option}`);
  await click(item);
  await settle();
}
