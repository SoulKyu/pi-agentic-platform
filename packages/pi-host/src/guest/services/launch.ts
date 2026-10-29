import { randomBytes } from "node:crypto";
import type { VmLayout } from "@pap/contracts/pi-host";
import { bwrapVmArgv } from "../../vm-shell/argv.ts";
import { shellFixedEnv } from "../../vm-shell/ops.ts";
import { encodeSeccomp, shellSeccompProgram } from "../../vm-shell/seccomp.ts";

/** The image's bwrap and what T0a showed it can do as guest root: the values the daemon gives a worker's shell (`vm-launch.ts`). */
export const GUEST_BWRAP = "/usr/bin/bwrap";
/** The descriptor bwrap reads the filter from (`--seccomp 3`): the fourth `stdio` entry, as for the shell. */
export const SERVICE_SECCOMP_FD = 3;

export interface ServiceLaunchInput {
  readonly layout: VmLayout;
  /** The session's network, as the daemon read it from its own records: the service keeps exactly that (spec §5). */
  readonly network: boolean;
  readonly command: string;
  readonly port: number;
  /** The guest's proxy variables (`proxyEnv`), given to a networked service only. */
  readonly proxy: Readonly<Record<string, string>>;
}

export interface ServiceLaunch {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly filter: Buffer;
}

/** The service's environment: the proxy (networked only), then the shell's fixed names, which win, and `PORT`. No vault value. */
export const serviceEnv = (input: ServiceLaunchInput): Readonly<Record<string, string>> => ({
  ...(input.network ? input.proxy : {}),
  ...shellFixedEnv(input.layout),
  PORT: String(input.port),
});

/**
 * A preview service runs in the session shell's own sandbox (spec §5, §11): `bwrapVmArgv` builds its command line, the
 * same function the shell calls, with the shell's seccomp program, its fixed environment and its network setting. The only
 * differences are the guest keeping it running, its own overlay slot, `PORT`, and no vault value (the guest holds none).
 */
export function serviceLaunch(input: ServiceLaunchInput): ServiceLaunch {
  const argv = bwrapVmArgv(
    {
      bwrap: GUEST_BWRAP,
      layout: input.layout,
      slot: randomBytes(16).toString("hex"),
      rootView: "read-only",
      network: input.network,
    },
    input.command,
    SERVICE_SECCOMP_FD,
  );
  return { argv, env: serviceEnv(input), filter: encodeSeccomp(shellSeccompProgram()) };
}
