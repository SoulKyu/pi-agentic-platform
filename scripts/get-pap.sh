#!/bin/sh
# Fetches the pap installer and archive of one channel from GitHub Releases and runs the installer.
# The installer pins the archive's SHA-256; this script pins the installer's, taken from the channel's feed file.
# All three come from the same release host: that detects corruption and a swapped asset, not a compromised release (docs/agents/install.md).
# The whole body is one function called on the last line: a download cut at a line boundary runs nothing.
# usage: get-pap.sh [stable|next] [-- <pap-install flags, for example --port 7791>]
set -eu
umask 077

REPO="${PAP_GET_REPO:-SoulKyu/pi-agentic-platform}"
BASE="https://github.com/$REPO/releases"
die() { printf 'get-pap: %s\n' "$*" >&2; exit 1; }

fetch() { # url, output file, byte cap: https only, no redirect to anything else, bounded size and time
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --max-redirs 3 --connect-timeout 15 --max-time 900 --max-filesize "$3" --output "$2" -- "$1" \
    || die "download failed: $1"
}

main() {
  [ "$(id -u)" -ne 0 ] || die "do not run as root: pap is a user service"
  [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || die "the pap archive is for linux-x64"
  for tool in curl sha256sum bash mktemp; do command -v "$tool" >/dev/null 2>&1 || die "missing tool: $tool"; done
  case "$REPO" in ""|*[!A-Za-z0-9._/-]*|*..*|/*|*/|*//*|*/*/*) die "PAP_GET_REPO is not owner/name" ;; */*) ;; *) die "PAP_GET_REPO is not owner/name" ;; esac

  channel="stable"
  if [ "$#" -gt 0 ] && [ "$1" != "--" ]; then channel="$1"; shift; fi
  [ "${1:-}" != "--" ] || shift
  case "$channel" in
    stable) feed_url="$BASE/latest/download/pap-feed-stable.env" ;;
    next) feed_url="$BASE/download/next/pap-feed-next.env" ;;
    *) die "the channel is stable or next" ;;
  esac

  work="$(mktemp -d "${TMPDIR:-/tmp}/get-pap.XXXXXX")"
  trap 'rm -rf -- "$work"' EXIT HUP INT TERM

  fetch "$feed_url" "$work/feed.env" 8192
  # The feed is data, never sourced: every line must match one of seven fixed shapes.
  VERSION="" RELEASE_ID="" INSTALLER_NAME="" INSTALLER_URL="" INSTALLER_SHA256="" ARCHIVE_NAME="" ARCHIVE_URL=""
  while IFS='=' read -r key value; do
    case "$key" in
      VERSION) case "$value" in ""|*[!0-9A-Za-z.+-]*) die "bad feed: VERSION" ;; esac; VERSION="$value" ;;
      RELEASE_ID) case "$value" in ""|*[!0-9A-Za-z._-]*) die "bad feed: RELEASE_ID" ;; esac; RELEASE_ID="$value" ;;
      INSTALLER_NAME) case "$value" in pap-install-*.sh) ;; *) die "bad feed: INSTALLER_NAME" ;; esac
        case "$value" in *[!0-9A-Za-z._-]*|*..*) die "bad feed: INSTALLER_NAME" ;; esac; INSTALLER_NAME="$value" ;;
      ARCHIVE_NAME) case "$value" in pap-*-linux-x64.tar.gz) ;; *) die "bad feed: ARCHIVE_NAME" ;; esac
        case "$value" in *[!0-9A-Za-z._-]*|*..*) die "bad feed: ARCHIVE_NAME" ;; esac; ARCHIVE_NAME="$value" ;;
      INSTALLER_URL) case "$value" in https://github.com/"$REPO"/releases/download/*) ;; *) die "bad feed: INSTALLER_URL" ;; esac
        case "$value" in *[!0-9A-Za-z._/:+-]*|*..*) die "bad feed: INSTALLER_URL" ;; esac; INSTALLER_URL="$value" ;;
      ARCHIVE_URL) case "$value" in https://github.com/"$REPO"/releases/download/*) ;; *) die "bad feed: ARCHIVE_URL" ;; esac
        case "$value" in *[!0-9A-Za-z._/:+-]*|*..*) die "bad feed: ARCHIVE_URL" ;; esac; ARCHIVE_URL="$value" ;;
      INSTALLER_SHA256) case "$value" in *[!0-9a-f]*) die "bad feed: INSTALLER_SHA256" ;; esac
        [ "${#value}" -eq 64 ] || die "bad feed: INSTALLER_SHA256"; INSTALLER_SHA256="$value" ;;
      *) die "bad feed: unknown line" ;;
    esac
  done < "$work/feed.env"
  [ -n "$VERSION" ] && [ -n "$RELEASE_ID" ] && [ -n "$INSTALLER_NAME" ] && [ -n "$INSTALLER_URL" ] \
    && [ -n "$INSTALLER_SHA256" ] && [ -n "$ARCHIVE_NAME" ] && [ -n "$ARCHIVE_URL" ] || die "bad feed: a line is missing"
  [ "$INSTALLER_NAME" = "pap-install-$RELEASE_ID.sh" ] && [ "$ARCHIVE_NAME" = "pap-$RELEASE_ID-linux-x64.tar.gz" ] \
    || die "bad feed: the file names do not match the release id"

  fetch "$INSTALLER_URL" "$work/$INSTALLER_NAME" 262144
  actual="$(sha256sum -- "$work/$INSTALLER_NAME" | cut -d' ' -f1)"
  [ "$actual" = "$INSTALLER_SHA256" ] || die "the installer does not match the feed's checksum: nothing was run"
  fetch "$ARCHIVE_URL" "$work/$ARCHIVE_NAME" 1073741824
  printf 'get-pap: pap %s (%s), channel %s\n' "$VERSION" "$RELEASE_ID" "$channel"
  status=0
  bash "$work/$INSTALLER_NAME" "$@" </dev/null || status=$?
  exit "$status"
}

main "$@"
