import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type GithubBed, startGithubBed } from "./testing/bed.ts";
import { BOX_PERMISSIONS } from "./tokens.ts";

let bed: GithubBed;
beforeEach(async () => {
  bed = await startGithubBed();
  bed.fake.state.addRepo("octo/hello");
  bed.fake.state.addRepo("octo/other");
});
afterEach(() => bed.close());

describe("tokens", () => {
  it("mints a token limited to one repository and the asked permissions", async () => {
    const minted = await bed.core.tokens.mint("octo/hello", BOX_PERMISSIONS);
    expect(minted.token).toMatch(/^ghs_/);
    expect(minted.expiresAt).toBeGreaterThan(0);
    const [record] = bed.fake.state.minted;
    expect(record?.repositories).toEqual(["octo/hello"]);
    expect(record?.permissions).toEqual({ contents: "write", pull_requests: "write" });
    // The lookup used the App JWT, the mint the same; the installation is cached for the next mint.
    await bed.core.tokens.mint("octo/hello", BOX_PERMISSIONS);
    expect(bed.fake.state.callsTo("GET /repos/:o/:r/installation")).toHaveLength(1);
    expect(bed.fake.state.calls[0]?.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("remembers the tokens it minted until they expire, for value redaction", async () => {
    expect(bed.core.tokens.liveValues()).toEqual([]);
    const first = await bed.core.tokens.mint("octo/hello", BOX_PERMISSIONS);
    const second = await bed.core.tokens.mint("octo/other", BOX_PERMISSIONS);
    expect(bed.core.tokens.liveValues().sort()).toEqual([first.token, second.token].sort());
    await bed.clock.advance(5 * 365 * 86_400_000); // the fake clock starts in 2023, the fake GitHub dates tokens by the real one
    expect(bed.core.tokens.liveValues()).toEqual([]);
  });

  it("never asks administration for a box", async () => {
    await expect(
      bed.core.tokens.mint("octo/hello", { contents: "write", administration: "write" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(bed.fake.state.minted).toEqual([]);
    expect(bed.fake.state.calls).toEqual([]);
  });

  it("refuses an answer that grants more than asked", async () => {
    bed.fake.state.respond("POST /app/installations/:id/access_tokens", {
      status: 201,
      body: {
        token: "ghs_wide",
        expires_at: new Date(bed.clock.now() + 3_600_000).toISOString(),
        permissions: { contents: "write", administration: "write" },
        repositories: [{ full_name: "octo/hello" }],
      },
    });
    await expect(bed.core.tokens.mint("octo/hello", BOX_PERMISSIONS)).rejects.toBeInstanceOf(PapError);
  });

  it("maps an unknown repository to not_found and a rate limit to capacity", async () => {
    await expect(bed.core.tokens.mint("octo/missing", BOX_PERMISSIONS)).rejects.toMatchObject({
      code: "not_found",
    });
    bed.fake.state.fail("GET /repos/:o/:r/installation", 429);
    await expect(bed.core.tokens.installationFor("octo/other")).rejects.toMatchObject({ code: "capacity" });
    bed.fake.state.fail("GET /repos/:o/:r/installation", 403, "denied");
    await expect(bed.core.tokens.installationFor("octo/other")).rejects.toMatchObject({ code: "forbidden" });
    bed.fake.state.fail("GET /repos/:o/:r/installation", 500);
    await expect(bed.core.tokens.installationFor("octo/other")).rejects.toMatchObject({
      code: "github_unavailable",
    });
  });
});
