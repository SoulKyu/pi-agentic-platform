import { z } from "zod";
import type { Role } from "./roles.ts";

/** The setup rules (username and password), reused by an invitation. */
export const INVITE_USERNAME = /^[A-Za-z0-9_.-]{1,64}$/;
export const INVITE_PASSWORD = { min: 12, max: 1024 } as const;
/** An invitation token: 32 random bytes, base64url (43 characters). */
export const InviteToken = z.string().min(16).max(128);

export const INVITE_INVALID = "invite_invalid";
export const USERNAME_TAKEN = "username_taken";

/** `POST /auth/invite/info`: what the invitation page shows before the form. */
export const InviteInfoBody = z.object({ token: InviteToken }).strict();
export type InviteInfoBody = z.infer<typeof InviteInfoBody>;
export const InviteInfo = z
  .object({ inviter: z.string().min(1).max(64), expiresAt: z.number().int() })
  .strict();
export type InviteInfo = z.infer<typeof InviteInfo>;

/** `POST /auth/invite/accept`: creates a member and starts a session. */
export const InviteAcceptBody = z
  .object({
    token: InviteToken,
    username: z.string().regex(INVITE_USERNAME),
    password: z.string().min(INVITE_PASSWORD.min).max(INVITE_PASSWORD.max),
  })
  .strict();
export type InviteAcceptBody = z.infer<typeof InviteAcceptBody>;

/**
 * `AuthStatusRole`: `GET /auth/status` also answers `role`, the signed-in user's role, or `null` when nobody is signed
 * in. The web reads it for the role chip and to hide the sections a member never has.
 */
export interface AuthStatusRole {
  readonly role: Role | null;
}
