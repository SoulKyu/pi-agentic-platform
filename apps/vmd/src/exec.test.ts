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

  // T20a: buildctl writes its config under $DOCKER_CONFIG (default: root's home, read-only under ProtectSystem=strict).
  // Mutant: the variable dropped from the child's environment -> the real image.build fails with a "read-only file system" error.
  it("passes the child a fixed environment, not pap-vmd's, with a writable docker config folder", async () => {
    process.env.PAP_VMD_TEST_SECRET = "s3cret";
    try {
      const result = await exec([
        process.execPath,
        "-e",
        "process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))",
      ]);
      expect(JSON.parse(result.stdout)).toEqual(["DOCKER_CONFIG", "LANG", "PATH"]);
      const config = await exec([process.execPath, "-e", "process.stdout.write(process.env.DOCKER_CONFIG)"]);
      expect(config.stdout).toBe("/run/pap-vm/docker-config");
    } finally {
      delete process.env.PAP_VMD_TEST_SECRET;
    }
  });

  it("onLine receives each line as the child prints it", async () => {
    const seen: Array<[string, string]> = [];
    const result = await exec(
      [
        process.execPath,
        "-e",
        'process.stdout.write("a\\nb"); process.stderr.write("e1\\ne2\\n"); setTimeout(() => process.stdout.write("c\\n"), 20)',
      ],
      { onLine: (line, stream) => void seen.push([stream, line]) },
    );
    expect(seen).toContainEqual(["stdout", "a"]);
    expect(seen).toContainEqual(["stdout", "bc"]);
    expect(seen.filter(([stream]) => stream === "stderr").map(([, line]) => line)).toEqual(["e1", "e2"]);
    expect(result).toMatchObject({ code: 0, stdout: "a\nbc\n", stderr: "e1\ne2\n" });
  });
});
