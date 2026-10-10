# Container-side checks, passed to `sh -c` by extra.sh as user pap: $1 = all | exposure.
# Reads, access(2) tests and bwrap runs only: nothing is ever written to /proc or /sys.
mode=${1:-all}
mkdir -p /home/pap/agent-home
touch /tmp/outer-tmp-marker /home/pap/outer-home-marker

exposure() {
  echo "--- identity: $(id)  apparmor label: $(cat /proc/self/attr/current 2>&1)"
  grep -E '^(CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp):' /proc/self/status
  echo "--- formerly masked paths, seen by this user outside bwrap (mnt = path is a mountpoint, i.e. overmounted by the runtime)"
  for p in /proc/kcore /proc/keys /proc/timer_list /proc/timer_stats /proc/sched_debug /proc/latency_stats /proc/interrupts \
    /proc/sysrq-trigger /proc/sys/kernel/domainname /proc/sys/kernel/core_pattern /proc/sys/vm/drop_caches; do
    if [ ! -e "$p" ]; then echo "$p: absent"; continue; fi
    mnt=$(grep -c " $p " /proc/self/mountinfo)
    if head -c 1 "$p" >/dev/null 2>&1; then rd="read-ok lines<=$(head -c 65536 "$p" | wc -l)"; else rd=read-denied; fi
    if [ -w "$p" ]; then wr=write-access-OK; else wr=write-access-denied; fi
    echo "$p: $(stat -c '%A %U' "$p") mnt=$mnt $rd $wr"
  done
  for p in /proc/acpi /proc/scsi /proc/asound /proc/bus /proc/fs /proc/irq /proc/sys /sys/firmware /sys/fs/selinux \
    /sys/devices/virtual/powercap /sys/fs/cgroup; do
    if [ ! -e "$p" ]; then echo "$p: absent"; continue; fi
    mnt=$(grep -c " $p " /proc/self/mountinfo)
    n=$(ls -A "$p" 2>/dev/null | wc -l)
    names=$(ls -A "$p" 2>/dev/null | head -8 | tr '\n' ' ')
    if [ -w "$p" ]; then wr=write-access-OK; else wr=write-access-denied; fi
    echo "$p: $(stat -c '%A %U' "$p") mnt=$mnt entries=$n [$names] $wr"
  done
}

diag() {
  echo "--- /proc mounts in the container"
  grep -E ' /proc[/ ]' /proc/self/mountinfo | cut -d' ' -f3-6
  echo "--- minimal / unshare-net sandbox: pid ns and procfs superblock inside vs outside"
  echo "outside: pidns=$(readlink /proc/self/ns/pid) proc=$(awk '$5=="/proc"{print $3}' /proc/self/mountinfo | head -1)"
  for o in "" "--unshare-net"; do
    echo "bwrap [$o]: $(bwrap --ro-bind / / $o --dev /dev --proc /proc -- sh -c 'echo pidns=$(readlink /proc/self/ns/pid) proc=$(awk "\$5==\"/proc\"{print \$3}" /proc/self/mountinfo | tail -1) label=$(cat /proc/self/attr/current)' 2>&1)"
  done
  echo "--- unshare-pid without --proc: $(bwrap --ro-bind / / --unshare-pid --dev /dev -- sh -c 'echo ok pid=$$' 2>&1)"
  cp /usr/bin/bwrap /home/pap/bwrap-copy
  echo "--- bwrap copy at /home/pap/bwrap-copy, minimal: $(/home/pap/bwrap-copy --ro-bind / / --dev /dev --proc /proc -- sh -c 'echo ok label=$(cat /proc/self/attr/current)' 2>&1)"
  echo "--- bwrap copy at /home/pap/bwrap-copy, unshare-pid + proc: $(/home/pap/bwrap-copy --ro-bind / / --unshare-pid --dev /dev --proc /proc -- sh -c 'echo ok' 2>&1)"
  echo "--- isolation of the pi-web profile (network false)"
  bwrap --ro-bind / / --unshare-pid --proc /proc --dev /dev --unshare-ipc \
    --tmpfs /run --tmpfs /tmp --tmpfs /home/pap \
    --bind /home/pap/agent-home /home/pap/agent-home --unshare-net --die-with-parent \
    -- sh -c '
echo "pids visible: $(ls /proc | grep -E "^[0-9]+$" | tr "\n" " ")"
echo "pidns inside: $(readlink /proc/self/ns/pid)"
echo "net ifaces: $(tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d " " | tr "\n" " ")"
echo "write /usr: $(touch /usr/x 2>&1)"
echo "write /etc: $(touch /etc/x 2>&1)"
echo "tmp contents: [$(ls /tmp)]"
echo "home contents: [$(ls -A /home/pap)]"
touch /home/pap/agent-home/w && echo "agent-home writable: yes"
echo "sandbox child: $(grep CapEff /proc/self/status)"
if [ -w /proc/sys/kernel/domainname ]; then echo "write access /proc/sys/kernel/domainname: OK"; else echo "write access /proc/sys/kernel/domainname: denied"; fi
' 2>&1
  echo "outer pidns: $(readlink /proc/self/ns/pid)"
}

case $mode in
  all) diag; exposure ;;
  exposure) exposure ;;
esac
