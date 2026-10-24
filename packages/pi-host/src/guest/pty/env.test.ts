import { describe, expect, it } from "vitest";
import { ptyEnv } from "./env.ts";

describe("ptyEnv", () => {
  it("puts the wrapper folder first, sets home, term and language, and carries the proxy, never the token", () => {
    const env = ptyEnv(
      { PATH: "/usr/bin", PAP_GUEST_PROXY: "10.213.0.1:7843", PAP_GATEWAY_TOKEN: "secret", FOO: "x" },
      { home: "/boxes/p/home" },
      "10.213.0.1",
    );
    expect(env).toMatchObject({
      PATH: "/opt/pap/pi-host/bin:/usr/bin",
      HOME: "/boxes/p/home",
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      HTTPS_PROXY: "http://10.213.0.1:7843",
      NODE_USE_ENV_PROXY: "1",
    });
    expect(JSON.stringify(env)).not.toContain("secret");
    expect(env).not.toHaveProperty("FOO");
  });

  it("has no proxy variables without a proxy, and a default PATH without one", () => {
    const env = ptyEnv({}, { home: "/h" }, undefined);
    expect(env.PATH?.startsWith("/opt/pap/pi-host/bin:/usr/local/sbin:/usr/local/bin")).toBe(true);
    expect(env).not.toHaveProperty("HTTP_PROXY");
  });
});
