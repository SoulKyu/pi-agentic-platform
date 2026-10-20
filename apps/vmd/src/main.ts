import { createSystemClock } from "./clock.ts";
import { CONFIG_PATH, loadVmdConfig } from "./config.ts";
import { createExec } from "./exec.ts";
import { createLocks, createRoomCheck } from "./locks.ts";
import { createStderrLogger } from "./log.ts";
import { createRestoredNet } from "./net.ts";
import { BUNDLE_ROOT, createOps, VMD_VERSION, VOLUME_ROOT } from "./ops.ts";
import { createVmdServer } from "./server.ts";
import { createState } from "./state.ts";

const SOCKET_PATH = "/run/pap-vm/vmd.sock";
const DEFAULT_MIN_FREE_MB = 1024;

function minFreeMb(): number {
  const value = Number(process.env.PAP_MIN_FREE_DISK_MB ?? DEFAULT_MIN_FREE_MB);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_MIN_FREE_MB;
}

/** pap-vmd's entry (root): the state folder, the operations, the server. The net restores its guards before anything is served. */
async function main(): Promise<void> {
  const config = loadVmdConfig(CONFIG_PATH);
  const clock = createSystemClock();
  const log = createStderrLogger();
  const state = createState({ root: `/var/lib/pap-vm/${config.papUid}`, clock, log });
  state.ensure();
  const exec = createExec();
  // AVM-P11: the unit reloaded the ruleset (an empty `ports` set); the guards of the VMs that run come back before the
  // server accepts a request. If they cannot, pap-vmd does not start (main's catch exits 1).
  const { net, unleased } = await createRestoredNet({ exec, state, clock, log });
  const ops = createOps({
    exec,
    net,
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
    unleased,
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
