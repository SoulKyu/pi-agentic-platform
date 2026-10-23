import { describe, expect, it } from "vitest";
import { agentComposeFr } from "./agent-compose.ts";
import { agentSafetyFr } from "./agent-safety.ts";
import { agentSettingsFr } from "./agent-settings.ts";
import { agentSpaceFr } from "./agent-space.ts";
import { agentStatusFr } from "./agent-status.ts";
import { agentsPhoneFr } from "./agents-phone.ts";
import { automationAgentsFr } from "./automation-agents.ts";
import { automationFr } from "./automation.ts";
import { automationTriggerFr } from "./automation-trigger.ts";
import { inboxAgentsFr } from "./inbox-agents.ts";
import { inboxFr } from "./inbox.ts";
import { settingsAgentsFr } from "./settings-agents.ts";
import { shellFr } from "./shell.ts";
import { memoryFr } from "./memory.ts";
import { landingFr } from "./landing.ts";
import { notificationsFr } from "./notifications.ts";
import { pushFr } from "./push.ts";
import { pwaFr } from "./pwa.ts";
import { subagentsFr } from "./subagents.ts";

const WORD_START = String.raw`(?<![\p{L}'])`;
const WORD_END = String.raw`(?![\p{L}])`;
const FAMILIAR = new RegExp(
  `${WORD_START}(tu|ton|ta|tes|te|toi|tien|tiens|tienne|tiennes)${WORD_END}|${WORD_START}t'`,
  "iu",
);
const SINGULAR_IMPERATIVE = new RegExp(
  `(?<=^|[.!?«] )(utilise|lance|ouvre|rouvre|r[ée]essaie|v[ée]rifie|renouvelle|s[ée]lectionne|fournis|enregistre|copie|mets|corrige|ajoute|choisis|saisis)(-\\p{L}+)?(?=[ ,.;:])`,
  "iu",
);

const m11Catalogs = {
  agentComposeFr,
  agentSafetyFr,
  agentSettingsFr,
  agentSpaceFr,
  agentStatusFr,
  agentsPhoneFr,
  automationAgentsFr,
  automationFr,
  automationTriggerFr,
  inboxAgentsFr,
  inboxFr,
  settingsAgentsFr,
  memoryFr,
  subagentsFr,
  pwaFr,
  pushFr,
  notificationsFr,
  landingFr,
} as Record<string, Record<string, string>>;

describe("the French copy of the agents, automation and Inbox speaks to the owner with vous", () => {
  for (const [name, catalog] of Object.entries(m11Catalogs)) {
    it(`${name} has no tu, ton, ta, tes, toi, nor a familiar imperative`, () => {
      const familiar = Object.entries(catalog)
        .filter(([, text]) => FAMILIAR.test(text) || SINGULAR_IMPERATIVE.test(text))
        .map(([key]) => key);
      expect(familiar).toEqual([]);
    });
  }

  it("the advice to remove a leg of the triad uses the plural imperative", () => {
    expect(agentSafetyFr["agentSafety.tri.remove.private"]).toContain("donnez");
    expect(agentSafetyFr["agentSafety.tri.remove.untrusted"]).toContain("retirez");
    expect(agentSafetyFr["agentSafety.tri.remove.exfil"]).toContain("coupez");
  });

  it("the agent lines of the shell catalog use the vous imperative", () => {
    expect(shellFr["shell.agent.unreadable"]).toBe("profil illisible, ouvrez Réglages › Agents");
  });
});
