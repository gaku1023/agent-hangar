// CI が入れる codex の版の指定を、確かめた範囲（packages/shared/src/codexCompat.ts の CODEX_VERIFIED_RANGE）から作って出す。
// 版は 1 か所（CODEX_VERIFIED_RANGE）だけで持つ。範囲が 0.164.x なら、npm の指定は 0.164（その中でいちばん新しい 0.164.y）になる。
// 使い方：npm install -g @openai/codex@"$(node scripts/codex-compat-version.mjs)"
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../packages/shared/src/codexCompat.ts', import.meta.url), 'utf8');
const range = /export const CODEX_VERIFIED_RANGE = '([0-9x.]+)'/.exec(src)?.[1];
if (!range) {
  console.error('CODEX_VERIFIED_RANGE を読めません');
  process.exit(1);
}
// x は「その区切りを問わない」なので、そこから先を落とす（0.164.x → 0.164）。
const parts = range.split('.');
const fixed = parts.slice(0, parts.includes('x') ? parts.indexOf('x') : parts.length);
if (fixed.length === 0) {
  console.error(`範囲 ${range} は、npm の指定にできません`);
  process.exit(1);
}
console.log(fixed.join('.'));
