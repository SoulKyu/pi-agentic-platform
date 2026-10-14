import {
  decodeFrame,
  methods,
  SERVER_OPS,
  type BinaryFrame,
  type EventFrame,
  type MethodName,
  type ParamsOf,
  type ResponseFrame,
} from "@pap/contracts";
import { WebSocket } from "ws";

export interface TestClient {
  readonly events: EventFrame[];
  /** Binary frames the server sent, decoded, in arrival order. */
  readonly binaryFrames: BinaryFrame[];
  /** `response:<id>` and `binary:<streamId>` in arrival order, to check what came before what. */
  readonly timeline: string[];
  /** Resolves with the close code when the socket closes (1006 when it was cut). */
  readonly closed: Promise<number>;
  /** Rejects when no response comes within `timeoutMs`; the client never retries a mutation (R105). */
  call<M extends MethodName>(
    method: M,
    params: ParamsOf<M>,
    timeoutMs?: number,
    commandId?: string,
  ): Promise<ResponseFrame>;
  waitForEvent(predicate: (frame: EventFrame) => boolean, timeoutMs?: number): Promise<EventFrame>;
  /** Raw bytes as one binary message (a hostile test sends what the codec would refuse). */
  sendBinary(bytes: Uint8Array): void;
  waitForBinary(predicate: (frame: BinaryFrame) => boolean, timeoutMs?: number): Promise<BinaryFrame>;
  close(): void;
}

let commandCounter = 0;

export function connectTestClient(url: string, headers: Record<string, string>): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const events: EventFrame[] = [];
    const binaryFrames: BinaryFrame[] = [];
    const timeline: string[] = [];
    const pending = new Map<number, (frame: ResponseFrame) => void>();
    const wakers = new Set<() => void>();
    const closed = new Promise<number>((done) => socket.on("close", (code) => done(code)));
    let nextId = 0;
    let greeted = false;
    const client: TestClient = {
      events,
      binaryFrames,
      timeline,
      closed,
      call(method, params, timeoutMs = 30_000, replayOf) {
        const id = ++nextId;
        const commandId =
          replayOf ?? (methods[method].idempotent ? undefined : `cmd-${process.pid}-${++commandCounter}`);
        return new Promise((done, fail) => {
          const deadline = setTimeout(() => {
            pending.delete(id);
            fail(new Error(`no response to ${method} within ${timeoutMs} ms`));
          }, timeoutMs);
          pending.set(id, (frame) => {
            clearTimeout(deadline);
            done(frame);
          });
          try {
            socket.send(JSON.stringify({ id, method, params, ...(commandId ? { commandId } : {}) }));
          } catch (error) {
            clearTimeout(deadline);
            pending.delete(id);
            fail(error);
          }
        });
      },
      waitForEvent(predicate, timeoutMs = 30_000) {
        return new Promise((done, fail) => {
          const check = () => {
            const hit = events.find(predicate);
            if (!hit) return;
            wakers.delete(check);
            clearTimeout(deadline);
            done(hit);
          };
          const deadline = setTimeout(() => {
            wakers.delete(check);
            fail(
              new Error(
                `no matching event; got ${JSON.stringify(events.map((e) => e.event)).slice(0, 2000)}`,
              ),
            );
          }, timeoutMs);
          wakers.add(check);
          check();
        });
      },
      sendBinary: (bytes) => socket.send(bytes, { binary: true }),
      waitForBinary(predicate, timeoutMs = 30_000) {
        return new Promise((done, fail) => {
          const check = () => {
            const hit = binaryFrames.find(predicate);
            if (!hit) return;
            wakers.delete(check);
            clearTimeout(deadline);
            done(hit);
          };
          const deadline = setTimeout(() => {
            wakers.delete(check);
            fail(new Error(`no matching binary frame; got ${binaryFrames.length} frame(s)`));
          }, timeoutMs);
          wakers.add(check);
          check();
        });
      },
      close: () => socket.close(),
    };
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        const bytes = new Uint8Array(Buffer.concat([data as Buffer]));
        const frame = decodeFrame(bytes, SERVER_OPS);
        if (!frame) {
          timeline.push("binary:invalid");
          for (const wake of [...wakers]) wake();
          return;
        }
        binaryFrames.push(frame);
        timeline.push(`binary:${frame.streamId}`);
        for (const wake of [...wakers]) wake();
        return;
      }
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      if (!greeted) {
        greeted = true;
        resolve(client);
        return;
      }
      if ("sub" in frame) {
        events.push(frame as unknown as EventFrame);
        for (const wake of [...wakers]) wake();
        return;
      }
      const id = frame.id as number;
      timeline.push(`response:${id}`);
      pending.get(id)?.(frame as unknown as ResponseFrame);
      pending.delete(id);
    });
    socket.on("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    socket.on("error", reject);
  });
}
