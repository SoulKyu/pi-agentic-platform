import { afterEach, describe, expect, it } from "vitest";
import { CLIENT_SECRET, type GithubBoxBed, auditText, startGithubBoxBed } from "./testing/github-bed.ts";

// Journey of boxes lot B2, secrets: the whole GitHub flow runs, then every place a secret must not reach is searched for every
// secret value the flow created.

let bed: GithubBoxBed | undefined;
afterEach(async () => {
  await bed?.stop();
  bed = undefined;
});

const REPO = "octo/hello";
const TOKEN_SHAPE =
  /gh[opsur]_[A-Za-z0-9]{16,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}|BEGIN [A-Z ]*PRIVATE KEY/;

describe("secrets", () => {
  it("no secret in logs", async () => {
    bed = await startGithubBoxBed({ steps: [{ text: "noted" }] });
    const b = bed;
    b.fake.state.addRepo(REPO);
    b.fake.state.data.pulls.set(REPO, [
      {
        number: 3,
        title: "Fix",
        html_url: "https://x/3",
        user: { login: "ann" },
        head: { ref: "fix", sha: "s1" },
      },
    ]);
    b.fake.state.data.checkRuns.set(`${REPO}@s1`, [
      { id: 11, name: "build", status: "completed", conclusion: "failure" },
    ]);
    b.fake.state.data.jobLogs.set(`${REPO}#11`, "boom\n");
    b.fake.state.data.issues.set(REPO, [
      { number: 5, title: "Crash", body: "steps", html_url: "https://x/5" },
    ]);

    await b.connectApp();
    const project = await b.cloneProject(REPO);
    await b.writeFile(project, "notes.txt", "from the box\n");
    await b.ask("projects.commitPush", { projectId: project.id, message: "feat: notes" });
    await b.ask("projects.prCreate", { projectId: project.id, title: "Notes", body: "" });
    await b.githubOf(project.id);
    await b.ask("projects.checkLog", { projectId: project.id, checkId: "11" });
    await b.ask("projects.sendToSession", { projectId: project.id, source: { kind: "issue", number: 5 } });
    await b.ask("github.status", {});
    await b.ask("github.repositories", {});
    // A failing GitHub is logged too.
    b.fake.state.fail("GET /user/installations", 500);
    expect(await b.code("github.repositories", {})).not.toBe("ok");
    // The scan sees files: the App file holds the client secret (so a leak elsewhere would be found).
    expect(b.filesHolding(CLIENT_SECRET).map((path) => path.split("/").slice(-2).join("/"))).toEqual([
      "secrets/github-app.json",
    ]);
    await b.ask("github.disconnect", {});
    await b.ask("github.forget", {});

    const secrets = b.secretValues();
    // The flow created the PEM, its body, the client secret, a user and a refresh token and several installation tokens.
    expect(secrets.length).toBeGreaterThanOrEqual(7);
    expect(b.fake.state.minted.length).toBeGreaterThanOrEqual(3);

    const places: Array<[string, string]> = [
      ["the daemon log", b.logLines.map((line) => JSON.stringify(line)).join("\n")],
      ["the audit rows", auditText(b.t.home)],
      ["the RPC answers", b.answers.join("\n")],
      ["the stream events", JSON.stringify(b.owner.client.events)],
    ];
    for (const [place, text] of places) {
      if (place !== "the stream events") expect(text.length, place).toBeGreaterThan(100);
      for (const secret of secrets) expect(text.includes(secret), `${place} holds a secret`).toBe(false);
      expect(text.match(TOKEN_SHAPE), `${place} holds something shaped like a token`).toBeNull();
    }

    // On disk nothing but the App file (the key and the client secret) and the box's /run (its token) holds one.
    for (const secret of secrets) {
      const held = b.filesHolding(secret).filter((path) => !path.endsWith("/secrets/github-app.json"));
      expect(held, "a file holds a secret").toEqual([]);
    }
  }, 300_000);
});
