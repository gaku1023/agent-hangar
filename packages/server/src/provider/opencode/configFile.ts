import fs from 'node:fs';
import path from 'node:path';
import { parseJsonc } from '../../config/jsonTextEdit.ts';

/**
 * 利用者の opencode の設定（`~/.config/opencode/opencode.json`）を、hangar が書き換える口（docs/design.md「opencode のプロバイダー」）。
 * hangar が書くのは、設定のプロバイダーの面の「OpenAI 互換のサーバー」と「モデル ID を追加」と、OpenAI 互換のサーバーの「接続を解除」だけである。
 * 書く前に、同じディレクトリへ `opencode.json.bak-<日時>` の形でバックアップする。書き方（コメント、字下げ、キーの順）は config/jsonTextEdit.ts で保つ。
 * opencode の serve は hangar の空の環境（HOME だけ）で起こすので、読む設定はいつも HOME の下の .config/opencode である（XDG_CONFIG_HOME は渡さない）。
 */

/** opencode.json の場所。.json が無く .jsonc があれば、そちらを使う。どちらも無ければ .json（書くときに作る）。 */
export function opencodeConfigPath(home: string): string {
  const dir = path.join(home, '.config', 'opencode');
  const json = path.join(dir, 'opencode.json');
  const jsonc = path.join(dir, 'opencode.jsonc');
  return !fs.existsSync(json) && fs.existsSync(jsonc) ? jsonc : json;
}

/** opencode.json に書いたプロバイダー 1 つ。legacy は 1.x の書き方（`provider`）の中にあること。baseURL は 2.x の settings か 1.x の options のもの。 */
export type ConfigProvider = { id: string; legacy: boolean; baseURL: string | null; models: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** opencode.json の中身。無ければ空のオブジェクト。読めなければ投げる（JsonTextEditError）。 */
export function readOpencodeConfig(file: string): Record<string, unknown> {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const j = parseJsonc(text);
  return isObj(j) ? j : {};
}

/** opencode.json に書いたプロバイダー。2.x の `providers` を先に、1.x の `provider` を後に並べる（同じ ID は 2.x のもの）。読めなければ空。 */
export function configProviders(file: string): ConfigProvider[] {
  let j: Record<string, unknown>;
  try { j = readOpencodeConfig(file); } catch { return []; }
  const out: ConfigProvider[] = [];
  const add = (block: unknown, legacy: boolean) => {
    if (!isObj(block)) return;
    for (const [id, p] of Object.entries(block)) {
      if (!isObj(p) || out.some((x) => x.id === id)) continue;
      const settings = isObj(p.settings) ? p.settings : isObj(p.options) ? p.options : {};
      out.push({ id, legacy, baseURL: typeof settings.baseURL === 'string' && settings.baseURL ? settings.baseURL : null, models: isObj(p.models) ? Object.keys(p.models) : [] });
    }
  };
  add(j.providers, false);
  add(j.provider, true);
  return out;
}

const pad = (n: number): string => String(n).padStart(2, '0');
/** バックアップの名前に付ける日時（その PC の時刻で YYYYMMDD-HHMMSS）。 */
const stamp = (d: Date): string => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/**
 * opencode.json を書き換える。edit は今の中身（無ければ空の文字列）から次の中身を返す。変わらなければ何もしない。
 * 書く前に、ファイルがあれば `<file>.bak-<日時>` にバックアップする（同じ名前があれば番号を付ける）。書き込みはその場に行い、シンボリックリンクとモードを保つ。
 * 戻り値はバックアップの場所（取らなかったら null）と、書いたか。
 */
export function editOpencodeConfig(file: string, edit: (text: string) => string, now: Date = new Date()): { backup: string | null; changed: boolean } {
  let before: string | null;
  try { before = fs.readFileSync(file, 'utf8'); } catch { before = null; }
  const next = edit(before ?? '');
  if (next === (before ?? '')) return { backup: null, changed: false };
  let backup: string | null = null;
  if (before !== null) {
    const base = `${file}.bak-${stamp(now)}`;
    backup = base;
    for (let n = 2; fs.existsSync(backup); n++) backup = `${base}-${n}`;
    fs.copyFileSync(file, backup);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.writeFileSync(file, next);
  return { backup, changed: true };
}
