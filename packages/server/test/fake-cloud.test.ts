import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MAX_PUSH_BATCH } from '@agent-hangar/shared';
import { CloudError, goneFloor } from '../src/sync/client.ts';
import { FakeCloudClient } from './fake-cloud.ts';

const ch = (rowId: string, updatedAt: number) => ({ tableName: 'projects' as const, rowId, op: 'upsert' as const, payload: { id: rowId, updated_at: updatedAt }, updatedAt });
const meta = (key: string, over: Record<string, unknown> = {}) => ({ key, path: 'projects/-x/u.jsonl', kind: 'transcript' as const, sha256: 'a'.repeat(64), size: 3, mtime: 1, encrypted: true, ...over });

describe('FakeCloudClient', () => {
  it('Worker と同じ LWW と自端末の除外', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    const b = a.asDevice('b');
    expect(await a.pushChanges([ch('p1', 100)])).toEqual({ seq: 1, accepted: 1, skipped: 0 });
    expect(await b.pushChanges([ch('p1', 50)])).toEqual({ seq: 1, accepted: 0, skipped: 1 });
    expect(await b.pushChanges([ch('p1', 200)])).toEqual({ seq: 2, accepted: 1, skipped: 0 });
    const pa = await a.pullChanges(0, 500);
    expect(pa.changes.map((c) => [c.seq, c.deviceId])).toEqual([[2, 'b']]);
    expect(pa.nextSeq).toBe(2);
    expect((await b.pullChanges(0, 500)).changes.map((c) => c.seq)).toEqual([1]);
    expect((await a.snapshot(null, 500)).changes.map((c) => c.rowId)).toEqual(['p1']);
  });

  it('同じ鍵の重複は新しい方だけを見て、残りを skipped に数える', async () => {
    const a = new FakeCloudClient({ deviceId: 'a' });
    expect(await a.pushChanges([ch('p1', 1), ch('p1', 5), ch('p1', 3)])).toEqual({ seq: 1, accepted: 1, skipped: 2 });
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
    expect(await a.pushChanges([ch('p1', 1), { ...ch('p2', 2), op: 'delete' as const }])).toEqual({ seq: 2, accepted: 2, skipped: 0 });
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
});
