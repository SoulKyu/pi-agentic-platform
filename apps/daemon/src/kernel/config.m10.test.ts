import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, type ConfigInput } from "./config.ts";

const input = (env: NodeJS.ProcessEnv): ConfigInput => ({
  argv: [],
  env,
  cwd: "/tmp",
  homedir: "/home/u",
  totalMemMb: 16_384,
  piHostEntry: "/x/main.js",
  piHostExecArgv: [],
  staticRoot: null,
});

describe("PAP_METRICS_TOKEN", () => {
  it("is off when unset", () => {
    expect(loadConfig(input({})).metricsToken).toBeNull();
  });

  it("is kept when it has the right shape", () => {
    const token = "Zk3._~+/=-".repeat(4);
    expect(loadConfig(input({ PAP_METRICS_TOKEN: token })).metricsToken).toBe(token);
  });

  it.each([
    ["too short", "short-but-secret-looking"],
    ["empty", ""],
    ["a space inside", `${"a".repeat(20)} ${"b".repeat(20)}`],
    ["too long", "a".repeat(257)],
  ])("stops the daemon at boot when %s, naming the variable and never the value", (_name, value) => {
    let message = "";
    try {
      loadConfig(input({ PAP_METRICS_TOKEN: value }));
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      message = (error as Error).message;
    }
    expect(message).toContain("PAP_METRICS_TOKEN");
    if (value.length > 3) expect(message).not.toContain(value.slice(0, 6));
  });
});

describe("PAP_OTLP_ENDPOINT", () => {
  const withEndpoint = (endpoint: string, more: NodeJS.ProcessEnv = {}) =>
    loadConfig(input({ PAP_OTLP_ENDPOINT: endpoint, ...more }));
  const message = (env: NodeJS.ProcessEnv): string => {
    try {
      loadConfig(input(env));
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as Error).message;
    }
    return "";
  };

  it("is off when unset or empty, whatever the other variables hold", () => {
    expect(loadConfig(input({})).otlp).toBeNull();
    expect(loadConfig(input({ PAP_OTLP_ENDPOINT: "" })).otlp).toBeNull();
    expect(loadConfig(input({ PAP_OTLP_HEADERS: "a=b", PAP_OTLP_SERVICE_NAME: "x" })).otlp).toBeNull();
  });

  it.each(["http://localhost:4318", "http://127.0.0.1:4318/", "http://[::1]:4318", "https://otel.example"])(
    "accepts %s",
    (endpoint) => {
      expect(withEndpoint(endpoint).otlp?.endpoint).toBe(endpoint.replace(/\/$/, ""));
    },
  );

  it.each([
    "http://collector:4318",
    "http://10.0.0.5:4318",
    "http://localhost.evil.example",
    "http://127.0.0.1.evil.example",
    "ftp://otel.example",
    "otel.example:4318",
    "https://user:secret-pass@otel.example",
    "https://otel.example/?token=secret-query",
    "not a url",
  ])("stops the daemon at boot for %s, without echoing it", (endpoint) => {
    const text = message({ PAP_OTLP_ENDPOINT: endpoint });
    expect(text).toContain("PAP_OTLP_ENDPOINT");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("collector");
  });

  it("defaults the service name to pap and takes PAP_OTLP_SERVICE_NAME", () => {
    expect(withEndpoint("https://otel.example").otlp?.serviceName).toBe("pap");
    expect(
      withEndpoint("https://otel.example", { PAP_OTLP_SERVICE_NAME: "pap-home" }).otlp?.serviceName,
    ).toBe("pap-home");
    expect(message({ PAP_OTLP_ENDPOINT: "https://otel.example", PAP_OTLP_SERVICE_NAME: "a b" })).toContain(
      "PAP_OTLP_SERVICE_NAME",
    );
  });
});

describe("PAP_OTLP_HEADERS", () => {
  const base = { PAP_OTLP_ENDPOINT: "https://otel.example" };
  const failure = (headers: string): string => {
    try {
      loadConfig(input({ ...base, PAP_OTLP_HEADERS: headers }));
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as Error).message;
    }
    return "";
  };

  it("reads name=value pairs, and none when unset or empty", () => {
    const parsed = loadConfig(input({ ...base, PAP_OTLP_HEADERS: "x-key=a=b,Authorization=Bearer abc" }));
    expect(parsed.otlp?.headers()).toEqual({ "x-key": "a=b", Authorization: "Bearer abc" });
    expect(loadConfig(input(base)).otlp?.headers()).toEqual({});
    expect(loadConfig(input({ ...base, PAP_OTLP_HEADERS: "" })).otlp?.headers()).toEqual({});
  });

  it("accepts 8 pairs and refuses 9, never echoing a value", () => {
    const pairs = (count: number) =>
      Array.from({ length: count }, (_, i) => `h${i}=secret-value-${i}`).join(",");
    expect(loadConfig(input({ ...base, PAP_OTLP_HEADERS: pairs(8) })).otlp?.headers()).toHaveProperty("h7");
    const text = failure(pairs(9));
    expect(text).toContain("PAP_OTLP_HEADERS");
    expect(text).not.toContain("secret-value");
  });

  it.each([
    ["a name with a space", "bad name=secret-value"],
    ["a name that is empty", "=secret-value"],
    ["a name of 65 characters", `${"n".repeat(65)}=secret-value`],
    ["a pair without =", "secret-value"],
    ["an empty pair", "a=b,"],
    ["a value with a newline", "a=secret\nvalue"],
    ["a value with a control character", "a=secret\u0007value"],
    ["a value outside ASCII", "a=secret-valué"],
    ["a value of 513 characters", `a=${"v".repeat(513)}`],
    ["an empty value", "a="],
  ])("stops the daemon at boot for %s, without echoing the value", (_name, headers) => {
    const text = failure(headers);
    expect(text).toContain("PAP_OTLP_HEADERS");
    expect(text).not.toContain("secret");
  });

  it("keeps the header values out of the config's JSON and its enumerable keys", () => {
    const parsed = loadConfig(input({ ...base, PAP_OTLP_HEADERS: "x-key=do-not-log-me" }));
    expect(JSON.stringify(parsed)).not.toContain("do-not-log-me");
    expect(JSON.stringify(parsed.otlp)).not.toContain("do-not-log-me");
  });
});

describe("PAP_MIN_FREE_DISK_MB", () => {
  const configError = (value: string): string => {
    try {
      loadConfig(input({ PAP_MIN_FREE_DISK_MB: value }));
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as Error).message;
    }
    return "";
  };

  it("defaults to 1024", () => {
    expect(loadConfig(input({})).minFreeDiskMb).toBe(1024);
  });

  it("takes a count, and 0 turns the floor off", () => {
    expect(loadConfig(input({ PAP_MIN_FREE_DISK_MB: "4096" })).minFreeDiskMb).toBe(4096);
    expect(loadConfig(input({ PAP_MIN_FREE_DISK_MB: "0" })).minFreeDiskMb).toBe(0);
  });

  it.each(["-1", "lots", "1.5", "1e3x"])("stops the daemon at boot for %s, naming the variable", (value) => {
    expect(configError(value)).toContain("PAP_MIN_FREE_DISK_MB");
  });
});

describe("PAP_TEST_OUTBOX_HOLD (M10R80)", () => {
  const withScript = { PAP_TEST_PROVIDER_SCRIPT: "/s.json" };
  const failure = (env: NodeJS.ProcessEnv): string => {
    try {
      loadConfig(input(env));
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as Error).message;
    }
    return "";
  };

  it("is off by default, and with the scripted provider when unset", () => {
    expect(loadConfig(input({})).testOutboxHold).toBeNull();
    expect(loadConfig(input(withScript)).testOutboxHold).toBeNull();
  });

  it.each(["task.start", "run.resume", "run.resume:sent", "cancel"])(
    "holds %s with the scripted provider",
    (hold) => {
      expect(loadConfig(input({ ...withScript, PAP_TEST_OUTBOX_HOLD: hold })).testOutboxHold).toBe(hold);
    },
  );

  it("stops the daemon at boot when it is set without the scripted provider, naming the variable only", () => {
    const text = failure({ PAP_TEST_OUTBOX_HOLD: "task.start" });
    expect(text).toContain("PAP_TEST_OUTBOX_HOLD");
    expect(text).toContain("PAP_TEST_PROVIDER_SCRIPT");
    expect(text).not.toContain("task.start");
  });

  it.each(["", "task.start:later", "nothing", "cancel:sent", "TASK.START"])(
    "stops the daemon at boot for %j, without echoing it",
    (hold) => {
      const text = failure({ ...withScript, PAP_TEST_OUTBOX_HOLD: hold });
      expect(text).toContain("PAP_TEST_OUTBOX_HOLD");
      if (hold.length > 3) expect(text).not.toContain(hold);
    },
  );
});
