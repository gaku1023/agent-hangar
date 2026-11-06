import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../db/open.ts';
import {
  PEER_CHAT_TAIL_BYTE_BUDGET,
  currentPendingAsk,
  dbTranscriptReader,
  transcriptTail,
  type PeerPendingAsk,
  type TailDeps,
} from './tail.ts';

// ---- 道具 ----

let n = 0;
const uid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const line = (o: Record<string, unknown>): string => JSON.stringify({ uuid: uid(), isSidechain: false, timestamp: '2026-01-01T00:00:00.000Z', ...o });
const user = (text: string, extra: Record<string, unknown> = {}): string => line({ type: 'user', message: { role: 'user', content: text }, ...extra });
const asst = (...blocks: unknown[]): string => line({ type: 'assistant', message: { role: 'assistant', model: 'm', content: blocks } });
const text = (t: string) => ({ type: 'text', text: t });
const use = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
const result = (id: string, content: string, isError = false): string => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const body = (lines: string[], tail = ''): Buffer => Buffer.from(lines.join('\n') + '\n' + tail);

function deps(buf: Buffer | null, pending: PeerPendingAsk | null = null): TailDeps {
  return { readTranscript: () => buf, pendingAsk: () => pending };
}
const uuidOf = (l: string): string => (JSON.parse(l) as { uuid: string }).uuid;

const permissionAsk = (over: Partial<PeerPendingAsk> = {}): PeerPendingAsk => ({
  kind: 'permission', tool: 'Bash', input: 'rm -rf build', description: 'Delete build output',
  options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }], multi: false, allowText: false, ...over,
});

// ---- 試験 ----

describe('transcriptTail: 対応づけ', () => {
  it('利用者の文と Claude の返事を user と assistant にし、thinking は出さない', () => {
    const u = user('hello');
    const a = asst({ type: 'thinking', thinking: 'secret', signature: 'x' }, text('hi there'));
    const r = transcriptTail('s', null, 200, deps(body([u, a])));
    expect(r.items.map((i) => [i.kind, i.text])).toEqual([['user', 'hello'], ['assistant', 'hi there']]);
    expect(r.items[0]!.uuid).toBe(uuidOf(u));
    expect(r.items[1]!.uuid).toBe(uuidOf(a));
    expect(r.items[0]!.at).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(JSON.stringify(r)).not.toContain('secret');
  });

  it('tool_use と tool_result を 1 つの tool 項目にし、名前と主な引数と成否を持つ', () => {
    const lines = [
      user('go'),
      asst(use('t1', 'Bash', { command: 'ls -la\necho second' })),
      result('t1', 'file'),
      asst(use('t2', 'Read', { file_path: '/tmp/x.txt' })),
      result('t2', 'boom', true),
    ];
    const r = transcriptTail('s', null, 200, deps(body(lines)));
    expect(r.items.map((i) => i.kind)).toEqual(['user', 'tool', 'tool']);
    expect(r.items[1]!.tool).toEqual({ name: 'Bash', summary: 'Bash ls -la', ok: true });
    expect(r.items[2]!.tool).toEqual({ name: 'Read', summary: 'Read /tmp/x.txt', ok: false });
    expect(r.items[1]!.uuid).toBe(uuidOf(lines[1]!));
    // tool_result の行は項目にならない
    expect(r.items).toHaveLength(3);
  });

  it('要約は 1 行で、長すぎれば切る', () => {
    const lines = [asst(use('t1', 'Bash', { command: 'x'.repeat(5000) })), result('t1', 'ok')];
    const r = transcriptTail('s', null, 200, deps(body(lines)));
    const s = r.items[0]!.tool!.summary;
    expect(s.includes('\n')).toBe(false);
    expect(s.length).toBeLessThanOrEqual(200);
    expect(s.startsWith('Bash xxx')).toBe(true);
  });

  it('1 つの行から複数の項目が出ても uuid は重ならない', () => {
    const a = asst(text('one'), use('t1', 'Bash', { command: 'ls' }), text('two'));
    const lines = [a, result('t1', 'ok')];
    const r = transcriptTail('s', null, 200, deps(body(lines)));
    const ids = r.items.map((i) => i.uuid);
    expect(r.items.map((i) => i.kind)).toEqual(['assistant', 'tool', 'assistant']);
    expect(ids[0]).toBe(uuidOf(a));
    expect(new Set(ids).size).toBe(3);
  });

  it('サブエージェント（sidechain）、meta、要約の継続、ローカルコマンドは出さない', () => {
    const lines = [
      user('visible'),
      user('sidechain prompt', { isSidechain: true }),
      asst(text('sidechain reply')),
      user('meta text', { isMeta: true }),
      user('<command-name>/clear</command-name>'),
      user('This session is being continued from a previous conversation', { isCompactSummary: true }),
      line({ type: 'attachment', attachment: { type: 'date' } }),
      line({ type: 'system', subtype: 'turn_duration', content: 'x' }),
      line({ type: 'api-request', blob: 'x'.repeat(100) }),
    ];
    // sidechain の assistant 行は isSidechain を付けて作り直す
    lines[2] = line({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [text('sidechain reply')] } });
    const r = transcriptTail('s', null, 200, deps(body(lines)));
    expect(r.items.map((i) => i.text)).toEqual(['visible']);
  });

  it('作業中に打って積まれた指示（queued_command）は user として出す', () => {
    const lines = [line({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, prompt: 'queued one' } })];
    const r = transcriptTail('s', null, 200, deps(body(lines)));
    expect(r.items.map((i) => [i.kind, i.text])).toEqual([['user', 'queued one']]);
  });
});

describe('transcriptTail: after と cursor', () => {
  const lines = [user('a'), asst(text('b')), user('c'), asst(text('d'))];
  const ids = lines.map(uuidOf);

  it('after 以降だけを返し、cursor は最後の項目の uuid', () => {
    const r = transcriptTail('s', ids[1]!, 200, deps(body(lines)));
    expect(r.items.map((i) => i.text)).toEqual(['c', 'd']);
    expect(r.cursor).toBe(ids[3]);
    expect(r.truncated).toBe(false);
  });

  it('新しいものが無ければ項目は空で、cursor は after のまま', () => {
    const r = transcriptTail('s', ids[3]!, 200, deps(body(lines)));
    expect(r.items).toEqual([]);
    expect(r.cursor).toBe(ids[3]);
    expect(r.truncated).toBe(false);
  });

  it('after が null なら全部、少なければ truncated は false', () => {
    const r = transcriptTail('s', null, 200, deps(body(lines)));
    expect(r.items).toHaveLength(4);
    expect(r.truncated).toBe(false);
  });

  it('after が null で limit を超えれば、末尾 limit 件と truncated', () => {
    const many = Array.from({ length: 10 }, (_, i) => user(`m${i}`));
    const r = transcriptTail('s', null, 3, deps(body(many)));
    expect(r.items.map((i) => i.text)).toEqual(['m7', 'm8', 'm9']);
    expect(r.truncated).toBe(true);
    expect(r.cursor).toBe(uuidOf(many[9]!));
  });

  it('after が見つからなければ、末尾 limit 件と truncated: true', () => {
    const many = Array.from({ length: 10 }, (_, i) => user(`m${i}`));
    const r = transcriptTail('s', 'no-such-uuid', 4, deps(body(many)));
    expect(r.items.map((i) => i.text)).toEqual(['m6', 'm7', 'm8', 'm9']);
    expect(r.truncated).toBe(true);
  });

  it('after が見つかっても、その後ろが limit を超えれば末尾 limit 件と truncated', () => {
    const many = Array.from({ length: 10 }, (_, i) => user(`m${i}`));
    const r = transcriptTail('s', uuidOf(many[0]!), 3, deps(body(many)));
    expect(r.items.map((i) => i.text)).toEqual(['m7', 'm8', 'm9']);
    expect(r.truncated).toBe(true);
  });

  it('既定の limit は 200', () => {
    const many = Array.from({ length: 250 }, (_, i) => user(`m${i}`));
    const r = transcriptTail('s', null, undefined, deps(body(many)));
    expect(r.items).toHaveLength(200);
    expect(r.items[0]!.text).toBe('m50');
    expect(r.truncated).toBe(true);
  });

  it('同じ uuid を二度出さない（再開で行が写されても 1 つにする）', () => {
    const dup = user('dup');
    const r = transcriptTail('s', null, 200, deps(body([dup, user('x'), dup])));
    expect(r.items.map((i) => i.text)).toEqual(['dup', 'x']);
  });

  it('本文が無いか空なら、空の答えで cursor は after', () => {
    expect(transcriptTail('s', 'x', 200, deps(null))).toEqual({ items: [], cursor: 'x', truncated: false });
    expect(transcriptTail('s', null, 200, deps(Buffer.alloc(0)))).toEqual({ items: [], cursor: null, truncated: false });
  });
});

describe('transcriptTail: 書きかけの行と道具の途中', () => {
  it('改行で終わらない最終行は読まない', () => {
    const a = user('complete');
    const partial = user('half').slice(0, 40);
    const r = transcriptTail('s', null, 200, deps(body([a], partial)));
    expect(r.items.map((i) => i.text)).toEqual(['complete']);
  });

  it('壊れた行は飛ばす', () => {
    const r = transcriptTail('s', null, 200, deps(body([user('a'), '{not json', user('b')])));
    expect(r.items.map((i) => i.text)).toEqual(['a', 'b']);
  });

  it('結果がまだ来ない道具と、その後ろの項目は、結果が来るまで出さない', () => {
    const lines = [user('go'), asst(use('t1', 'Bash', { command: 'sleep 20' })), line({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, prompt: 'typed later' } })];
    const r = transcriptTail('s', null, 200, deps(body(lines)));
    expect(r.items.map((i) => i.kind)).toEqual(['user']);
    // 結果が届けば、そこから先も出る
    const done = [...lines, result('t1', 'ok'), asst(text('done'))];
    const r2 = transcriptTail('s', r.cursor, 200, deps(body(done)));
    expect(r2.items.map((i) => i.kind)).toEqual(['tool', 'user', 'assistant']);
  });

  it('結果が来ないまま利用者の発言が続いた道具は、失敗として出す（中断）', () => {
    const lines = [asst(use('t1', 'Bash', { command: 'sleep 20' })), user('[Request interrupted by user for tool use]'), user('next')];
    const r = transcriptTail('s', null, 200, deps(body(lines)));
    expect(r.items.map((i) => [i.kind, i.tool?.ok])).toEqual([['tool', false], ['user', undefined]]);
  });
});

describe('transcriptTail: 許可と質問の札', () => {
  const base = [user('go'), asst(use('toolu_A', 'Bash', { command: 'rm -rf build' }))];

  it('出ている許可を最後の項目として足し、ask に選択肢と multi と allowText を持たせる', () => {
    const r = transcriptTail('s', null, 200, deps(body(base), permissionAsk()));
    const last = r.items[r.items.length - 1]!;
    expect(r.items.map((i) => i.kind)).toEqual(['user', 'permission']);
    expect(last.ask).toMatchObject({ kind: 'permission', tool: 'Bash', input: 'rm -rf build', options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }], multi: false, allowText: false });
    expect(last.ask!.askId).toMatch(/^[0-9a-f]{24}$/);
    expect(last.text).toBe('Delete build output');
    expect(r.cursor).toBe(last.uuid);
  });

  it('質問は question 項目で、本文は問いの文', () => {
    const q: PeerPendingAsk = { kind: 'question', tool: 'AskUserQuestion', question: 'Which one?', options: [{ key: '1', label: 'A' }, { key: '2', label: 'B' }], multi: true, allowText: true };
    const r = transcriptTail('s', null, 200, deps(body([user('go'), asst(use('toolu_Q', 'AskUserQuestion', {}))]), q));
    const last = r.items[r.items.length - 1]!;
    expect(last.kind).toBe('question');
    expect(last.text).toBe('Which one?');
    expect(last.ask).toMatchObject({ kind: 'question', multi: true, allowText: true });
  });

  it('同じ許可なら askId は変わらず、別の許可なら変わる', () => {
    const id = (d: TailDeps): string => transcriptTail('s', null, 200, d).items.at(-1)!.ask!.askId;
    const same1 = id(deps(body(base), permissionAsk()));
    const same2 = id(deps(body(base), permissionAsk()));
    expect(same1).toBe(same2);
    // 画面から取った選択肢の違いでは変わらない
    expect(id(deps(body(base), permissionAsk({ options: [{ key: '1', label: 'Yes' }] })))).toBe(same1);
    // 命令が違えば変わる
    expect(id(deps(body(base), permissionAsk({ input: 'rm -rf other' })))).not.toBe(same1);
    // 同じ命令でも、道具の呼び出しが別なら（2 回目の確認）変わる
    const again = [user('go'), asst(use('toolu_B', 'Bash', { command: 'rm -rf build' }))];
    expect(id(deps(body(again), permissionAsk()))).not.toBe(same1);
  });

  it('許可が出ている間に別の行が増えても askId は変わらない', () => {
    const id = (d: TailDeps): string => transcriptTail('s', null, 200, d).items.at(-1)!.ask!.askId;
    const before = id(deps(body(base), permissionAsk()));
    const queued = line({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, prompt: 'more' } });
    // 結果の来ていない道具の後ろに積んだ指示が増えても、askId の拠り所（道具の呼び出し）は同じ
    expect(id(deps(body([...base, queued]), permissionAsk()))).toBe(before);
  });

  it('札を受け取った後の after では札を繰り返さず、許可が消えれば続きの項目が出る', () => {
    const d1 = deps(body(base), permissionAsk());
    const r1 = transcriptTail('s', null, 200, d1);
    const again = transcriptTail('s', r1.cursor, 200, d1);
    expect(again.items).toEqual([]);
    expect(again.cursor).toBe(r1.cursor);
    // 許可して道具が終わり、許可の札が無くなった後
    const lines2 = [...base, result('toolu_A', 'ok'), asst(text('finished'))];
    const r2 = transcriptTail('s', r1.cursor, 200, deps(body(lines2), null));
    expect(r2.items.map((i) => [i.kind, i.text])).toEqual([['tool', 'Bash rm -rf build'], ['assistant', 'finished']]);
  });

  it('transcript がまだ空でも札は出て、その uuid を after にすると繰り返さず、続きは先頭から出る', () => {
    const d = deps(Buffer.alloc(0), permissionAsk());
    const r1 = transcriptTail('s', null, 200, d);
    expect(r1.items).toHaveLength(1);
    expect(transcriptTail('s', r1.cursor, 200, d)).toEqual({ items: [], cursor: r1.cursor, truncated: false });
    const r2 = transcriptTail('s', r1.cursor, 200, deps(body([user('first')]), null));
    expect(r2.items.map((i) => i.text)).toEqual(['first']);
    expect(r2.truncated).toBe(false);
  });

  it('選択肢の label は画面の文のまま、key は一意にそろえる', () => {
    const options = [
      { key: '1', label: "Yes, and don't ask again for rm commands in /tmp" },
      { key: '1', label: 'Yes' },
      { key: '', label: ' No ' },
    ];
    const r = transcriptTail('s', null, 200, deps(body(base), permissionAsk({ options })));
    const got = r.items.at(-1)!.ask!.options;
    expect(got.map((o) => o.label)).toEqual(options.map((o) => o.label));
    expect(new Set(got.map((o) => o.key)).size).toBe(3);
    expect(got.every((o) => o.key !== '')).toBe(true);
    expect(got[0]!.key).toBe('1');
  });

  it('札の項目には uuid が付き、transcript の項目と重ならない', () => {
    const r = transcriptTail('s', null, 200, deps(body(base), permissionAsk()));
    expect(new Set(r.items.map((i) => i.uuid)).size).toBe(r.items.length);
  });

  it('currentPendingAsk は tail が出す札と同じ askId を返す', () => {
    const d = deps(body(base), permissionAsk());
    const viaTail = transcriptTail('s', null, 200, d).items.at(-1)!.ask!;
    expect(currentPendingAsk('s', d)).toEqual(viaTail);
    expect(currentPendingAsk('s', deps(body(base), null))).toBeNull();
  });
});

describe('transcriptTail: 大きさ', () => {
  it('JSON が予算を超えれば古い項目から落とし、truncated にする', () => {
    const big = 'あ'.repeat(2000);
    const many = Array.from({ length: 40 }, (_, i) => user(`${i}:${big}`));
    const r = transcriptTail('s', null, 200, deps(body(many)));
    const size = Buffer.byteLength(JSON.stringify(r.items));
    expect(size).toBeLessThanOrEqual(PEER_CHAT_TAIL_BYTE_BUDGET);
    expect(r.truncated).toBe(true);
    expect(r.items.length).toBeLessThan(40);
    // 新しい側が残る
    expect(r.items.at(-1)!.text.startsWith('39:')).toBe(true);
    expect(r.cursor).toBe(r.items.at(-1)!.uuid);
  });

  it('1 件が大きすぎても、本文を切って予算に収める', () => {
    const huge = 'x'.repeat(500_000);
    const r = transcriptTail('s', null, 200, deps(body([user(huge)])));
    expect(r.items).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(r.items))).toBeLessThanOrEqual(PEER_CHAT_TAIL_BYTE_BUDGET);
  });

  it('許可の札は、予算で落とされる側に入らない', () => {
    const big = 'x'.repeat(8000);
    const many = Array.from({ length: 20 }, (_, i) => user(`${i}${big}`));
    const r = transcriptTail('s', null, 200, deps(body(many), permissionAsk()));
    expect(r.items.at(-1)!.kind).toBe('permission');
    expect(r.truncated).toBe(true);
  });
});

describe('実際の Claude Code のトランスクリプト', () => {
  const fixture = path.join(__dirname, '../../../test/fixtures/claude/2.1.312/transcript.jsonl');

  it('会話だけが出て、thinking や meta や raw は出ず、uuid は重ならない', () => {
    const r = transcriptTail('s', null, 200, deps(fs.readFileSync(fixture)));
    expect(r.items.length).toBeGreaterThan(3);
    expect(new Set(r.items.map((i) => i.uuid)).size).toBe(r.items.length);
    for (const i of r.items) {
      expect(['user', 'assistant', 'tool']).toContain(i.kind);
      expect(i.tool === undefined || typeof i.tool.ok === 'boolean').toBe(true);
    }
    expect(r.items[0]!.kind).toBe('user');
    expect(r.items.some((i) => i.kind === 'tool')).toBe(true);
    // 続きの取得は、最後の cursor で空になる
    expect(transcriptTail('s', r.cursor, 200, deps(fs.readFileSync(fixture))).items).toEqual([]);
  });

  it('どの切れ目で読んでも、改行の手前までの行だけで同じ前半になる', () => {
    const buf = fs.readFileSync(fixture);
    const half = buf.subarray(0, Math.floor(buf.length / 2));
    const whole = transcriptTail('s', null, 200, deps(buf)).items.map((i) => i.uuid);
    const part = transcriptTail('s', null, 200, deps(half)).items.map((i) => i.uuid);
    expect(whole.slice(0, part.length)).toEqual(part);
  });
});

describe('dbTranscriptReader', () => {
  it('索引の本体のファイル（この PC のもの）を読み、無ければ null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-tail-'));
    try {
      const file = path.join(dir, 'a.jsonl');
      fs.writeFileSync(file, body([user('from file')]));
      const db = openDb(':memory:');
      const ins = db.prepare('insert into transcript_files (path, session_id, agent_id, size, mtime, indexed_bytes, indexer_version, device_id) values (?,?,?,?,?,?,?,?)');
      ins.run(path.join(dir, 'remote.jsonl'), 'sess', null, 1, 5, 1, 1, 'other-device');
      ins.run(path.join(dir, 'agent-x.jsonl'), 'sess', 'x', 1, 9, 1, 1, null);
      ins.run(file, 'sess', null, 1, 1, 1, 1, null);
      const read = dbTranscriptReader(db);
      const r = transcriptTail('sess', null, 200, { readTranscript: read, pendingAsk: () => null });
      expect(r.items.map((i) => i.text)).toEqual(['from file']);
      expect(read('unknown')).toBeNull();
      // 索引にあるが消えたファイル
      fs.rmSync(file);
      expect(read('sess')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
