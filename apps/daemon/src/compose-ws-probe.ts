import { PROTOCOL_VERSION } from "@pap/contracts";
import type { Context } from "hono";
import type { AuthModule } from "./modules/auth/index.ts";

/** The browser cannot read the status of a failed upgrade, so the client asks this plain GET first. */
export function createWsProbe(auth: Pick<AuthModule, "credentialOf" | "authenticateCredential">) {
  return (c: Context) => {
    if (c.req.query("proto") !== String(PROTOCOL_VERSION)) return c.json({ protocol: PROTOCOL_VERSION }, 426);
    const credential = auth.credentialOf({
      cookie: c.req.header("cookie"),
      authorization: c.req.header("authorization"),
    });
    if (credential === "conflict") return c.json({ error: { code: "bad_request" } }, 400);
    if (!auth.authenticateCredential(credential)) return c.json({ error: { code: "unauthenticated" } }, 401);
    return c.json({ protocol: PROTOCOL_VERSION });
  };
}
