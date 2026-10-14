import { describe, expect, it } from "vitest";
import { ENV_SIGN_IN_VARS, envSignInOf } from "./env-sign-in.ts";

describe("env sign-in names (MC26)", () => {
  it("names the variables of a built-in provider and says which are set, never their value", () => {
    const secret = "sk-env-secret-value";
    const view = envSignInOf("anthropic", { ANTHROPIC_API_KEY: secret, ANTHROPIC_OAUTH_TOKEN: "" });
    expect(view).toEqual([
      { name: "ANTHROPIC_AUTH_TOKEN", set: false },
      { name: "ANTHROPIC_OAUTH_TOKEN", set: false },
      { name: "ANTHROPIC_API_KEY", set: true },
    ]);
    expect(JSON.stringify(view)).not.toContain(secret);
  });

  it("says nothing for a provider the table does not know (a models.json one, an ambient-credential one)", () => {
    expect(envSignInOf("mine", { MINE_API_KEY: "x" })).toEqual([]);
    expect(envSignInOf("amazon-bedrock", { AWS_PROFILE: "x" })).toEqual([]);
  });

  it("only names variables of providers Pi ships, so a renamed provider shows up here", async () => {
    const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
    const ids = new Set(builtinProviders().map((provider) => provider.id));
    expect(Object.keys(ENV_SIGN_IN_VARS).filter((id) => !ids.has(id))).toEqual([]);
  });

  it("only names well-formed variable names", () => {
    const names = Object.values(ENV_SIGN_IN_VARS).flat();
    expect(names.filter((name) => !/^[A-Z][A-Z0-9_]{1,63}$/.test(name))).toEqual([]);
  });
});
