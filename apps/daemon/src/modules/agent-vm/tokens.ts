import { randomBytes, timingSafeEqual } from "node:crypto";
import { type BoxRef, boxKey } from "@pap/contracts";

export interface LaunchTokens {
  /** One launch: its id, the gateway token (the guest and every worker of the VM present it) and the relay key (R13). */
  issue(box: BoxRef): { launchId: string; token: string; relayKey: string };
  check(box: BoxRef, launchId: string, token: string): boolean;
  revoke(launchId: string): void;
}

const TOKEN_HEX = /^[0-9a-f]{64}$/;

export function createLaunchTokens(): LaunchTokens {
  const live = new Map<string, { box: string; token: Buffer }>();
  return {
    issue(box) {
      const launchId = randomBytes(16).toString("hex");
      const token = randomBytes(32);
      live.set(launchId, { box: boxKey(box), token });
      return { launchId, token: token.toString("hex"), relayKey: randomBytes(32).toString("hex") };
    },
    check(box, launchId, token) {
      const entry = live.get(launchId);
      if (!entry || entry.box !== boxKey(box)) return false;
      // `Buffer.from(text, "hex")` stops at the first pair that is not hex: a valid token followed by junk would decode to
      // the same bytes, so the text itself is held to the exact shape first.
      if (!TOKEN_HEX.test(token)) return false;
      const given = Buffer.from(token, "hex");
      return given.length === entry.token.length && timingSafeEqual(given, entry.token);
    },
    revoke(launchId) {
      live.delete(launchId);
    },
  };
}
