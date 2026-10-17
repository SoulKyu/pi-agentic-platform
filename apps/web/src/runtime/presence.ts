import type { Connection, Timers } from "./connection.ts";
import type { RpcClient } from "./rpc.ts";

const HEARTBEAT_MS = 20_000;
const IDLE_MS = 120_000;
const INPUTS = ["pointerdown", "keydown", "touchstart", "wheel"] as const;

interface PresenceDeps {
  readonly rpc: Pick<RpcClient, "call">;
  readonly connection: Pick<Connection, "state" | "onState">;
  readonly timers: Timers;
  readonly doc: Pick<Document, "visibilityState" | "hasFocus" | "addEventListener" | "removeEventListener">;
  readonly win: Pick<Window, "addEventListener" | "removeEventListener">;
  now?(): number;
}

/**
 * Tells the daemon whether the owner is looking (M12R11): focused, visible and active in the last 2 minutes. A beat every
 * 20 s while the socket is open and on every change; a tab that dies simply stops beating. Returns its stop.
 */
export function startPresence({
  rpc,
  connection,
  timers,
  doc,
  win,
  now = Date.now,
}: PresenceDeps): () => void {
  let lastInput = now();
  let lastSent: boolean | null = null;
  let timer: number | null = null;
  const looking = () => doc.hasFocus() && doc.visibilityState === "visible" && now() - lastInput < IDLE_MS;
  const send = (focused = looking()) => {
    if (connection.state !== "open") return;
    lastSent = focused;
    // A refused beat (capacity, a closing socket) only costs one heartbeat: the next one is already scheduled.
    rpc.call("push.presence", { focused }).catch(() => {});
  };
  const stopBeat = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  const beat = () => {
    stopBeat();
    send();
    timer = timers.set(beat, HEARTBEAT_MS);
  };
  const onInput = () => {
    lastInput = now();
    if (lastSent === false && looking()) send();
  };
  const onChange = () => send();
  const onPageHide = () => send(false);
  const stopState = connection.onState((state) => (state === "open" ? beat() : stopBeat()));
  if (connection.state === "open") beat();
  win.addEventListener("focus", onChange);
  win.addEventListener("blur", onChange);
  win.addEventListener("pagehide", onPageHide);
  doc.addEventListener("visibilitychange", onChange);
  for (const type of INPUTS) win.addEventListener(type, onInput, { capture: true, passive: true });
  return () => {
    stopState();
    stopBeat();
    win.removeEventListener("focus", onChange);
    win.removeEventListener("blur", onChange);
    win.removeEventListener("pagehide", onPageHide);
    doc.removeEventListener("visibilitychange", onChange);
    for (const type of INPUTS) win.removeEventListener(type, onInput, { capture: true });
  };
}
