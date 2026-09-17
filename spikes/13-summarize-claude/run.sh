#!/usr/bin/env bash
# 同じ入力を Haiku に投げ、JSON スキーマ出力の安定性を 3 回見る
set -euo pipefail
F="$1"; OUT="${2:-/tmp}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SCHEMA=$(node "$HERE/../12-summarize-local/schema.mjs")
INPUT=$(node "$HERE/../12-summarize-local/compress.mjs" "$F")
echo "input chars: ${#INPUT}"
for i in 1 2 3; do
  START=$(date +%s)
  printf '%s' "$INPUT" | claude -p --model haiku --output-format json --json-schema "$SCHEMA" \
    --append-system-prompt '以下はコーディングエージェントのセッションログの抜粋です。日本語で要約してください。title は名詞句、one_liner は 1 文、body は 2〜3 文、next_steps は具体的な行動。' \
    --no-session-persistence --tools "" > "$OUT/spike13-$i.json" 2> "$OUT/spike13-$i.err" || echo "run $i exit=$?"
  echo "run $i: $(( $(date +%s) - START ))s"
  node -e "
    const j = require('$OUT/spike13-$i.json');
    console.log('keys:', Object.keys(j).join(','));
    console.log('structured_output:', JSON.stringify(j.structured_output ?? null).slice(0, 500));
    console.log('result:', String(j.result ?? '').slice(0, 300));
    console.log('usage:', JSON.stringify(j.usage ?? j.modelUsage ?? null).slice(0, 300), 'cost_usd:', j.total_cost_usd);
  " || echo "(not json)"
  head -c 300 "$OUT/spike13-$i.err" || true
done
