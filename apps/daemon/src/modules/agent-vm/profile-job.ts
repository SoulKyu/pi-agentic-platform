import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { prepareProfileContext, type ProfileMade } from "./image-inputs.ts";
import { type Fingerprint, profileFingerprint } from "./profile-fingerprint.ts";
import { ProfileSecretError } from "./secret-scan.ts";

/** What the last good preparation looked at. */
export interface Inputs {
  readonly digest: string;
  readonly roots: readonly string[];
}

export interface ProfileJob {
  readonly agentDir: string;
  readonly out: string;
  readonly secrets: readonly string[];
  readonly papHome: string;
  readonly baseTag: string;
  readonly providers: readonly string[];
  /** The daemon's clock now, in ms: a file modified this close to the preparation is not trusted as unchanged. */
  readonly nowMs: number;
  /** The inputs of the last good preparation whose tree is still in `out`, or null. */
  readonly previous: Inputs | null;
}

export type ProfileOutcome =
  | { readonly kind: "unchanged" }
  | { readonly kind: "made"; readonly made: ProfileMade; readonly inputs: Inputs | null }
  | { readonly kind: "secret"; readonly file: string }
  | { readonly kind: "failed"; readonly message: string };

/** Files modified within this long of the preparation start could have changed after they were copied. */
const SETTLE_MS = 2000;

const saltOf = (job: ProfileJob): string =>
  createHash("sha256")
    .update(JSON.stringify([job.baseTag, job.papHome, job.providers, [...job.secrets].sort()]))
    .digest("hex");

/**
 * I4: one preparation of the profile, run in a worker thread (a 23k-file, hundreds-of-MB profile takes seconds, and the
 * daemon's event loop serves every socket meanwhile). When the inputs' fingerprint is that of the last good preparation and its
 * tree is still in place, nothing is copied, scanned or hashed. Pure of the daemon: it is also the in-process runner of tests.
 */
export function runProfileJob(job: ProfileJob): ProfileOutcome {
  const salt = saltOf(job);
  try {
    if (job.previous !== null && existsSync(job.out)) {
      const now = profileFingerprint(job.agentDir, job.previous.roots, salt);
      if (now.digest === job.previous.digest) return { kind: "unchanged" };
    }
    const made = prepareProfileContext(
      job.agentDir,
      job.out,
      job.secrets,
      job.papHome,
      job.baseTag,
      job.providers,
    );
    const after: Fingerprint = profileFingerprint(job.agentDir, made.roots, salt);
    const settled = after.newestMs < job.nowMs - SETTLE_MS;
    return { kind: "made", made, inputs: settled ? { digest: after.digest, roots: made.roots } : null };
  } catch (error) {
    if (error instanceof ProfileSecretError) return { kind: "secret", file: error.file };
    return { kind: "failed", message: error instanceof Error ? error.message : "preparation failed" };
  }
}
