import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { treeBundleOf, treeDigest } from "../../modules/agent-vm/index.ts";
import { openNoWrite } from "../ops/schema-status.ts";
import type { Check, DoctorContext } from "./types.ts";

/** What the skew checks read from the machine. Tests replace these. */
export interface SkewProbes {
  /** The digests of the bundle `pap vm setup` installed and of the one built with this pap; null when a folder cannot be read. */
  bundles(): { readonly installed: string | null; readonly tree: string | null };
  /** The agents whose thread file is outside the mirrors folder (made in host mode), by name. */
  hostMade(ctx: DoctorContext): readonly string[];
}

const INSTALLED_BUNDLE = "/opt/pap-vm/agent-bundle";
const SETUP = "sudo pap vm setup";

function digestOf(dir: string | null): string | null {
  try {
    return dir === null ? null : treeDigest(dir);
  } catch {
    return null;
  }
}

export function hostMadeAgents(ctx: DoctorContext): readonly string[] {
  const dbPath = join(ctx.home, "state.db");
  if (!existsSync(dbPath)) return [];
  let db: ReturnType<typeof openNoWrite> = null;
  try {
    db = openNoWrite(dbPath, ctx.lockHeld);
    const rows = (db
      ?.prepare(
        "SELECT a.name AS name, s.pi_path AS piPath FROM agents a JOIN sessions s ON s.id = a.thread_session_id ORDER BY a.name",
      )
      .all() ?? []) as Array<{ name: string; piPath: string | null }>;
    // A thread never prompted has no file yet (pi_path NULL): a healthy VM agent. A file outside the mirrors is the host's.
    const mirrors = `${join(ctx.home, "agents", ".mirrors")}${sep}`;
    return rows
      .filter((row) => row.piPath !== null && !row.piPath.startsWith(mirrors))
      .map((row) => row.name);
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

export function defaultSkewProbes(): SkewProbes {
  return {
    bundles: () => ({
      installed: digestOf(existsSync(INSTALLED_BUNDLE) ? INSTALLED_BUNDLE : null),
      tree: digestOf(treeBundleOf(import.meta.dirname)),
    }),
    hostMade: hostMadeAgents,
  };
}

/** The variable is gone (every agent is a VM): a unit or a shell that still sets it is told it is ignored. */
const runtimeVarSetIn = (ctx: DoctorContext): string[] => {
  const where: string[] = [];
  if (ctx.unit?.env.PAP_AGENTS_RUNTIME !== undefined) where.push("the unit");
  if (ctx.env.PAP_AGENTS_RUNTIME !== undefined) where.push("this shell");
  return where;
};

export function makeSkewChecks(probes: SkewProbes): readonly Check[] {
  return [
    {
      id: "vm.bundle",
      title: "The code inside the agents' VMs",
      async run() {
        const { installed, tree } = probes.bundles();
        if (tree === null)
          return {
            status: "info",
            detail: "this pap has no agent bundle of its own to compare: not checked",
          };
        if (installed === null)
          return {
            status: "warn",
            detail: "the agents' VM bundle is not installed or cannot be read",
            fix: SETUP,
          };
        return installed === tree
          ? { status: "ok", detail: "the installed bundle is the one built with this pap" }
          : {
              status: "warn",
              detail: "the code inside the agents' VMs is older than pap: a thread would refuse to open",
              fix: `run \`${SETUP}\`, then open the thread again`,
            };
      },
    },
    {
      id: "vm.hostMade",
      title: "Agents made in host mode",
      async run(ctx) {
        const names = probes.hostMade(ctx);
        return names.length === 0
          ? { status: "ok", detail: "every agent with a thread has its mirror" }
          : {
              status: "warn",
              detail: `${names.join(", ")}: made in host mode, delete it and create it again`,
              fix: "delete the agent in Settings › Agents, then create it again",
            };
      },
    },
    {
      id: "vm.runtimeVar",
      title: "PAP_AGENTS_RUNTIME",
      async run(ctx) {
        const where = runtimeVarSetIn(ctx);
        return where.length === 0
          ? { status: "ok", detail: "PAP_AGENTS_RUNTIME is not set" }
          : {
              status: "warn",
              detail: `PAP_AGENTS_RUNTIME is set in ${where.join(" and ")} and ignored: agents always run in microVMs`,
              fix: "remove PAP_AGENTS_RUNTIME from the unit's Environment lines and from the shell",
            };
      },
    },
  ];
}

export const CHECKS_VM_SKEW: readonly Check[] = makeSkewChecks(defaultSkewProbes());
