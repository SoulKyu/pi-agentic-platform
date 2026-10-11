import { methods, type EventFrame, type MethodName, type ParamsOf, type ResponseFrame } from "@pap/contracts";
import { WebSocket } from "ws";

export interface TestClient {
  readonly events: EventFrame[];
  /** Rejects when no response comes within `timeoutMs`; the client never retries a mutation (R105). */
  call<M extends MethodName>(method: M, params: ParamsOf<M>, timeoutMs?: number): Promise<ResponseFrame>;
  waitForEvent(predicate: (frame: EventFrame) => boolean, timeoutMs?: number): Promise<EventFrame>;
  close(): void;
}

let commandCounter = 0;

export function connectTestClient(url: string, headers: Record<string, string>): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const events: EventFrame[] = [];
    const pending = new Map<number, (frame: ResponseFrame) => void>();
    const wakers = new Set<() => void>();
    let nextId = 0;
    let greeted = false;
    const client: TestClient = {
      events,
      call(method, params, timeoutMs = 30_000) {
        const id = ++nextId;
        const commandId = methods[method].idempotent ? undefined : `cmd-${process.pid}-${++commandCounter}`;
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
      close: () => socket.close(),
    };
    socket.on("message", (data) => {
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
      pending.get(id)?.(frame as unknown as ResponseFrame);
      pending.delete(id);
    });
    socket.on("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    socket.on("error", reject);
  });
}
