#!/usr/bin/env bash
# 3 モデル × 3 セッション。LM Studio はモデル切替で読み込みが走るため、モデル外側でループする。
LIST="$1"
for m in qwen3.6-35b-a3b-mlx qwen3.8-27b-uncensored-mlx gemma-4-26b-a4b-it-heretic; do
  while read -r f; do
    echo "=== $m :: $(basename "$f") ==="
    node summarize.mjs "$f" "$m" 2>&1 | cut -c1-1500
  done < "$LIST"
done
echo ALL_DONE
