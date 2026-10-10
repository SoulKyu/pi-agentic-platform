import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

// A WebAuthn authenticator in software (ES256, "none" attestation), so a test can run the real
// @simplewebauthn/server verification: challenge, origin, RP ID, user verification, signature and counter.
// What a browser adds (user gesture, platform UI) is out of scope; Task 27 drives a real Chromium for that.
export interface CeremonyOverrides {
  readonly origin?: string;
  readonly rpId?: string;
  readonly userVerified?: boolean;
  /** The signature counter to report; by default one more than the last assertion. */
  readonly counter?: number;
}

export interface SoftwareAuthenticator {
  readonly credentialId: string;
  create(challenge: string, overrides?: CeremonyOverrides): Record<string, unknown>;
  get(challenge: string, overrides?: CeremonyOverrides): Record<string, unknown>;
}

const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;
const ATTESTED_CREDENTIAL = 0x40;
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest();
const uint = (value: number, bytes: 2 | 4) => {
  const buffer = Buffer.alloc(bytes);
  if (bytes === 2) buffer.writeUInt16BE(value);
  else buffer.writeUInt32BE(value);
  return buffer;
};

export function createSoftwareAuthenticator(defaults: {
  readonly origin: string;
  readonly rpId: string;
  readonly userVerified?: boolean;
}): SoftwareAuthenticator {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credentialId = randomBytes(16);
  const coseKey = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x ?? "", "base64url")],
      [-3, Buffer.from(jwk.y ?? "", "base64url")],
    ]),
  );
  let lastCounter = 0;
  const settings = (overrides: CeremonyOverrides = {}) => ({
    origin: overrides.origin ?? defaults.origin,
    rpId: overrides.rpId ?? defaults.rpId,
    userVerified: overrides.userVerified ?? defaults.userVerified ?? true,
  });
  const header = (rpId: string, userVerified: boolean, counter: number, attested: boolean) =>
    Buffer.concat([
      sha256(rpId),
      Buffer.from([USER_PRESENT | (userVerified ? USER_VERIFIED : 0) | (attested ? ATTESTED_CREDENTIAL : 0)]),
      uint(counter, 4),
    ]);
  const clientData = (type: string, challenge: string, origin: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const id = credentialId.toString("base64url");
  return {
    credentialId: id,
    create(challenge, overrides) {
      const { origin, rpId, userVerified } = settings(overrides);
      const authData = Buffer.concat([
        header(rpId, userVerified, 0, true),
        Buffer.alloc(16),
        uint(credentialId.length, 2),
        credentialId,
        coseKey,
      ]);
      const attestation = new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]);
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientData("webauthn.create", challenge, origin).toString("base64url"),
          attestationObject: Buffer.from(isoCBOR.encode(attestation as never)).toString("base64url"),
          transports: ["internal"],
        },
      };
    },
    get(challenge, overrides) {
      const { origin, rpId, userVerified } = settings(overrides);
      lastCounter = overrides?.counter ?? lastCounter + 1;
      const authData = header(rpId, userVerified, lastCounter, false);
      const data = clientData("webauthn.get", challenge, origin);
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: data.toString("base64url"),
          authenticatorData: authData.toString("base64url"),
          signature: sign("sha256", Buffer.concat([authData, sha256(data)]), privateKey).toString(
            "base64url",
          ),
          userHandle: Buffer.from("user").toString("base64url"),
        },
      };
    },
  };
}
