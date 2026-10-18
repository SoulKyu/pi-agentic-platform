import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSystemd } from "../service/systemd.ts";
import { CHECKS_SYSTEM } from "./checks-system.ts";
import { ctx, fake, run, tools } from "../testing/doctor-fixture.ts";

describe("registry", () => {
  it("lists the seven system checks in the documented order", () => {
    expect(CHECKS_SYSTEM.map((c) => c.id)).toEqual([
      "node",
      "toolchain",
      "user_manager",
      "linger",
      "journal",
      "disk",
      "home",
    ]);
    expect(new Set(CHECKS_SYSTEM.map((c) => c.title)).size).toBe(7);
  });
});

describe("node", () => {
  it.each([
    ["24.14.0", "ok"],
    ["24.15.1", "ok"],
    ["24.99.0", "ok"],
    ["25.0.0", "warn"],
    ["26.2.0", "warn"],
    ["24.13.9", "fail"],
    ["23.9.0", "fail"],
    ["22.20.0", "fail"],
    ["not-a-version", "fail"],
  ])("node %s is %s", async (nodeVersion, status) => {
    const result = await run("node", ctx(), { nodeVersion });
    expect(result.status).toBe(status);
    if (status === "fail") expect(result.fix).toContain("24.14");
    if (status === "warn")
      expect(result.detail).toBe(
        `pap is tested on Node 24; Node ${nodeVersion.split(".")[0]} is not supported yet`,
      );
  });
});

describe("toolchain", () => {
  const tool = (name: string) => writeFileSync(join(tools, name), "#!/bin/sh\n", { mode: 0o755 });

  it("is ok when the four tools are on the PATH", async () => {
    for (const name of ["gcc", "g++", "make", "python3"]) tool(name);
    expect((await run("toolchain", ctx({ path: tools }))).status).toBe("ok");
  });

  it("is info, never warn, and names the missing tools", async () => {
    tool("gcc");
    tool("make");
    const result = await run("toolchain", ctx({ path: `${tools}:relative/bin:.` }));
    expect(result.status).toBe("info");
    expect(result.detail).toContain("g++");
    expect(result.detail).toContain("python3");
    expect(result.detail).not.toContain("gcc");
    expect(result.detail).toContain("only needed for method 1 and `npm install`");
    expect(result.fix).toContain("apt");
  });
});

describe("user_manager and linger", () => {
  it("user manager reachable is ok, and asks only show-environment", async () => {
    expect((await run("user_manager", ctx())).status).toBe("ok");
    expect(fake.calls()).toEqual(["systemctl --user show-environment"]);
  });

  it("an unreachable user manager is a fail with a command", async () => {
    fake.set("fail-show-environment", "");
    const result = await run("user_manager", ctx());
    expect(result.status).toBe("fail");
    expect(result.fix).toContain("loginctl enable-linger");
    expect(result.detail).not.toContain("SECRET-STDERR");
  });

  it("a missing systemctl binary is a fail too, not a crash", async () => {
    expect((await run("user_manager", ctx({ path: tools }))).status).toBe("fail");
  });

  it("linger yes is ok, no is a warn with the command", async () => {
    expect((await run("linger", ctx())).status).toBe("ok");
    fake.set("linger", "no\n");
    const result = await run("linger", ctx());
    expect(result.status).toBe("warn");
    expect(result.fix).toBe("loginctl enable-linger");
    expect(fake.calls().every((c) => c.startsWith("loginctl show-user"))).toBe(true);
  });

  it.each(["user_manager", "linger", "journal"])(
    "%s is skipped in a container, without a call",
    async (id) => {
      const result = await run(id, ctx({ inContainer: true }));
      expect(result).toMatchObject({ status: "skip", detail: "not applicable in a container" });
      expect(fake.calls()).toEqual([]);
    },
  );
});

describe("journal", () => {
  it("volatile storage (no /var/log/journal, no Storage=persistent) is a warn with the M6 prerequisite", async () => {
    const result = await run("journal", ctx(), { journalDirExists: () => false });
    expect(result.status).toBe("warn");
    expect(result.fix).toBe("sudo mkdir -p /var/log/journal && sudo systemctl restart systemd-journald");
  });

  it("a Storage=persistent line makes it ok; a commented one does not", async () => {
    const none = { journalDirExists: () => false };
    const yes = await run("journal", ctx(), {
      ...none,
      journaldConf: () => ["[Journal]\n Storage = persistent \n"],
    });
    expect(yes.status).toBe("ok");
    const commented = await run("journal", ctx(), {
      ...none,
      journaldConf: () => ["#Storage=persistent\nStorage=auto\n"],
    });
    expect(commented.status).toBe("warn");
  });

  it("an active unit with an empty journal is a warn that names exit 3", async () => {
    fake.set("active", "yes\n");
    fake.set("active-enter", "Fri 2026-10-16 10:00:00 UTC\n");
    fake.set("journal-any", "");
    const result = await run("journal", ctx());
    expect(result.status).toBe("warn");
    expect(result.detail).toBe(
      "the journal holds no line for pap.service: `pap service install` and `pap update apply` cannot verify a start (exit 3)",
    );
    expect(result.fix).toContain("systemd-journald");
  });

  it("an active unit with journal lines is ok and the lines are never printed", async () => {
    fake.set("active", "yes\n");
    fake.set("active-enter", "Fri 2026-10-16 10:00:00 UTC\n");
    fake.set("journal-any", '{"msg":"setup_url","url":"http://localhost:7777/setup?token=ONE-TIME"}\n');
    const result = await run("journal", ctx());
    expect(result.status).toBe("ok");
    expect(JSON.stringify(result)).not.toContain("ONE-TIME");
  });

  it("a journal that cannot be read is its own warn, not the empty-journal one", async () => {
    fake.set("active", "yes\n");
    fake.set("active-enter", "Fri 2026-10-16 10:00:00 UTC\n");
    fake.set("fail-journal", "");
    const result = await run("journal", ctx());
    expect(result.status).toBe("warn");
    expect(result.detail).toBe("the journal of pap.service cannot be read");
    expect(result.detail).not.toContain("holds no line");
    expect(result.fix).toBe("journalctl --user -u pap.service -n 5");
    expect(JSON.stringify(result)).not.toContain("SECRET-STDERR");
  });

  it("an inactive unit has nothing to look for", async () => {
    fake.set("active", "no\n");
    expect((await run("journal", ctx())).status).toBe("ok");
    expect(fake.calls().some((c) => c.startsWith("journalctl"))).toBe(false);
  });

  it("uses the unit of the context", async () => {
    fake.set("active", "yes\n");
    fake.set("active-enter", "Fri 2026-10-16 10:00:00 UTC\n");
    fake.set("journal-any", "");
    const env = { PATH: `${fake.binDir}:/usr/bin:/bin` };
    const result = await run(
      "journal",
      ctx({ unitName: "pap-preview.service", systemd: createSystemd(env, { unit: "pap-preview.service" }) }),
    );
    expect(result.detail).toContain("pap-preview.service");
    expect(fake.calls().some((c) => c.includes("-u pap-preview.service"))).toBe(true);
  });
});
