import { ALL_CHECKS } from "../doctor/registry.ts";

/**
 * Every check but the `vm.*` and `agents.*` ones, for `pap doctor --only`: those read the machine's real pap-vmd socket,
 * `/opt/pap-vm` and the real VM stack, which a test never reaches.
 */
export const DOCTOR_ONLY_NO_VM: string = ALL_CHECKS.map((check) => check.id)
  .filter((id) => !/^(vm|agents)\./.test(id))
  .join(",");
