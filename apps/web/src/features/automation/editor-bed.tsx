import {
  TriggerInput,
  type DryRunResult,
  type FireView,
  type ProjectSummary,
  type TriggerView,
} from "@pap/contracts";
import { useState, type ReactNode } from "react";
import "../../i18n/register-automation-trigger.ts";
import { EMPTY_SHELL } from "../../stores/shell-reducer.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { NOW } from "./board-bed.tsx";
import type { Draft } from "./editor.vm.ts";

export const SECRET = `pwh_${"A".repeat(43)}`;

const SAVED = TriggerInput.parse({
  name: "prod-alerts",
  enabled: true,
  source: { type: "webhook", format: "alertmanager", auth: "secret" },
  execution: { cwd: "/work/atlas", tools: ["read", "grep"] },
  prompt: "Investigate the alert.\n{{payload}}",
});

/** A saved webhook trigger as `automation.triggers.get` answers it. */
export const viewOf = (over: Partial<TriggerView> = {}): TriggerView => ({
  id: "g1",
  name: SAVED.name,
  enabled: SAVED.enabled,
  state: "ok",
  source: SAVED.source,
  execution: SAVED.execution,
  prompt: SAVED.prompt,
  projectId: "p1",
  cwd: "/work/atlas",
  revision: 3,
  createdAt: NOW,
  updatedAt: NOW,
  webhookUrl: "https://pap.home.arpa/hooks/g1",
  secretRotatedAt: NOW,
  nextFireAt: null,
  lastFireAt: null,
  redacted: false,
  ...over,
});

export const fireOf = (over: Partial<FireView> = {}): FireView => ({
  id: 10,
  firstAt: NOW - 60_000,
  at: NOW - 60_000,
  count: 1,
  source: "webhook",
  verdict: "fired",
  detail: "HighMemory · api-7f9c",
  taskId: "tsk_41aaaaaaaaaa",
  taskState: "done",
  durationMs: 220_000,
  costUsd: 0.21,
  ...over,
});

export const dryRunOf = (over: Partial<DryRunResult> = {}): DryRunResult => ({
  verdict: "fire",
  reasons: [],
  tools: ["read", "grep"],
  profile: { preset: "read-only", mode: "supervised", tainted: true, editsUnasked: false },
  cwd: "/work/atlas",
  prompt: "Investigate.",
  precheck: null,
  budget: { spentUsd: 1.84, budgetUsd: 5 },
  tokens: "none",
  feed: null,
  ...over,
});

export const knowProject = (project: ProjectSummary) =>
  useShellStore.setState({
    view: { ...EMPTY_SHELL, loaded: true, projects: new Map([[project.id, project]]) },
  });

/** A form's state for a section tested on its own. */
export function DraftHarness({
  initial,
  children,
}: {
  readonly initial: Draft;
  children(draft: Draft, set: (patch: Partial<Draft>) => void): ReactNode;
}) {
  const [draft, setDraft] = useState(initial);
  return <>{children(draft, (patch) => setDraft((previous) => ({ ...previous, ...patch })))}</>;
}

/** The label of the item that is on in a Segmented group (`aria-label`). */
export function segmentOn(container: ParentNode, label: string): string | null {
  const group = [...container.querySelectorAll('[role="group"], [data-slot="segmented"]')].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  return group?.querySelector('[data-state="on"]')?.textContent ?? null;
}
