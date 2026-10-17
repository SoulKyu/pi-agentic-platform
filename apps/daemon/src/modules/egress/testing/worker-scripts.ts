/** TEST ONLY: the python the networked sandbox runs in `host.egress.int.test.ts`; both need nothing outside the standard library. */
export const FETCH = `import ssl, sys, urllib.error, urllib.request
try:
    with urllib.request.urlopen(sys.argv[1], context=ssl._create_unverified_context(), timeout=10) as reply:
        print(reply.status, reply.read().decode())
except urllib.error.HTTPError as error:
    print(error.code, error.read().decode().strip())
except Exception as error:
    print("error", type(error).__name__)
`;
export const BYPASS = `import json, socket, sys, urllib.request
tcp, udp, origin = (int(value) for value in sys.argv[1:4])
out = {}
def direct(port):
    sock = socket.socket()
    sock.settimeout(3)
    try:
        sock.connect(("127.0.0.1", port))
        return "connected"
    except OSError as error:
        return type(error).__name__
    finally:
        sock.close()
out["tcp"] = direct(tcp)
out["origin"] = direct(origin)
datagram = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
datagram.sendto(b"x", ("127.0.0.1", udp))
try:
    socket.getaddrinfo("nothing.invalid", 80)
    out["dns"] = "resolved"
except socket.gaierror:
    out["dns"] = "failed"
out["interfaces"] = sorted(line.split(":")[0].strip() for line in open("/proc/net/dev").read().splitlines()[2:])
# What a client does that honours NO_PROXY='*': no proxy, a direct connection.
try:
    urllib.request.build_opener(urllib.request.ProxyHandler({})).open("http://nothing.invalid/x", timeout=3)
    out["noproxy"] = "reached"
except Exception as error:
    out["noproxy"] = type(error).__name__
proxy = socket.create_connection(("127.0.0.1", 3128), timeout=3)
proxy.sendall(b"\\x05\\x01\\x00\\r\\n\\r\\n")
try:
    reply = proxy.recv(64)
except OSError:
    reply = b""
out["socks"] = "accepted" if reply[:2] == b"\\x05\\x00" else "refused"
print(json.dumps(out))
`;
