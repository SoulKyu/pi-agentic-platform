import { closeInheritedPtyFds } from "./close-pty-fds.ts";

// A side-effect module, imported first by main.ts: ES modules evaluate in import order, so this runs before the Pi SDK's
// top level and before any agent, extension or tool code (MC29, MC30 m10).
closeInheritedPtyFds();
