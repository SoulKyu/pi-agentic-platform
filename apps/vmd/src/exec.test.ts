import { describe, expect, it } from "vitest";
import { createExec } from "./exec.ts";

describe("createExec", () => {
  const exec = createExec();

  it("runs a program without a shell and returns its code, stdout and stderr", async () => {
    const result = await exec([
      process.execPath,
      "-e",
      'process.stdout.write(process.argv[1]); process.stderr.write("e"); process.exit(3)',
      "$(echo x); y",
    ]);
    expect(result).toEqual({ code: 3, stdout: "$(echo x); y", stderr: "e" });
  });

  it("answers code -1 for a program that does not exist", async () => {
    await expect(exec(["/nonexistent/pap-vmd-test"])).resolves.toMatchObject({ code: -1, stdout: "" });
  });

  it("passes the child a fixed environment, not pap-vmd's", async () => {
    process.env.PAP_VMD_TEST_SECRET = "s3cret";
    try {
      const result = await exec([
        process.execPath,
        "-e",
        "process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))",
      ]);
      expect(JSON.parse(result.stdout)).toEqual(["LANG", "PATH"]);
    } finally {
      delete process.env.PAP_VMD_TEST_SECRET;
    }
  });
});
