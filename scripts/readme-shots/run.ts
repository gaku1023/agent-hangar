// README に載せる画面の画像を撮る台本の入口。
//   node --import tsx scripts/readme-shots/run.ts [--only hero,search [--solo]] [--hold] [--keep]
// scenes/<名前>.ts を全部読み、見本の HOME を作り、偽の claude で動かしたサーバを 4177 以外のポートで起こして、Playwright で撮る。
// 出力は docs/images/（motion は <名前>.webp、still は <名前>.png）。場面の足し方は README.md。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PAST, PROJECTS } from './data.mjs';
import { api, type Env, prepare, requireBuilt, requireTools, startServer, teardown, waitHealthy } from './env.ts';
import type { ApiMock, LiveScript, PastSession, Project, Scene, Seed } from './kit.ts';
import { type Ids, OUT, shoot } from './stage.ts';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const only = (() => { const i = args.indexOf('--only'); return i >= 0 ? new Set(args[i + 1]!.split(',')) : null; })();

type SessionRow = { id: string; providerSessionId: string };

async function loadScenes(): Promise<Scene[]> {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scenes');
  // --solo は --only の場面だけを読み、ほかの場面の setup も走らせない（作りかけの場面に引きずられずに試すため）。
  const files = fs.readdirSync(dir).filter((f) => /^[^_.][^.]*\.ts$/.test(f))
    .filter((f) => !(flag('--solo') && only) || only.has(f.replace(/\.ts$/, ''))).sort();
  const scenes: Scene[] = [];
  for (const f of files) {
    const mod = (await import(pathToFileURL(path.join(dir, f)).href)) as { default?: Scene };
    const s = mod.default;
    if (!s) throw new Error(`scenes/${f} が default で場面を export していません`);
    if (s.name !== f.replace(/\.ts$/, '')) throw new Error(`scenes/${f} の name が "${s.name}" です。ファイル名と同じにしてください`);
    scenes.push(s);
  }
  if (only) for (const n of only) if (!scenes.some((s) => s.name === n)) throw new Error(`場面 "${n}" がありません（あるもの: ${scenes.map((s) => s.name).join(', ')}）`);
  return scenes;
}

/** 全場面の setup を呼んで、見本のデータを集める。 */
function collect(scenes: Scene[]): { projects: Project[]; past: PastSession[]; live: Record<string, LiveScript>; mocks: ApiMock[] } {
  const projects: Project[] = [...PROJECTS];
  const past: PastSession[] = [...(PAST as PastSession[])];
  const live: Record<string, LiveScript> = {};
  const mocks: ApiMock[] = [];
  for (const s of scenes) {
    const seed: Seed = {
      project: (p) => { if (projects.some((q) => q.dir === p.dir)) throw new Error(`${s.name}: プロジェクト ${p.dir} が重なります`); projects.push(p); },
      past: (x) => { if (past.some((q) => q.title === x.title)) throw new Error(`${s.name}: 過去の会話 "${x.title}" が重なります`); past.push(x); },
      live: (key, sc) => {
        if (live[key]) throw new Error(`${s.name}: live の key ${key} が重なります`);
        if (Object.values(live).some((q) => q.name === sc.name)) throw new Error(`${s.name}: live の name "${sc.name}" が重なります`);
        live[key] = sc;
      },
      mock: (m) => { mocks.push(m); },
    };
    s.setup?.(seed);
  }
  return { projects, past, live, mocks };
}

async function populate(e: Env, data: ReturnType<typeof collect>): Promise<Ids> {
  const projectIds: Record<string, string> = {};
  for (const p of data.projects) {
    const dto = await api<{ id: string }>(e, 'POST', '/projects', { kind: 'dir', path: e.cwdOf[p.dir], name: p.name });
    projectIds[p.dir] = dto.id;
  }
  // 過去の会話が索引に入るのを待つ。
  const t0 = Date.now();
  let ids = new Map<string, string>();
  for (;;) {
    const rows = await api<SessionRow[]>(e, 'GET', '/sessions');
    const have = new Map(rows.map((r) => [r.providerSessionId, r.id]));
    if (e.pastIds.every((id) => have.has(id))) { ids = have; break; }
    if (Date.now() - t0 > 60_000) throw new Error('過去の会話が索引に入りません');
    await new Promise((r) => setTimeout(r, 500));
  }
  const pastIds: Record<string, string> = {};
  for (const [i, s] of data.past.entries()) {
    const id = ids.get(e.pastIds[i]!)!;
    pastIds[s.title] = id;
    if (!s.state) continue;
    await api(e, 'PUT', `/sessions/${id}/state`, { status: s.state, ...(s.note ? { note: s.note } : {}) });
  }
  const live: Record<string, string> = {};
  for (const [key, sc] of Object.entries(data.live)) {
    const run = await api<{ id?: string; sessionId?: string }>(e, 'POST', '/runs', { projectId: projectIds[sc.project], name: sc.name });
    live[key] = run.sessionId ?? run.id ?? '';
  }
  return { projectIds, live, pastIds };
}

async function main(): Promise<void> {
  requireBuilt();
  const tools = requireTools();
  const scenes = await loadScenes();
  const data = collect(scenes);
  const e = await prepare(tools, data);
  console.log(`撮影用の環境: ${e.root}（ポート ${e.port}）`);
  let code = 0;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => { void teardown(e, tools, flag('--keep')).finally(() => process.exit(130)); });
  }
  try {
    startServer(e);
    await waitHealthy(e);
    const ids = await populate(e, data);
    if (flag('--hold')) {
      console.log(`開く: ${e.base}/?t=${e.token}\nCtrl+C で止めます。`);
      await new Promise(() => {});
    }
    fs.mkdirSync(OUT, { recursive: true });
    await shoot(e, ids, tools, scenes.filter((s) => !only || only.has(s.name)), data.mocks);
  } catch (err) {
    console.error(err);
    code = 1;
  } finally {
    await teardown(e, tools, flag('--keep'));
  }
  process.exit(code);
}

void main();
