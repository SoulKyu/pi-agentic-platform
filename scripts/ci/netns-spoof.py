"""T16a: assertions of scripts/ci/netns-spoof.sh (run by it, as root, inside the throwaway namespace set up there).

`run` orchestrates; `connect`, `listen`, `spoof` run inside a VM namespace through `ip netns exec`. Standard library only.
"""

import os
import re
import socket
import struct
import subprocess
import sys
import threading
import time

GATEWAY = "10.213.0.1"
GATEWAY_PORT = 7841
RELAY_PORT = 7842
SSH_PORT = 2222
VM_B_PORT = 9000
CONNECT_TIMEOUT = 2.0
SPOOF_ARP_FRAMES = 5
SPOOF_SYN_FRAMES = 3

IP = os.environ.get("NETNS_SPOOF_IP", "ip").split()
NFT = os.environ.get("NETNS_SPOOF_NFT", "nft").split()
A_MAC = os.environ.get("NETNS_SPOOF_A_MAC", "")
B_MAC = os.environ.get("NETNS_SPOOF_B_MAC", "")
A_IP = os.environ.get("NETNS_SPOOF_A_IP", "")
B_IP = os.environ.get("NETNS_SPOOF_B_IP", "")

failures = []


def check(ok, label):
    print(("PASS " if ok else "FAIL ") + label, flush=True)
    if not ok:
        failures.append(label)


def sh(argv):
    return subprocess.run(argv, capture_output=True, text=True, check=False)


def can_connect(host, port):
    try:
        with socket.create_connection((host, port), timeout=CONNECT_TIMEOUT):
            return True
    except OSError:
        return False


def in_ns(ns, *args):
    return IP + ["netns", "exec", ns, sys.executable, "-I", os.path.abspath(__file__), *args]


def connects_from(ns, host, port):
    return sh(in_ns(ns, "connect", host, str(port))).returncode == 0


def listen_forever(port):
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("0.0.0.0", port))
    server.listen(16)
    while True:
        conn, _ = server.accept()
        conn.close()


def drop_counter():
    """Packets of the last (catch-all) rule of the bridge prerouting chain."""
    text = sh(NFT + ["list", "chain", "bridge", "pap_agents", "prerouting"]).stdout
    found = re.findall(r"counter packets (\d+) bytes \d+ drop", text)
    return int(found[-1]) if found else -1


def neighbour(ip):
    text = sh(IP + ["neigh", "show", ip, "dev", "pap0"]).stdout
    match = re.search(r"lladdr ([0-9a-f:]{17}) (\w+)", text)
    return (match.group(1), match.group(2)) if match else (None, None)


def add_guard(port, mac, ip):
    """What pap-vmd's attach runs (apps/vmd/src/net.ts): the set element, then the permanent neighbour entry."""
    element = '{ "%s" . %s . %s }' % (port, mac, ip)
    added = sh(NFT + ["add", "element", "bridge", "pap_agents", "ports", element])
    check(added.returncode == 0, "nft add element %s: %s" % (port, added.stderr.strip()))
    neigh = sh(IP + ["neigh", "replace", ip, "lladdr", mac, "dev", "pap0", "nud", "permanent"])
    check(neigh.returncode == 0, "ip neigh replace %s: %s" % (ip, neigh.stderr.strip()))


def mac_bytes(text):
    return bytes(int(part, 16) for part in text.split(":"))


def checksum(data):
    if len(data) % 2:
        data += b"\x00"
    total = sum(struct.unpack("!%dH" % (len(data) // 2), data))
    while total >> 16:
        total = (total & 0xFFFF) + (total >> 16)
    return (~total) & 0xFFFF


def arp_reply_frame(src_mac, claimed_ip):
    broadcast = b"\xff" * 6
    ethernet = broadcast + mac_bytes(src_mac) + struct.pack("!H", 0x0806)
    arp = struct.pack("!HHBBH", 1, 0x0800, 6, 4, 2)
    arp += mac_bytes(src_mac) + socket.inet_aton(claimed_ip) + broadcast + socket.inet_aton(claimed_ip)
    return ethernet + arp


def syn_frame(src_mac, dst_mac, src_ip, dst_ip, dst_port):
    sip, dip = socket.inet_aton(src_ip), socket.inet_aton(dst_ip)
    tcp = struct.pack("!HHLLBBHHH", 40000, dst_port, 1, 0, 5 << 4, 0x02, 65535, 0, 0)
    pseudo = sip + dip + struct.pack("!BBH", 0, 6, len(tcp))
    tcp = tcp[:16] + struct.pack("!H", checksum(pseudo + tcp)) + tcp[18:]
    header = struct.pack("!BBHHHBBH", 0x45, 0, 20 + len(tcp), 1, 0, 64, 6, 0) + sip + dip
    header = header[:10] + struct.pack("!H", checksum(header)) + header[12:]
    return mac_bytes(dst_mac) + mac_bytes(src_mac) + struct.pack("!H", 0x0800) + header + tcp


def spoof_from_vm_a(victim_ip, bridge_mac):
    """Runs inside VM a as root (CAP_NET_RAW): forged gratuitous ARP replies, then SYNs from the victim's address."""
    raw = socket.socket(socket.AF_PACKET, socket.SOCK_RAW)
    raw.bind(("eth0", 0))
    for _ in range(SPOOF_ARP_FRAMES):
        raw.send(arp_reply_frame(A_MAC, victim_ip))
    for _ in range(SPOOF_SYN_FRAMES):
        raw.send(syn_frame(A_MAC, bridge_mac, victim_ip, GATEWAY, GATEWAY_PORT))
    raw.close()


def host_port_of_vm(letter):
    return "veth" + letter


def run():
    for port in (GATEWAY_PORT, RELAY_PORT, SSH_PORT):
        threading.Thread(target=listen_forever, args=(port,), daemon=True).start()
    vm_b_listener = subprocess.Popen(in_ns("vmb", "listen", str(VM_B_PORT)))
    time.sleep(0.5)
    try:
        # 1. Fail closed: no element yet, so the bridge drops everything a VM sends.
        check(not connects_from("vma", GATEWAY, GATEWAY_PORT), "before its element exists VM a cannot reach the gateway")

        add_guard(host_port_of_vm("a"), A_MAC, A_IP)
        add_guard(host_port_of_vm("b"), B_MAC, B_IP)

        # 2. What a VM may reach, and what it may not.
        check(connects_from("vma", GATEWAY, GATEWAY_PORT), "VM a reaches the gateway port 7841")
        check(connects_from("vma", GATEWAY, RELAY_PORT), "VM a reaches the relay port 7842")
        check(connects_from("vmb", GATEWAY, GATEWAY_PORT), "VM b reaches the gateway port 7841")
        check(not connects_from("vma", GATEWAY, SSH_PORT), "VM a cannot reach port 2222 on the host")
        check(not connects_from("vma", B_IP, VM_B_PORT), "VM a cannot reach VM b")
        check(not can_connect(GATEWAY, RELAY_PORT), "the relay port does not answer the host's own loopback path")
        check(not can_connect(GATEWAY, GATEWAY_PORT), "the gateway port does not answer the host's own loopback path")

        # 3. VM a forges VM b's address.
        bridge_mac = open("/sys/class/net/pap0/address").read().strip()
        before = drop_counter()
        spoofed = sh(in_ns("vma", "spoof", B_IP, bridge_mac))
        check(spoofed.returncode == 0, "the spoofing frames were sent: %s" % spoofed.stderr.strip())
        time.sleep(0.5)
        mac, nud = neighbour(B_IP)
        check(mac == B_MAC, "the host's neighbour entry for VM b keeps VM b's MAC (is %s)" % mac)
        check(nud == "PERMANENT", "the neighbour entry for VM b is permanent (is %s)" % nud)
        after = drop_counter()
        check(after - before >= SPOOF_ARP_FRAMES + SPOOF_SYN_FRAMES, "the drop counter moved (%d to %d)" % (before, after))
        check(connects_from("vma", GATEWAY, GATEWAY_PORT), "VM a still reaches the gateway after the attack")
        check(connects_from("vmb", GATEWAY, GATEWAY_PORT), "VM b still reaches the gateway after the attack")
    finally:
        vm_b_listener.terminate()
        vm_b_listener.wait()
    if failures:
        print("%d check(s) failed" % len(failures), file=sys.stderr)
        sys.exit(1)
    print("all checks passed")


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else "run"
    if command == "connect":
        sys.exit(0 if can_connect(sys.argv[2], int(sys.argv[3])) else 1)
    elif command == "listen":
        listen_forever(int(sys.argv[2]))
    elif command == "spoof":
        spoof_from_vm_a(sys.argv[2], sys.argv[3])
    elif command == "run":
        run()
    else:
        sys.exit(64)


main()
