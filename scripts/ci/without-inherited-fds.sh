#!/usr/bin/env bash
# Runs a command with only stdin, stdout and stderr open (M13-C13).
# GitHub's Actions runner hands every step open descriptors without close-on-exec (pipes, fd 142 and 145 seen), and Node's
# spawn passes them on to the shell and the sandbox. The integration tests pin that only stdio reaches a shell or a
# sandbox (M8R119, RT-23). Under systemd, the supported runtime, the daemon inherits only 0 to 2, so product behaviour is
# unchanged; this wrapper gives the tests the same start. The loop lives in a `bash -c` string so that no script file
# descriptor of this shell is left to close.
set -eu
exec bash -c 'for f in /proc/$$/fd/*; do fd=${f##*/}; if [ "$fd" -gt 2 ] 2>/dev/null; then eval "exec $fd>&-"; fi; done 2>/dev/null; exec "$@"' bash "$@"
