import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { VmLayout } from "@pap/contracts";

/** The scripted provider copied into the VM's folder at each worker start (a test may rewrite it between starts). */
export const scriptCopier = (source: string) => (layout: VmLayout) => {
  const run = join(layout.root, "run");
  mkdirSync(run, { recursive: true, mode: 0o700 });
  const target = join(run, "provider-script.json");
  copyFileSync(source, target);
  return target;
};
