import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFakeTool } from '../../../test/fake-bin.ts';
import type { ServerEvent, SettingsDto } from '@agent-hangar/shared';
import type { Db } from '../../db/open.ts';
import { upsertShared } from '../../db/shared.ts';
import { SESSION_OTHER } from '../../../test/fixtures.ts';
import { createApp, type RunsApi } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// 設定の経路（routes/settings.ts）の試験。依存は testDeps() で組み、createApp を通して /api の下から叩く。

let t: TestWorld;
let app: ReturnType<typeof createApp>;
let dir: string;
let db: Db;
let ws: string;
let sent: ServerEvent[];
let runs: RunsApi;
const get = (p: string, headers: Record<string, string> = H) => app.request(p, { headers });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

/** 実行できる空のファイルを ws/bin に置く。パスの欄は保存の前に存在と実行権を確かめるので、実物が要る。 */
const exe = (name: string): string => writeFakeTool(path.join(ws, 'bin'), name, { sh: '', cmd: '' });

beforeEach(async () => {
  t = await testDeps();
  ({ db, ws, runs } = t);
  dir = t.claudeDir; sent = t.events;
  app = createApp(t.deps);
});
afterEach(() => { t.dispose(); });

describe('routes', () => {
  it('設定の取得と更新', async () => {
    expect((await json(await get('/api/settings'))).body.workspaceRoot).toBe(ws);
    const r = await app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ workspaceRoot: path.join(ws, 'alpha') }) });
    expect(r.status).toBe(200);
    expect((await r.json()).workspaceRoot).toBe(path.join(ws, 'alpha'));
    // 保存の知らせは画面が欄の横に出すので、サーバからトーストは配らない。
    expect(sent.some((e) => e.type === 'toast')).toBe(false);
  });
  it('パスの欄は、保存する前に存在と実行権を確かめ、理由を欄の見出しで言う', async () => {
    const error = async (body: unknown) => {
      const r = await app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(r.status).toBe(400);
      return ((await r.json()) as { error: string }).error;
    };
    // 実在しないルートと、ファイルを指したルートは弾く。どちらも 500 にはしない。
    const missing = path.join(ws, 'no-such-root');
    expect(await error({ workspaceRoot: missing })).toBe(`「ワークスペースのルート」に ${missing} が見つかりません`);
    const asFile = path.join(ws, 'root-is-a-file');
    fs.writeFileSync(asFile, 'x');
    expect(await error({ workspaceRoot: asFile })).toBe(`「ワークスペースのルート」の ${asFile} はディレクトリではありません`);
    // ツールは、無い、ファイルでない、実行できないを分けて言う。
    expect(await error({ tmuxPath: path.join(ws, 'no-tmux') })).toBe(`「tmux のパス」に ${path.join(ws, 'no-tmux')} が見つかりません`);
    expect(await error({ claudePath: ws })).toBe(`「claude のパス」の ${ws} はファイルではありません`);
    expect(await error({ codePath: asFile })).toBe(`「code のパス」の ${asFile} には実行権がありません`);
    expect(await error({ nodePath: path.join(ws, 'no-node') })).toBe(`「Node のパス」に ${path.join(ws, 'no-node')} が見つかりません`);
    // 弾いた値は保存していない。
    expect((await json(await get('/api/settings'))).body).toMatchObject({ workspaceRoot: ws, tmuxPath: null, claudePath: null, codePath: null, nodePath: null });
  });
  // 名前だけ（tmux など）は PATH から探して確かめ、打たれたまま保存する。起動のときも PATH から探すからである。
  it('パスの欄は名前だけでも受け、PATH から探して確かめ、打たれたまま保存する', async () => {
    const patch = (body: unknown) => app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const bin = path.dirname(exe('mytmux'));
    vi.stubEnv('PATH', ['/no/such/dir', bin].join(path.delimiter));
    try {
      const r = await patch({ tmuxPath: ' mytmux ' });
      expect(r.status).toBe(200);
      expect((await r.json()).tmuxPath).toBe('mytmux');
      expect((await json(await get('/api/settings'))).body.tmuxPath).toBe('mytmux');
      const missing = await patch({ tmuxPath: 'no-such-tool' });
      expect(missing.status).toBe(400);
      expect(((await missing.json()) as { error: string }).error).toBe('「tmux のパス」の no-such-tool が PATH に見つかりません');
      // 相対パスは、サーバの作業ディレクトリで読むとどこを指すかが分からないので弾く。
      for (const rel of ['./mytmux', 'bin/mytmux']) {
        const bad = await patch({ claudePath: rel });
        expect(bad.status).toBe(400);
        expect(((await bad.json()) as { error: string }).error).toBe('「claude のパス」は / か ~ で始まるパスか、tmux のようなコマンドの名前にしてください');
      }
      expect((await json(await get('/api/settings'))).body).toMatchObject({ tmuxPath: 'mytmux', claudePath: null });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  // 起動するときに ~ は直されないので、パスは ~ をホームに直した値で保存する。
  it('パスの欄の ~ はホームに直して保存する', async () => {
    const patch = (body: unknown) => app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const tool = exe('hometool');
    vi.stubEnv('HOME', ws);
    vi.stubEnv('USERPROFILE', ws);
    try {
      // Windows の偽の道具は hometool.cmd になる。拡張子まで書いたパスで指す。
      const r = await patch({ codePath: `~/bin/${path.basename(tool)}` });
      expect(r.status).toBe(200);
      expect((await r.json()).codePath).toBe(tool);
      expect((await json(await get('/api/settings'))).body.codePath).toBe(tool);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('設定の誤りは、内部のキー名ではなく画面の欄の見出しと画面名「設定」で言う', async () => {
    const error = async (body: unknown) => {
      const r = await app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(r.status).toBe(400);
      return ((await r.json()) as { error: string }).error;
    };
    expect(await error({ workspaceRoot: '' })).toBe('「ワークスペースのルート」は空にできません');
    expect(await error({ claudeDir: ' ' })).toBe('「読み取り元」は空にできません');
    expect(await error({ tmuxPath: 3 })).toBe('「tmux のパス」の値の形が違います');
    expect(await error({ codePath: 3 })).toBe('「code のパス」の値の形が違います');
    expect(await error({ nodePath: 3 })).toBe('「Node のパス」の値の形が違います');
    expect(await error({ claudePath: 3 })).toBe('「claude のパス」の値の形が違います');
    expect(await error({ terminalApp: 'kitty' })).toBe('「ターミナルアプリ」は Terminal.app か iTerm2 から選んでください');
    expect(await error({ lmStudioUrl: 'ftp://x' })).toBe('「LM Studio の URL」は http か https で始まる URL にしてください');
    expect(await error({ lmStudioModel: 3 })).toBe('「モデル」の値の形が違います');
    expect(await error({ summaryFallback: 'yes' })).toBe('「LM Studio が使えないとき Claude へ切り替える」の値の形が違います');
    expect(await error({ summaryHourlyCap: 0 })).toBe('「1 時間の上限」は 1 から 200 までの整数にしてください');
    // 画面の入力と同じく 200 までにする。
    expect(await error({ summaryHourlyCap: 201 })).toBe('「1 時間の上限」は 1 から 200 までの整数にしてください');
    expect(await error({ allowExternalSummarizer: 'yes' })).toBe('「外部の要約器を許す」の値の形が違います');
    expect(await error({ lmStudioUrl: 'https://attacker.example.com' })).toBe('要約器の宛先は 127.0.0.1 か localhost だけです。トランスクリプトが送られるため、ほかの宛先は、設定の「外部の要約器を許す」を入れてから指定してください');
  });
  it('設定の更新は既知の項目だけを受け、値が空なら 400', async () => {
    const patch = (body: unknown) => app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await patch({ workspaceRoot: '' })).status).toBe(400);
    expect((await patch({ workspaceRoot: 123 })).status).toBe(400);
    expect((await patch({ claudeDir: '  ' })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await patch({ token: 'stolen' })).status).toBe(400);
    expect((await json(await get('/api/settings'))).body).toEqual({ workspaceRoot: ws, claudeDir: dir, tmuxPath: null, terminalApp: 'terminal', codePath: null, lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryFallback: true, summaryHourlyCap: 20, allowExternalSummarizer: false, configApproval: 'each', configBundleSync: false, nodePath: null, claudePath: null, language: 'ja' });
  });
  it('claudePath は保存でき、空なら null に戻る', async () => {
    const patch = (body: unknown) => app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const claude = exe('claude');
    const r = await patch({ claudePath: ` ${claude} ` });
    expect(r.status).toBe(200);
    expect((await r.json()).claudePath).toBe(claude);
    expect((await json(await get('/api/settings'))).body.claudePath).toBe(claude);
    const r2 = await patch({ claudePath: '' });
    expect(r2.status).toBe(200);
    expect((await r2.json()).claudePath).toBeNull();
    expect((await patch({ claudePath: 7 })).status).toBe(400);
  });
  it('nodePath は保存でき、空なら null に戻る', async () => {
    const node = exe('node');
    const r = await app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ nodePath: ` ${node} ` }) });
    expect(r.status).toBe(200);
    expect((await r.json()).nodePath).toBe(node);
    expect((await json(await get('/api/settings'))).body.nodePath).toBe(node);
    expect((await json(await get('/api/bootstrap'))).body.settings.nodePath).toBe(node);
    const r2 = await app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ nodePath: '' }) });
    expect(r2.status).toBe(200);
    expect((await r2.json()).nodePath).toBeNull();
    // 文字列でも null でもない値は弾く。
    const r3 = await app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ nodePath: 7 }) });
    expect(r3.status).toBe(400);
  });
  it('ワークスペースのルートを変えるとプロジェクトを登録し直して配信する', async () => {
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-app2-'));
    try {
      fs.mkdirSync(`${ws2}/other`);
      const other = db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_OTHER) as { id: string };
      db.prepare('update sessions set cwd = ? where id = ?').run(`${ws2}/other`, other.id);
      sent.length = 0;
      const r = await app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ workspaceRoot: ws2 }) });
      expect(r.status).toBe(200);
      const created = db.prepare('select id from projects where name = ?').get('other') as { id: string } | undefined;
      expect(created).toBeDefined();
      expect(sent.some((e) => e.type === 'project.upsert' && e.project.id === created!.id)).toBe(true);
      const up = sent.find((e) => e.type === 'session.upsert' && e.session.id === other.id);
      expect(up).toBeDefined();
      expect((up as { session: { projectId: string | null } }).session.projectId).toBe(created!.id);
    } finally {
      fs.rmSync(ws2, { recursive: true, force: true });
    }
  });
  it('設定の新しい項目を検査する', async () => {
    const patch = (body: unknown) => app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    // 実物の置き場（/opt/homebrew/bin/tmux）は PC によって無いので、偽の道具を置いて指す。
    const tmuxBin = exe('tmux');
    expect(await (await patch({ terminalApp: 'iterm', tmuxPath: tmuxBin })).json()).toMatchObject({ terminalApp: 'iterm', tmuxPath: tmuxBin });
    expect((await patch({ terminalApp: 'kitty' })).status).toBe(400);
    expect((await patch({ tmuxPath: 3 })).status).toBe(400);
    expect((await (await patch({ codePath: null })).json()).codePath).toBeNull();
  });
  const post = (p: string, body?: unknown, method = 'POST') => app.request(p, { method, headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  it('要約器の設定を検査する', async () => {
    const patch = (body: unknown) => post('/api/settings', body, 'PATCH');
    expect(await (await patch({ lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: 'gemma', summaryFallback: false, summaryHourlyCap: 5 })).json()).toMatchObject({ lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: 'gemma', summaryFallback: false, summaryHourlyCap: 5 });
    expect((await patch({ lmStudioUrl: 'ftp://x' })).status).toBe(400);
    // host の無い URL は繋ぎ先にならない。
    expect((await patch({ lmStudioUrl: 'http://' })).status).toBe(400);
    expect((await patch({ lmStudioUrl: 'http' })).status).toBe(400);
    expect((await patch({ summaryHourlyCap: 0 })).status).toBe(400);
    expect((await patch({ summaryFallback: 'yes' })).status).toBe(400);
    expect((await (await patch({ lmStudioModel: null })).json()).lmStudioModel).toBeNull();
  });
  it('要約器の宛先は、既定ではループバックだけを受ける', async () => {
    const patch = (body: unknown) => post('/api/settings', body, 'PATCH');
    // 会話の本文はこの宛先へ送られる。外部のホストは、明示の許可が無ければ断る。
    const bad = await patch({ lmStudioUrl: 'https://attacker.example.com/collect' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/外部の要約器/);
    expect((await json(await get('/api/settings'))).body.lmStudioUrl).toBe('http://127.0.0.1:1234');
    for (const u of ['http://127.0.0.1:1234', 'http://localhost:4321', 'http://[::1]:1234']) {
      expect([u, (await patch({ lmStudioUrl: u })).status]).toEqual([u, 200]);
    }
    // 許しを立てたときだけ通り、外部の宛先であることは設定に残る。
    expect((await patch({ allowExternalSummarizer: true, lmStudioUrl: 'https://attacker.example.com/collect' })).status).toBe(200);
    expect((await json(await get('/api/settings'))).body).toMatchObject({ allowExternalSummarizer: true, lmStudioUrl: 'https://attacker.example.com/collect' });
    // 許しを下ろすときは、宛先も戻してもらう。外部のまま無効にはできない。
    expect((await patch({ allowExternalSummarizer: false })).status).toBe(400);
    expect((await patch({ allowExternalSummarizer: false, lmStudioUrl: 'http://127.0.0.1:1234' })).status).toBe(200);
    expect((await patch({ allowExternalSummarizer: 'yes' })).status).toBe(400);
  });
});

describe('設定の変更でロックを消さない', () => {
  it('ワークスペースを変えたときの配り直しにもロックが乗る', async () => {
    // 配り直しの 1 か所だけ deviceId が抜けていると、サーバはロックを持っているのに
    // 配信はロック無しの SessionDto を送り、UI の store がそれで置き換えて画面から消える。
    const all = (await json(await get('/api/sessions'))).body as { id: string; projectId: string | null }[];
    const orphan = all.find((s) => s.projectId === null)!;
    // このセッションが新しいワークスペースの下に入るようにして、紐づけ直しの配信に載せる。
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ws2-'));
    try {
      fs.mkdirSync(path.join(ws2, 'beta'));
      db.prepare('update sessions set cwd = ? where id = ?').run(path.join(ws2, 'beta'), orphan.id);
      upsertShared(db, 'devices', { id: 'mini', name: 'mini', platform: 'darwin', last_seen_at: Date.now(), deleted_at: null }, 'mini');
      upsertShared(db, 'runs', {
        id: 'remote-run', session_id: orphan.id, device_id: 'mini', kind: 'start', tmux_name: 'hangar-remote',
        pid: null, launch_params: '{}', started_at: Date.now(), ended_at: null, end_reason: null, heartbeat_at: Date.now(), deleted_at: null,
      }, 'mini');
      sent.length = 0;
      const r = await app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ workspaceRoot: ws2 }) });
      expect(r.status).toBe(200);
      const upserts = sent.filter((e): e is Extract<ServerEvent, { type: 'session.upsert' }> => e.type === 'session.upsert');
      const mine = upserts.find((e) => e.session.id === orphan.id);
      expect(mine).toBeDefined();
      expect(mine!.session.lock).toMatchObject({ deviceId: 'mini', deviceName: 'mini', runId: 'remote-run' });
      // 配った後に引き直しても同じ姿である（配信だけが違う、という形を作らない）。
      expect((await json(await get(`/api/sessions/${orphan.id}`))).body.lock).toMatchObject({ deviceId: 'mini' });
    } finally {
      fs.rmSync(ws2, { recursive: true, force: true });
    }
  });
});

describe('設定の往復', () => {
  const patch = (body: unknown) => app.request('/api/settings', { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('SettingsDto の項目はすべて UI から往復できる', async () => {
    // 受け口に 1 つでも項目が足りないと、UI の操作は 400 で弾かれ、その機能が丸ごと死ぬ。
    // 実物の確認では旧い設定の同期のスイッチがそれで、設定の同期を UI から入れられなかった。
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ws3-'));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-cd-'));
    try {
      // 1 項目ずつ送って、応答と GET の両方に載ることを見る。UI は 1 項目だけの patch を送る。
      const cases: [keyof SettingsDto, unknown][] = [
        ['workspaceRoot', ws2],
        ['claudeDir', dir2],
        ['tmuxPath', exe('tmux')],
        ['terminalApp', 'iterm'],
        ['codePath', exe('code')],
        ['lmStudioUrl', 'http://127.0.0.1:9999'],
        ['lmStudioModel', 'gemma-3'],
        ['summaryFallback', false],
        ['summaryHourlyCap', 7],
        ['allowExternalSummarizer', true],
        ['configApproval', 'auto'],
        ['configBundleSync', true],
        ['nodePath', exe('node')],
        ['claudePath', exe('claude')],
        ['language', 'en'],
      ];
      for (const [key, value] of cases) {
        const r = await patch({ [key]: value });
        expect([key, r.status]).toEqual([key, 200]);
        expect([key, (await r.json())[key]]).toEqual([key, value]);
        expect([key, (await json(await get('/api/settings'))).body[key]]).toEqual([key, value]);
      }
      // 受け口の項目が DTO の項目とそろっていることを、抜けが出たら落ちる形で見る。
      const dto = (await json(await get('/api/settings'))).body as SettingsDto;
      expect(cases.map(([k]) => k).sort()).toEqual(Object.keys(dto).sort());
    } finally {
      fs.rmSync(ws2, { recursive: true, force: true });
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('届いた設定の承諾の仕方は、既定が毎回で、auto を保存でき、知らない値は断る', async () => {
    expect((await json(await get('/api/settings'))).body.configApproval).toBe('each');
    expect((await json(await get('/api/bootstrap'))).body.settings.configApproval).toBe('each');
    expect((await (await patch({ configApproval: 'auto' })).json()).configApproval).toBe('auto');
    expect((await json(await get('/api/settings'))).body.configApproval).toBe('auto');
    for (const v of ['always', 'AUTO', '', null, true, ['auto']]) {
      const r = await patch({ configApproval: v });
      expect([v, r.status]).toEqual([v, 400]);
      expect((await r.json()).error).toBe('「届いた設定の承諾の仕方」の値の形が違います');
    }
    expect((await json(await get('/api/settings'))).body.configApproval).toBe('auto');
  });
  it('設定の同期（作り直した実装）のスイッチは、既定が切で、保存でき、真偽値でない値は断る', async () => {
    expect((await json(await get('/api/settings'))).body.configBundleSync).toBe(false);
    expect((await (await patch({ configBundleSync: true })).json()).configBundleSync).toBe(true);
    expect((await json(await get('/api/bootstrap'))).body.settings.configBundleSync).toBe(true);
    for (const v of ['true', 1, null, []]) {
      const r = await patch({ configBundleSync: v });
      expect([v, r.status]).toEqual([v, 400]);
    }
  });
  it('言語の既定は日本語で、英語を保存して読める', async () => {
    expect((await json(await get('/api/settings'))).body.language).toBe('ja');
    expect((await json(await get('/api/bootstrap'))).body.settings.language).toBe('ja');
    const r = await patch({ language: 'en' });
    expect(r.status).toBe(200);
    expect((await r.json()).language).toBe('en');
    expect((await json(await get('/api/settings'))).body.language).toBe('en');
    expect((await json(await get('/api/bootstrap'))).body.settings.language).toBe('en');
    expect((await (await patch({ language: 'ja' })).json()).language).toBe('ja');
  });
  it('知らない言語は断り、保存した値を変えない', async () => {
    await patch({ language: 'en' });
    for (const v of ['fr', 'EN', '', null, 1, ['en']]) {
      const r = await patch({ language: v });
      expect([v, r.status]).toEqual([v, 400]);
      // 言語を英語にしたあとなので、断る文も英語で返る。
      expect((await r.json()).error).toBe('"Language" must be ja or en');
    }
    expect((await json(await get('/api/settings'))).body.language).toBe('en');
  });
  it('日本語のままなら、知らない言語を日本語で断る', async () => {
    const r = await patch({ language: 'fr' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('「言語」は ja か en から選んでください');
  });
  it('言語を英語にすると、経路のエラーが英語になり、日本語に戻すと日本語になる', async () => {
    const missing = async () => ((await (await get('/api/projects/no-such-project')).json()) as { error: string }).error;
    expect(await missing()).toBe('プロジェクトが見つかりません');
    await patch({ language: 'en' });
    expect(await missing()).toBe('Project not found');
    expect((await (await patch({ tmuxPath: 'relative/tmux' })).json()).error).toBe('"tmux path" must be a path starting with / or ~, or a command name such as tmux');
    expect((await (await patch({})).json()).error).toBe('The request contains no settings that can be updated');
    await patch({ language: 'ja' });
    expect(await missing()).toBe('プロジェクトが見つかりません');
  });

  // 前後の空白に意味は無い。パス系の設定と同じ扱いにそろえる。
  it('lmStudioModel は前後の空白を落として保存する', async () => {
    const r = await patch({ lmStudioModel: '  gemma-3  ' });
    expect(r.status).toBe(200);
    expect((await r.json()).lmStudioModel).toBe('gemma-3');
    expect((await json(await get('/api/settings'))).body.lmStudioModel).toBe('gemma-3');
    // 空白だけの文字列は「未設定」と同じに扱う。
    expect((await (await patch({ lmStudioModel: '   ' })).json()).lmStudioModel).toBeNull();
  });

  it('旧い設定の同期のスイッチ（syncClaudeConfig）はもう受けない。単独の要求は 400 で、混ざっても保存しない', async () => {
    // 旧実装は段 4 の PR 18 で消した。旧い画面や手書きの要求が送っても、設定に残さない。
    const r = await patch({ syncClaudeConfig: true });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('更新できる設定が含まれていません');
    const mixed = await patch({ configBundleSync: true, syncClaudeConfig: true });
    expect(mixed.status).toBe(200);
    expect(await mixed.json()).not.toHaveProperty('syncClaudeConfig');
    expect((await json(await get('/api/bootstrap'))).body.settings).not.toHaveProperty('syncClaudeConfig');
  });
});

// 経路は行を書くだけで、画面へのイベントは配る層（events/publisher.ts）が組む。
// 書いた行のイベントが、1 回だけ、最新の中身で届くことを経路ごとに押さえる。
describe('書いた行のイベントは配る層から届く', () => {
  const send = (p: string, body?: unknown, method = 'POST') => app.request(p, { method, headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const of = <T extends ServerEvent['type']>(type: T) => sent.filter((e): e is Extract<ServerEvent, { type: T }> => e.type === type);

  describe('プロジェクト', () => {
    it('ワークスペースを変えると、新しく登録したプロジェクトと、そこへ入ったセッションが 1 回ずつ届く', async () => {
      const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-app3-'));
      try {
        fs.mkdirSync(path.join(ws2, 'other'));
        const other = db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_OTHER) as { id: string };
        db.prepare('update sessions set cwd = ? where id = ?').run(path.join(ws2, 'other'), other.id);
        await send('/api/settings', { workspaceRoot: ws2 }, 'PATCH');
        const created = (db.prepare('select id from projects where name = ?').get('other') as { id: string }).id;
        // 中身の変わっていない既存のプロジェクトは配らない。
        expect(of('project.upsert').map((e) => e.project.id)).toEqual([created]);
        // 入ったセッションの最終の活動が、プロジェクトの中身に載っている（紐づけた後に組んでいる）。
        expect(of('project.upsert')[0]!.project.lastActivityAt).not.toBeNull();
        expect(of('session.upsert')).toEqual([{ type: 'session.upsert', session: expect.objectContaining({ id: other.id, projectId: created }) }]);
      } finally {
        fs.rmSync(ws2, { recursive: true, force: true });
      }
    });
  });
});
