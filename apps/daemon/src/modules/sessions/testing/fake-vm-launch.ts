import type { WorkerHandle } from "../../../kernel/supervisor/worker.ts";
import type { VmLaunch } from "../index.ts";

/** A launcher whose VM worker is one of the bed's fake workers and whose `init` is the host's: for tests of what happens around a VM row. */
export const fakeVmLaunch = (makeWorker: () => WorkerHandle): VmLaunch => ({
  spawn: () => Promise.resolve({ handle: makeWorker(), bind: (compose) => compose() }),
});
