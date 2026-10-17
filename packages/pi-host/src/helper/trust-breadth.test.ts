import { describe, expect, it } from "vitest";
import { trustRefusal } from "./trust-breadth.ts";

const facts = {
  home: "/home/u",
  agentDir: "/home/u/.pi/agent",
  papHome: "/home/u/.pap",
  agents: "/home/u/.pap/agents",
  projects: ["/home/u/work/a", "/home/u/work/b"],
};
// Facts of a host whose Pi and pap folders sit outside the home, so that their own rule is the one that answers.
const apart = {
  ...facts,
  home: "/home/u/h",
  agentDir: "/srv/pi/agent",
  papHome: "/srv/pap",
  agents: "/srv/pap/agents",
};

describe("trustRefusal (M7R104)", () => {
  it("refuses the filesystem root", () => {
    expect(trustRefusal("/", facts)).toBe("filesystem-root");
  });

  it("refuses the home folder and every ancestor of it", () => {
    expect(trustRefusal("/home/u", facts)).toBe("home-or-above");
    expect(trustRefusal("/home", facts)).toBe("home-or-above");
  });

  it("refuses a folder that holds Pi's agent directory or pap's home", () => {
    expect(trustRefusal("/srv/pi", apart)).toBe("holds-pi-or-pap");
    expect(trustRefusal("/srv/pi/agent", apart)).toBe("holds-pi-or-pap");
    expect(trustRefusal("/srv", apart)).toBe("holds-pi-or-pap");
    expect(trustRefusal("/srv/pap", apart)).toBe("holds-pi-or-pap");
  });

  it("refuses any folder inside pap's agents folder: an agent home and a scratch folder (W5-R27)", () => {
    expect(trustRefusal("/srv/pap/agents/atlas-1a2b", apart)).toBe("inside-pap-home");
    expect(trustRefusal("/srv/pap/agents/.runs/atlas-1a2b/0a1b2c3d-0000-4000-8000-0123456789ab", apart)).toBe(
      "inside-pap-home",
    );
    expect(trustRefusal("/srv/pap/agents/atlas-1a2b/sub", apart)).toBe("inside-pap-home");
    expect(trustRefusal("/srv/papers", apart)).toBeNull();
  });

  it("accepts a lane worktree under pap's home, which needs trust (M9, W5-R27 amended)", () => {
    expect(trustRefusal("/srv/pap/worktrees/proj-1a2b/lane-3c4d", apart)).toBeNull();
    expect(trustRefusal("/srv/pap/agents-old/x", apart)).toBeNull();
  });

  it("refuses a folder that strictly holds another known project, and accepts a project itself", () => {
    expect(trustRefusal("/home/u/work", facts)).toBe("holds-other-projects");
    expect(trustRefusal("/home/u/work/a", facts)).toBeNull();
  });

  it("accepts a folder inside a project, and a sibling of every fact", () => {
    expect(trustRefusal("/home/u/work/a/sub", facts)).toBeNull();
    expect(trustRefusal("/home/u/other", facts)).toBeNull();
    expect(trustRefusal("/home/user", facts)).toBeNull();
  });
});
