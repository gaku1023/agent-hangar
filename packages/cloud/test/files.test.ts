import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLOUD_HEADERS, encodeHeaderText, isHeaderSafe, isValidFileKey, type FileEntry } from '@agent-hangar/shared';
import { MAX_R2_META_BYTES, buildMetadata, validKey } from '../src/files.ts';
import { ensureSchema, resetSchemaCache } from '../src/schema.ts';
import { sha256Hex } from '../src/util.ts';
import { startCloud, type CloudHarness } from './harness.ts';

const SECRET = 'join-secret-1';

let cloud: CloudHarness;
let tokA = '';
let tokB = '';

const join = async (id: string): Promise<string> => {
  const r = await cloud.SELF.fetch('https://x/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: SECRET, device: { id, name: id, platform: 'darwin' } }),
  });
  return ((await r.json()) as { deviceToken: string }).deviceToken;
};

/** 既定は端末 A の transcript 1 件分の見出しである。上書きしたい分だけ渡す。 */
const meta = (o: Record<string, string> = {}): Record<string, string> => ({
  [CLOUD_HEADERS.path]: 'projects/-x/u1.jsonl',
  [CLOUD_HEADERS.kind]: 'transcript',
  [CLOUD_HEADERS.sha256]: 'a'.repeat(64),
  [CLOUD_HEADERS.size]: '3',
  [CLOUD_HEADERS.mtime]: '1700000000000',
  [CLOUD_HEADERS.encrypted]: '1',
  ...o,
});

/** config を置くときの見出しである。 */
const configMeta = (rel: string, o: Record<string, string> = {}): Record<string, string> =>
  meta({ [CLOUD_HEADERS.path]: rel, [CLOUD_HEADERS.kind]: 'config', [CLOUD_HEADERS.size]: '1', ...o });

const put = (tok: string, key: string, body: string, headers: Record<string, string> = meta()): Promise<Response> =>
  cloud.SELF.fetch(`https://x/files/${key}`, { method: 'PUT', headers: { authorization: `Bearer ${tok}`, ...headers }, body });

const get = (tok: string, key: string): Promise<Response> => cloud.SELF.fetch(`https://x/files/${key}`, { headers: { authorization: `Bearer ${tok}` } });

const del = (tok: string, key: string): Promise<Response> =>
  cloud.SELF.fetch(`https://x/files/${key}`, { method: 'DELETE', headers: { authorization: `Bearer ${tok}` } });

type Listing = { files: FileEntry[]; nextSeq: number; more: boolean };

const list = async (tok: string, since = 0, limit = 500): Promise<Listing> =>
  (await (await cloud.SELF.fetch(`https://x/files?since=${since}&limit=${limit}`, { headers: { authorization: `Bearer ${tok}` } })).json()) as Listing;

const keysInR2 = async (): Promise<string[]> => (await cloud.env.BUCKET.list()).objects.map((o) => o.key).sort();

beforeEach(async () => {
  resetSchemaCache();
  cloud = await startCloud();
  resetSchemaCache();
  await ensureSchema({ ...cloud.env, JOIN_SECRET_HASH: await sha256Hex(SECRET) });
  tokA = await join('dev-a');
  tokB = await join('dev-b');
});

afterEach(async () => {
  await cloud.dispose();
});

describe('PUT と GET /files/<key>', () => {
  it('R2 に置き、索引に載せ、本体を取り出せる', async () => {
    const r = await put(tokA, 'transcripts/dev-a/u1.jsonl.gz', 'abc');
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ seq: 1 });
    expect(await (await cloud.env.BUCKET.get('transcripts/dev-a/u1.jsonl.gz'))!.text()).toBe('abc');
    const l = await list(tokB);
    expect(l.files).toHaveLength(1);
    expect(l.files[0]).toMatchObject({
      seq: 1,
      key: 'transcripts/dev-a/u1.jsonl.gz',
      path: 'projects/-x/u1.jsonl',
      kind: 'transcript',
      deviceId: 'dev-a',
      sha256: 'a'.repeat(64),
      size: 3,
      storedSize: 3,
      mtime: 1700000000000,
      encrypted: true,
    });
    expect(l.files[0]!.uploadedAt).toBeGreaterThan(Date.now() - 60_000);
    expect(l).toMatchObject({ nextSeq: 1, more: false });
    const g = await get(tokB, 'transcripts/dev-a/u1.jsonl.gz');
    expect(g.status).toBe(200);
    expect(g.headers.get('content-length')).toBe('3');
    expect(await g.text()).toBe('abc');
  });

  it('同じ鍵を置き直すと新しい seq になり、古い索引は消える', async () => {
    await put(tokA, 'transcripts/dev-a/u1.jsonl.gz', 'abc');
    await put(tokA, 'transcripts/dev-a/u1.jsonl.gz', 'abcd', meta({ [CLOUD_HEADERS.sha256]: 'b'.repeat(64), [CLOUD_HEADERS.size]: '4' }));
    const l = await list(tokB);
    expect(l.files.map((f) => [f.seq, f.sha256[0], f.storedSize])).toEqual([[2, 'b', 4]]);
    expect((await list(tokB, 1)).files.map((f) => f.seq)).toEqual([2]);
    expect(await (await cloud.env.BUCKET.get('transcripts/dev-a/u1.jsonl.gz'))!.text()).toBe('abcd');
  });

  it('一覧は自端末の分も返し、limit と more を持つ', async () => {
    for (let i = 0; i < 3; i++) await put(tokA, `transcripts/dev-a/u${i}.jsonl.gz`, 'x', meta({ [CLOUD_HEADERS.size]: '1' }));
    const r = await list(tokA, 0, 2);
    expect(r.files.map((f) => f.seq)).toEqual([1, 2]);
    expect(r).toMatchObject({ nextSeq: 2, more: true });
    const r2 = await list(tokA, 2, 2);
    expect(r2.files.map((f) => f.seq)).toEqual([3]);
    expect(r2).toMatchObject({ nextSeq: 3, more: false });
  });

  it('1 つの部分を超える本文も multipart で預け、そのまま取り出せる', async () => {
    const n = 9 * 1024 * 1024 + 7; // PART_BYTES（8 MiB）を超え、端数も出る大きさ
    const buf = new Uint8Array(n);
    for (let i = 0; i < n; i++) buf[i] = i % 251;
    const key = 'transcripts/dev-a/big.jsonl.gz';
    const r = await cloud.SELF.fetch(`https://x/files/${key}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${tokA}`, ...meta({ [CLOUD_HEADERS.size]: String(n) }) },
      body: buf,
    });
    expect(r.status).toBe(201);
    expect((await list(tokA)).files.map((f) => f.storedSize)).toEqual([n]);
    const g = await get(tokA, key);
    expect(g.headers.get('content-length')).toBe(String(n));
    const back = new Uint8Array(await g.arrayBuffer());
    expect(back.length).toBe(n);
    expect(back.every((v, i) => v === i % 251)).toBe(true);
  });

  it('無い鍵は 404、DELETE は本体と索引を消す', async () => {
    expect((await get(tokA, 'transcripts/dev-a/nope.gz')).status).toBe(404);
    await put(tokA, 'transcripts/dev-a/u1.jsonl.gz', 'abc');
    expect((await del(tokA, 'transcripts/dev-a/u1.jsonl.gz')).status).toBe(204);
    expect(await cloud.env.BUCKET.head('transcripts/dev-a/u1.jsonl.gz')).toBeNull();
    expect((await list(tokA)).files).toEqual([]);
  });
});

describe('validKey', () => {
  // 「.」「..」は URL の側で畳まれるので HTTP 越しには届かない。判定そのものはここで見る。
  it('接頭辞と相対パスの形を見る', () => {
    expect(validKey('transcripts/dev-a/u1.gz', 'dev-a', 'PUT')).toBe(true);
    expect(validKey('config/skills/日本語 メモ/SKILL.md', 'dev-a', 'PUT')).toBe(true);
    for (const k of [
      '',
      'u1.gz',
      'other/u1.gz',
      'transcripts',
      'transcripts/',
      '/transcripts/dev-a/u1.gz',
      'transcripts/dev-a/../dev-b/u1.gz',
      'transcripts/dev-a/./u1.gz',
      'transcripts/dev-a//u1.gz',
      'config/a\u0000b',
      'config/a\u001fb',
      'config/a\u007fb',
      `config/${'a'.repeat(513)}`, // 相対パスの文字数の上限
      `config/${'あ'.repeat(400)}`, // R2 の鍵のバイト数の上限
    ])
      expect([k, validKey(k, 'dev-a', 'GET')]).toEqual([k, false]);
  });

  it('transcripts は自端末の分だけ書けて消せる。読むのは誰でもよい', () => {
    expect(validKey('transcripts/dev-b/u1.gz', 'dev-a', 'GET')).toBe(true);
    for (const m of ['PUT', 'DELETE'] as const) {
      expect(validKey('transcripts/dev-a/u1.gz', 'dev-a', m)).toBe(true);
      expect(validKey('transcripts/dev-b/u1.gz', 'dev-a', m)).toBe(false);
      expect(validKey('transcripts/dev-ax/u1.gz', 'dev-a', m)).toBe(false); // 接頭辞の一致だけでは通さない
      expect(validKey('config/a.md', 'dev-a', m)).toBe(true);
      // 端末 ID の形も見る。スラッシュが混ざると他端末の接頭辞の下に潜り込める。
      expect(validKey('transcripts/dev-a/evil/u1.gz', 'dev-a/evil', m)).toBe(false);
      expect(validKey('transcripts/../dev-a/u1.gz', '..', m)).toBe(false);
    }
  });
});

describe('buildMetadata', () => {
  const bytes = (m: Record<string, string>): number => Object.entries(m).reduce((n, [k, v]) => n + new TextEncoder().encode(k).length + new TextEncoder().encode(v).length, 0);

  it('入り切る間は path を載せ、境目までは落とさない', () => {
    const sha = 'a'.repeat(64);
    // 名前（path, sha256, device）と sha と device を引いた残りが path に使える。
    const room = MAX_R2_META_BYTES - ('path'.length + 'sha256'.length + 'device'.length) - sha.length - 'dev-a'.length;
    const fit = buildMetadata('x'.repeat(room), sha, 'dev-a');
    expect(fit).toEqual({ path: 'x'.repeat(room), sha256: sha, device: 'dev-a' });
    expect(bytes(fit!)).toBe(MAX_R2_META_BYTES);
    expect(buildMetadata('x'.repeat(room + 1), sha, 'dev-a')).toEqual({ sha256: sha, device: 'dev-a' });
  });

  it('入り切らなければ path を落とし、それでも入らなければ null', () => {
    const sha = 'a'.repeat(64);
    expect(buildMetadata('%E3%81%82'.repeat(300), sha, 'dev-a')).toEqual({ sha256: sha, device: 'dev-a' });
    // 端末 ID は参加の入口で 64 文字までに限られるので、実際には null にならない。最後の網である。
    expect(buildMetadata('x', sha, 'd'.repeat(MAX_R2_META_BYTES))).toBeNull();
  });
});

describe('鍵の検査', () => {
  it('接頭辞の違う鍵と危うい相対パスは 400 で、R2 にも索引にも残らない', async () => {
    for (const key of [
      'other/u1',
      'transcripts',
      'transcripts/',
      'config',
      'transcripts/dev-a//u1.gz', // 空の断片
      'config/a%00b', // NUL
      'config/a%01b', // 制御文字
    ])
      expect([key, (await put(tokA, key, 'x')).status]).toEqual([key, 400]);
    expect(await keysInR2()).toEqual([]);
    expect((await list(tokA)).files).toEqual([]);
  });

  it('見出しが欠けていたり形が違えば 400', async () => {
    const key = 'transcripts/dev-a/u1.jsonl.gz';
    const bad: Record<string, string>[] = [
      meta({ [CLOUD_HEADERS.sha256]: 'zz' }),
      meta({ [CLOUD_HEADERS.sha256]: 'A'.repeat(64) }), // 大文字の hex は受けない
      meta({ [CLOUD_HEADERS.kind]: 'video' }),
      meta({ [CLOUD_HEADERS.size]: '-1' }),
      meta({ [CLOUD_HEADERS.size]: '1.5' }),
      meta({ [CLOUD_HEADERS.mtime]: 'x' }),
      meta({ [CLOUD_HEADERS.encrypted]: 'yes' }),
      meta({ [CLOUD_HEADERS.path]: '/etc/passwd' }),
      meta({ [CLOUD_HEADERS.path]: 'a/../b' }),
      meta({ [CLOUD_HEADERS.path]: 'a//b' }),
      meta({ [CLOUD_HEADERS.path]: 'a/./b' }),
      meta({ [CLOUD_HEADERS.kind]: 'config' }), // 接頭辞と種別が食い違う
    ];
    for (const h of bad) expect([h, (await put(tokA, key, 'x', h)).status]).toEqual([h, 400]);
    for (const drop of [CLOUD_HEADERS.path, CLOUD_HEADERS.kind, CLOUD_HEADERS.sha256, CLOUD_HEADERS.size, CLOUD_HEADERS.mtime, CLOUD_HEADERS.encrypted]) {
      const h = meta();
      delete h[drop];
      expect([drop, (await put(tokA, key, 'x', h)).status]).toEqual([drop, 400]);
    }
    expect(await keysInR2()).toEqual([]);
  });

  it('日本語と空白を含む config の鍵を通し、そのまま取り出せる', async () => {
    // 利用者の `~/.claude` の中身は名前を選べない。ASCII に限った鍵の検査だと、ここが黙って 400 になる。
    // なお `x-hangar-path` は見出しなので非 ASCII を運べない（報告の「気になった点」を見ること）。
    const rel = 'skills/日本語 メモ/SKILL.md';
    const r = await put(tokB, `config/${rel}`, 'x', configMeta('skills/a/SKILL.md'));
    expect(r.status).toBe(201);
    expect(await keysInR2()).toEqual([`config/${rel}`]);
    expect((await list(tokA)).files.map((f) => f.key)).toEqual([`config/${rel}`]);
    expect(await (await get(tokA, `config/${rel}`)).text()).toBe('x');
    expect((await del(tokB, `config/${rel}`)).status).toBe(204);
    expect(await keysInR2()).toEqual([]);
  });

  it('見出しは非 ASCII を運べない。端末側が符号化してから送る必要がある', async () => {
    // undici（Node の fetch）が送る前に投げる。Worker の検査より手前なので、Worker では直せない。
    // 実物の `HttpCloudClient.putFile` も同じ経路である。
    await expect(put(tokB, 'config/a.md', 'x', configMeta('skills/日本語/SKILL.md'))).rejects.toThrow();
  });

  it('符号化した見出しを復号して索引に載せ、端から端まで通す', async () => {
    // 非 ASCII は見出しに直接載せられないので、端末が `encodeHeaderText` で符号化して送る。
    // Worker は同じ共有の関数で復号する。片方だけ変えると、索引に百分率のままの文字列が残る。
    const path = 'skills/日本語 メモ/SKILL.md';
    const key = `config/${path}`;
    const wire = encodeHeaderText(path)!;
    expect(isHeaderSafe(wire)).toBe(true);
    const r = await put(tokB, key, 'x', configMeta(wire));
    expect(r.status).toBe(201);
    const e = (await list(tokA)).files[0]!;
    expect([e.key, e.path]).toEqual([key, path]);
    expect(await (await get(tokA, key)).text()).toBe('x');
    // R2 の customMetadata は見出しのままの形で持つ（値も ByteString しか運べない）。
    expect((await cloud.env.BUCKET.head(key))?.customMetadata?.path).toBe(wire);
    expect((await del(tokB, key)).status).toBe(204);
  });

  it('符号化すると R2 の覚え書きの上限を超える path でも上げられる。500 にして永久に再送させない', async () => {
    // 日本語は `encodeURIComponent` で 1 文字が 9 バイトに伸びるので、
    // `isSafeRelPath` が許す 512 文字のうち 218 文字あたりから R2 の 2048 バイトを超える。
    // 超えたら覚え書きの `path` を落とす。索引の正本は D1 なので、降ろす側は何も失わない。
    const path = `skills/${'あ'.repeat(300)}/SKILL.md`;
    const wire = encodeHeaderText(path)!;
    expect(wire.length).toBeGreaterThan(MAX_R2_META_BYTES);
    const key = `config/${path}`;
    expect((await put(tokB, key, 'x', configMeta(wire))).status).toBe(201);
    // D1 の索引には元のパスがそのまま入る。
    const e = (await list(tokA)).files[0]!;
    expect([e.key, e.path]).toEqual([key, path]);
    expect(await (await get(tokA, key)).text()).toBe('x');
    // R2 側の覚え書きからは path だけが落ちる。指紋と端末は残る。
    const meta = (await cloud.env.BUCKET.head(key))?.customMetadata;
    expect(meta?.path).toBeUndefined();
    expect([meta?.sha256, meta?.device]).toEqual(['a'.repeat(64), 'dev-b']);
  });

  it('百分率の形が壊れた path の見出しは 400', async () => {
    for (const wire of ['%', '%zz', '%E3%81', 'a/%2E%2E/b', '%2Fabs']) {
      expect([wire, (await put(tokB, 'config/a.md', 'x', configMeta(wire))).status]).toEqual([wire, 400]);
    }
    expect(await keysInR2()).toEqual([]);
  });

  it('鍵の形の物差しは端末と 1 つを共有する', () => {
    // `isValidFileKey` は端末側（`packages/server/src/sync/client.ts`）も通る共有の判定である。
    // ここがずれると、端末で作れる鍵が Worker で 400 になる（またはその逆になる）。
    for (const key of ['transcripts/dev-a/u1.jsonl.gz', 'config/skills/日本語 メモ/SKILL.md', 'config/memory/🐕.md', 'config/a%b.md']) {
      expect([key, isValidFileKey(key), validKey(key, 'dev-a', 'GET')]).toEqual([key, true, true]);
    }
    for (const key of ['other/u1', 'transcripts', 'transcripts/', 'transcripts/../x', 'transcripts/./x', 'transcripts//x', '/transcripts/x', `config/${'あ'.repeat(400)}`]) {
      expect([key, isValidFileKey(key), validKey(key, 'dev-a', 'GET')]).toEqual([key, false, false]);
    }
  });

  it('長すぎる鍵は 400（R2 の鍵の上限に当てて 500 にしない）', async () => {
    const rel = 'あ'.repeat(400); // 400 文字だが UTF-8 では 1200 バイトで、R2 の 1024 バイトを超える
    expect((await put(tokB, `config/${rel}`, 'x', configMeta('a.md'))).status).toBe(400);
    expect((await put(tokB, `config/${'a'.repeat(513)}`, 'x', configMeta('a.md'))).status).toBe(400);
    expect(await keysInR2()).toEqual([]);
  });
});

describe('端末の境目', () => {
  it('他端末の transcripts には書けず消せず、しかし読める', async () => {
    await put(tokA, 'transcripts/dev-a/u1.jsonl.gz', 'abc');
    expect((await put(tokB, 'transcripts/dev-a/u1.jsonl.gz', 'evil')).status).toBe(403);
    expect((await put(tokB, 'transcripts/dev-a/new.jsonl.gz', 'evil')).status).toBe(403);
    expect((await del(tokB, 'transcripts/dev-a/u1.jsonl.gz')).status).toBe(403);
    // 断られた書き込みは R2 にも索引にも入っていない。
    expect(await keysInR2()).toEqual(['transcripts/dev-a/u1.jsonl.gz']);
    expect(await (await cloud.env.BUCKET.get('transcripts/dev-a/u1.jsonl.gz'))!.text()).toBe('abc');
    expect((await list(tokB)).files.map((f) => f.seq)).toEqual([1]);
    // 読むのは誰でもよい。取り直しに要る。
    expect(await (await get(tokB, 'transcripts/dev-a/u1.jsonl.gz')).text()).toBe('abc');
  });

  it('「..」で他端末の接頭辞へ抜けられない', async () => {
    // 「..」は URL の側で畳まれて `transcripts/dev-b/...` として届く。そこで権限に当たって断られる。
    // 符号化した `%2e%2e` も URL の規格では同じ扱いで、やはり畳まれる。
    for (const key of ['transcripts/dev-a/../dev-b/u1.gz', 'transcripts/dev-a/%2e%2e/dev-b/u1.gz', 'transcripts/dev-a/%2E%2E/dev-b/u1.gz'])
      expect([key, (await put(tokA, key, 'x')).status]).toEqual([key, 403]);
    expect(await keysInR2()).toEqual([]);
    expect((await list(tokA)).files).toEqual([]);
  });

  it('config はどの端末からでも置き直せる', async () => {
    const rel = 'skills/a/SKILL.md';
    expect((await put(tokB, `config/${rel}`, 'x', configMeta(rel))).status).toBe(201);
    expect((await put(tokA, `config/${rel}`, 'y', configMeta(rel))).status).toBe(201);
    expect(await (await cloud.env.BUCKET.get(`config/${rel}`))!.text()).toBe('y');
    expect((await list(tokB)).files.map((f) => [f.seq, f.deviceId])).toEqual([[2, 'dev-a']]);
    expect((await del(tokB, `config/${rel}`)).status).toBe(204);
  });

  it('端末 ID にスラッシュを混ぜた形は、参加の入口でも鍵の検査でも通らない', async () => {
    // 入口で断る（Task 3 が `0b6467b` で足した検査）。そもそもこの端末は作れない。
    const r = await cloud.SELF.fetch('https://x/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: SECRET, device: { id: 'dev-a/evil', name: 'evil', platform: 'darwin' } }),
    });
    expect(r.status).toBe(400);
    // 入口を抜けたとしても、鍵の検査でも断る。層は 2 つある。
    expect(validKey('transcripts/dev-a/evil/u1.gz', 'dev-a/evil', 'PUT')).toBe(false);
    expect(validKey('transcripts/dev-a/u1.gz', 'dev-a/evil', 'PUT')).toBe(false);
    // config は端末 ID を見ないので、今までどおり書ける。
    expect(validKey('config/a.md', 'dev-a/evil', 'PUT')).toBe(true);
    expect(await keysInR2()).toEqual([]);
  });

  it('認証が無ければ files のどの経路も 401', async () => {
    for (const init of [
      { method: 'GET', path: 'https://x/files?since=0' },
      { method: 'GET', path: 'https://x/files/transcripts/dev-a/u1.gz' },
      { method: 'PUT', path: 'https://x/files/transcripts/dev-a/u1.gz' },
      { method: 'DELETE', path: 'https://x/files/transcripts/dev-a/u1.gz' },
    ]) {
      const r = await cloud.SELF.fetch(init.path, { method: init.method, headers: meta(), body: init.method === 'PUT' ? 'x' : undefined });
      expect([init.path, r.status]).toEqual([init.path, 401]);
    }
    expect(await keysInR2()).toEqual([]);
  });
});

describe('例外の覆い', () => {
  it('中で倒れても文言を外に出さず、秘密も漏らさない', async () => {
    await put(tokA, 'transcripts/dev-a/u1.jsonl.gz', 'abc'); // ここでスキーマの用意が済む
    await cloud.env.DB.prepare('drop table files').run();
    const r = await put(tokA, 'transcripts/dev-a/u2.jsonl.gz', 'abc');
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ error: 'internal error' });
    expect(text).not.toContain('files');
    expect(text).not.toContain('no such table');
    expect(text).not.toContain(tokA);
    expect(text).not.toContain(SECRET);
  });
});
