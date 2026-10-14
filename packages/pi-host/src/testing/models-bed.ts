import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HelperContext } from "../helper/ops.ts";

export const SECRET_MODELS_KEY = "sk-LITERAL-MODELS-JSON-SECRET";
export const SECRET_AUTH_KEY = "sk-ant-AUTH-JSON-SECRET";

export interface ModelsBed {
  readonly root: string;
  readonly home: string;
  readonly agentDir: string;
  /** A project folder under the home. */
  readonly project: string;
  context(options?: { cwd?: string }): HelperContext;
  write(path: string, value: unknown): Promise<void>;
  read(path: string): Promise<unknown>;
  /** Marks `cwd` as trusted in the agent directory's trust file (what the worker's own store reads). */
  trust(cwd: string): Promise<void>;
  cleanup(): Promise<void>;
}

/** A temporary home, agent directory and project: tests never touch `~/.pi/agent` or `~/.pap`. */
export async function makeModelsBed(): Promise<ModelsBed> {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "pap-models-")));
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const project = join(home, "work", "project");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(project, { recursive: true });
  return {
    root,
    home,
    agentDir,
    project,
    context: (options = {}) => ({
      agentDir,
      papHome: join(root, "pap"),
      home,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      signal: new AbortController().signal,
      emit: () => {},
      prompt: async () => null,
    }),
    write: async (path, value) => {
      await fs.mkdir(join(path, ".."), { recursive: true });
      await fs.writeFile(path, JSON.stringify(value, null, 2));
    },
    read: async (path) => JSON.parse(await fs.readFile(path, "utf8")) as unknown,
    trust: async (cwd) => {
      const { ProjectTrustStore } = await import("@earendil-works/pi-coding-agent");
      new ProjectTrustStore(agentDir).set(cwd, true);
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

/** A models.json with one provider of `count` models and a literal key. */
export const modelsJsonWith = (count = 2, key = SECRET_MODELS_KEY) => ({
  providers: {
    mine: {
      name: "Mine",
      baseUrl: "http://localhost:1/v1",
      apiKey: key,
      api: "openai-completions",
      models: Array.from({ length: count }, (_, i) => ({ id: `m${i + 1}`, name: `Model ${i + 1}` })),
    },
  },
});
