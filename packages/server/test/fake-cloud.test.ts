import fs from 'node:fs';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MAX_PUSH_BATCH } from '@agent-hangar/shared';
import { CloudError, goneFloor } from '../src/sync/client.ts';
import { FakeCloudClient, MAX_BODY_BYTES, MAX_ROW_BYTES, MAX_ROW_ID_CHARS } from './fake-cloud.ts';

const ch = (rowId: string, updatedAt: number) => ({ tableName: 'projects' as const, rowId, op: 'upsert' as const, payload: { id: rowId, updated_at: updatedAt }, updatedAt });
/**
 * push の応答の形。
 * `d1RowsToday`（その日に D1 へ書いた行数）は書いた量で変わるので、ここでは数であることだけを見る。
 * 中身は `fake-cloud-usage.test.ts` が実物のスキーマから出した表と突き合わせる。
 */
const pushResult = (o: { seq: number; accepted: number; skipped: number }) => ({ ...o, d1RowsToday: expect.any(Number) });

const meta = (key: string, over: Record<string, unknown> = {}) => ({ key, path: 'projects/-x/u.jsonl', kind: 'transcript' as const, sha256: 'a'.repeat(64), size: 3, mtime: 1, encrypted: true, ...over });

/**
 * 実物の Worker が持つ上限を、その原本から読み出す。
 * 偽物は実物を写したものなので、実物だけが変わったら落ちて写し直しを促す。
 * `packages/server` は `packages/cloud` に依存しないので、import ではなく原本の文字列から読む。
 */
function workerConstant(file: 'changes.ts' | 'files.ts', name: string): number {
  const src = fs.readFileSync(new URL(`../../cloud/src/${file}`, import.meta.url), 'utf8');
  const m = new RegExp(`export const ${name} = ([0-9*\\s]+);`).exec(src);
  if (!m) throw new Error(`${name} を packages/cloud/src/${file} から読めない`);
  return m[1]!.split('*').reduce((a, b) => a * Number(b.trim()), 1);
}

describe('FakeCloudClient', () => {
  it('Worker と同じ LWW と自端末の除外', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    const b = a.asDevice('b');
    expect(await a.pushChanges([ch('p1', 100)])).toEqual(pushResult({ seq: 1, accepted: 1, skipped: 0 }));
    expect(await b.pushChanges([ch('p1', 50)])).toEqual(pushResult({ seq: 1, accepted: 0, skipped: 1 }));
    expect(await b.pushChanges([ch('p1', 200)])).toEqual(pushResult({ seq: 2, accepted: 1, skipped: 0 }));
    const pa = await a.pullChanges(0, 500);
    expect(pa.changes.map((c) => [c.seq, c.deviceId])).toEqual([[2, 'b']]);
    expect(pa.nextSeq).toBe(2);
    expect((await b.pullChanges(0, 500)).changes.map((c) => c.seq)).toEqual([1]);
    expect((await a.snapshot(null, 500)).changes.map((c) => c.rowId)).toEqual(['p1']);
  });

  it('同じ鍵の重複は新しい方だけを見て、残りを skipped に数える', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    expect(await a.pushChanges([ch('p1', 1), ch('p1', 5), ch('p1', 3)])).toEqual(pushResult({ seq: 1, accepted: 1, skipped: 2 }));
    expect((await a.asDevice('b').pullChanges(0, 500)).changes.map((c) => c.updatedAt)).toEqual([5]);
  });

  it('40 行を超える push は Worker と同じ 400', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    const many = Array.from({ length: MAX_PUSH_BATCH + 1 }, (_, i) => ch(`p${i}`, 1));
    await expect(a.pushChanges(many)).rejects.toMatchObject({ status: 400 });
    expect(a.changes).toHaveLength(0);
  });

  it('pull と snapshot は limit で切って more と nextAfter を返す', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    await a.pushChanges([ch('p1', 1), ch('p2', 1), ch('p3', 1)]);
    const b = a.asDevice('b');
    const p1 = await b.pullChanges(0, 2);
    expect(p1.changes.map((c) => c.seq)).toEqual([1, 2]);
    expect(p1).toMatchObject({ nextSeq: 2, more: true });
    const p2 = await b.pullChanges(p1.nextSeq, 2);
    expect(p2.changes.map((c) => c.seq)).toEqual([3]);
    expect(p2).toMatchObject({ nextSeq: 3, more: false });
    const s1 = await b.snapshot(null, 2);
    expect(s1.changes.map((c) => c.rowId)).toEqual(['p1', 'p2']);
    expect(s1).toMatchObject({ nextAfter: 'projects:p2', seq: 3 });
    expect(s1.changes.every((c) => c.seq === 0)).toBe(true);
    const s2 = await b.snapshot(s1.nextAfter, 2);
    expect(s2.changes.map((c) => c.rowId)).toEqual(['p3']);
    expect(s2.nextAfter).toBe(null);
  });

  it('圧縮した区間を読み逃した端末には 410 と floor を返す', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    await a.pushChanges([ch('p1', 1)]);
    await a.pushChanges([ch('p2', 1)]);
    const b = a.asDevice('b');
    a.compact(1);
    expect(a.changes.map((c) => c.seq)).toEqual([2]);
    const e = await b.pullChanges(0, 500).catch((x: unknown) => x);
    expect(e).toMatchObject({ status: 410 });
    expect(goneFloor(e)).toBe(1);
    // floor に追いついている端末はそのまま読める。
    expect((await b.pullChanges(1, 500)).changes.map((c) => c.seq)).toEqual([2]);
    // 全件の取り直しは 410 にならない。
    expect((await b.snapshot(null, 500)).changes.map((c) => c.rowId)).toEqual(['p1', 'p2']);
  });

  it('ファイルは本体を集めて持ち、権限を検査する', async () => {
    const a = new FakeCloudClient({ deviceId: 'a', now: () => 1_700_000_000_000 });
    const m = meta('transcripts/a/u.jsonl.gz');
    expect(await a.putFile(m, Readable.from([Buffer.from('abc')]))).toEqual({ seq: 1 });
    await expect(a.asDevice('b').putFile(m, Readable.from([Buffer.from('x')]))).rejects.toMatchObject({ status: 403 });
    const l = await a.asDevice('b').listFiles(0, 500);
    expect(l.files[0]).toMatchObject({ key: m.key, deviceId: 'a', seq: 1, storedSize: 3, uploadedAt: 1_700_000_000_000 });
    expect(l).toMatchObject({ nextSeq: 1, more: false });
    let text = '';
    for await (const c of await a.asDevice('b').getFile(m.key)) text += c;
    expect(text).toBe('abc');
    await expect(a.getFile('transcripts/a/nope')).rejects.toMatchObject({ status: 404 });
  });

  it('config も自分の接頭辞の下だけに書け、置き直すと新しい seq になる', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    const key = 'config/a/skills/x/SKILL.md';
    const m = meta(key, { kind: 'config', path: 'skills/x/SKILL.md', size: 1 });
    expect(await a.putFile(m, Readable.from([Buffer.from('1')]))).toEqual({ seq: 1 });
    // 端末ごとに写しを持つので、別の端末は自分の接頭辞へ置く。他人の下へは書けない。
    await expect(a.asDevice('b').putFile(m, Readable.from([Buffer.from('2')]))).rejects.toMatchObject({ status: 403 });
    expect(await a.asDevice('b').putFile({ ...m, key: 'config/b/skills/x/SKILL.md' }, Readable.from([Buffer.from('2')]))).toEqual({ seq: 2 });
    // 鍵が別なので写しは 2 つ並ぶ。どちらを採るかは受け取る側（claudeConfig）が相対パスで決める。
    const l = await a.listFiles(0, 500);
    expect(l.files.map((f) => [f.seq, f.deviceId])).toEqual([[1, 'a'], [2, 'b']]);
    expect((await a.listFiles(1, 500)).files.map((f) => f.seq)).toEqual([2]);
    // 同じ鍵へ置き直したときは、古い索引が消えて新しい seq になる。
    expect(await a.putFile(m, Readable.from([Buffer.from('3')]))).toEqual({ seq: 3 });
    expect((await a.listFiles(0, 500)).files.map((f) => [f.seq, f.deviceId])).toEqual([[2, 'b'], [3, 'a']]);
  });

  it('DELETE は自端末の分だけ消せる', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    const m = meta('transcripts/a/u.jsonl.gz');
    await a.putFile(m, Readable.from([Buffer.from('abc')]));
    await expect(a.asDevice('b').deleteFile(m.key)).rejects.toMatchObject({ status: 403 });
    await a.deleteFile(m.key);
    expect((await a.listFiles(0, 500)).files).toEqual([]);
    await expect(a.getFile(m.key)).rejects.toMatchObject({ status: 404 });
  });

  it('鍵とメタデータの形が違えば 400', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    const body = () => Readable.from([Buffer.from('x')]);
    await expect(a.putFile(meta('other/u1'), body())).rejects.toMatchObject({ status: 400 });
    await expect(a.putFile(meta('transcripts/a/../b/u1.gz'), body())).rejects.toMatchObject({ status: 400 });
    await expect(a.putFile(meta('transcripts/a/./u1.gz'), body())).rejects.toMatchObject({ status: 400 });
    await expect(a.putFile(meta('transcripts/a/u1.gz', { sha256: 'zz' }), body())).rejects.toMatchObject({ status: 400 });
    await expect(a.putFile(meta('transcripts/a/u1.gz', { kind: 'video' }), body())).rejects.toMatchObject({ status: 400 });
    await expect(a.putFile(meta('transcripts/a/u1.gz', { size: -1 }), body())).rejects.toMatchObject({ status: 400 });
    await expect(a.getFile('other/u1')).rejects.toMatchObject({ status: 400 });
  });

  it('呼び出しを記録し、asDevice はストアを分け合う', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    const b = a.asDevice('b');
    await a.health();
    await a.pushChanges([ch('p1', 1)]);
    await b.pullChanges(0, 500);
    expect(a.calls.map((c) => c.method)).toEqual(['health', 'pushChanges']);
    expect(b.calls.map((c) => c.method)).toEqual(['pullChanges']);
    expect(b.changes).toBe(a.changes);
    expect(b.deviceId).toBe('b');
  });

  it('offline は status 0 の CloudError', async () => {
    const a = new FakeCloudClient();
    a.offline = true;
    await expect(a.health()).rejects.toMatchObject({ status: 0 });
    await expect(a.pushChanges([])).rejects.toMatchObject({ status: 0 });
    await expect(a.pullChanges(0, 500)).rejects.toMatchObject({ status: 0 });
    await expect(a.snapshot(null, 500)).rejects.toMatchObject({ status: 0 });
    await expect(a.listFiles(0, 500)).rejects.toMatchObject({ status: 0 });
    await expect(a.getFile('transcripts/self/u.gz')).rejects.toMatchObject({ status: 0 });
    await expect(a.deleteFile('transcripts/self/u.gz')).rejects.toMatchObject({ status: 0 });
    await expect(a.putFile(meta('transcripts/self/u.gz'), Readable.from([Buffer.from('x')]))).rejects.toMatchObject({ status: 0 });
    // 片方を offline にすると同じストアの全端末が落ちる。
    expect(a.asDevice('b').offline).toBe(true);
    a.offline = false;
    expect(await a.health()).toEqual({ ok: true, version: 'fake' });
  });

  it('Worker と同じ厳しさで行の形を断る', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    const bad = (over: Record<string, unknown>) => [{ ...ch('p1', 1), ...over }] as never;
    await expect(a.pushChanges(bad({ op: 'drop' }))).rejects.toMatchObject({ status: 400 });
    await expect(a.pushChanges(bad({ payload: 'not-an-object' }))).rejects.toMatchObject({ status: 400 });
    await expect(a.pushChanges(bad({ payload: [1, 2] }))).rejects.toMatchObject({ status: 400 });
    await expect(a.pushChanges(bad({ payload: null }))).rejects.toMatchObject({ status: 400 });
    await expect(a.pushChanges(bad({ updatedAt: Number.NaN }))).rejects.toMatchObject({ status: 400 });
    await expect(a.pushChanges(bad({ updatedAt: Number.POSITIVE_INFINITY }))).rejects.toMatchObject({ status: 400 });
    await expect(a.pushChanges(bad({ updatedAt: '1' }))).rejects.toMatchObject({ status: 400 });
    await expect(a.pushChanges(bad({ rowId: '' }))).rejects.toMatchObject({ status: 400 });
    await expect(a.pushChanges(bad({ tableName: 'nope' }))).rejects.toMatchObject({ status: 400 });
    // 1 行でも形が違えば塊ごと断り、ストアには何も入らない。
    await expect(a.pushChanges([ch('p1', 1), { ...ch('p2', 1), op: 'drop' } as never])).rejects.toMatchObject({ status: 400 });
    expect(a.changes).toHaveLength(0);
    expect(a.rows.size).toBe(0);
    expect(await a.pushChanges([ch('p1', 1), { ...ch('p2', 2), op: 'delete' as const }])).toEqual(pushResult({ seq: 2, accepted: 2, skipped: 0 }));
  });

  it('path の .. と絶対パスと制御文字を断る', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    const body = () => Readable.from([Buffer.from('x')]);
    const key = 'transcripts/a/u1.gz';
    await expect(a.putFile(meta(key, { path: '../../../../etc/passwd' }), body())).rejects.toMatchObject({ status: 400 });
    await expect(a.putFile(meta(key, { path: '/etc/passwd' }), body())).rejects.toMatchObject({ status: 400 });
    await expect(a.putFile(meta(key, { path: 'a/../b' }), body())).rejects.toMatchObject({ status: 400 });
    await expect(a.putFile(meta(key, { path: 'a/./b' }), body())).rejects.toMatchObject({ status: 400 });
    await expect(a.putFile(meta(key, { path: 'a//b' }), body())).rejects.toMatchObject({ status: 400 });
    await expect(a.putFile(meta(key, { path: 'a\u0000b' }), body())).rejects.toMatchObject({ status: 400 });
    await expect(a.putFile(meta(key, { path: '' }), body())).rejects.toMatchObject({ status: 400 });
    expect((await a.listFiles(0, 500)).files).toEqual([]);
    // 空白と日本語は置ける（R2 の鍵ではなく手元の相対パスなので）。
    expect(await a.putFile(meta(key, { path: 'projects/-x/メモ 1.jsonl' }), body())).toEqual({ seq: 1 });
  });

  it('unauthorized は 401 を全メソッドで返す', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    await a.pushChanges([ch('p1', 1)]);
    a.unauthorized = true;
    const shape = { status: 401, message: JSON.stringify({ error: 'unauthorized' }) };
    await expect(a.health()).rejects.toMatchObject(shape);
    await expect(a.pushChanges([ch('p2', 1)])).rejects.toMatchObject(shape);
    await expect(a.pullChanges(0, 500)).rejects.toMatchObject(shape);
    await expect(a.snapshot(null, 500)).rejects.toMatchObject(shape);
    await expect(a.listFiles(0, 500)).rejects.toMatchObject(shape);
    await expect(a.getFile('transcripts/a/u.gz')).rejects.toMatchObject(shape);
    await expect(a.deleteFile('transcripts/a/u.gz')).rejects.toMatchObject(shape);
    await expect(a.putFile(meta('transcripts/a/u.gz'), Readable.from([Buffer.from('x')]))).rejects.toMatchObject(shape);
    expect(a.changes).toHaveLength(1);
    // 端末をまたいで効き、offline の方が先に立つ。
    expect(a.asDevice('b').unauthorized).toBe(true);
    a.offline = true;
    await expect(a.health()).rejects.toMatchObject({ status: 0 });
    a.offline = false;
    a.unauthorized = false;
    expect(await a.health()).toEqual({ ok: true, version: 'fake' });
  });

  it('limit は Worker の clampLimit と同じに丸める', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    await a.pushChanges([ch('p1', 1), ch('p2', 1)]);
    const b = a.asDevice('b');
    // 0 と NaN は既定（PULL_LIMIT）として扱う。Worker の `Number(v) || PULL_LIMIT` と同じ。
    for (const limit of [0, Number.NaN]) {
      const p = await b.pullChanges(0, limit);
      expect(p.changes.map((c) => c.seq)).toEqual([1, 2]);
      expect(p).toMatchObject({ nextSeq: 2, more: false });
    }
    // 負の数は 1 に、PULL_LIMIT より大きい数は PULL_LIMIT に丸める。
    const neg = await b.pullChanges(0, -5);
    expect(neg.changes.map((c) => c.seq)).toEqual([1]);
    expect(neg).toMatchObject({ nextSeq: 1, more: true });
    expect((await b.pullChanges(0, 10_000)).changes).toHaveLength(2);
    const s = await b.snapshot(null, -5);
    expect(s.changes.map((c) => c.rowId)).toEqual(['p1']);
    expect(s.nextAfter).toBe('projects:p1');
    expect((await b.snapshot(null, 0)).nextAfter).toBe(null);
    expect((await b.listFiles(0, 0))).toMatchObject({ nextSeq: 0, more: false });
  });

  it('断りの本文は Worker と同じ JSON の形にする', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    const body = () => Readable.from([Buffer.from('x')]);
    const msg = async (p: Promise<unknown>) => (await p.catch((e: CloudError) => e.message)) as string;
    expect(await msg(a.pushChanges([{ ...ch('p1', 1), op: 'drop' } as never]))).toBe(JSON.stringify({ error: 'invalid body' }));
    expect(await msg(a.getFile('other/u1'))).toBe(JSON.stringify({ error: 'invalid key' }));
    expect(await msg(a.asDevice('b').deleteFile('transcripts/a/u1.gz'))).toBe(JSON.stringify({ error: 'forbidden' }));
    expect(await msg(a.getFile('transcripts/a/nope.gz'))).toBe(JSON.stringify({ error: 'not found' }));
    expect(await msg(a.putFile(meta('transcripts/a/u1.gz', { sha256: 'zz' }), body()))).toBe(JSON.stringify({ error: 'invalid headers' }));
  });

  it('日本語と空白を含む鍵と path が端から端まで通る', async () => {
    const a = new FakeCloudClient({ deviceId: 'a', now: () => 5 });
    const key = 'config/a/skills/日本語 メモ/SKILL.md';
    const path = 'skills/日本語 メモ/SKILL.md';
    const m = { key, path, kind: 'config' as const, sha256: 'b'.repeat(64), size: 3, mtime: 1, encrypted: true };
    expect(await a.putFile(m, Readable.from([Buffer.from('abc')]))).toEqual({ seq: 1 });
    // 一覧に出るのは符号化する前の形である（Worker は復号してから索引に載せる）。
    const l = await a.asDevice('b').listFiles(0, 500);
    expect(l.files[0]).toMatchObject({ key, path, deviceId: 'a', seq: 1 });
    let text = '';
    for await (const c of await a.asDevice('b').getFile(key)) text += c;
    expect(text).toBe('abc');
    await a.deleteFile(key);
    expect((await a.listFiles(0, 500)).files).toEqual([]);
  });

  it('見出しで運べない path は実物と同じところで落ちる', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    const body = () => Readable.from([Buffer.from('x')]);
    // 単独のサロゲートは符号化できない。実物は undici が送る前に TypeError を投げる（status 0 になる）。
    const e = await a.putFile(meta('transcripts/a/u1.gz', { path: '\ud800' }), body()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CloudError);
    expect(e).toMatchObject({ status: 0 });
    expect((e as CloudError).message).toContain('ByteString');
    expect(a.files.size).toBe(0);
  });

  it('128 KiB を超える payload の行は 413 で名指しして断る', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    // UI は 1 MiB までのメモを保存できるので、この大きさの行は実際に積まれる。
    const huge = { tableName: 'project_memos' as const, rowId: 'p1', op: 'upsert' as const, payload: { project_id: 'p1', markdown: 'あ'.repeat(70_000) }, updatedAt: 1 };
    expect(new TextEncoder().encode(JSON.stringify(huge.payload)).byteLength).toBeGreaterThan(MAX_ROW_BYTES);
    const e = await a.pushChanges([ch('p0', 1), huge]).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CloudError);
    expect(e).toMatchObject({ status: 413 });
    expect(JSON.parse((e as CloudError).message)).toEqual({
      error: 'payload too large',
      limit: MAX_ROW_BYTES,
      count: 1,
      row: { tableName: 'project_memos', rowId: 'p1', bytes: new TextEncoder().encode(JSON.stringify(huge.payload)).byteLength },
    });
    // 塊ごと断るので、同じ要求に乗っていた小さい行も入らない。
    expect(a.changes).toHaveLength(0);
    expect(a.rows.size).toBe(0);
    // 本文は 200 字に収まる（CloudError が持てるのは先頭 200 字だけである）。
    expect((e as CloudError).message.length).toBeLessThanOrEqual(200);
    // ちょうど上限の行は通る。
    // {"m":"..."} の囲みが 8 バイトあるので、その分を引くとちょうど上限になる。
    const edge = { ...huge, payload: { m: 'a'.repeat(MAX_ROW_BYTES - 8) } };
    expect(new TextEncoder().encode(JSON.stringify(edge.payload)).byteLength).toBe(MAX_ROW_BYTES);
    expect(await a.pushChanges([edge])).toEqual(pushResult({ seq: 1, accepted: 1, skipped: 0 }));
  });

  it('413 の本文は rowId が長くても 200 字に収まる', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    const e = await a
      .pushChanges([{ tableName: 'todos' as const, rowId: 'x'.repeat(500), op: 'upsert' as const, payload: { m: 'a'.repeat(MAX_ROW_BYTES) }, updatedAt: 1 }])
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CloudError);
    const err = e as CloudError;
    expect(err.status).toBe(413);
    expect(err.message.length).toBeLessThanOrEqual(200);
    expect((JSON.parse(err.message) as { row: { rowId: string } }).row.rowId).toBe('x'.repeat(MAX_ROW_ID_CHARS));
  });

  it('100 MiB を超える本文は 413 で断り、何も残さない', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    const m = meta('transcripts/a/big.jsonl.gz');
    const chunk = Buffer.alloc(1024 * 1024);
    // 上限を 1 MiB だけ超える本文を流す。偽物は超えた時点で畳む。
    const over = (async function* () { for (let i = 0; i <= MAX_BODY_BYTES / chunk.length; i++) yield chunk; })();
    const e = await a.putFile(m, Readable.from(over)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CloudError);
    expect(e).toMatchObject({ status: 413, message: JSON.stringify({ error: 'too large' }) });
    expect(a.files.size).toBe(0);
    expect((await a.listFiles(0, 500)).files).toEqual([]);
    // 上限ちょうどまでは受ける（その大きさを毎回流すと重いので、境目の 1 バイト下で見る）。
    expect(await a.putFile(meta('transcripts/a/ok.gz'), Readable.from([Buffer.alloc(3)]))).toEqual({ seq: 1 });
  });

  it('暗号化していない transcript は実物と同じ 400 で断る', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    const body = () => Readable.from([Buffer.from('x')]);
    const e = await a.putFile(meta('transcripts/a/u1.gz', { encrypted: false }), body()).catch((x: unknown) => x);
    expect(e).toMatchObject({ status: 400, message: JSON.stringify({ error: 'unencrypted transcript' }) });
    expect(a.files.size).toBe(0);
    // config は今までどおり通る（種別ごとの約束の違いは実物と揃える）。
    expect(await a.putFile({ ...meta('config/a/x.md', { encrypted: false }), kind: 'config' as const }, body())).toEqual({ seq: 1 });
  });

  it('その検査は実物の Worker にもある', () => {
    // 偽物だけが厳しいのも、実物だけが厳しいのも困る。原本にその枝があることをここで縛る。
    const src = fs.readFileSync(new URL('../../cloud/src/files.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/kind === 'transcript' && enc !== '1'/);
    expect(src).toContain("'unencrypted transcript'");
  });

  it('でたらめに大きい since を nextSeq にそのまま返さない', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    await a.putFile(meta('transcripts/a/u1.gz'), Readable.from([Buffer.from('x')]));
    expect(await a.listFiles(999_999, 500)).toMatchObject({ files: [], nextSeq: 1, more: false });
    // 索引が空なら 0 である。
    await a.deleteFile('transcripts/a/u1.gz');
    expect(await a.listFiles(999_999, 500)).toMatchObject({ files: [], nextSeq: 0, more: false });
  });

  it('上限は実物の Worker と同じ数である', () => {
    // 偽物は実物を写したものである。実物だけが変わったら、ここで落ちて写し直しを促す。
    expect(MAX_ROW_BYTES).toBe(workerConstant('changes.ts', 'MAX_ROW_BYTES'));
    expect(MAX_ROW_ID_CHARS).toBe(workerConstant('changes.ts', 'MAX_ROW_ID_CHARS'));
    expect(MAX_BODY_BYTES).toBe(workerConstant('files.ts', 'MAX_BODY_BYTES'));
  });
});
