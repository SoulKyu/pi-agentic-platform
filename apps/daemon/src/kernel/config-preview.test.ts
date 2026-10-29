import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.ts";
import { parsePreview, previewOriginOf } from "./config-preview.ts";

const refuse = (message: string) => new ConfigError(message);
const parse = (
  over: {
    flag?: string;
    env?: NodeJS.ProcessEnv;
    port?: number;
    insecureHttp?: boolean;
    appOrigins?: string[];
  } = {},
) =>
  parsePreview(
    {
      flag: over.flag,
      env: over.env ?? {},
      port: over.port ?? 7777,
      insecureHttp: over.insecureHttp ?? false,
      appOrigins: new Set(over.appOrigins ?? []),
    },
    refuse,
  );
const message = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).message;
  }
  throw new Error("expected a ConfigError");
};

describe("preview port", () => {
  it("defaults to the main port plus one", () => {
    expect(parse()).toEqual({ previewPort: 7778, previewOrigin: null });
  });
  it("reads PAP_PREVIEW_PORT, and --preview-port beats it", () => {
    expect(parse({ env: { PAP_PREVIEW_PORT: "9100" } }).previewPort).toBe(9100);
    expect(parse({ flag: "9200", env: { PAP_PREVIEW_PORT: "9100" } }).previewPort).toBe(9200);
  });
  it("gives 0 (ephemeral) when the main port is 0, whatever else is set", () => {
    expect(parse({ port: 0 }).previewPort).toBe(0);
    expect(parse({ port: 0, flag: "9200" }).previewPort).toBe(0);
  });
  it("refuses the main port, a bad value and a default past 65535, with fixed sentences", () => {
    const equal = message(() => parse({ flag: "7777" }));
    expect(equal).toBe("the preview port must differ from the port of the app");
    expect(message(() => parse({ env: { PAP_PREVIEW_PORT: "7777" } }))).toBe(equal);
    const bad = message(() => parse({ flag: "70000" }));
    expect(bad).toBe("--preview-port must be an integer from 1 to 65535");
    expect(message(() => parse({ env: { PAP_PREVIEW_PORT: "x7" } }))).not.toContain("x7");
    expect(message(() => parse({ port: 65_535 }))).toBe(
      "the app is on port 65535: set --preview-port or PAP_PREVIEW_PORT",
    );
    expect(parse({ port: 65_535, flag: "65534" }).previewPort).toBe(65_534);
  });
  it("is wired into loadConfig and the --preview-port flag", () => {
    const base = {
      cwd: "/tmp",
      homedir: "/home/u",
      totalMemMb: 16_384,
      piHostEntry: "/x/main.js",
      piHostExecArgv: [],
      staticRoot: null,
    };
    const config = loadConfig({ ...base, argv: ["--preview-port", "9300"], env: {} });
    expect(config.previewPort).toBe(9300);
    expect(config.previewOrigin).toBeNull();
    expect(loadConfig({ ...base, argv: [], env: {} }).previewPort).toBe(7778);
  });
});

describe("preview origin", () => {
  const origin = (value: string, insecureHttp = false) =>
    parse({ env: { PAP_PREVIEW_ORIGIN: value }, insecureHttp }).previewOrigin;
  it("accepts https, and http to a loopback host", () => {
    expect(origin("https://p.example")).toBe("https://p.example");
    expect(origin("http://localhost:7778")).toBe("http://localhost:7778");
    expect(origin("http://127.0.0.1:7778")).toBe("http://127.0.0.1:7778");
    expect(origin("http://[::1]:7778")).toBe("http://[::1]:7778");
  });
  it("refuses http to another host unless --insecure-http", () => {
    const refused = message(() => origin("http://192.0.2.1:7778"));
    expect(refused).toBe(
      "PAP_PREVIEW_ORIGIN must be an https:// origin (http:// only for localhost or with --insecure-http)",
    );
    expect(refused).not.toContain("192.0.2.1");
    expect(origin("http://192.0.2.1:7778", true)).toBe("http://192.0.2.1:7778");
  });
  it("keeps only the origin: credentials, path and query are dropped", () => {
    expect(origin("https://user:secret@p.example/path?q=1")).toBe("https://p.example");
  });
  it("refuses a value that is not an origin, without echoing it", () => {
    const text = message(() => origin("not a url secret-value"));
    expect(text).toBe("PAP_PREVIEW_ORIGIN must be an origin such as https://preview.example.net");
    expect(text).not.toContain("secret-value");
    expect(() => origin("ftp://p.example")).toThrow(ConfigError);
  });
  it("refuses an origin of the app (public or allowed), without echoing it", () => {
    const apps = ["https://pap.example", "http://localhost:7777"];
    const text = message(() =>
      parse({ env: { PAP_PREVIEW_ORIGIN: "https://pap.example/anything" }, appOrigins: apps }),
    );
    expect(text).toBe("PAP_PREVIEW_ORIGIN must differ from the origins of the app");
    expect(text).not.toContain("pap.example");
    expect(() => parse({ env: { PAP_PREVIEW_ORIGIN: "http://localhost:7777" }, appOrigins: apps })).toThrow(
      ConfigError,
    );
    expect(parse({ env: { PAP_PREVIEW_ORIGIN: "https://p.example" }, appOrigins: apps }).previewOrigin).toBe(
      "https://p.example",
    );
  });
  it("is wired into loadConfig: the public origin as the preview origin is refused", () => {
    expect(() =>
      loadConfig({
        cwd: "/tmp",
        homedir: "/home/u",
        totalMemMb: 16_384,
        piHostEntry: "/x/main.js",
        piHostExecArgv: [],
        staticRoot: null,
        argv: [],
        env: { PAP_PUBLIC_ORIGIN: "https://pap.example", PAP_PREVIEW_ORIGIN: "https://pap.example" },
      }),
    ).toThrow("PAP_PREVIEW_ORIGIN must differ from the origins of the app");
  });
  it("treats an empty value as unset", () => {
    expect(origin("")).toBeNull();
  });
});

describe("previewOriginOf", () => {
  it("keeps the public origin's scheme and host and swaps in the bound port", () => {
    expect(previewOriginOf("http://localhost:7777", 7778, null)).toBe("http://localhost:7778");
    expect(previewOriginOf("https://pap.example", 8443, null)).toBe("https://pap.example:8443");
    expect(previewOriginOf("http://[::1]:7777", 40_001, null)).toBe("http://[::1]:40001");
  });
  it("prefers the override", () => {
    expect(previewOriginOf("http://localhost:7777", 7778, "https://p.example")).toBe("https://p.example");
  });
});
