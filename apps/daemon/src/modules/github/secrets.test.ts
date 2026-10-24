import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOwnerSecrets } from "../agent-vm/index.ts";
import { createVaultStore } from "../secrets/index.ts";
import { type GithubBed, OWNER, startGithubBed } from "./testing/bed.ts";
import { assertBrowserCaller, createGithubModule, githubAppSecretValues } from "./index.ts";
import { BOX_PERMISSIONS } from "./tokens.ts";

describe("secrets never leave", () => {
  it("no secret value appears in logged lines or returned objects", async () => {
    const bed: GithubBed = await startGithubBed();
    try {
      bed.fake.state.addRepo("octo/hello");
      const response = await fetch(`${bed.fake.origin}/login/oauth/access_token`, {
        method: "POST",
        body: JSON.stringify({ code: "c1" }),
      });
      bed.core.userTokens.store(
        OWNER,
        (await response.json()) as Parameters<typeof bed.core.userTokens.store>[1],
      );
      const minted = await bed.core.tokens.mint("octo/hello", BOX_PERMISSIONS);
      await bed.clock.advance(28_800_000);
      const refreshed = await bed.core.userTokens.get(OWNER);
      // A failing path too: a refused refresh and a missing repository.
      bed.fake.state.userTokens.refresh = "ghr_spent";
      await bed.clock.advance(28_800_000);
      await bed.core.userTokens.get(OWNER).catch(() => undefined);
      await bed.core.tokens.mint("octo/missing", BOX_PERMISSIONS).catch(() => undefined);
      bed.core.appSecrets.forget();
      await bed.core.tokens.mint("octo/hello", BOX_PERMISSIONS).catch(() => undefined);

      const secrets = [
        bed.app.clientSecret,
        bed.app.privateKey,
        ...bed.app.privateKey.split("\n").filter((line) => line.length > 20),
        minted.token,
        refreshed,
        bed.fake.state.userTokens.access,
      ];
      const logged = JSON.stringify(bed.lines);
      const returned = JSON.stringify([bed.core.appSecrets.status(), bed.core.userTokens.state(OWNER)]);
      for (const secret of secrets) {
        expect(logged).not.toContain(secret);
        expect(returned).not.toContain(secret);
      }
      expect(bed.lines.length).toBeGreaterThan(0);
    } finally {
      await bed.close();
    }
  });

  it("the owner-secrets collector knows the App key, the client secret and the user tokens", async () => {
    const bed = await startGithubBed();
    try {
      bed.core.userTokens.store(OWNER, {
        access_token: "ghu_0123456789abcdef",
        refresh_token: "ghr_0123456789abcdef",
        expires_in: 3600,
        refresh_token_expires_in: 7200,
      });
      const vault = createVaultStore(join(bed.home, "secrets", "vault"), { sweep: false });
      const collector = createOwnerSecrets({
        logger: bed.logger,
        auth: async () => ({ values: [], providers: [] }),
        vault: () => vault.everyValue(),
        claudeToken: () => null,
        extra: () => githubAppSecretValues(join(bed.home, "secrets"), bed.logger),
      });
      const { secrets } = await collector();
      for (const value of [
        bed.app.clientSecret,
        bed.app.privateKey,
        "ghu_0123456789abcdef",
        "ghr_0123456789abcdef",
      ])
        expect(secrets).toContain(value);
    } finally {
      await bed.close();
    }
  });

  it("refuses origins other than GitHub's outside a test", () => {
    const base = { home: "/nonexistent", clock: undefined as never, logger: undefined as never };
    const vault = undefined as unknown as ReturnType<typeof createVaultStore>;
    expect(() => createGithubModule({ ...base, vault, apiOrigin: "http://127.0.0.1:1" })).toThrow();
    expect(() => createGithubModule({ ...base, vault, webOrigin: "https://evil.example" })).toThrow();
    expect(createGithubModule({ ...base, vault }).cloneUrl("octo/hello")).toBe(
      "https://github.com/octo/hello.git",
    );
  });

  it("answers forbidden to a token caller on a browser-only method", () => {
    expect(() => assertBrowserCaller("github.startCreate", { kind: "token" })).toThrow(/permission/);
    expect(() => assertBrowserCaller("github.startCreate", { kind: "session" })).not.toThrow();
    expect(() => assertBrowserCaller("projects.github", { kind: "token" })).not.toThrow();
  });
});
