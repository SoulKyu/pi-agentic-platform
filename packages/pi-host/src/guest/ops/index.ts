import { type BoxOp, type BoxOpError } from "@pap/contracts/pi-host";
import { fsGet, fsRead } from "./fs-read.ts";
import { fsList } from "./fs-list.ts";
import { createSearch } from "./fs-search.ts";
import { createUploads, fsWrite } from "./fs-write.ts";
import { gitBlob, gitStatus } from "./git.ts";
import { gitClone, gitCommit, gitLink, gitPush, gitUnlink } from "./git-remote.ts";
import { githubForgetKey, githubIdentity, githubToken } from "./github.ts";
import type { GithubDeps } from "./github-env.ts";
import { knowledgeEnable, knowledgeState } from "./knowledge.ts";
import { type OpEnv, opErrorOf } from "./paths.ts";
import { projectConfig } from "./project.ts";

export type OpAnswer =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: BoxOpError };

/** Runs one operation of a project box; the daemon checks the value against the operation's result schema. */
export type GuestOps = (op: BoxOp) => Promise<OpAnswer>;

/**
 * The guest's operations on its project folder (spec boxes). They run as the guest process: the VM is the boundary. Every path
 * is judged under `project` with no link followed; git always runs with the neutralised command line.
 */
export function createGuestOps(project: string, now: () => number, github?: GithubDeps): GuestOps {
  const env: OpEnv = { project, now, ...(github ? { github } : {}) };
  const uploads = createUploads();
  const search = createSearch();

  const run = (op: BoxOp): Promise<unknown> | unknown => {
    switch (op.name) {
      case "fs.list":
        return fsList(env, op);
      case "fs.read":
        return fsRead(env, op);
      case "fs.write":
        return fsWrite(env, op);
      case "fs.put":
        return uploads.put(env, op);
      case "fs.get":
        return fsGet(env, op);
      case "fs.search":
        return search.run(env, op);
      case "git.status":
        return gitStatus(env);
      case "git.blob":
        return gitBlob(env, op);
      case "knowledge.state":
        return knowledgeState(env);
      case "knowledge.enable":
        return knowledgeEnable(env);
      case "project.config":
        return projectConfig(env);
      case "git.clone":
        return gitClone(env, op);
      case "git.link":
        return gitLink(env, op);
      case "git.unlink":
        return gitUnlink(env);
      case "git.commit":
        return gitCommit(env, op);
      case "git.push":
        return gitPush(env);
      case "github.token":
        return githubToken(env, op);
      case "github.identity":
        return githubIdentity(env, op);
      case "github.forgetKey":
        return githubForgetKey(env);
    }
  };

  return async (op) => {
    try {
      return { ok: true, value: await run(op) };
    } catch (error) {
      return { ok: false, code: opErrorOf(error).code };
    }
  };
}
