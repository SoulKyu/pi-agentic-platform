import { type BoxOp, type BoxRef, boxKey, PapError, type ServiceView } from "@pap/contracts";
import type { BoxOps } from "../../../kernel/boxes.ts";
import { createFakeClock } from "../../../kernel/clock.ts";
import { captureLogger } from "../../../testing/capture-logger.ts";
import {
  createPreviewRegistry,
  createPreviewTokens,
  type RegistryLink,
  type RegistryRuntime,
} from "../index.ts";

export const PROJECT_BOX: BoxRef = { kind: "project", id: "0b1c2d3e-0000-4000-8000-000000000001" };
export const OTHER_BOX: BoxRef = { kind: "project", id: "0b1c2d3e-0000-4000-8000-000000000002" };
export const AGENT_BOX: BoxRef = { kind: "agent", id: "atlas-0001" };

export type ServiceReport = Parameters<Parameters<RegistryLink["onServiceReport"]>[0]>[0];

interface FakeBox {
  phase: "stopped" | "running";
  link: RegistryLink & { report(report: ServiceReport): void; close(): void };
  services: ServiceView[];
  logs: Map<string, string[]>;
}

/**
 * A registry over a fake guest that behaves as the real supervisor answers (a start replaces its name with a new id, a stop marks
 * it stopped, a list shows what the guest holds), with every `BoxOps` call recorded by the way it went (`call` or `poll`).
 */
export function registryBed(options: { redact?: (line: string) => Promise<string> } = {}) {
  const clock = createFakeClock();
  const { logger, lines } = captureLogger();
  const tokens = createPreviewTokens(clock);
  const calls: Array<{ via: "call" | "poll"; box: string; op: BoxOp }> = [];
  const boxes = new Map<string, FakeBox>();
  const phaseListeners = new Set<(box: BoxRef, phase: "stopped" | "starting" | "running") => void>();
  let counter = 0;
  const hex = (): string => (++counter).toString(16).padStart(32, "0");
  /** Makes the next guest answer fail with this error (once). */
  let failNext: Error | null = null;
  let skip = 0;
  let tamper: ((op: BoxOp, answer: unknown) => unknown) | null = null;

  const newLink = (): FakeBox["link"] => {
    let closeLink: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      closeLink = resolve;
    });
    const reporters = new Set<(report: ServiceReport) => void>();
    return {
      onServiceReport(listener) {
        reporters.add(listener);
        return () => void reporters.delete(listener);
      },
      closed,
      report: (report) => reporters.forEach((listener) => listener(report)),
      close: closeLink,
    };
  };
  const fake = (box: BoxRef): FakeBox => {
    const key = boxKey(box);
    let known = boxes.get(key);
    if (known) return known;
    known = { phase: "stopped", link: newLink(), services: [], logs: new Map() };
    boxes.set(key, known);
    return known;
  };

  const honest = (box: BoxRef, op: BoxOp): unknown => {
    const guest = fake(box);
    if (failNext !== null && skip > 0) skip -= 1;
    else if (failNext !== null) {
      const error = failNext;
      failNext = null;
      throw error;
    }
    if (op.name === "svc.start" || op.name === "svc.restart") {
      const spec =
        op.name === "svc.start"
          ? { name: op.service, command: op.command, port: op.port, network: op.network }
          : (() => {
              const found = guest.services.find((service) => service.name === op.service);
              if (found === undefined) throw new PapError("not_found");
              return { name: found.name, port: found.port, network: found.network };
            })();
      const running = guest.services.filter((s) => s.state === "running" && s.name !== spec.name);
      if (running.length >= 4) throw new PapError("conflict");
      const view: ServiceView = {
        id: hex(),
        name: spec.name,
        port: spec.port,
        state: "running",
        reason: null,
        startedAt: clock.now(),
        network: spec.network,
      };
      guest.services = [...guest.services.filter((s) => s.name !== spec.name), view];
      return view;
    }
    if (op.name === "svc.stop") {
      const found = guest.services.find((s) => s.name === op.service);
      if (found === undefined || found.state !== "running") return { stopped: false };
      guest.services = guest.services.map((s) => (s === found ? { ...s, state: "stopped" as const } : s));
      return { stopped: true };
    }
    if (op.name === "svc.list") return { services: guest.services };
    if (op.name === "svc.logs") return { lines: guest.logs.get(op.service) ?? [] };
    throw new PapError("bad_request");
  };

  const answer = (box: BoxRef, op: BoxOp): unknown => {
    const real = honest(box, op);
    return tamper === null ? real : tamper(op, real);
  };

  const opsOf = (kind: BoxRef["kind"]): BoxOps => {
    const run = (via: "call" | "poll") => async (id: string, op: BoxOp) => {
      const ref = { kind, id } as BoxRef;
      calls.push({ via, box: boxKey(ref), op });
      if (fake(ref).phase !== "running") throw new PapError("box_stopped");
      return answer(ref, op);
    };
    return { call: run("call"), poll: run("poll") } as unknown as BoxOps;
  };
  const runtime: RegistryRuntime = {
    onPhase(listener) {
      phaseListeners.add(listener);
      return () => void phaseListeners.delete(listener);
    },
    link: (box) => (fake(box).phase === "running" ? fake(box).link : undefined),
    phase: (box) => fake(box).phase,
  };
  const ops = { project: opsOf("project"), agent: opsOf("agent") };
  const registry = createPreviewRegistry({
    runtime,
    ops,
    tokens,
    redact: options.redact ?? (async (line) => line),
    clock,
    logger,
  });
  const events: Array<{ event: unknown; ownerId: string }> = [];
  registry.onChange((event, ownerId) => events.push({ event, ownerId }));

  return {
    clock,
    lines,
    tokens,
    runtime,
    ops,
    registry,
    calls,
    events,
    /** The box's VM reaches `running` (its link is set first, as the runtime does). */
    run(box: BoxRef): void {
      const guest = fake(box);
      guest.phase = "running";
      guest.link = newLink();
      phaseListeners.forEach((listener) => listener(box, "running"));
    },
    /** The box's VM stops. */
    halt(box: BoxRef): void {
      fake(box).phase = "stopped";
      phaseListeners.forEach((listener) => listener(box, "stopped"));
    },
    guest: (box: BoxRef) => fake(box),
    /** A lying guest: every answer passes through this (the guest's own state stays honest). */
    lie(fn: ((op: BoxOp, answer: unknown) => unknown) | null): void {
      tamper = fn;
    },
    /** The guest's answer after `after` more answers fails with this error (once). */
    failNext(error: Error, after = 0): void {
      failNext = error;
      skip = after;
    },
    spec: (name: string, port = 3000, network = true) => ({ name, command: `serve ${name}`, port, network }),
  };
}
