import { describe, expect, it } from "vitest";
import { MASK, maskArgs, maskCommandLine, maskUrl, tokenLike } from "./mask.ts";

describe("maskArgs: one word at a time (M7R83)", () => {
  const table: Array<[string, string[], string[]]> = [
    ["a credential flag with a glued value", ["--api-key=sk-live-123"], [`--api-key=${MASK}`]],
    ["a credential flag hides the next word", ["--token", "abc"], ["--token", MASK]],
    ["-k hides the next word", ["-k", "abc"], ["-k", MASK]],
    ["a one-argument header", ["Authorization: Bearer x"], [`Authorization: ${MASK}`]],
    ["a scheme word hides the next word", ["Bearer", "xyz"], ["Bearer", MASK]],
    ["a name=value pair with a credential name", ["API_KEY=x"], [`API_KEY=${MASK}`]],
    ["a flag value that is a variable is kept", ["--api-key=${OPENAI_KEY}"], ["--api-key=${OPENAI_KEY}"]],
    ["a capitals variable is kept", ["$OPENAI_KEY"], ["$OPENAI_KEY"]],
    ["a variable after a credential flag is kept", ["--token", "$OPENAI_KEY"], ["--token", "$OPENAI_KEY"]],
    ["a pair value that is a variable is kept", ["API_KEY=${KEY}"], ["API_KEY=${KEY}"]],
    ["$Passw0rd (not capitals) after a credential flag", ["--password", "$Passw0rd"], ["--password", MASK]],
    ["$Passw0rd (not capitals) when token-like", ["$Passw0rd1234567890abcdefgh"], [MASK]],
    [
      "a URL argument",
      ["https://user:pass@h.example/p?token=abc&page=2"],
      [`https://${MASK}@h.example/p?token=${MASK}&page=2`],
    ],
    [
      "a plain package command",
      ["-y", "@modelcontextprotocol/server-filesystem", "."],
      ["-y", "@modelcontextprotocol/server-filesystem", "."],
    ],
    ["a token-like word", ["sk-live-abcdefghijklmnopqrstuvwxyz0123456789"], [MASK]],
    [
      "a shell line in one argument",
      ["-c", "npx -y server --api-key sk-live-abcdefghijklmnopqrstuvwxyz0123"],
      ["-c", `npx -y server --api-key ${MASK}`],
    ],
    [
      "a scheme and token in one argument",
      ["Bearer sk-live-abcdefghijklmnopqrstuvwxyz0123"],
      [`Bearer ${MASK}`],
    ],
    ["a header value in the next argument", ["--header", "Bearer abc"], ["--header", `Bearer ${MASK}`]],
    ["a flag value with several words", ["--header=Bearer abc"], [`--header=Bearer ${MASK}`]],
    ["a URL in a flag value", ["--dsn=postgres://user:pa55word@db/x"], [`--dsn=postgres://${MASK}@db/x`]],
    [
      "a URL in a name=value pair",
      ["DATABASE_URL=postgres://user:pa55word@db/x"],
      [`DATABASE_URL=postgres://${MASK}@db/x`],
    ],
    [
      "a URL query in a flag value",
      ["--url=https://h.example/mcp?token=abc"],
      [`--url=https://h.example/mcp?token=${MASK}`],
    ],
    ["a bare --key flag hides the next word", ["--key", "hunter2secret"], ["--key", MASK]],
    ["a key header in one argument", ["X-Key: hunter2"], [`X-Key: ${MASK}`]],
    ["a pair whose name ends in KEY", ["ANTHROPIC_KEY=sk-ant-short"], [`ANTHROPIC_KEY=${MASK}`]],
    ["a flag whose name holds key", ["--openai_key=abc"], [`--openai_key=${MASK}`]],
    ["a pair whose name ends in PWD", ["DB_PWD=x"], [`DB_PWD=${MASK}`]],
    ["a passphrase flag hides the next word", ["--passphrase", "x"], ["--passphrase", MASK]],
    ["a session pair", ["SESSION_ID=x"], [`SESSION_ID=${MASK}`]],
    ["a signature header", ["X-Signature: x"], [`X-Signature: ${MASK}`]],
    ["a plain flag is kept", ["--port", "8080"], ["--port", "8080"]],
  ];
  it.each(table)("%s", (_label, input, expected) => {
    expect(maskArgs(input)).toEqual(expected);
  });

  // MC42: a shell line is split as a shell would split it, so a quoted word is read like a top-level argument.
  const token = "sk-live-abcdefghijklmnopqrstuvwxyz0123";
  const quoted: Array<[string, string[], string[]]> = [
    [
      "a quoted header with a token in a shell line",
      ["-c", `npx mcp-remote https://x/sse --header 'X-Api-Key: ${token}'`],
      ["-c", `npx mcp-remote https://x/sse --header 'X-Api-Key: ${MASK}'`],
    ],
    [
      "a quoted header with a short value in a shell line",
      ["-c", "npx mcp-remote https://x/sse --header 'X-Api-Key: sk-x'"],
      ["-c", `npx mcp-remote https://x/sse --header 'X-Api-Key: ${MASK}'`],
    ],
    [
      "a single-quoted token in a shell line",
      ["-c", `npx s --foo '${token}'`],
      ["-c", `npx s --foo ${MASK}`],
    ],
    [
      "a double-quoted token in a shell line",
      ["-c", `npx s --foo "${token}"`],
      ["-c", `npx s --foo ${MASK}`],
    ],
    [
      "a quoted URL with user information in a shell line",
      ["-c", "npx s --dsn 'postgres://u:p@h/db'"],
      ["-c", `npx s --dsn postgres://${MASK}@h/db`],
    ],
    [
      "a quoted credential flag in a shell line",
      ["-c", 'npx s "--api-key=abc"'],
      ["-c", `npx s --api-key=${MASK}`],
    ],
    [
      "escaped quotes inside a double-quoted shell line",
      ["-c", 'sh -c "curl -H \\"X-Api-Key: abc\\" https://h.example/mcp"'],
      ["-c", `sh -c "curl -H 'X-Api-Key: ${MASK}' https://h.example/mcp"`],
    ],
    ["a quoted argument with no space", [`'${token}'`], [MASK]],
    ["a header in a flag value", ["--header=X-Api-Key: abc"], [`--header=X-Api-Key: ${MASK}`]],
    [
      "an Authorization header in a flag value",
      ["--header=Authorization: abc"],
      [`--header=Authorization: ${MASK}`],
    ],
    ["a header with no space in a flag value", ["--header=X-Key:abc"], [`--header=X-Key: ${MASK}`]],
    ["a header joined to a short flag", ["-HX-Api-Key: abc"], [`-HX-Api-Key: ${MASK}`]],
    ["a header split in two words", ["-H", "X-Api-Key:", "abc"], ["-H", "X-Api-Key:", MASK]],
    [
      "a header split in words with a scheme",
      ["-H", "Authorization:", "Bearer", "abc"],
      ["-H", "Authorization:", "Bearer", MASK],
    ],
    ["a scheme after a credential flag", ["--token", "Bearer", "abc"], ["--token", "Bearer", MASK]],
    ["a credential pair in a flag value", ["--env=API_KEY=hunter2"], [`--env=API_KEY=${MASK}`]],
    [
      "an unterminated quote runs to the end and is still read as a line",
      ["-c", "npx s --header 'X-Api-Key: abc"],
      ["-c", `npx s --header 'X-Api-Key: ${MASK}'`],
    ],
    [
      "a word with a space that starts with a URL is read as a line, not as a URL",
      ["--note", `visit 'https://h/x and ${token}`],
      ["--note", `visit 'https://h/x and ${MASK}'`],
    ],
    ["a padded base64 token is no name=value", ["dGhpcyBpcyBhIHNlY3JldCB0b2tlbjEy=="], [MASK]],
  ];
  it.each(quoted)("%s", (_label, input, expected) => {
    expect(maskArgs(input)).toEqual(expected);
  });

  it("hides a value nested deeper than it reads, without running out of stack", () => {
    expect(maskArgs([`${"--a=".repeat(10_000)}b c`])).toEqual([`${"--a=".repeat(9)}${MASK}`]);
  });

  it("a hidden word is hidden even when the next word looks harmless", () => {
    expect(maskArgs(["--secret", "hello", "--port", "80"])).toEqual(["--secret", MASK, "--port", "80"]);
  });
});

describe("maskUrl", () => {
  it("masks userinfo, credential-named query values and keeps the rest", () => {
    expect(maskUrl("https://user:pass@h.example/p?token=abc&page=2")).toBe(
      `https://${MASK}@h.example/p?token=${MASK}&page=${encodeURIComponent("2")}`,
    );
    expect(maskUrl("postgres://u:p@db/x")).toBe(`postgres://${MASK}@db/x`);
  });

  it("masks a 40-character mixed token in a path segment", () => {
    const token = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0";
    expect(maskUrl(`https://h.example/v1/${token}/mcp`)).toBe(`https://h.example/v1/${MASK}/mcp`);
  });

  it("masks key, code and sig query values and a token-like value under any name", () => {
    expect(maskUrl("https://h.example/?key=abc&code=1&sig=2&x=1")).toBe(
      `https://h.example/?key=${MASK}&code=${MASK}&sig=${MASK}&x=1`,
    );
    expect(maskUrl(`https://h.example/?q=${"a1".repeat(14)}`)).toBe(`https://h.example/?q=${MASK}`);
  });

  it("keeps a variable in a query value and masks a token-like fragment", () => {
    expect(maskUrl("https://h.example/?token=${DOCS_TOKEN}")).toBe("https://h.example/?token=${DOCS_TOKEN}");
    expect(maskUrl("https://h.example/mcp/${DOCS_TOKEN}")).toBe("https://h.example/mcp/${DOCS_TOKEN}");
    expect(maskUrl(`https://h.example/#${"a1".repeat(14)}`)).toBe(`https://h.example/#${MASK}`);
  });

  it("masks a query value under a name that holds key", () => {
    expect(maskUrl("https://h.example/?openai_key=abc&page=2")).toBe(
      `https://h.example/?openai_key=${MASK}&page=2`,
    );
  });

  it("masks a fragment that carries parameters like a query", () => {
    expect(maskUrl("https://h.example/cb#access_token=ya29.abc&token_type=Bearer&state=xyz")).toBe(
      `https://h.example/cb#access_token=${MASK}&token_type=${MASK}&state=xyz`,
    );
    expect(maskUrl("https://h.example/#section")).toBe("https://h.example/#section");
  });

  it("masks a fragment in place, keeping its route and encoding (MC42)", () => {
    expect(maskUrl("https://h.example/#/cb?code=abc&state=xyz")).toBe(
      `https://h.example/#/cb?code=${MASK}&state=xyz`,
    );
    expect(maskUrl("https://h.example/#q=a+b")).toBe("https://h.example/#q=a+b");
    const token = "a1".repeat(14);
    expect(maskUrl(`https://h.example/#/cb/${token}?x=1`)).toBe(`https://h.example/#/cb/${MASK}?x=1`);
    expect(maskUrl(`https://h.example/#=${token}&x=1`)).toBe(`https://h.example/#=${MASK}&x=1`);
    // A standard base64 secret holds `/`: read whole, before its pieces.
    expect(maskUrl("https://h.example/#wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")).toBe(
      `https://h.example/#${MASK}`,
    );
  });

  it("returns a text that is not a URL unchanged, or masked when it looks like a token", () => {
    expect(maskUrl("not a url")).toBe("not a url");
    // A host that does not parse; the user information is still hidden.
    expect(maskUrl("https://user:pw@exa mple/mcp")).toBe(`https://${MASK}@exa mple/mcp`);
    expect(maskUrl("a1".repeat(14))).toBe(MASK);
  });
});

describe("maskCommandLine and tokenLike", () => {
  it("masks a whole command line word by word", () => {
    expect(maskCommandLine("npx -y server --token abc")).toBe(`npx -y server --token ${MASK}`);
    expect(maskCommandLine("npx -y @modelcontextprotocol/server-filesystem .")).toBe(
      "npx -y @modelcontextprotocol/server-filesystem .",
    );
  });

  it("calls a long URL-safe word with letters and digits token-like, and nothing shorter or plainer", () => {
    expect(tokenLike("a1".repeat(12))).toBe(true);
    expect(tokenLike("a1".repeat(11) + "a")).toBe(false);
    expect(tokenLike("abcdefghij".repeat(3))).toBe(false);
    expect(tokenLike("1234567890".repeat(3))).toBe(false);
    expect(tokenLike("has space and 1234567890123456")).toBe(false);
  });
});
