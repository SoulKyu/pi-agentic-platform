import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeGithub, type FakeGithub } from "./fake-github.ts";

let fake: FakeGithub | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const send = async (
  origin: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> => {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
};

describe("the fake GitHub", () => {
  it("listens on loopback only", async () => {
    fake = await startFakeGithub();
    expect(fake.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("converts a manifest code once", async () => {
    fake = await startFakeGithub();
    const first = await send(fake.origin, "POST", "/app-manifests/abc/conversions", {});
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({
      slug: "pap-fake",
      client_id: expect.any(String),
      pem: expect.any(String),
    });
    expect((await send(fake.origin, "POST", "/app-manifests/abc/conversions", {})).status).toBe(404);
    expect((await send(fake.origin, "POST", "/app-manifests/def/conversions", {})).status).toBe(201);
  });

  it("rotates refresh tokens", async () => {
    fake = await startFakeGithub();
    const grant = await send(fake.origin, "POST", "/login/oauth/access_token", { code: "c1" });
    const refresh = grant.json.refresh_token as string;
    expect(refresh).toMatch(/^ghr_/);
    const second = await send(fake.origin, "POST", "/login/oauth/access_token", {
      grant_type: "refresh_token",
      refresh_token: refresh,
    });
    expect(second.json.refresh_token).not.toBe(refresh);
    expect(fake.state.userTokens.refreshes).toBe(1);
    const replay = await send(fake.origin, "POST", "/login/oauth/access_token", {
      grant_type: "refresh_token",
      refresh_token: refresh,
    });
    expect(replay.json).toEqual({ error: "bad_refresh_token" });
    expect((await send(fake.origin, "POST", "/login/oauth/access_token", { code: "c1" })).json.error).toBe(
      "bad_verification_code",
    );
  });

  it("mints tokens with the asked permissions only", async () => {
    fake = await startFakeGithub();
    fake.state.addRepo("octo/one");
    fake.state.addRepo("octo/two");
    const minted = await send(fake.origin, "POST", "/app/installations/7/access_tokens", {
      permissions: { contents: "write", pull_requests: "write" },
      repositories: ["one"],
    });
    expect(minted.status).toBe(201);
    expect(minted.json.permissions).toEqual({ contents: "write", pull_requests: "write" });
    expect((minted.json.repositories as Array<{ full_name: string }>).map((r) => r.full_name)).toEqual([
      "octo/one",
    ]);
    expect(fake.state.minted).toHaveLength(1);
    fake.state.appPermissions = { contents: "write" };
    const refused = await send(fake.origin, "POST", "/app/installations/7/access_tokens", {
      permissions: { administration: "write" },
    });
    expect(refused.status).toBe(422);
  });

  it("records every call in order and the posted manifest", async () => {
    fake = await startFakeGithub();
    await send(fake.origin, "GET", "/app");
    await send(fake.origin, "POST", "/settings/apps/new", { manifest: '{"name":"x"}' });
    await send(fake.origin, "GET", "/nowhere");
    expect(fake.state.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /app",
      "POST /settings/apps/new",
      "GET /nowhere",
    ]);
    expect(fake.state.calls[2]?.route).toBeNull();
    expect(fake.state.manifests).toEqual(['{"name":"x"}']);
    expect(fake.state.callsTo("GET /app")).toHaveLength(1);
  });

  it("answers or fails an endpoint on demand, and a signing-key upload with 403", async () => {
    fake = await startFakeGithub();
    fake.state.respond("GET /user", { status: 200, body: { login: "other" } }, 1);
    expect((await send(fake.origin, "GET", "/user")).json.login).toBe("other");
    expect((await send(fake.origin, "GET", "/user")).json.login).toBe("octo");
    fake.state.fail("POST /user/ssh_signing_keys", 403, "Resource not accessible by integration");
    const denied = await send(fake.origin, "POST", "/user/ssh_signing_keys", {
      title: "t",
      key: "ssh-ed25519 AAAA",
    });
    expect(denied).toEqual({ status: 403, json: { message: "Resource not accessible by integration" } });
    expect(fake.state.signingKeys.size).toBe(0);
  });

  it("stores and removes signing keys", async () => {
    fake = await startFakeGithub();
    const added = await send(fake.origin, "POST", "/user/ssh_signing_keys", {
      title: "t",
      key: "ssh-ed25519 AAAA",
    });
    expect(added.status).toBe(201);
    expect(
      (await send(fake.origin, "POST", "/user/ssh_signing_keys", { title: "t", key: "ssh-ed25519 AAAA" }))
        .status,
    ).toBe(422);
    expect((await send(fake.origin, "DELETE", `/user/ssh_signing_keys/${added.json.id}`)).status).toBe(204);
    expect(fake.state.signingKeys.size).toBe(0);
  });

  it("serves repositories whose clone_url is a local bare repository, and forks them", async () => {
    fake = await startFakeGithub();
    fake.state.addRepo("octo/one");
    const listed = await send(fake.origin, "GET", "/user/installations/7/repositories");
    const [repo] = listed.json.repositories as Array<{ clone_url: string }>;
    expect(repo?.clone_url).toMatch(/^file:\/\//);
    const heads = execFileSync("git", ["ls-remote", repo?.clone_url ?? ""], { encoding: "utf8" });
    expect(heads).toContain("refs/heads/main");
    const fork = await send(fake.origin, "POST", "/repos/other/lib/forks", {});
    expect(fork.status).toBe(404);
    fake.state.addRepo("other/lib");
    const forked = await send(fake.origin, "POST", "/repos/other/lib/forks", {});
    expect(forked.status).toBe(202);
    expect(forked.json.full_name).toBe("octo/lib");
    expect(execFileSync("git", ["ls-remote", String(forked.json.clone_url)], { encoding: "utf8" })).toContain(
      "refs/heads/main",
    );
  });

  it("serves the list endpoints from seeded data and opens pull requests", async () => {
    fake = await startFakeGithub();
    fake.state.addRepo("octo/one");
    fake.state.data.pulls.set("octo/one", [{ number: 1 }]);
    fake.state.data.jobLogs.set("octo/one#9", "log text");
    expect((await send(fake.origin, "GET", "/repos/octo/one/pulls")).status).toBe(200);
    expect(await fetch(`${fake.origin}/repos/octo/one/actions/jobs/9/logs`).then((r) => r.text())).toBe(
      "log text",
    );
    const minted = await send(fake.origin, "POST", "/app/installations/7/access_tokens", {
      repositories: ["one"],
      permissions: { pull_requests: "write" },
    });
    const token = String(minted.json.token);
    const open = (authorization?: string) =>
      fetch(`${fake?.origin}/repos/octo/one/pulls`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
        body: JSON.stringify({ title: "t", head: "x", base: "main" }),
      });
    expect((await open()).status).toBe(403);
    const pr = await open(`Bearer ${token}`);
    expect(pr.status).toBe(201);
    expect(((await pr.json()) as { html_url: string }).html_url).toContain("/octo/one/pull/");
    expect(fake.state.callsTo("POST /repos/:o/:r/pulls").at(-1)?.body).toMatchObject({ title: "t" });
    // The same head and base again: 422, as GitHub answers.
    expect((await open(`Bearer ${token}`)).status).toBe(422);
    const revoke = await fetch(`${fake.origin}/installation/token`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revoke.status).toBe(204);
    expect(fake.state.revoked).toEqual([token]);
  });

  it("forks a repository once: a second fork returns the existing one", async () => {
    fake = await startFakeGithub();
    fake.state.addRepo("other/lib");
    const first = await send(fake.origin, "POST", "/repos/other/lib/forks", {});
    const second = await send(fake.origin, "POST", "/repos/other/lib/forks", {});
    expect(second.status).toBe(202);
    expect(second.json.clone_url).toBe(first.json.clone_url);
    expect([...fake.state.repos.keys()].filter((name) => name.startsWith("octo/"))).toEqual(["octo/lib"]);
  });

  it("answers 400 to a malformed percent escape in a path, and records the error", async () => {
    fake = await startFakeGithub();
    const bad = await send(fake.origin, "GET", "/repos/octo/%E0%A4%A/pulls");
    expect(bad.status).toBe(400);
    expect(fake.state.calls[0]?.error).toContain("URIError");
    expect((await send(fake.origin, "GET", "/app")).status).toBe(200);
  });

  it("answers 500 when a handler throws, keeps serving, and records the error", async () => {
    fake = await startFakeGithub();
    fake.state.addRepo("octo/one");
    // A repositories list that is not a list makes the minting handler throw.
    const broken = await send(fake.origin, "POST", "/app/installations/7/access_tokens", { repositories: 5 });
    expect(broken.status).toBe(500);
    expect(fake.state.calls[0]?.error).toMatch(/^\w+Error:/);
    expect((await send(fake.origin, "GET", "/app")).status).toBe(200);
  });

  it("records the query string of each call", async () => {
    fake = await startFakeGithub();
    await send(fake.origin, "GET", "/repos/octo/one/pulls?state=open&per_page=50");
    expect(fake.state.calls[0]?.query).toBe("state=open&per_page=50");
  });
});
