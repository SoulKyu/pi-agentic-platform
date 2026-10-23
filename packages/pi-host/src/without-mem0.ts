import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { isPiMem0 } from "@pap/contracts";
import type { ExtensionErrorReport } from "./open-session.ts";

/**
 * pap's sessions never load pi-mem0 (ADR 0082): OKF knowledge replaced it, and its capture would reopen the memory
 * path pap closed. The shared `~/.pi/agent` is untouched, so pi-web still loads it. Reported once per worker, by name only.
 */
export function withoutPiMem0(
  report: (error: ExtensionErrorReport) => void,
): (base: LoadExtensionsResult) => LoadExtensionsResult {
  let reported = false;
  return (base) => {
    const kept = base.extensions.filter(
      (extension) => !(isPiMem0(extension.path) || isPiMem0(extension.resolvedPath)),
    );
    if (kept.length === base.extensions.length) return base;
    if (!reported) {
      reported = true;
      report({
        extensionPath: "pi-mem0",
        event: "extension_skipped",
        error: "pi-mem0 is not loaded by pap sessions; OKF knowledge replaced it.",
      });
    }
    return { ...base, extensions: kept };
  };
}
