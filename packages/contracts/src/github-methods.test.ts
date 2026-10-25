import { describe, expect, it } from "vitest";
import { TOKEN_PERMISSIONS } from "./auth.ts";
import { GITHUB_BROWSER_ONLY, githubMethods } from "./github-methods.ts";
import { methods } from "./methods.ts";

describe("the GitHub methods", () => {
  it("every method declares a permission and errors", () => {
    for (const [name, def] of Object.entries(githubMethods)) {
      expect(def.permission, name).toMatch(/^[a-z]+:(read|operate|admin)$/);
      expect(Array.isArray(def.errors), name).toBe(true);
      expect(methods[name as keyof typeof methods], name).toBe(def);
    }
    expect(githubMethods["github.status"].permission).toBe("settings:read");
    expect(githubMethods["github.startCreate"].permission).toBe("system:admin");
    expect(githubMethods["github.forget"].permission).toBe("system:admin");
    expect(githubMethods["github.forget"].errors).toContain("step_up_required");
    expect(githubMethods["github.repositories"].permission).toBe("sessions:operate");
    expect(githubMethods["projects.github"].permission).toBe("sessions:read");
    expect(githubMethods["projects.checkLog"].permission).toBe("sessions:read");
    expect(githubMethods["projects.prCreate"].permission).toBe("sessions:operate");
    expect(githubMethods["projects.createFromGithub"].errors).toContain("github_unavailable");
  });

  it("marks exactly the mutations as non-idempotent", () => {
    const mutations = Object.values(githubMethods)
      .filter((def) => !def.idempotent)
      .map((def) => def.name)
      .sort();
    expect(mutations).toEqual([
      "github.authorizeUrl",
      "github.disconnect",
      "github.forget",
      "github.startCreate",
      "projects.cloneAgain",
      "projects.commitPush",
      "projects.createFromGithub",
      "projects.linkGithub",
      "projects.prCreate",
      "projects.sendToSession",
      "projects.unlinkGithub",
    ]);
  });

  it("browser-only methods are marked", () => {
    expect([...GITHUB_BROWSER_ONLY].sort()).toEqual(
      Object.keys(githubMethods)
        .filter((name) => !["github.status", "projects.github", "projects.checkLog"].includes(name))
        .sort(),
    );
    expect(GITHUB_BROWSER_ONLY.has("github.status")).toBe(false);
    expect(GITHUB_BROWSER_ONLY.has("projects.commitPush")).toBe(true);
    // Their permissions are ones a token can hold, which is why the set exists.
    expect(TOKEN_PERMISSIONS).toContain("sessions:operate");
  });

  it("projects.prCreate answers a created pull request or a compare page", () => {
    const { result } = githubMethods["projects.prCreate"];
    expect(
      result.safeParse({ kind: "created", number: 3, url: "https://github.com/o/r/pull/3" }).success,
    ).toBe(true);
    expect(result.safeParse({ kind: "compare", url: "https://github.com/o/r/compare/x" }).success).toBe(true);
    expect(
      result.safeParse({ kind: "compare", number: 3, url: "https://github.com/o/r/compare/x" }).success,
    ).toBe(false);
  });
});
