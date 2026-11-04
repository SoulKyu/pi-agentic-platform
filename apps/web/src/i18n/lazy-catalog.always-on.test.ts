import { describe, expect, it } from "vitest";
import { agentVmEn, agentVmFr } from "./catalog/agent-vm.ts";

describe("catalog (agent VM): always on", () => {
  it("carries the exact words of the Global Constraints", () => {
    const pairs = [
      ["agentVm.alwaysOn.label", "Always on", "Toujours allumée"],
      [
        "agentVm.alwaysOn.hint",
        "Never stops on its own; pap starts it again when pap starts. Keeps {memory} of shared memory reserved at all times.",
        "Ne s'arrête jamais d'elle-même ; pap la rallume à son démarrage. Garde {memory} de mémoire partagée réservés en permanence.",
      ],
      [
        "agentVm.alwaysOn.hintShort",
        "Never stops on its own; pap starts it again when pap starts.",
        "Ne s'arrête jamais d'elle-même ; pap la rallume à son démarrage.",
      ],
      ["agentVm.size", "{value} GB", "{value} Go"],
    ] as const;
    for (const [key, en, fr] of pairs) {
      expect(agentVmEn[key], key).toBe(en);
      expect(agentVmFr[key], key).toBe(fr);
    }
  });
});
