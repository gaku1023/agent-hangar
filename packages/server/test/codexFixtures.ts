import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Codex の rollout の模擬（すべて合成。実際の会話の中身は含まない）。legacy は実物が手元に無いので、設計の推定どおりに作った合成である。
export const FIXTURE_CODEX_DIR = fileURLToPath(new URL('./fixtures/codex', import.meta.url));

export const CODEX_ONE_TURN = { file: 'paginated-one-turn.jsonl', id: '00000000-0000-7000-8000-000000000001' } as const;
export const CODEX_TOOLS = { file: 'paginated-tools.jsonl', id: '00000000-0000-7000-8000-000000000002' } as const;
export const CODEX_LEGACY = { file: 'legacy-synthetic.jsonl', id: '00000000-0000-7000-8000-000000000003' } as const;

export const fixtureBytes = (name: string): Buffer => fs.readFileSync(path.join(FIXTURE_CODEX_DIR, name));
export const fixtureRecords = (name: string): Record<string, any>[] =>
  fixtureBytes(name).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** 空の CODEX_HOME を作る。 */
export function makeCodexHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
}

/** rollout の名前（rollout-<時刻>-<uuid>.jsonl）。日付ごとの置き場に置く相対パスも返す。 */
export function rolloutName(id: string, when = '2026-10-26T14-00-00'): { name: string; rel: string } {
  const [date] = when.split('T');
  const [y, m, d] = date!.split('-');
  const name = `rollout-${when}-${id}.jsonl`;
  return { name, rel: path.join('sessions', y!, m!, d!, name) };
}

/** 本文（バイト列）を CODEX_HOME の下の相対パスへ置き、置いた絶対パスを返す。 */
export function putRollout(home: string, rel: string, body: Buffer | string): string {
  const full = path.join(home, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
}
