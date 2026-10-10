import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// 初期プロンプト欄の経路（routes/prompt.ts）の試験。依存は testDeps() で組み、createApp を通して /api の下から叩く。

let t: TestWorld;
let app: ReturnType<typeof createApp>;
let dir: string;
let deps: AppDeps;
/** ワークスペースから登録される唯一のプロジェクト alpha の id。 */
let list0ProjectId: () => string;
const get = (p: string, headers: Record<string, string> = H) => app.request(p, { headers });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

beforeEach(async () => {
  t = await testDeps();
  ({ deps } = t);
  dir = t.claudeDir; list0ProjectId = t.alphaProjectId;
  app = createApp(deps);
});
afterEach(() => { t.dispose(); });

describe('GET /api/prompt/commands', () => {
  it('読み取り元のスキルと組み込みを返す', async () => {
    const dir = path.join(deps.settings().claudeDir, 'skills', 'demo-skill');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: demo-skill\ndescription: 試し\n---\n');
    const r = await json(await get('/api/prompt/commands'));
    expect(r.status).toBe(200);
    const list = (r.body as { commands: { name: string; source: string }[] }).commands;
    expect(list).toContainEqual(expect.objectContaining({ name: 'demo-skill', source: 'user', description: '試し' }));
    expect(list).toContainEqual(expect.objectContaining({ name: 'init', source: 'builtin' }));
  });
  it('projectId を渡すと、そのプロジェクトの .claude の下も読む', async () => {
    const id = list0ProjectId();
    const p = (await json(await get(`/api/projects/${id}`))).body as { path: string };
    const dir = path.join(p.path, '.claude', 'skills', 'proj-skill');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: proj-skill\ndescription: x\n---\n');
    const r = await json(await get(`/api/prompt/commands?projectId=${id}`));
    expect((r.body as { commands: { name: string; source: string }[] }).commands).toContainEqual(expect.objectContaining({ name: 'proj-skill', source: 'project' }));
  });
  it('知らない projectId は 404', async () => {
    expect((await get('/api/prompt/commands?projectId=nope')).status).toBe(404);
  });
  it('トークンが無ければ 401', async () => {
    expect((await get('/api/prompt/commands', {})).status).toBe(401);
  });
});

describe('GET /api/prompt/files', () => {
  it('プロジェクトのファイルを問いで探して返す', async () => {
    const id = list0ProjectId();
    const p = (await json(await get(`/api/projects/${id}`))).body as { path: string };
    const probe = path.join(p.path, 'prompt-files-probe.ts');
    fs.writeFileSync(probe, 'x');
    try {
      const r = await json(await get(`/api/prompt/files?projectId=${id}&q=prompt-files-probe`));
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ files: ['prompt-files-probe.ts'] });
    } finally {
      fs.rmSync(probe, { force: true });
    }
  });
  it('projectId が無ければ 400、知らなければ 404', async () => {
    expect((await get('/api/prompt/files?q=a')).status).toBe(400);
    expect((await get('/api/prompt/files?projectId=nope&q=a')).status).toBe(404);
  });
});

describe('/api/drops', () => {
  // ブラウザは本文を送るとき必ず Content-Length を付ける。app.request は付けないので、実際の形に合わせてここで付ける。
  const post = (name: string, body: Uint8Array<ArrayBuffer> | string, headers: Record<string, string> = {}) => app.request(`/api/drops?name=${encodeURIComponent(name)}`, { method: 'POST', body, headers: { ...H, 'content-type': 'application/octet-stream', 'content-length': String(typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength), ...headers } });

  it('本文を置き場に置き、パスと名前と大きさを返す', async () => {
    const r = await json(await post('画面 1.png', new Uint8Array([1, 2, 3])));
    expect(r.status).toBe(201);
    const d = r.body as { path: string; name: string; size: number };
    expect(d.name).toBe('画面 1.png');
    expect(d.size).toBe(3);
    expect(path.dirname(d.path)).toBe(path.join(deps.home, 'drops'));
    expect(path.basename(d.path)).toMatch(/^\d+-0-画面_1\.png$/);
    expect([...fs.readFileSync(d.path)]).toEqual([1, 2, 3]);
  });
  it('置いたファイルを名前で読める。画像は種類を付け、中身を勝手に解釈させない', async () => {
    const d = (await json(await post('a.png', new Uint8Array([9, 8])))).body as { path: string };
    const r = await get(`/api/drops/${encodeURIComponent(path.basename(d.path))}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([9, 8]);
  });
  it('画像でないものは、開かせずに落とす種類で返す', async () => {
    const d = (await json(await post('a.html', '<script>1</script>'))).body as { path: string };
    const r = await get(`/api/drops/${encodeURIComponent(path.basename(d.path))}`);
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
  });
  it('置き場の外を指す名前は 404', async () => {
    fs.writeFileSync(path.join(deps.home, 'secret'), 's');
    for (const n of ['..%2Fsecret', '%2e%2e%2fsecret', '..', 'nope.png']) expect((await get(`/api/drops/${n}`)).status).toBe(404);
  });
  it('20 MB を超える本文は 413 で、何も置かない', async () => {
    const r = await post('big.bin', new Uint8Array(20 * 1024 * 1024 + 1));
    expect(r.status).toBe(413);
    expect(fs.existsSync(path.join(deps.home, 'drops')) ? fs.readdirSync(path.join(deps.home, 'drops')).filter((n) => n.endsWith('big.bin')) : []).toEqual([]);
  });
  it('413 の文言は、上限を MB で読ませる（20480KB ではなく 20MB）', async () => {
    const r = await post('big.bin', new Uint8Array(20 * 1024 * 1024 + 1));
    expect((await r.json()).error).toBe('本文が大きすぎます（上限は 20MB です）');
  });
  it('長さの申告が 20 MB を超えていれば、読む前に 413 にする', async () => {
    expect((await post('lie.bin', new Uint8Array([1]), { 'content-length': String(20 * 1024 * 1024 + 1) })).status).toBe(413);
  });
  it('置き場の中の、外を指すシンボリックリンクは読ませない', async () => {
    const outside = path.join(deps.home, 'outside-secret');
    fs.writeFileSync(outside, 's');
    const drops = path.join(deps.home, 'drops');
    fs.mkdirSync(drops, { recursive: true });
    fs.symlinkSync(outside, path.join(drops, 'link.png'));
    expect((await get('/api/drops/link.png')).status).toBe(404);
  });
  it('本文の型は application/octet-stream だけを受ける（text/plain は断る）', async () => {
    expect((await post('a.png', new Uint8Array([1]), { 'content-type': 'text/plain;charset=UTF-8' })).status).toBe(415);
    expect((await post('a.png', new Uint8Array([1]), { 'content-type': 'multipart/form-data; boundary=x' })).status).toBe(415);
  });
  it('octet-stream の例外は POST /api/drops だけで、ほかの経路は 415 のまま', async () => {
    const body = JSON.stringify({ paths: [] });
    const r = await app.request('/api/drops/existing', { method: 'POST', headers: { ...H, 'content-type': 'application/octet-stream', 'content-length': String(body.length) }, body });
    expect(r.status).toBe(415);
    const p = await app.request('/api/projects', { method: 'POST', headers: { ...H, 'content-type': 'application/octet-stream', 'content-length': String(body.length) }, body });
    expect(p.status).toBe(415);
  });
  it('例外の経路でも、トークンと Sec-Fetch-Site の検査は効く', async () => {
    expect((await post('a.png', new Uint8Array([1]), { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await post('a.png', new Uint8Array([1]), { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post('a.png', new Uint8Array([1]), { origin: 'https://evil.example' })).status).toBe(403);
  });
  it('空の本文は 400', async () => {
    expect((await post('empty.png', new Uint8Array(0))).status).toBe(400);
  });
  it('existing は、渡したパスのうち、いまあるファイルだけを返す', async () => {
    const d = (await json(await post('a.png', new Uint8Array([1])))).body as { path: string };
    const r = await json(await app.request('/api/drops/existing', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ paths: [d.path, path.join(deps.home, 'drops', 'gone.png'), 42] }) }));
    expect(r.body).toEqual({ paths: [d.path] });
  });
  it('トークンが無ければ 401', async () => {
    expect((await app.request('/api/drops?name=a.png', { method: 'POST', body: new Uint8Array([1]) })).status).toBe(401);
  });
});
