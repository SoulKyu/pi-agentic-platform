// Must stay first: closes the inherited pty descriptors before anything else is evaluated (MC29).
import "./close-inherited-fds.ts";
import { installSignalCleanup, killDetachedDescendants } from "./descendants.ts";
import { runHost } from "./host.ts";
import { transportFromEnv } from "./transport.ts";
import { applyOomScore, startParentWatchdog } from "./watchdog.ts";

const fail = (error: unknown): never => {
  process.stderr.write(`pi-host: ${error instanceof Error ? error.message : String(error)}\n`);
  killDetachedDescendants();
  process.exit(70);
};

applyOomScore(800);
installSignalCleanup();
const ipc = await transportFromEnv(process.env).catch(fail);
// A socket worker's parent is the guest, which kills its workers when it dies.
if (process.env.PAP_WORKER_TRANSPORT !== "socket") {
  startParentWatchdog({
    initialPpid: process.ppid,
    onOrphan: () => {
      killDetachedDescendants();
      process.exit(1);
    },
  });
}
runHost(ipc).catch(fail);
