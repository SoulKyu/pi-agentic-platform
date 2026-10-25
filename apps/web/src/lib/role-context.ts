import type { Role } from "@pap/contracts";
import { createContext, useContext } from "react";

/** The signed-in role. UX only: the daemon refuses a member whatever the page shows. Outside the shell: the least privilege, a member. */
export const RoleContext = createContext<Role>("member");

export const useRole = (): Role => useContext(RoleContext);
