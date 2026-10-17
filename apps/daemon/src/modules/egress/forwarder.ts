import { randomBytes } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Run in the sandbox as `<python> -I -S /run/pap-fwd.py <socket> <port>` (M11R242). It binds 127.0.0.1:<port> and listens
 * BEFORE it forks, so the parent's exit means "ready" (no polling). The child serves, one thread pair per connection, at
 * most 64 at once, and dies with the sandbox's pid namespace. Standard library only.
 */
export const FORWARDER_SOURCE = `import os, socket, sys, threading

SOCKET, PORT, MAX_CONNECTIONS = sys.argv[1], int(sys.argv[2]), 64
slots = threading.BoundedSemaphore(MAX_CONNECTIONS)


def pump(source, sink):
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            sink.sendall(data)
        sink.shutdown(socket.SHUT_WR)
    except OSError:
        for end in (source, sink):
            try:
                end.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def serve(client):
    upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        upstream.connect(SOCKET)
        back = threading.Thread(target=pump, args=(upstream, client), daemon=True)
        back.start()
        pump(client, upstream)
        back.join()
    except OSError:
        pass
    finally:
        client.close()
        upstream.close()
        slots.release()


listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", PORT))
listener.listen(64)
if os.fork() != 0:
    os._exit(0)
null = os.open(os.devnull, os.O_RDWR)
for stream in (0, 1, 2):
    os.dup2(null, stream)
while True:
    client, _ = listener.accept()
    if slots.acquire(blocking=False):
        threading.Thread(target=serve, args=(client,), daemon=True).start()
    else:
        client.close()
`;

/** Writes the forwarder once, read-only (0400), by rename: a reader never sees a half-written file. */
export function writeForwarder(root: string): string {
  const path = join(root, "fwd.py");
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, FORWARDER_SOURCE, { mode: 0o400, flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return path;
}
