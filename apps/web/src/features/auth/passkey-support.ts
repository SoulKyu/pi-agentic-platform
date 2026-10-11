import { browserSupportsWebAuthn } from "@simplewebauthn/browser";

/** A passkey button is shown only when the server offers passkeys and this browser can use them. */
export const passkeysUsable = (serverAllows: boolean): boolean => serverAllows && browserSupportsWebAuthn();
