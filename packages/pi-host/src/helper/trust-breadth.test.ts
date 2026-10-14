import { describe, expect, it } from "vitest";
import { trustRefusal } from "./trust-breadth.ts";

const facts = {
  home: "/home/u",
  agentDir: "/home/u/.pi/agent",
  papHome: "/home/u/.pap",
  projects: ["/home/u/work/a", "/home/u/work/b"],
};
// Facts of a host whose Pi and pap folders sit outside the home, so that their own rule is the one that answers.
const apart = { ...facts, home: "/home/u/h", agentDir: "/srv/pi/agent", papHome: "/srv/pap" };

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
