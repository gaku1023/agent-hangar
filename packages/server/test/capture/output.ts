import { SCENARIO } from './scenario.ts';
import { leaks, redactAgents, redactAuth, redactRegistry, redactStatusline, redactTranscriptLine, replacements, type Secrets } from './redact.ts';

// 採った生の値から、書き出すファイルの中身を組み立てる。伏せ残しの見つけ方もここに置く。
// run.ts（採る道具）が使う。純粋な関数にして、作り物の採取で試験する。

/**
 * JSON Lines を読む。空の行は飛ばす。name は、壊れた行を言うときのファイル名である。
 * JSON.parse の言葉は行の頭の文字を含むので（Node 22）、捕まえて、ファイル名と行番号だけの言葉で投げ直す。
 */
export function jsonl(text: string, name: string): unknown[] {
  const out: unknown[] = [];
  text.split('\n').forEach((l, i) => {
    if (l.trim() === '') return;
    try { out.push(JSON.parse(l) as unknown); } catch { throw new Error(`${name} の ${i + 1} 行目を JSON として読めませんでした`); }
  });
  return out;
}
export const toJsonl = (recs: unknown[]): string => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** 採った生の値。サブエージェントの鍵はファイル名（agent-<id>.jsonl）である。 */
export type Raw = {
  transcript: string;
  subagents: Record<string, string>;
  registry: unknown[];
  statusline: unknown[];
  /** agents --json --all の結果（読めなければ空の配列）。 */
  agents: unknown;
  auth: Record<string, unknown>;
  help: string;
  /** claude --version の出力そのまま（version.txt になる）。 */
  versionText: string;
  /** versionText から読んだ版（meta.json に入る）。 */
  version: string;
  sessionId: string;
  /** 採った日（YYYY-MM-DD）。 */
  capturedAt: string;
};

/** 書き出すファイルの名前と中身。伏せ方はここで全部当てる。 */
export function buildFiles(raw: Raw, secrets: Secrets): Record<string, string> {
  const pairs = replacements(secrets);
  const files: Record<string, string> = {
    'transcript.jsonl': toJsonl(jsonl(raw.transcript, 'transcript.jsonl').map((r) => redactTranscriptLine(r, pairs))),
    'registry.jsonl': toJsonl(raw.registry.map((r) => redactRegistry(r, pairs))),
    'statusline.jsonl': toJsonl(raw.statusline.map((r) => redactStatusline(r, pairs))),
    'agents.json': JSON.stringify(redactAgents(raw.agents, raw.sessionId, pairs), null, 2) + '\n',
    'auth-status.json': JSON.stringify(redactAuth(raw.auth, pairs), null, 2) + '\n',
    'help.txt': raw.help,
    'version.txt': raw.versionText,
    'meta.json': JSON.stringify({ version: raw.version, sessionId: raw.sessionId, capturedAt: raw.capturedAt }, null, 2) + '\n',
  };
  for (const [name, text] of Object.entries(raw.subagents)) files[`subagents/${name}`] = toJsonl(jsonl(text, `subagents/${name}`).map((r) => redactTranscriptLine(r, pairs)));
  return files;
}

/**
 * 伏せた後の transcript に、筋書きの 2 つの指示が残っているか。無いものを、値を出さない言葉で返す（空なら通った）。
 * 伏せ（置き換えの組やアドレスの置き換え）が、たまたま指示の文の一部を崩すことがあるので、書き出す前に確かめる。
 * 指示は JSON の文字列の中にあるので、JSON で書き換わる記号を書き換えた形で探す。
 */
export function scenarioKept(files: Record<string, string>, scenario: { first: string; queued: string } = SCENARIO): string[] {
  const text = files['transcript.jsonl'] ?? '';
  const has = (v: string): boolean => text.includes(JSON.stringify(v).slice(1, -1));
  const out: string[] = [];
  if (!has(scenario.first)) out.push('伏せた後の transcript に 1 つ目の指示がありません');
  if (!has(scenario.queued)) out.push('伏せた後の transcript に積んだ指示がありません');
  return out;
}

/** 伏せ残し 1 件。値は持たない。line は 1 から数える（ファイル全体が 1 つの JSON のときは null）、path は JSON のパス（読めなければ -）。 */
export type Leak = { file: string; line: number | null; path: string; kind: string };

/** 鍵や語をそのまま出してよい形（識別子の形で、それ自体が伏せ残しでない）。 */
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

/**
 * 書き出す前のファイル全部から、伏せ残しを 1 件ずつ見つける。
 * 文字列の値と鍵を 1 つずつ leaks に通し、どのファイルの何行目の、JSON のどのパスかを返す。
 * パスに値が出ないように、識別子の形でない鍵（パスなど）は {key} と書く。鍵そのものが伏せ残しのときは、パスの末尾に {key} を付ける。
 * JSON として読めない行と、テキストのファイル（.json と .jsonl でないもの）は、行ごとの文字列として見て、パスを - にする。
 * ファイル全体の文字列は見ない。JSON の文字列化で改行は \n、タブは \t になり、その直後の置き換え済みのアドレスが
 * nuser@example.com のような別のアドレスに見えて、伏せが済んでいても書き出しを断ってしまうためである。
 * 読めた JSON の文字列と鍵はどれも 1 つずつ見るので、ファイル全体で見ていた範囲は欠けない。
 */
export function findLeaks(files: Record<string, string>, s: Secrets): Leak[] {
  const out: Leak[] = [];
  const walk = (file: string, line: number | null, v: unknown, p: string): void => {
    if (typeof v === 'string' || typeof v === 'number') {
      // 数も、ファイル全体を見ていたときと同じく文字の形で見る（数だけのユーザー名やホスト名に備える）。
      for (const kind of leaks(String(v), s)) out.push({ file, line, path: p, kind });
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(file, line, x, `${p}[${i}]`));
    } else if (typeof v === 'object' && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        const keyKinds = leaks(k, s);
        for (const kind of keyKinds) out.push({ file, line, path: `${p}{key}`, kind });
        walk(file, line, x, `${p}.${SAFE_KEY.test(k) && keyKinds.length === 0 ? k : '{key}'}`);
      }
    }
  };
  /** 行を、JSON として読まずに文字列のまま見る。 */
  const textLine = (file: string, line: number, l: string): void => {
    for (const kind of leaks(l, s)) out.push({ file, line, path: '-', kind });
  };
  for (const [file, text] of Object.entries(files)) {
    const lines = text.split('\n');
    if (file.endsWith('.json')) {
      let parsed: { ok: true; v: unknown } | { ok: false };
      try { parsed = { ok: true, v: JSON.parse(text) }; } catch { parsed = { ok: false }; }
      if (parsed.ok) walk(file, null, parsed.v, '$');
      else lines.forEach((l, i) => { if (l !== '') textLine(file, i + 1, l); });
    } else if (file.endsWith('.jsonl')) {
      lines.forEach((l, i) => {
        if (l === '') return;
        let parsed: { ok: true; v: unknown } | { ok: false };
        try { parsed = { ok: true, v: JSON.parse(l) }; } catch { parsed = { ok: false }; }
        if (parsed.ok) walk(file, i + 1, parsed.v, '$');
        else textLine(file, i + 1, l);
      });
    } else {
      lines.forEach((l, i) => { if (l !== '') textLine(file, i + 1, l); });
    }
  }
  return out;
}

/** 伏せ残しを標準エラーに出す形にする。値は出さない。多いときは先頭の limit 件と、残りの件数。 */
export function formatLeaks(found: Leak[], limit = 30): string {
  const lines = found.slice(0, limit).map((l) => `- ${l.file}:${l.line ?? '-'} ${l.path} ${l.kind}`);
  if (found.length > limit) lines.push(`- ほか ${found.length - limit} 件`);
  return lines.join('\n');
}
