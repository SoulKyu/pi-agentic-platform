import { pushReadiness } from "../../kernel/push-readiness.ts";
import { CHECKS_DAEMON } from "./checks-daemon.ts";
import { makePreviewCheck, probePreview } from "./checks-preview.ts";
import { makeHttpsCheck, makePushCheck } from "./checks-push.ts";
import { CHECKS_SYSTEM } from "./checks-system.ts";
import { CHECKS_VM } from "./checks-vm.ts";
import { CHECKS_VM_SKEW } from "./checks-vm-skew.ts";
import type { Check } from "./types.ts";

const updateAt = CHECKS_DAEMON.findIndex((check) => check.id === "update_available");

/**
 * Every check, in the order they run, one line each. `https` and `push` are built from M12's `pushReadiness`
 * (`kernel/push-readiness.ts`) and sit between `backup` and `update_available`. `preview.listener` follows them; the `vm.*` checks come last.
 */
export const ALL_CHECKS: readonly Check[] = [
  ...CHECKS_SYSTEM,
  ...CHECKS_DAEMON.slice(0, updateAt),
  makeHttpsCheck(pushReadiness),
  makePushCheck(pushReadiness),
  ...CHECKS_DAEMON.slice(updateAt),
  makePreviewCheck(probePreview),
  ...CHECKS_VM,
  ...CHECKS_VM_SKEW,
];
