#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/worker"
yes | npx wrangler delete --name hangar-spike 2>&1 | tail -2
npx wrangler r2 object delete hangar-spike/spike/hello.bin 2>&1 | tail -1
npx wrangler r2 bucket delete hangar-spike 2>&1 | tail -1
npx wrangler d1 delete hangar-spike -y 2>&1 | tail -1
rm -f wrangler.jsonc url.txt deploy.log
echo TEARDOWN_DONE
