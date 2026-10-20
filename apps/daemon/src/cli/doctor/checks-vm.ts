import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AGENT_NET } from "@pap/contracts";
import { VERSION } from "../../kernel/version.ts";
import {
  assessStack,
  createVmdClient,
  GATEWAY_ENDPOINT,
  ownerOf,
  realProcReader,
  RELAY_ENDPOINT,
  STACK_REASONS,
  type StackAssessment,
  VMD_SOCKET,
} from "../../modules/agent-vm/index.ts";
import { openNoWrite } from "../ops/schema-status.ts";
import type { Check, CheckResult, DoctorContext } from "./types.ts";

/** What the VM checks read from the machine. Tests replace these. */
export interface VmProbes {
  /** pap's own version: pap-vmd must run the same (R6). */
  readonly papVersion: string;
  /** `/dev/kvm` exists. */
  kvm(): boolean;
  /** `vmd.health` against pap's version; asked once per context. */
  stack(ctx: DoctorContext): Promise<StackAssessment>;
  /** The image tags pap-vmd holds, or null when it did not say. */
  images(ctx: DoctorContext): Promise<readonly string[] | null>;
  /** The worst case the agents' disks can take, and what the kept mirrors take now. */
  reserved(ctx: DoctorContext): { agentDisksMb: number; keptMirrorsMb: number };
  /** Who holds the gateway's and the relay's sockets on the bridge address (AVM-E49 M9b): the pid that holds each, and the relay's parent. */
  listeners(): ListenerFacts;
  /** The host firewalls that are active: `ufw`, `firewalld`. */
  firewalls(): readonly string[];
}

export interface ListenerFacts {
  readonly gateway: { readonly listening: boolean; readonly pid: number | null };
  readonly relay: {
    readonly listening: boolean;
    readonly pid: number | null;
    readonly parent: number | null;
  };
}

const MIN_FREE_DEFAULT_MB = 1024;
/** `DEFAULT_AGENT_RESOURCES.diskMb`: an agent whose profile names none. */
const DEFAULT_DISK_MB = 4096;
const KEPT_FILES_MAX = 10_000;
const SETUP = "sudo pap vm setup";

const asVm = (ctx: DoctorContext): boolean =>
  (ctx.unit === null ? ctx.env : ctx.unit.env).PAP_AGENTS_RUNTIME === "vm";

function floorOf(ctx: DoctorContext): number {
  const raw = (ctx.unit === null ? ctx.env : ctx.unit.env).PAP_MIN_FREE_DISK_MB;
  return raw !== undefined && /^\d{1,9}$/.test(raw) ? Number(raw) : MIN_FREE_DEFAULT_MB;
}

function agentDisksMb(ctx: DoctorContext): number {
  const dbPath = join(ctx.home, "state.db");
  if (!existsSync(dbPath)) return 0;
  let db: ReturnType<typeof openNoWrite> = null;
  try {
    db = openNoWrite(dbPath, ctx.lockHeld);
    const row = db
      ?.prepare(
        "SELECT COALESCE(SUM(COALESCE(json_extract(profile, '$.resources.diskMb'), ?)), 0) AS mb FROM agents",
      )
      .get(DEFAULT_DISK_MB) as { mb: number } | undefined;
    return row?.mb ?? 0;
  } catch {
    return 0;
  } finally {
    db?.close();
  }
}

/** The bytes of `<home>/agents/.mirrors/<agent>/replaced/*` (R14), in MiB, rounded up; links are not followed. */
function keptMirrorsMb(ctx: DoctorContext): number {
  const root = join(ctx.home, "agents", ".mirrors");
  let bytes = 0;
  let seen = 0;
  try {
    for (const agent of readdirSync(root)) {
      const kept = join(root, agent, "replaced");
      let names: string[];
      try {
        names = readdirSync(kept);
      } catch {
        continue;
      }
      for (const name of names) {
        if (++seen > KEPT_FILES_MAX) return Math.ceil(bytes / 1024 ** 2);
        const found = lstatSync(join(kept, name), { throwIfNoEntry: false });
        if (found?.isFile()) bytes += found.size;
      }
    }
  } catch {
    // no mirrors yet
  }
  return Math.ceil(bytes / 1024 ** 2);
}

export function defaultVmProbes(): VmProbes {
  const imagesOf = async (ctx: DoctorContext): Promise<readonly string[] | null> => {
    try {
      const answer = (await createVmdClient(VMD_SOCKET, ctx.clock).request({ op: "image.list" })) as {
        tags?: unknown;
      };
      return Array.isArray(answer.tags) ? answer.tags.filter((tag) => typeof tag === "string") : null;
    } catch {
      return null;
    }
  };
  return {
    papVersion: VERSION,
    kvm: () => {
      try {
        return statSync("/dev/kvm").isCharacterDevice();
      } catch {
        return false;
      }
    },
    stack: (ctx) => assessStack(createVmdClient(VMD_SOCKET, ctx.clock), VERSION),
    images: imagesOf,
    reserved: (ctx) => ({ agentDisksMb: agentDisksMb(ctx), keptMirrorsMb: keptMirrorsMb(ctx) }),
    listeners: () => {
      const proc = realProcReader();
      const gateway = ownerOf(proc, GATEWAY_ENDPOINT);
      const relay = ownerOf(proc, RELAY_ENDPOINT);
      return { gateway, relay: { ...relay, parent: relay.pid === null ? null : proc.parentOf(relay.pid) } };
    },
    firewalls: () => {
      const active: string[] = [];
      try {
        if (/^ENABLED=yes\s*$/im.test(readFileSync("/etc/ufw/ufw.conf", "utf8"))) active.push("ufw");
      } catch {
        // no ufw
      }
      if (existsSync("/run/firewalld/firewalld.pid")) active.push("firewalld");
      return active;
    },
  };
}

const NOT_VM: CheckResult = {
  status: "skip",
  detail: "PAP_AGENTS_RUNTIME is not vm: the agents run on the host",
};
const NO_VMD: CheckResult = { status: "skip", detail: "pap-vmd does not answer" };

/**
 * The agent VM stack (T18): one check per fact. They apply only when the unit (else the shell) sets `PAP_AGENTS_RUNTIME=vm`.
 * The root-only facts come from `vmd.health` (RT-40): doctor runs as pap's user and cannot read the ruleset or the root-owned
 * state folder. Every result that is not ok has a `fix`.
 */
export function makeVmChecks(probes: VmProbes): readonly Check[] {
  const stacks = new WeakMap<DoctorContext, Promise<StackAssessment>>();
  const stackOf = (ctx: DoctorContext): Promise<StackAssessment> => {
    let found = stacks.get(ctx);
    if (found === undefined) {
      found = probes.stack(ctx);
      stacks.set(ctx, found);
    }
    return found;
  };
  /** A check on the stack's `vmd.health` facts. */
  const onStack = (
    id: string,
    title: string,
    judge: (health: NonNullable<StackAssessment["health"]>, ctx: DoctorContext) => CheckResult,
  ): Check => ({
    id,
    title,
    async run(ctx) {
      if (!asVm(ctx)) return NOT_VM;
      const stack = await stackOf(ctx);
      return stack.health === null ? NO_VMD : judge(stack.health, ctx);
    },
  });
  return [
    {
      id: "vm.kvm",
      title: "KVM for the agents' VMs",
      async run(ctx) {
        if (!asVm(ctx)) return NOT_VM;
        return probes.kvm()
          ? { status: "ok", detail: "/dev/kvm exists" }
          : {
              status: "fail",
              detail: "/dev/kvm does not exist: the agents' VMs need hardware virtualization",
              fix: "enable nested virtualization on the host (docs/agents/install.md, Agent VMs)",
            };
      },
    },
    {
      id: "vm.vmd",
      title: "pap-vmd",
      async run(ctx) {
        if (!asVm(ctx)) return NOT_VM;
        const stack = await stackOf(ctx);
        if (stack.health === null) return { status: "fail", detail: STACK_REASONS.unreachable, fix: SETUP };
        return stack.health.version === probes.papVersion
          ? { status: "ok", detail: `pap-vmd ${stack.health.version} answers` }
          : {
              status: "fail",
              detail: STACK_REASONS.version(stack.health.version, probes.papVersion),
              fix: SETUP,
            };
      },
    },
    onStack("vm.stack", "pap's firewall table", (health) =>
      health.ruleset
        ? { status: "ok", detail: "pap-vmd has loaded its firewall table" }
        : { status: "fail", detail: STACK_REASONS.ruleset, fix: SETUP },
    ),
    onStack("vm.network", "The agents' bridge", (health) =>
      health.bridge
        ? { status: "ok", detail: `the bridge ${AGENT_NET.bridge} is up` }
        : { status: "fail", detail: STACK_REASONS.bridge, fix: SETUP },
    ),
    {
      id: "vm.images",
      title: "Agent images",
      async run(ctx) {
        if (!asVm(ctx)) return NOT_VM;
        if ((await stackOf(ctx)).health === null) return NO_VMD;
        const tags = await probes.images(ctx);
        if (tags === null)
          return {
            status: "warn",
            detail: "pap-vmd did not list its images",
            fix: "journalctl -u pap-vmd -n 20",
          };
        return tags.some((tag) => tag.startsWith("pap-agent-base-"))
          ? { status: "ok", detail: `${tags.length} agent image(s) built` }
          : {
              status: "info",
              detail: "no agent image is built yet: the first agent start builds it (a few minutes)",
              fix: "start an agent, or wait for it",
            };
      },
    },
    onStack("vm.disk", "Disk room for the agents' VMs", (health, ctx) => {
      // The disks are sparse: their sizes are the worst case, so a shortfall is a warning, not a failure.
      const { agentDisksMb, keptMirrorsMb } = probes.reserved(ctx);
      const floor = floorOf(ctx);
      const need = agentDisksMb + keptMirrorsMb + floor;
      return health.stateFreeMb >= need
        ? { status: "ok", detail: `${health.stateFreeMb} MB free for the agents' VMs (${need} MB reserved)` }
        : {
            status: "warn",
            detail: `${health.stateFreeMb} MB free for the agents' VMs; their disks (${agentDisksMb} MB) and kept mirrors (${keptMirrorsMb} MB) and the floor (${floor} MB) add up to ${need} MB`,
            fix: "free space under /var/lib/pap-vm, or lower the agents' disk sizes",
          };
    }),
    {
      id: "vm.listeners",
      title: "The sockets on the bridge address",
      async run(ctx) {
        if (!asVm(ctx)) return NOT_VM;
        const { gateway, relay } = probes.listeners();
        const where = `${AGENT_NET.host}:${AGENT_NET.gatewayPort} and :${AGENT_NET.relayPort}`;
        if (!gateway.listening && !relay.listening)
          return ctx.lockHeld
            ? {
                status: "warn",
                detail: `pap runs but nothing listens on ${where}`,
                fix: "journalctl --user -u pap -n 50",
              }
            : { status: "info", detail: `pap is not running: nothing listens on ${where}` };
        const foreign = (what: string): CheckResult => ({
          status: "fail",
          detail: `${what} is held by a process that is not pap's: the agents' VMs would reach it, never pap`,
          fix: `stop pap, find the holder (ss -ltnp 'sport = :${AGENT_NET.gatewayPort} or sport = :${AGENT_NET.relayPort}') and stop it`,
        });
        if (gateway.listening && gateway.pid === null)
          return foreign(`the gateway port ${AGENT_NET.gatewayPort}`);
        if (relay.listening && (relay.pid === null || relay.parent !== gateway.pid))
          return foreign(`the relay port ${AGENT_NET.relayPort}`);
        if (!relay.listening)
          return {
            status: "warn",
            detail: `the gateway listens but nothing listens on the relay port ${AGENT_NET.relayPort}: the agents' VMs cannot start`,
            fix: "journalctl --user -u pap -n 50 (relay_restart, relay_listener_foreign)",
          };
        return { status: "ok", detail: `${where} are held by pap's gateway and its relay` };
      },
    },
    {
      id: "vm.firewall",
      title: "Host firewall",
      async run(ctx) {
        if (!asVm(ctx)) return NOT_VM;
        const active = probes.firewalls();
        if (active.length === 0) return { status: "ok", detail: "neither ufw nor firewalld is active" };
        const fixes = active.map((name) =>
          name === "ufw"
            ? `sudo ufw allow in on ${AGENT_NET.bridge} to any port ${AGENT_NET.gatewayPort},${AGENT_NET.relayPort} proto tcp`
            : `sudo firewall-cmd --permanent --zone=trusted --add-interface=${AGENT_NET.bridge} && sudo firewall-cmd --reload`,
        );
        return {
          status: "warn",
          detail: `${active.join(" and ")} ${active.length === 1 ? "is" : "are"} active: it can drop the agents' VMs on ports ${AGENT_NET.gatewayPort} and ${AGENT_NET.relayPort} of ${AGENT_NET.bridge}`,
          fix: fixes.join("; "),
        };
      },
    },
  ];
}

export const CHECKS_VM: readonly Check[] = makeVmChecks(defaultVmProbes());
