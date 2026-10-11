import { installSignalCleanup, killDetachedDescendants } from "./descendants.ts";
import { runHost } from "./host.ts";
import { createIpc } from "./ipc.ts";
import { applyOomScore, startParentWatchdog } from "./watchdog.ts";

applyOomScore(800);
installSignalCleanup();
startParentWatchdog({
  initialPpid: process.ppid,
  onOrphan: () => {
    killDetachedDescendants();
    process.exit(1);
  },
});
runHost(createIpc(process)).catch((error: unknown) => {
  process.stderr.write(`pi-host: ${error instanceof Error ? error.message : String(error)}\n`);
  killDetachedDescendants();
  process.exit(70);
});
