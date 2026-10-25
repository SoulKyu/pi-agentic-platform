import { rmSync } from "node:fs";

/**
 * A deleted member's vault: the owner's whole folder (the `user` scope and every `agent-*` scope file, with any temporary
 * file a crash left), whatever scopes it holds. The key beside the vault is the install's and stays.
 */
export function dropOwnerFolder(ownerDir: string): void {
  rmSync(ownerDir, { recursive: true, force: true });
}
