import { describe, expect, it } from "vitest";
import { agentSettingsEn } from "./agent-settings.ts";
import { settingsAgentsEn, settingsAgentsFr } from "./settings-agents.ts";

const slots = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe("the Settings › Agents catalog", () => {
  it("has every key in both languages, filled, with the same slots", () => {
    expect(Object.keys(settingsAgentsFr)).toEqual(Object.keys(settingsAgentsEn));
    for (const key of Object.keys(settingsAgentsEn) as Array<keyof typeof settingsAgentsEn>) {
      expect(settingsAgentsFr[key], key).not.toBe("");
      expect(slots(settingsAgentsFr[key]), key).toEqual(slots(settingsAgentsEn[key]));
    }
  });

  it("shares no key with the agent form's catalog, which registers beside it", () => {
    const form = new Set(Object.keys(agentSettingsEn));
    expect(Object.keys(settingsAgentsEn).filter((key) => form.has(key))).toEqual([]);
  });
});
