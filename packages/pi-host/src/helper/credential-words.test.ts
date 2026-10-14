import { describe, expect, it } from "vitest";
import { COMMENT_WORD, CREDENTIAL_WORDS, credentialName } from "./credential-words.ts";

describe("credentialName: the one vocabulary of both maskers (MC40)", () => {
  it("lists the words of MC32 and MC41", () => {
    expect([...CREDENTIAL_WORDS]).toEqual([
      "key",
      "token",
      "secret",
      "password",
      "passwd",
      "auth",
      "bearer",
      "credential",
      "cookie",
      "pwd",
      "passphrase",
      "session",
      "signature",
    ]);
  });

  it.each([
    "--key",
    "X-Key",
    "ANTHROPIC_KEY",
    "openaiApiKey",
    "client_secret",
    "Authorization",
    "Set-Cookie",
    "PASS_WORD_X_PASSWD",
    "DB_PWD",
    "SESSION_ID",
    "X-Signature",
    "ssh_passphrase",
  ])("%s is a credential name", (name) => expect(credentialName(name)).toBe(true));

  it.each(["page", "--port", "HOME_DIR", "Content-Type", "x1"])("%s is not", (name) =>
    expect(credentialName(name)).toBe(false),
  );

  it("finds a word in a comment as it is written", () => {
    expect(COMMENT_WORD.test("my Token is below")).toBe(true);
    expect(COMMENT_WORD.test("nothing here")).toBe(false);
  });
});
