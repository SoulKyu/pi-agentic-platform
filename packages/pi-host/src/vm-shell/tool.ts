import { createBashToolDefinition, type LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import type { VmInit } from "@pap/contracts";
import type { NamedInlineExtension } from "../policy/extension.ts";
import type { ShellEnvironment } from "../shell-env.ts";
import type { Redactor } from "../policy/redact.ts";
import { SANDBOX_SOURCE } from "../policy/tool-kind.ts";
import type { ShellTimers } from "../shell-process.ts";
import { vmShell } from "./ops.ts";
import { pickProxyEnv } from "./proxy-env.ts";
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
    /** `rules.sandbox?.network === true`: the shell reaches the egress proxy. */
    readonly network?: boolean;
    readonly env?: NodeJS.ProcessEnv;
    /** The vault and one-use values of the shell (ADR 0081). */
    readonly environment?: Pick<ShellEnvironment, "envFor">;
    readonly timers?: ShellTimers;
    readonly spawn?: typeof nodeSpawn;
  } = {},
): NamedInlineExtension {
  const network = deps.network === true;
  const operations = vmShell(
    { bwrap: vm.bwrap, layout: vm.layout, slot: vm.slot, rootView: vm.rootView, network },
    {
      ...deps,
      ...(network ? { proxyEnv: pickProxyEnv(deps.env ?? process.env) } : {}),
    },
  );
  return {
    name: "pap-sandbox",
    factory: (pi) => {
      pi.registerTool(
        createBashToolDefinition(vm.layout.project ?? vm.layout.home, {
          operations,
          exposeSessionEnvironment: false,
        }),
      );
    },
  };
}

/**
 * Pi keeps the first registration of a tool name, so pap's shell goes first: an extension that registered `bash` too lost,
 * and that is reported once per session with a fixed sentence. Whichever `bash` Pi keeps, stage 02 blocks one that is not
 * from `SANDBOX_SOURCE`.
 */
export function vmShellFirst(
  report: (error: { extensionPath: string; event: string; error: string }) => void,
): (base: LoadExtensionsResult) => LoadExtensionsResult {
  let reported = false;
  return (base) => {
    const mine = base.extensions.find((extension) => extension.path === SANDBOX_SOURCE);
    if (!mine) return base;
    if (!reported && base.extensions.some((extension) => extension !== mine && extension.tools.has("bash"))) {
      reported = true;
      report({
        extensionPath: SANDBOX_SOURCE,
        event: "tool_name_collision",
        error: "another extension registered bash; pap's sandboxed bash is the one in use.",
      });
    }
    return { ...base, extensions: [mine, ...base.extensions.filter((extension) => extension !== mine)] };
  };
}
