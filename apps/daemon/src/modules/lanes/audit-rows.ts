import type { Caller } from "@pap/contracts";

/** Who an audit row names for a lane action: a token by its credential, anyone else as the owner (the shape of `lane_pushed`). */
export const actorOf = (
  caller: Pick<Caller, "kind" | "credentialId">,
): { readonly actor: "user" | "token"; readonly actorId?: string } =>
  caller.kind === "token"
    ? { actor: "token", ...(caller.credentialId ? { actorId: caller.credentialId } : {}) }
    : { actor: "user" };
