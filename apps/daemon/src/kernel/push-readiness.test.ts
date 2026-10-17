import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pushReadiness } from "./push-readiness.ts";

const base = { tls: false, insecureHttp: false };

describe("pushReadiness", () => {
  it("is ready on an https origin even when TLS ends at a proxy", () => {
    expect(pushReadiness({ ...base, publicOrigin: "https://x.example" })).toEqual({
      status: "ready",
      origin: "https://x.example",
    });
  });

  it("is ready when pap serves TLS itself", () => {
    expect(
      pushReadiness({ publicOrigin: "https://x.example:7777", tls: true, insecureHttp: false }).status,
    ).toBe("ready");
  });

  it.each(["http://localhost:7777", "http://127.0.0.1:7777", "http://[::1]:7777"])(
    "is localhost_only for %s",
    (publicOrigin) => {
      const result = pushReadiness({ ...base, publicOrigin });
      expect(result.status).toBe("localhost_only");
      expect(result).toHaveProperty("hint");
    },
  );

  it("is insecure_http on a LAN address, with the routes in the agreed order", () => {
    const result = pushReadiness({
      publicOrigin: "http://192.168.1.182:7777",
      tls: false,
      insecureHttp: true,
    });
    if (result.status !== "insecure_http") throw new Error(`unexpected status ${result.status}`);
    expect(result.origin).toBe("http://192.168.1.182:7777");
    const order = ["ngrok", "Tailscale", "reverse proxy", "--tls-cert"].map((route) =>
      result.hint.indexOf(route),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(result.hint).toContain("PAP_PUBLIC_ORIGIN");
    expect(result.hint).not.toContain("trustProxy");
    expect(result.hint.length).toBeLessThanOrEqual(200);
  });

  it("is insecure_http for a non-local http origin without the flag too", () => {
    expect(pushReadiness({ ...base, publicOrigin: "http://pap.lan:7777" }).status).toBe("insecure_http");
  });

  it("is origin_mismatch when TLS is served but the origin says http", () => {
    const result = pushReadiness({ publicOrigin: "http://x.example", tls: true, insecureHttp: false });
    expect(result.status).toBe("origin_mismatch");
    expect(result).toHaveProperty("hint");
  });

  it.each(["not a url", "ftp://x.example", ""])(
    "is origin_mismatch for the unusable origin %j",
    (publicOrigin) => {
      expect(pushReadiness({ ...base, publicOrigin }).status).toBe("origin_mismatch");
    },
  );

  it("keeps every hint within the contract's 200 characters", () => {
    for (const publicOrigin of ["http://localhost:1", "http://10.0.0.5:1", "bad"]) {
      const result = pushReadiness({ ...base, publicOrigin });
      if ("hint" in result) expect(result.hint.length).toBeLessThanOrEqual(200);
    }
  });

  it("imports nothing from modules/, so the CLI can use it without the push module", () => {
    const source = readFileSync(new URL("./push-readiness.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map(
      (match) => match[1] ?? "",
    );
    expect(imports.filter((path) => path.includes("modules/"))).toEqual([]);
  });
});
