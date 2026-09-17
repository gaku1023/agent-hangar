#!/usr/bin/env bash
# 非対話で D1 と R2 を作り、wrangler.jsonc を生成してデプロイする
set -euo pipefail
cd "$(dirname "$0")/worker"
OUT=$(npx wrangler d1 create hangar-spike 2>&1 | tee /dev/stderr)
DB_ID=$(echo "$OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
[ -n "$DB_ID" ] || { echo "no database id parsed"; exit 1; }
npx wrangler r2 bucket create hangar-spike 2>&1 | tail -2
cat > wrangler.jsonc <<EOS
{
  "name": "hangar-spike",
  "main": "src/index.js",
  "compatibility_date": "2026-08-01",
  "d1_databases": [{ "binding": "DB", "database_name": "hangar-spike", "database_id": "$DB_ID" }],
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "hangar-spike" }]
}
EOS
npx wrangler deploy 2>&1 | tee deploy.log | tail -6
grep -oE 'https://[a-z0-9.-]+workers\.dev' deploy.log | head -1 > url.txt
echo "URL: $(cat url.txt)"
