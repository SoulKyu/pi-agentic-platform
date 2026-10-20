import { pushReadiness } from "../../kernel/push-readiness.ts";
import { CHECKS_DAEMON } from "./checks-daemon.ts";
import { makeHttpsCheck, makePushCheck } from "./checks-push.ts";
import { CHECKS_SYSTEM } from "./checks-system.ts";
import { CHECKS_VM } from "./checks-vm.ts";
import type { Check } from "./types.ts";

const bwrapAt = CHECKS_DAEMON.findIndex((check) => check.id === "bwrap");

/**
 * Every check, in the order they run, one line each. `https` and `push` are built from M12's `pushReadiness`
 * (`kernel/push-readiness.ts`) and sit between `backup` and `bwrap`. The `vm.*` checks (T18) come last and skip outside `vm` mode.
 */
export const ALL_CHECKS: readonly Check[] = [
  ...CHECKS_SYSTEM,
  ...CHECKS_DAEMON.slice(0, bwrapAt),
  makeHttpsCheck(pushReadiness),
  makePushCheck(pushReadiness),
  ...CHECKS_DAEMON.slice(bwrapAt),
  ...CHECKS_VM,
];
