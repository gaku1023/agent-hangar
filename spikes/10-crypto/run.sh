#!/usr/bin/env bash
set -euo pipefail
T0=$(date +%s)
tar czf /tmp/projects.tgz -C "$HOME/.claude" projects
echo "gzip: $(( $(date +%s) - T0 ))s, size: $(stat -f %z /tmp/projects.tgz) bytes"
node "$(dirname "$0")/bench.mjs" /tmp/projects.tgz
rm -f /tmp/projects.tgz /tmp/spike.enc /tmp/spike.dec
echo DONE
