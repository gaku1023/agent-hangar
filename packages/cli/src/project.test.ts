import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FolderCandidatesDto, FolderRegisterOutcomeDto, ProjectDto } from '@agent-hangar/shared';
import { candidatesCommand, formatCandidates, projectAddCommand, projectRemoveCommand, workspaceSetCommand, workspaceUnsetCommand } from './project.ts';

// hangar project と hangar workspace（2026-10-15）。
// 動いているサーバの API を鍵付きで呼ぶ。
// サーバは偽の fetch で置き換え、呼ばれた経路と本文を控える。

type Call = { method: string; path: string; body: unknown; auth: string | null };
type Route = (call: Call) => { status?: number; body: unknown } | undefined;

/**
 * 経路ごとの応答を返す偽の fetch。
 * どの経路にも当たらなければ 404。
 */
function fakeServer(route: Route) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? 'GET', path: url.pathname + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: (init?.headers as Record<string, string>)?.authorization ?? null };
    calls.push(call);
    const r = route(call) ?? { status: 404, body: { error: 'not found' } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchFn };
}

/** 繋がらないサーバ（接続を断られる）。 */
const downFetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;

function outs() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (l: string) => out.push(l), error: (l: string) => err.push(l) };
}

const base = (o: ReturnType<typeof outs>, fetchFn: typeof fetch, json = false) => ({ port: 4177, token: 'tok', json, fetch: fetchFn, log: o.log, error: o.error });

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 15, 12);

const candidates: FolderCandidatesDto = {
  unassignedTotal: 9,
  workspaceRoot: null,
  suggestedRoot: '/Users/someone/src',
  candidates: [
    { path: '/Users/someone/src/app', sessionCount: 5, lastActivityAt: NOW - DAY, worktreeCount: 1, recentTitles: ['a'], isGit: true, gitRemote: 'github.com/someone/app', enclosedBy: null, cloudSynced: null, notes: [] },
    { path: '/Users/someone/Desktop/memo', sessionCount: 1, lastActivityAt: NOW - 40 * DAY, worktreeCount: 0, recentTitles: [], isGit: false, gitRemote: null, enclosedBy: { kind: 'candidate', path: '/Users/someone/Desktop' }, cloudSynced: 'icloud', notes: ['desktop-direct', 'not-git', 'stale-30d', 'single-session'] },
  ],
};

describe('hangar project candidates', () => {
  it('人向けは 1 行 1 候補で、会話の数、最終日、パス、注記を出す', async () => {
    const o = outs();
    const s = fakeServer((c) => (c.path === '/api/workspace/candidates' ? { body: candidates } : undefined));
    expect(await candidatesCommand(base(o, s.fetchFn))).toBe(0);
    expect(s.calls[0]!.auth).toBe('Bearer tok');
    expect(o.out.join('\n')).toBe(formatCandidates(candidates, { timeZone: undefined }).join('\n'));
  });
  it('formatCandidates の形', () => {
    const lines = formatCandidates(candidates, { timeZone: 'UTC' });
    expect(lines).toEqual([
      'この PC の未分類の会話: 9 件',
      '作成場所: 未設定',
      '候補 2 件（会話の多い順）:',
      '  会話   5 件  2026-10-14  /Users/someone/src/app  [worktree 1]',
      '  会話   1 件  2026-09-05  /Users/someone/Desktop/memo  [デスクトップの直下、git なし、30 日より前、会話 1 件、iCloud で同期、候補 /Users/someone/Desktop の中]',
      '作成場所の候補: /Users/someone/src（hangar workspace set で決められます）',
    ]);
    expect(formatCandidates({ candidates: [], suggestedRoot: null, unassignedTotal: 0, workspaceRoot: '/w' }, { timeZone: 'UTC' })).toEqual([
      'この PC の未分類の会話: 0 件',
      '作成場所: /w',
      '候補はありません。',
    ]);
  });
  it('--json はサーバの返事をそのまま 1 行で出す', async () => {
    const o = outs();
    const s = fakeServer(() => ({ body: candidates }));
    expect(await candidatesCommand(base(o, s.fetchFn, true))).toBe(0);
    expect(o.out).toHaveLength(1);
    expect(JSON.parse(o.out[0]!)).toEqual(candidates);
  });
  it('サーバが止まっていれば exit 2。人向けは案内を標準エラーへ、--json は標準出力に server_down', async () => {
    const o = outs();
    expect(await candidatesCommand(base(o, downFetch))).toBe(2);
    expect(o.err).toEqual(['ポート 4177 でサーバが動いていません。`hangar start` で起動してください。']);
    expect(o.out).toEqual([]);
    const j = outs();
    expect(await candidatesCommand(base(j, downFetch, true))).toBe(2);
    expect(j.out).toEqual(['{"error":"server_down","hint":"hangar start"}']);
  });
  it('鍵が合わなければ exit 1 で unauthorized', async () => {
    const j = outs();
    const s = fakeServer(() => ({ status: 401, body: { error: 'unauthorized' } }));
    expect(await candidatesCommand(base(j, s.fetchFn, true))).toBe(1);
    expect(JSON.parse(j.out[0]!)).toMatchObject({ error: 'unauthorized' });
  });
});

const outcome = (o: Partial<FolderRegisterOutcomeDto> & Pick<FolderRegisterOutcomeDto, 'path' | 'status'>): FolderRegisterOutcomeDto => o;

describe('hangar project add', () => {
  const ok = [
    outcome({ path: '/w/one', status: 'added', projectId: 'p1', name: 'one', sessionCount: 2 }),
    outcome({ path: '/w/alpha', status: 'already', projectId: 'p0', name: 'alpha', sessionCount: 0, restored: true }),
    outcome({ path: '/w/far', status: 'linked', projectId: 'p9', name: 'far-old', sessionCount: 1 }),
  ];
  it('パスを絶対にして送り、--dry-run は本文に dryRun を付ける。全部成功なら exit 0', async () => {
    const o = outs();
    const s = fakeServer((c) => (c.path === '/api/workspace/register' ? { body: { dryRun: true, results: ok } } : undefined));
    expect(await projectAddCommand({ ...base(o, s.fetchFn), paths: ['rel/dir', '/w/alpha/'], dryRun: true, cwd: '/home/me' })).toBe(0);
    expect(s.calls[0]).toMatchObject({ method: 'POST', body: { paths: [path.resolve('/home/me', 'rel/dir'), path.resolve('/w/alpha/')], dryRun: true } });
    expect(o.out).toEqual([
      '登録します: /w/one（名前 one、未分類の会話 2 件が入ります）',
      '登録済み: /w/alpha（名前 alpha。アーカイブから戻します）',
      '結び付けます: /w/far（ほかの PC のプロジェクト far-old、未分類の会話 1 件が入ります）',
      '試しなので、何も書いていません。',
    ]);
  });
  it('本番は登録しましたの形で出し、登録済みは失敗にしない', async () => {
    const o = outs();
    const s = fakeServer(() => ({ body: { projects: [], failed: [], linked: [], results: ok } }));
    expect(await projectAddCommand({ ...base(o, s.fetchFn), paths: ['/w/one'], dryRun: false, cwd: '/' })).toBe(0);
    expect((s.calls[0]!.body as { dryRun?: boolean }).dryRun).toBeUndefined();
    expect(o.out).toEqual([
      '登録しました: /w/one（名前 one、未分類の会話 2 件が入りました）',
      '登録済み: /w/alpha（名前 alpha。アーカイブから戻しました）',
      '結び付けました: /w/far（ほかの PC のプロジェクト far-old、未分類の会話 1 件が入りました）',
    ]);
  });
  it('入れ子とそのほかの失敗も全件出し、1 件でもあれば exit 1。入れ子はアプリで決めるよう案内する', async () => {
    const results = [
      ok[0]!,
      outcome({ path: '/w/alpha/inner', status: 'nested', enclosing: { projectId: 'p0', name: 'alpha', path: '/w/alpha' }, error: 'このフォルダはプロジェクト alpha の中にあります' }),
      outcome({ path: '/w/nope', status: 'error', error: 'path が存在するディレクトリではありません' }),
    ];
    const o = outs();
    const s = fakeServer(() => ({ body: { projects: [], failed: [], linked: [], results } }));
    expect(await projectAddCommand({ ...base(o, s.fetchFn), paths: ['/w/one', '/w/alpha/inner', '/w/nope'], dryRun: false, cwd: '/' })).toBe(1);
    expect(o.out).toEqual([
      '登録しました: /w/one（名前 one、未分類の会話 2 件が入りました）',
      '登録できません: /w/alpha/inner（プロジェクト alpha（/w/alpha）の中にあります。別のプロジェクトに分けるかは、アプリで決めてください）',
      '登録できません: /w/nope（path が存在するディレクトリではありません）',
    ]);
    const j = outs();
    expect(await projectAddCommand({ ...base(j, s.fetchFn, true), paths: ['/w/one'], dryRun: false, cwd: '/' })).toBe(1);
    expect(JSON.parse(j.out[0]!)).toEqual({ ok: false, dryRun: false, results });
  });
  it('--json は ok と dryRun と行ごとの結果を 1 行で出す', async () => {
    const j = outs();
    const s = fakeServer(() => ({ body: { dryRun: true, results: ok } }));
    expect(await projectAddCommand({ ...base(j, s.fetchFn, true), paths: ['/w/one'], dryRun: true, cwd: '/' })).toBe(0);
    expect(JSON.parse(j.out[0]!)).toEqual({ ok: true, dryRun: true, results: ok });
  });
  it('サーバが止まっていれば exit 2', async () => {
    const j = outs();
    expect(await projectAddCommand({ ...base(j, downFetch, true), paths: ['/w/one'], dryRun: true, cwd: '/' })).toBe(2);
    expect(j.out).toEqual(['{"error":"server_down","hint":"hangar start"}']);
  });
});

const project = (over: Partial<ProjectDto>): ProjectDto => ({ id: 'p', name: 'n', status: 'active', isScratch: false, path: null, resolved: true, lastActivityAt: null, runningCount: 0, openTodoCount: 0, memoHead: null, updatedAt: 1, ...over });

describe('hangar project remove', () => {
  // 一覧のパスは、試験機の形の絶対パスにする。
  // Windows では /w/alpha が D:\w\alpha に解決されるためである。
  const alpha = path.resolve('/w/alpha');
  const list = [project({ id: 'p1', name: 'alpha', path: alpha }), project({ id: 'scr', name: 'scratch', path: '/h/scratch', isScratch: true }), project({ id: 'p2', name: 'beta', path: null })];
  const server = (syncing: boolean) => fakeServer((c) => {
    if (c.path === '/api/projects') return { body: list };
    const m = /^\/api\/projects\/([^/]+)\/resolve$/.exec(c.path);
    if (!m) return undefined;
    const p = list.find((x) => x.id === m[1])!;
    const b = c.body as { kind: string; dryRun?: boolean };
    if (b.dryRun) return { body: { dryRun: true, id: p.id, name: p.name, path: p.path, sessionCount: 3, syncing } };
    return { body: { id: p.id, unlinked: true, sessionCount: 3 } };
  });

  it('パス（この PC の場所）で選び、--dry-run は未分類に戻る会話の数と、本文が消えないことを出す', async () => {
    const o = outs();
    const s = server(true);
    expect(await projectRemoveCommand({ ...base(o, s.fetchFn), target: '/w/alpha/', dryRun: true, cwd: '/' })).toBe(0);
    expect(s.calls.map((c) => [c.method, c.path, c.body])).toEqual([['GET', '/api/projects', undefined], ['POST', '/api/projects/p1/resolve', { kind: 'unlink', dryRun: true }]]);
    expect(o.out).toEqual([
      `一覧から削除します: alpha（${alpha}）`,
      '会話 3 件が未分類に戻ります。',
      '会話は未分類に戻るだけで、本文は消えません。フォルダにも触れません。',
      '同期しているほかの PC の一覧からも消えます。',
      '試しなので、何も書いていません。',
    ]);
  });
  it('id でも選べる。本番は一覧から削除し、同期を使っていなければその行を出さない', async () => {
    const o = outs();
    const s = server(false);
    expect(await projectRemoveCommand({ ...base(o, s.fetchFn), target: 'p1', dryRun: false, cwd: '/' })).toBe(0);
    expect(s.calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/projects/p1/resolve', body: { kind: 'unlink' } });
    expect(o.out).toEqual([
      `一覧から削除しました: alpha（${alpha}）`,
      '会話 3 件を未分類に戻しました。',
      '会話は未分類に戻るだけで、本文は消えません。フォルダにも触れません。',
    ]);
    const j = outs();
    expect(await projectRemoveCommand({ ...base(j, s.fetchFn, true), target: 'p1', dryRun: false, cwd: '/' })).toBe(0);
    expect(JSON.parse(j.out[0]!)).toEqual({ ok: true, dryRun: false, project: { id: 'p1', name: 'alpha', path: alpha }, sessionCount: 3, syncing: false });
  });
  it('見つからない、スクラッチは exit 1 で断り、書かない', async () => {
    const s = server(false);
    const j = outs();
    expect(await projectRemoveCommand({ ...base(j, s.fetchFn, true), target: '/w/none', dryRun: false, cwd: '/' })).toBe(1);
    expect(JSON.parse(j.out[0]!)).toMatchObject({ error: 'not_found' });
    const o = outs();
    expect(await projectRemoveCommand({ ...base(o, s.fetchFn), target: 'scr', dryRun: false, cwd: '/' })).toBe(1);
    expect(o.err.join('\n')).toContain('スクラッチ');
    expect(s.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('hangar workspace set / unset', () => {
  it('--dry-run は保存と同じ検証を通し、自動で登録される直下のフォルダを全部見せる', async () => {
    const o = outs();
    const s = fakeServer((c) => (c.method === 'PATCH' && c.path === '/api/settings' ? { body: { dryRun: true, workspaceRoot: '/w2', previous: '', unchanged: false, register: [
      outcome({ path: '/w2/a', status: 'added', projectId: 'x', name: 'a', sessionCount: 4 }),
      outcome({ path: '/w2/b', status: 'linked', projectId: 'y', name: 'b-old', sessionCount: 0 }),
    ] } } : undefined));
    expect(await workspaceSetCommand({ ...base(o, s.fetchFn), dir: '~/w2', dryRun: true, cwd: '/', homeDir: '/home/me' })).toBe(0);
    expect(s.calls[0]!.body).toEqual({ workspaceRoot: path.resolve('/home/me', 'w2'), dryRun: true });
    expect(o.out).toEqual([
      '作成場所: 未設定 → /w2',
      '保存すると、直下の次のフォルダを自動で登録します（2 件）:',
      '  登録します: /w2/a（名前 a、未分類の会話 4 件が入ります）',
      '  結び付けます: /w2/b（ほかの PC のプロジェクト b-old、未分類の会話 0 件が入ります）',
      '試しなので、何も書いていません。',
    ]);
  });
  it('断られた値は理由を出して exit 1', async () => {
    const j = outs();
    const s = fakeServer(() => ({ status: 400, body: { error: '「新しいフォルダの作成場所」に /x が見つかりません' } }));
    expect(await workspaceSetCommand({ ...base(j, s.fetchFn, true), dir: '/x', dryRun: true, cwd: '/', homeDir: '/h' })).toBe(1);
    expect(JSON.parse(j.out[0]!)).toEqual({ error: 'rejected', message: '「新しいフォルダの作成場所」に /x が見つかりません' });
  });
  it('ホームフォルダとその上、ファイルシステムの根は、サーバに送らずに断る', async () => {
    for (const dir of ['~', '/home', '/']) {
      const j = outs();
      const s = fakeServer(() => ({ body: {} }));
      expect(await workspaceSetCommand({ ...base(j, s.fetchFn, true), dir, dryRun: true, cwd: '/', homeDir: '/home/me' })).toBe(1);
      expect(s.calls).toEqual([]);
      expect(JSON.parse(j.out[0]!).error).toBe('rejected');
    }
  });
  it('本番は保存し、保存の前後のプロジェクトの違いから、登録したものを出す', async () => {
    let saved = false;
    const s = fakeServer((c) => {
      if (c.path === '/api/projects') return { body: saved ? [project({ id: 'old', name: 'old', path: '/elsewhere' }), project({ id: 'x', name: 'a', path: '/w2/a' })] : [project({ id: 'old', name: 'old', path: '/elsewhere' })] };
      if (c.method === 'PATCH') { saved = true; return { body: { workspaceRoot: '/w2' } }; }
      return undefined;
    });
    const o = outs();
    expect(await workspaceSetCommand({ ...base(o, s.fetchFn), dir: '/w2', dryRun: false, cwd: '/', homeDir: '/h' })).toBe(0);
    expect(s.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ workspaceRoot: path.resolve('/w2') });
    expect(o.out).toEqual(['作成場所を /w2 にしました。', '直下の 1 件を登録しました:', '  /w2/a（名前 a）']);
  });
  it('--trust の試しは、信頼済みにするフォルダと書く先を見せ、同意は残さない', async () => {
    const s = fakeServer((c) => {
      if (c.method === 'PATCH') return { body: { dryRun: true, workspaceRoot: '/w2', previous: '', unchanged: false, register: [] } };
      if (c.method === 'POST' && c.path === '/api/workspace/trust') return { body: { dryRun: true, workspaceRoot: '/w2', dirs: ['/w2', '/w2/repo'], files: [
        { file: '/h/.claude.json', added: ['/w2', '/w2/repo'], missing: false },
        { file: '/h/.claude-univ/.claude.json', added: [], missing: true },
      ] } };
      return undefined;
    });
    const o = outs();
    expect(await workspaceSetCommand({ ...base(o, s.fetchFn), dir: '/w2', dryRun: true, trust: true, cwd: '/', homeDir: '/h' })).toBe(0);
    expect(s.calls.find((c) => c.path === '/api/workspace/trust')!.body).toEqual({ path: path.resolve('/w2'), dryRun: true });
    expect(o.out).toEqual([
      '作成場所: 未設定 → /w2',
      '直下に、会話があってまだ登録していないフォルダはありません。',
      'フォルダの信頼: 次のフォルダを Claude Code の信頼済みにします（2 件）:',
      '  /w2',
      '  /w2/repo',
      '  /h/.claude.json: 2 件を書きます',
      '  /h/.claude-univ/.claude.json: 設定ファイルが無いので書きません（その置き場で Claude Code を一度起こすと作られます）',
      '後から作成場所の下に置いたリポジトリも、hangar から起こすときに信頼済みにします。',
      '試しなので、何も書いていません。',
    ]);
  });
  it('--trust の本番は、保存してから信頼を書く。書けなかった書く先があれば exit 1', async () => {
    const s = fakeServer((c) => {
      if (c.path === '/api/projects') return { body: [] };
      if (c.method === 'PATCH') return { body: { workspaceRoot: '/w2' } };
      if (c.method === 'POST' && c.path === '/api/workspace/trust') return { body: { dryRun: false, workspaceRoot: '/w2', dirs: ['/w2'], files: [
        { file: '/h/.claude.json', added: [], missing: false },
        { file: '/u/.claude.json', added: [], missing: false, error: 'ロックが取れません' },
      ], consentRecorded: true } };
      return undefined;
    });
    const o = outs();
    expect(await workspaceSetCommand({ ...base(o, s.fetchFn), dir: '/w2', dryRun: false, trust: true, cwd: '/', homeDir: '/h' })).toBe(1);
    const order = s.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf('POST /api/workspace/trust')).toBeGreaterThan(order.indexOf('PATCH /api/settings'));
    expect(s.calls.find((c) => c.path === '/api/workspace/trust')!.body).toEqual({ path: '/w2' });
    expect(o.out.slice(-6)).toEqual([
      'フォルダの信頼: 次のフォルダを Claude Code の信頼済みにしました（1 件）:',
      '  /w2',
      '  /h/.claude.json: すでに信頼済みです',
      '  /u/.claude.json: 書けませんでした（ロックが取れません）',
      '後から作成場所の下に置いたリポジトリも、hangar から起こすときに信頼済みにします。',
      '同意は記録しました。書けなかった分も含め、次の書き込みは hangar から Claude を起こすときに行います。',
    ]);
    const j = outs();
    expect(await workspaceSetCommand({ ...base(j, s.fetchFn, true), dir: '/w2', dryRun: false, trust: true, cwd: '/', homeDir: '/h' })).toBe(1);
    expect(JSON.parse(j.out[0]!)).toMatchObject({ ok: false, workspaceRoot: '/w2', consentRecorded: true, trust: { dirs: ['/w2'] } });
  });
  it('--trust を付けなければ信頼の経路を呼ばない', async () => {
    const s = fakeServer((c) => (c.method === 'PATCH' ? { body: { dryRun: true, workspaceRoot: '/w2', previous: '', unchanged: false, register: [] } } : undefined));
    expect(await workspaceSetCommand({ ...base(outs(), s.fetchFn), dir: '/w2', dryRun: true, cwd: '/', homeDir: '/h' })).toBe(0);
    expect(s.calls.some((c) => c.path === '/api/workspace/trust')).toBe(false);
  });
  it('unset は作成場所を空にし、登録済みのプロジェクトが残ることを言う', async () => {
    const s = fakeServer((c) => {
      if (c.path === '/api/projects') return { body: [] };
      if (c.method === 'PATCH') return { body: (c.body as { dryRun?: boolean }).dryRun ? { dryRun: true, workspaceRoot: '', previous: '/w', unchanged: false, register: [] } : { workspaceRoot: '' } };
      return undefined;
    });
    const o = outs();
    expect(await workspaceUnsetCommand({ ...base(o, s.fetchFn), dryRun: true })).toBe(0);
    expect(s.calls[0]!.body).toEqual({ workspaceRoot: '', dryRun: true });
    expect(o.out).toEqual(['作成場所: /w → 未設定', '登録済みのプロジェクトはそのまま残ります。作成場所の直下の自動の登録は止まり、新しいフォルダはアプリで作るときに場所を選びます。', '試しなので、何も書いていません。']);
    const j = outs();
    expect(await workspaceUnsetCommand({ ...base(j, s.fetchFn, true), dryRun: false })).toBe(0);
    expect(JSON.parse(j.out[0]!)).toEqual({ ok: true, dryRun: false, workspaceRoot: '', registered: [] });
  });
});
