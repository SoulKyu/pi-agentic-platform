import {
  createEditToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import type { NamedInlineExtension } from "../policy/extension.ts";
import { VM_FILES_SOURCE } from "../policy/tool-kind.ts";
import type { VmFileRoots } from "../policy/vm-paths.ts";
import { createVmFileOps } from "./ops.ts";

const NAMES = ["read", "write", "edit", "ls"] as const;

/**
 * R26 (RT-01): Pi's own `read`, `write`, `edit` and `ls` tool definitions (output handling, truncation, rendering) over pap's
 * operations, which open every path component without following a link. An extension's tool takes a built-in's name (Pi's
 * `docs/containerization.md`: the Gondolin extension overrides the same tools). `grep` and `find` stay Pi's built-ins; their
 * root is judged by the VM file rule. The tools' source is `VM_FILES_SOURCE`: stage 02 classifies them as built-ins in a
 * worker whose policy config has `vm`, and as unknown anywhere else.
 */
export function createVmFileTools(roots: VmFileRoots, cwd: string): NamedInlineExtension {
  return {
    name: "pap-vm-files",
    factory: (pi) => {
      const ops = createVmFileOps(roots);
      pi.registerTool(createReadToolDefinition(cwd, { operations: ops.read }));
      pi.registerTool(createWriteToolDefinition(cwd, { operations: ops.write }));
      pi.registerTool(createEditToolDefinition(cwd, { operations: ops.edit }));
      pi.registerTool(createLsToolDefinition(cwd, { operations: ops.ls }));
    },
  };
}

/**
 * Pi keeps the first registration of a tool name, so pap-vm-files goes first (like `sandboxFirst`): an extension that
 * registered one of the four names too lost, and that is reported once per session with a fixed sentence.
 */
export function vmFilesFirst(
  report: (error: { extensionPath: string; event: string; error: string }) => void,
): (base: LoadExtensionsResult) => LoadExtensionsResult {
  let reported = false;
  return (base) => {
    const mine = base.extensions.find((extension) => extension.path === VM_FILES_SOURCE);
    if (!mine) return base;
    if (
      !reported &&
      base.extensions.some(
        (extension) => extension !== mine && NAMES.some((name) => extension.tools.has(name)),
      )
    ) {
      reported = true;
      report({
        extensionPath: VM_FILES_SOURCE,
        event: "tool_name_collision",
        error:
          "another extension registered read, write, edit or ls; pap's VM file tools are the ones in use.",
      });
    }
    return { ...base, extensions: [mine, ...base.extensions.filter((extension) => extension !== mine)] };
  };
}
