import { existsSync } from "node:fs";
import { constants as osConstants } from "node:os";
import type net from "node:net";
import {
  AGENT_VM_MAX_FRAME_BYTES,
  AGENT_VM_PROTOCOL,
  createFrameDecoder,
  encodeSocketFrame,
  parseBoxKey,
  PTY_FOLDER_REFUSAL,
  PTY_FRAME_BYTES,
  PTY_WINDOW_BYTES,
  PtyCommand,
  TerminalHello,
  type GuestCommand,
  type PtyReport,
  type VmLayout,
} from "@pap/contracts/pi-host";
import { errorClass } from "../../bounded.ts";
import type { GuestClock } from "../guest.ts";
import { terminalCwd } from "./cwd.ts";
import { ptyEnv } from "./env.ts";
import type { NodePty, PtyChild } from "./load.ts";

const CONNECT_MS = 10_000;
/** A paused pty resumes when the unacknowledged output is down to this much. */
const RESUME_BYTES = PTY_WINDOW_BYTES / 2;
const PONG = encodeSocketFrame({ type: "pong" });
const SIGNAL_NAMES = new Map<number, string>(
  Object.entries(osConstants.signals).map(([name, n]) => [n, name]),
);

export interface PtyHostDeps {
  /** The guest's own environment (already scrubbed of the token). */
  env: NodeJS.ProcessEnv;
  /** The guest's gateway token: the pty's connection says hello with it, as the worker's does (in memory, never in the shell's environment). */
  token: string;
  layout: VmLayout;
  clock: GuestClock;
  connect(address: string): net.Socket;
  load(): NodePty | null;
  /** Tells the daemon a pty could not start (no connection of its own exists yet). */
  refuse(slot: string, why: string): void;
  log(line: string): void;
}

export interface PtyHost {
  open(command: Extract<GuestCommand, { type: "pty_open" }>): void;
  /** Kills every pty group (the guest is going away). */
  closeAll(): void;
}

/**
 * The guest's terminals (lot B2). `pty_open` spawns the login shell in a pty, in a folder of the project, then connects back
 * with a `terminal` hello carrying the slot. The pty stays paused until the hello is out and again while more than
 * `PTY_WINDOW_BYTES` of its output is unacknowledged (`pty_ack` carries the cumulative bytes the daemon has taken, as the host
 * terminal's offsets do). A closed connection kills the shell's group; `pty_exit` goes out once.
 */
export function createPtyHost(deps: PtyHostDeps): PtyHost {
  const { layout, log } = deps;
  const live = new Map<string, () => void>();
  const used = new Set<string>();

  const open: PtyHost["open"] = (command) => {
    const { slot } = command;
    if (used.has(slot)) return log(`ignored pty_open of slot ${slot}: it was already used`);
    used.add(slot);
    const cwd = terminalCwd(layout.project, command.cwd);
    if (cwd === null) return deps.refuse(slot, PTY_FOLDER_REFUSAL);
    const address = deps.env.PAP_GATEWAY;
    const hello = TerminalHello.safeParse({
      type: "hello",
      role: "terminal",
      box: parseBoxKey(deps.env.PAP_BOX ?? ""),
      launchId: deps.env.PAP_LAUNCH_ID,
      token: deps.token,
      protocol: AGENT_VM_PROTOCOL,
      imageTag: deps.env.PAP_IMAGE_TAG,
      slot,
    });
    if (!hello.success || !address) return deps.refuse(slot, "the terminal hello is invalid");
    const pty = deps.load();
    if (pty === null) return deps.refuse(slot, "terminal_unavailable");

    const shell = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
    let child: PtyChild;
    try {
      child = pty.spawn(shell, shell === "/bin/bash" ? ["-l"] : [], {
        name: "xterm-256color",
        cols: command.cols,
        rows: command.rows,
        cwd,
        env: ptyEnv(deps.env, layout, address.slice(0, address.lastIndexOf(":"))),
        encoding: null,
        handleFlowControl: false,
      });
    } catch (error) {
      log(`slot ${slot} pty could not start: ${errorClass(error)}`);
      return deps.refuse(slot, "the shell could not start");
    }
    child.pause();

    let ready = false;
    let paused = true;
    let sent = 0;
    let acked = 0;
    let exited = false;
    let dying = false;
    let timer: unknown;
    let pendingExit: PtyReport | undefined;
    const connection = deps.connect(address);
    const send = (report: PtyReport): void => {
      if (ready && !connection.destroyed) connection.write(encodeSocketFrame(report));
    };
    const kill = (signal: "SIGHUP" | "SIGKILL"): void => {
      // node-pty reports the exit only once the master is read to its end: a paused pty must drain to die.
      if (signal === "SIGKILL") dying = true;
      if (paused) {
        paused = false;
        child.resume();
      }
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      }
    };
    const flow = (): void => {
      if (dying) return;
      const lag = sent - acked;
      const want = ready && (paused ? lag <= RESUME_BYTES : lag < PTY_WINDOW_BYTES);
      if (want === !paused) return;
      paused = !want;
      if (paused) child.pause();
      else child.resume();
    };
    const finish = (): void => {
      live.delete(slot);
      if (timer !== undefined) deps.clock.clearTimeout(timer);
      connection.end();
    };

    live.set(slot, () => {
      if (!exited) kill("SIGKILL");
    });
    child.onData((chunk) => {
      for (let at = 0; at < chunk.length; at += PTY_FRAME_BYTES) {
        const part = chunk.subarray(at, at + PTY_FRAME_BYTES);
        send({ type: "pty_output", data: part.toString("base64") });
        sent += part.length;
      }
      flow();
    });
    child.onExit(({ exitCode, signal }) => {
      if (exited) return;
      exited = true;
      const name = signal ? (SIGNAL_NAMES.get(signal) ?? null) : null;
      const report: PtyReport = { type: "pty_exit", code: name ? null : exitCode, signal: name };
      if (!ready) {
        pendingExit = report;
        return;
      }
      send(report);
      finish();
    });

    const decoder = createFrameDecoder({
      maxBytes: () => AGENT_VM_MAX_FRAME_BYTES,
      onFrame: (raw) => {
        if ((raw as { type?: unknown } | null)?.type === "ping") {
          if (!connection.destroyed) connection.write(PONG);
          return;
        }
        const parsed = PtyCommand.safeParse(raw);
        if (!parsed.success) return log(`slot ${slot} dropped an unknown pty frame`);
        const frame = parsed.data;
        if (exited) return;
        if (frame.type === "pty_input") child.write(Buffer.from(frame.data, "base64"));
        else if (frame.type === "pty_resize") child.resize(frame.cols, frame.rows);
        else if (frame.type === "pty_signal") kill(frame.signal);
        else if (frame.bytes > acked && frame.bytes <= sent) {
          acked = frame.bytes;
          flow();
        }
      },
      onError: (error) => {
        log(`slot ${slot} terminal frame refused (${error})`);
        connection.destroy();
      },
    });
    connection.on("data", (chunk) => decoder.push(chunk));
    timer = deps.clock.setTimeout(() => connection.destroy(), CONNECT_MS);
    connection.once("connect", () => {
      deps.clock.clearTimeout(timer);
      timer = undefined;
      connection.setNoDelay(true);
      connection.write(encodeSocketFrame(hello.data));
      ready = true;
      if (pendingExit) {
        send(pendingExit);
        finish();
      } else flow();
    });
    connection.on("error", (error) => log(`slot ${slot} terminal socket error: ${errorClass(error)}`));
    connection.on("close", () => {
      decoder.stop();
      if (timer !== undefined) deps.clock.clearTimeout(timer);
      if (!exited) kill("SIGKILL");
      live.delete(slot);
    });
  };

  return {
    open,
    closeAll: () => {
      for (const stop of [...live.values()]) stop();
    },
  };
}
