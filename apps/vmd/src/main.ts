import { createSystemClock } from "./clock.ts";
import { CONFIG_PATH, loadVmdConfig } from "./config.ts";
import { createExec } from "./exec.ts";
import { createLocks, createRoomCheck } from "./locks.ts";
import { createStderrLogger } from "./log.ts";
import { unavailableNet } from "./net-unavailable.ts";
import { BUNDLE_ROOT, createOps, VMD_VERSION, VOLUME_ROOT } from "./ops.ts";
import { createVmdServer } from "./server.ts";
import { createState } from "./state.ts";

const SOCKET_PATH = "/run/pap-vm/vmd.sock";
const DEFAULT_MIN_FREE_MB = 1024;

function minFreeMb(): number {
  const value = Number(process.env.PAP_MIN_FREE_DISK_MB ?? DEFAULT_MIN_FREE_MB);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_MIN_FREE_MB;
}

/** pap-vmd's entry (root): the state folder, the operations, the server. T16a replaces `unavailableNet` and calls `restore()`. */
async function main(): Promise<void> {
  const config = loadVmdConfig(CONFIG_PATH);
  const clock = createSystemClock();
  const log = createStderrLogger();
  const state = createState({ root: `/var/lib/pap-vm/${config.papUid}`, clock, log });
  state.ensure();
  const ops = createOps({
    exec: createExec(),
    net: unavailableNet,
    state,
    locks: createLocks(),
    room: createRoomCheck({ freeMb: () => state.freeMb(), minFreeMb: minFreeMb() }),
    clock,
    log,
    papUid: config.papUid,
    papHome: config.papHome,
    bundleRoot: BUNDLE_ROOT,
    bundleUid: 0,
    volumeRoot: VOLUME_ROOT,
    version: VMD_VERSION,
  });
  // Task disks of VMs that no longer exist are swept; if nerdctl cannot say which exist, none is touched (fails closed).
  state.sweepAtStart(await ops.runningTasks().catch(() => null));
  const stopPurge = state.startDailyPurge();
  const server = createVmdServer({
    socketPath: SOCKET_PATH,
    papUid: config.papUid,
    papGid: config.papGid,
    handle: (request) => ops.handle(request),
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
