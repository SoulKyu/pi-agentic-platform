import { createBashToolDefinition, type LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import type { SandboxSpec } from "@pap/contracts";
import type { NamedInlineExtension } from "./policy/extension.ts";
import type { Redactor } from "./policy/redact.ts";
import { SANDBOX_SOURCE } from "./policy/tool-kind.ts";
import { sandboxedShell, type ShellEgress, type ShellTimers, toolCall } from "./sandbox-ops.ts";

/**
 * M11R22: pap's `bash` is Pi's own tool definition (output handling, truncation, rendering) over pap's process. No
 * `commandPrefix` (the owner's prefix sources files the sandbox hides), no `shellPath` (the shell is always `/bin/sh -c`),
 * no session environment (`PI_*`). An inline extension, not `replaceable` and not `builtin`: a Pi setting cannot disable it,
 * and its tool's source is `SANDBOX_SOURCE`. Pi passes no tool call id to `operations.exec`, so `execute` runs inside
 * `toolCall` and a networked command's egress report is kept under that id (M11R232).
 */
export function createSandboxTool(
  spec: SandboxSpec,
  envFor: (command: string) => Readonly<Record<string, string>>,
  deps: {
    readonly timers?: ShellTimers;
    readonly egress?: ShellEgress;
    readonly redact?: () => Redactor;
  } = {},
): NamedInlineExtension {
  return {
    name: "pap-sandbox",
    factory: (pi) => {
      const definition = createBashToolDefinition(spec.writable ?? spec.home, {
        operations: sandboxedShell(spec, envFor, deps),
        exposeSessionEnvironment: false,
      });
      pi.registerTool({
        ...definition,
        execute: (toolCallId, ...rest) =>
          toolCall.run(toolCallId, () => definition.execute(toolCallId, ...rest)),
      });
    },
  };
}

/**
 * Pi keeps the first registration of a tool name, so pap-sandbox goes first: an extension that registered `bash` too lost,
 * and that is reported once per session with a fixed sentence. Whichever `bash` Pi keeps, stage 02 blocks one that is not
 * from `SANDBOX_SOURCE` in a sandbox-required profile (Task 5).
 */
export function sandboxFirst(
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
