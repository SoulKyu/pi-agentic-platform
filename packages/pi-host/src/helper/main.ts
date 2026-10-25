// Must stay first: closes the inherited pty descriptors before anything else is evaluated (MC29).
import "../close-inherited-fds.ts";
import { type HelperToDaemon } from "@pap/contracts/pi-host";
import { installSignalCleanup, killDetachedDescendants } from "../descendants.ts";
import { OPS } from "./ops.ts";
import { serveHelper } from "./run.ts";

// The daemon is gone when its side of the channel closes: nobody can answer a prompt or read a result, so the helper
// ends at once instead of waiting (ADR 0023), and takes whatever it started in its group with it (the pool forks it as
// the leader of its group; anywhere else the signal finds no such group and only the exit applies).
// Registered before anything else runs.
process.on("disconnect", () => {
  // A stdio server of a Test leads a group of its own (pi-mcp), which the group signal below never reaches.
  killDetachedDescendants();
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    // not a group leader: the exit below is all there is to do
  }
  process.exit(1);
});
// A write to the closed channel emits an error event; the disconnect above already ended the process.
process.on("error", () => {});
// SIGTERM and SIGHUP (the daemon's kill ladder) end the servers a Test started before the helper dies of the signal.
installSignalCleanup();

const send = process.send?.bind(process);
if (!send) {
  process.stderr.write("pi-helper: needs an IPC channel: start it with child_process.fork\n");
  process.exit(70);
}

try {
  await serveHelper(
    {
      send: (record: HelperToDaemon) =>
        new Promise<void>((resolve, reject) => {
          send(record, (error: Error | null) => (error ? reject(error) : resolve()));
        }),
      onMessage: (listener) => void process.on("message", listener),
    },
    OPS,
  );
  killDetachedDescendants();
  process.exit(0);
} catch (error) {
  process.stderr.write(`pi-helper: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(70);
}
