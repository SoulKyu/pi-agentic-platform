import { describe, expect, it } from "vitest";
import { translate } from "../../i18n/index.ts";
import { laneView } from "../../testing/lane-fixtures.ts";
import { forgeNotice, openUrl, PR_REFUSED, prFormDefaults } from "./pr.vm.ts";
import "./register-lane-commit-catalog.ts";

const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) =>
  translate("en", key, vars);

describe("open on the forge", () => {
  it("opens an https address and nothing else", () => {
    expect(openUrl("https://github.com/o/r/pull/7")).toBe("https://github.com/o/r/pull/7");
    expect(openUrl("javascript:alert(1)")).toBeNull();
    expect(openUrl("http://github.com/o/r/pull/7")).toBeNull();
    expect(openUrl("data:text/html,x")).toBeNull();
    expect(openUrl("not a url")).toBeNull();
    expect(openUrl("")).toBeNull();
  });
});

describe("the form", () => {
  it("starts with the lane's title (its branch when it has none), no body and no draft", () => {
    expect(prFormDefaults(laneView({ id: "a-1a2b", title: "Fix the login" }))).toEqual({
      title: "Fix the login",
      body: "",
      draft: false,
    });
    expect(prFormDefaults(laneView({ id: "a-1a2b", title: "" })).title).toBe("pi/a-1a2b");
  });
});

describe("the forge's words", () => {
  it("tells what to do when the CLI is missing or signed out, and when the forge is not supported", () => {
    expect(PR_REFUSED.forge_missing).toBeTypeOf("string");
    expect(forgeNotice(laneView({ id: "a-1a2b", forge: "github" }), "not_signed_in")).toBe(
      "laneCommit.pr.hint.gh",
    );
    expect(forgeNotice(laneView({ id: "a-1a2b", forge: "github" }), "forge_missing")).toBe(
      "laneCommit.pr.hint.gh",
    );
    expect(forgeNotice(laneView({ id: "a-1a2b", forge: "gitlab" }), null)).toBe(
      "laneCommit.pr.hint.unsupported",
    );
    expect(forgeNotice(laneView({ id: "a-1a2b", forge: "gitea" }), null)).toBe(
      "laneCommit.pr.hint.unsupported",
    );
    expect(forgeNotice(laneView({ id: "a-1a2b", forge: "github" }), "unsupported_remote")).toBe(
      "laneCommit.pr.hint.unsupported",
    );
    expect(forgeNotice(laneView({ id: "a-1a2b", forge: "github" }), null)).toBeNull();
    expect(en("laneCommit.pr.hint.gh")).toBe("Run `gh auth login` in a terminal");
    expect(en("laneCommit.pr.hint.unsupported")).toBe("GitLab and Gitea are not supported yet");
  });
});
