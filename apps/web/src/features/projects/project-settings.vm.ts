import { AgentResources, type ProjectBoxView, ProjectHosts } from "@pap/contracts";
import type { MessageKey } from "../../i18n/index.ts";

/** The settings as typed: whole numbers (memory and disk in MiB) and one host per line. */
export interface SettingsDraft {
  readonly memoryMb: string;
  readonly cpus: string;
  readonly diskMb: string;
  readonly hosts: string;
}

export const draftOf = (box: ProjectBoxView): SettingsDraft => ({
  memoryMb: String(box.resources.memoryMb),
  cpus: String(box.resources.cpus),
  diskMb: String(box.resources.diskMb),
  hosts: box.hosts.join("\n"),
});

export type Built =
  | {
      readonly ok: true;
      readonly resources: AgentResources;
      readonly hosts: readonly string[];
    }
  | { readonly ok: false; readonly errors: Readonly<Partial<Record<string, MessageKey>>> };

const numberOrNaN = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text));
const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/**
 * What `projects.setBox` is given, judged by the contract's own schemas. The disk can only be enlarged: a value below the
 * saved one is refused here and never sent.
 */
export function toSetBox(draft: SettingsDraft, savedDiskMb: number): Built {
  const errors: Partial<Record<string, MessageKey>> = {};
  const resources = AgentResources.safeParse({
    memoryMb: numberOrNaN(draft.memoryMb),
    cpus: numberOrNaN(draft.cpus),
    diskMb: numberOrNaN(draft.diskMb),
  });
  if (!resources.success) {
    for (const issue of resources.error.issues)
      errors[`resources.${String(issue.path[0])}`] = "agentVm.error.number";
  } else if (resources.data.diskMb < savedDiskMb) {
    errors["resources.diskMb"] = "agentVm.error.diskShrink";
  }
  const hosts = ProjectHosts.safeParse(lines(draft.hosts));
  if (!hosts.success) errors["hosts"] = "boxes.hosts.error";
  if (!resources.success || !hosts.success || errors["resources.diskMb"] !== undefined)
    return { ok: false, errors };
  return { ok: true, resources: resources.data, hosts: hosts.data };
}
