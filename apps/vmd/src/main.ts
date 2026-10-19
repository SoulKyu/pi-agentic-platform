import { createSystemClock } from "./clock.ts";
import { CONFIG_PATH, loadVmdConfig } from "./config.ts";
import { VmdFailure } from "./errors.ts";
import { createStderrLogger } from "./log.ts";
import { createVmdServer } from "./server.ts";
import { createState } from "./state.ts";

const SOCKET_PATH = "/run/pap-vm/vmd.sock";

/**
 * pap-vmd's entry (root): the server and the state folder. T13b composes the operations (`handle`), the locks and the net;
 * until then every request that passes validation answers `unavailable`. With no list of running VMs the start sweep keeps
 * every task disk.
 */
async function main(): Promise<void> {
  const config = loadVmdConfig(CONFIG_PATH);
  const clock = createSystemClock();
  const log = createStderrLogger();
  const state = createState({ root: `/var/lib/pap-vm/${config.papUid}`, clock, log });
  state.ensure();
  state.sweepAtStart(null);
  const stopPurge = state.startDailyPurge();
  const server = createVmdServer({
    socketPath: SOCKET_PATH,
    papUid: config.papUid,
    papGid: config.papGid,
    handle: () => Promise.reject(new VmdFailure("unavailable")),
    log,
    clock,
  });
  await server.listen();
  log.info("vmd_listening", { socket: SOCKET_PATH });
  const stop = (): void => {
    stopPurge();
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch((error: unknown) => {
  process.stderr.write(`pap-vmd: ${error instanceof Error ? error.message : "start failed"}\n`);
  process.exit(1);
});
