import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type { VmInit } from "@pap/contracts";
import type { NamedInlineExtension } from "../policy/extension.ts";
import type { Redactor } from "../policy/redact.ts";
import type { ShellTimers } from "../shell-process.ts";
import { vmShell } from "./ops.ts";
import type { spawn as nodeSpawn } from "node:child_process";

/**
 * R15, RT-02: pap's `bash` for every VM session, whatever the host-sandbox switch says. Pi's own tool definition (output
 * handling, truncation, rendering) over `vmShell`; no session environment (`PI_*`). The extension's name is `pap-sandbox`, so
 * the tool's source is `SANDBOX_SOURCE` and stage 02 knows it as pap's sandboxed shell; Pi's own `bash` is blocked there.
 * One `vmShell` per worker: its calls queue (R27).
 */
export function createVmShellTool(
  vm: VmInit,
  deps: {
    readonly redact?: () => Redactor;
    readonly timers?: ShellTimers;
    readonly spawn?: typeof nodeSpawn;
  } = {},
): NamedInlineExtension {
  const operations = vmShell(
    { bwrap: vm.bwrap, layout: vm.layout, slot: vm.slot, rootView: vm.rootView, egressSocket: null },
    deps,
  );
  return {
    name: "pap-sandbox",
    factory: (pi) => {
      pi.registerTool(
        createBashToolDefinition(vm.layout.home, { operations, exposeSessionEnvironment: false }),
      );
    },
  };
}
