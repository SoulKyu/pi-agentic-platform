import { describe, expect, it } from "vitest";
import { agentPrompt } from "./agent-prompt.ts";

const HOME = "/pap/agents/atlas-1a2b";
const base = { name: "Atlas", home: HOME, role: "Be brief.", network: false, scratch: null };

describe("the agent's prompt (M11R55)", () => {
  it("names the agent and its home, says the network is off, and ends with the role", () => {
    const prompt = agentPrompt(base);
    expect(prompt).toContain("You are Atlas, a long-term agent of this pap instance.");
    expect(prompt).toContain(`Your home folder is ${HOME}.`);
    expect(prompt).not.toContain("MEMORY.md");
    expect(prompt).not.toContain("knowledge folder");
    expect(prompt).toContain("never add a remote or push.");
    expect(prompt).toContain("the network is off");
    expect(prompt).toContain("your secrets are environment variables");
    expect(prompt.endsWith("Role:\nBe brief.")).toBe(true);
  });

  it("names the knowledge folder and points to the Knowledge section", () => {
    const prompt = agentPrompt({ ...base, knowledge: "/agent/knowledge" });
    expect(prompt).not.toContain("MEMORY.md");
    expect(prompt).toContain(
      "your knowledge folder /agent/knowledge, described in the Knowledge section below.",
    );
  });

  it("says the network is on", () => {
    expect(agentPrompt({ ...base, network: true })).toContain("the network is on");
  });

  it("an agent without a sandbox does not claim one", () => {
    const prompt = agentPrompt({ ...base, network: null });
    expect(prompt).not.toContain("sandbox");
    expect(prompt).not.toContain("the network is");
  });

  it("no role, no Role line", () => {
    const prompt = agentPrompt({ ...base, role: "" });
    expect(prompt).not.toContain("Role:");
    expect(prompt.trimEnd()).toBe(prompt);
  });

  it("an isolated task names its scratch folder and says the home is read-only", () => {
    const scratch = "/pap/agents/.runs/atlas-1a2b/t1";
    const prompt = agentPrompt({ ...base, scratch });
    expect(prompt).toContain("This is an isolated task: your home is read-only;");
    expect(prompt).toContain(`write your files in ${scratch}, which is your working folder.`);
    expect(prompt).toContain("Your thread reads them as external content");
    expect(prompt).not.toContain("only your home is writable");
    expect(prompt.endsWith("Role:\nBe brief.")).toBe(true);
  });
});
