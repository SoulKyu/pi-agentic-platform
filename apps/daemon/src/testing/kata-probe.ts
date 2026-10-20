import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A Pi package whose one tool, `probe`, runs a shell command as the worker itself: guest root, no bwrap, the guest's network.
 * The Kata tests use it to look at the VM from inside (its processes, its sockets, its network); the agent's own `bash` is the
 * sandboxed shell and sees none of that. The package lives outside the agent folder, so the profile build copies it (`local/probe`).
 */
const EXTENSION = `import { execFile } from "node:child_process";
export default function (pi) {
  pi.registerTool({
    name: "probe",
    label: "Probe",
    description: "Test probe: runs a command inside the VM as the worker.",
    parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
    async execute(_id, params) {
      const text = await new Promise((resolve) => {
        execFile("/bin/sh", ["-c", params.cmd], { timeout: 60000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
          resolve(String(stdout) + String(stderr) + (error ? "\\nexit: " + (error.code ?? error.signal ?? "error") : "\\nexit: 0"));
        });
      });
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
`;

/** Writes the package into `<root>/probe` and returns that folder. */
export function writeProbePackage(root: string): string {
  const dir = join(root, "probe");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "t20a-probe", version: "1.0.0", type: "module", pi: { extensions: ["./index.js"] } })}\n`,
  );
  writeFileSync(join(dir, "index.js"), EXTENSION);
  // AVM-P19: a link inside the package is copied as a link; one that leaves the package is left out of the image.
  symlinkSync("index.js", join(dir, "alias.js"));
  symlinkSync("/etc/hostname", join(dir, "outside"));
  return dir;
}
