#!/bin/sh
# agent-hangar CLI launcher for Git Bash (MSYS) on Windows. It is bin/hangar next to bin/hangar.cmd (hangar.cmd serves cmd and PowerShell).
# Same idea as the sh shim that npm's cmd-shim writes: find where this file is, then run launch-cli.mjs with a Node.
# This file must stay ASCII only and LF only. It is copied as is into the Windows bundle (bundle-server.ts).
#
# Fast path: HANGAR_NODE, then the first node on PATH, when it answers as Node 16 or later
# (launch-cli.mjs is built for Node 16, LAUNCHER_MIN_NODE in bundle-server.ts). Arguments go to node as they are, without another shell in between.
# launch-cli.mjs then checks the Node-API version and architecture against manifest.json and hands over to a fitting Node if needed.
# Everything else (no such node, too old) goes to hangar.cmd, which owns the wider search (the official installer locations and so on).
# The rule for finding a Node is not written again here.

# $0 is the path Git Bash found this file by. A shim from an unusual place is not expected to be a symlink.
here="$(cd "$(dirname "$0")" && pwd)"

# A Windows path with forward slashes ("C:/Users/..."): node.exe and cmd.exe do not read "/c/Users/...".
if command -v cygpath >/dev/null 2>&1; then
  winpath() { cygpath -m "$1"; }
  winpath_bs() { cygpath -w "$1"; }
else
  winpath() { printf '%s\n' "$1"; }
  winpath_bs() { printf '%s\n' "$1"; }
fi

# $1 is a candidate. Prints nothing and returns 1 unless it answers as Node 16 or later.
fits() {
  [ -n "$1" ] || return 1
  major="$("$1" -p "parseInt(process.versions.node)" 2>/dev/null)" || return 1
  case "$major" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$major" -ge 16 ]
}

node=""
if fits "$HANGAR_NODE"; then
  node="$HANGAR_NODE"
elif fits "$(command -v node 2>/dev/null)"; then
  node="$(command -v node)"
fi

if [ -n "$node" ]; then
  exec "$node" "$(winpath "$here/../launch-cli.mjs")" "$@"
fi
# "//c" keeps MSYS from rewriting the /c switch into a path.
exec cmd.exe //c "$(winpath_bs "$here/hangar.cmd")" "$@"
