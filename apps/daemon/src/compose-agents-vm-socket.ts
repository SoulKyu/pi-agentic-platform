import { join } from "node:path";
import type { Logger } from "./kernel/logger.ts";
import type { Config } from "./kernel/config.ts";
import type { KataSeams } from "./compose-agents-vm-kata.ts";

/**
 * The Kata seams of a daemon. A scripted-provider daemon is a test: it must name its own pap-vmd (a fake client, or a socket
 * path under its temp dir via `PAP_TEST_VMD_SOCKET`). The real `/run/pap-vm/vmd.sock` stays out of reach of every test path,
 * because the boot stops every VM pap-vmd lists. A `--dev` daemon (a worktree's, with its own PAP_HOME) is the same case: it
 * dials nothing unless the developer opts in with `PAP_DEV_VMD=1`, so it never stops VMs it did not start.
 */
export function kataSeamsOf(
  config: Pick<Config, "testProviderScript" | "testVmdSocket" | "dev" | "devVmd" | "home">,
  seams: KataSeams | undefined,
): KataSeams {
  const named = seams?.client !== undefined || seams?.socket !== undefined;
  if (named) return seams ?? {};
  if (config.testProviderScript === null) {
    if (!config.dev || config.devVmd) return seams ?? {};
    return { ...seams, socket: join(config.home, "no-vmd.sock") };
  }
  if (config.testVmdSocket === null)
    throw new Error(
      "a test daemon (PAP_TEST_PROVIDER_SCRIPT) needs PAP_TEST_VMD_SOCKET: it never dials the real pap-vmd",
    );
  return { ...seams, socket: config.testVmdSocket };
}

/** A held proxy port is the gateway's case: 0 (unavailable, the boot goes on), never a throw; only the process backend throws. */
export async function startProxy(
  proxy: { start(): Promise<number> },
  kata: boolean,
  logger: Logger,
): Promise<number> {
  try {
    return await proxy.start();
  } catch (error) {
    if (!kata) throw error;
    logger.error("agent_vm_proxy_unavailable", { err: error });
    return 0;
  }
}
