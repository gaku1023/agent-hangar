// README に載せる画面の画像を撮る台本の入口。
//   node --import tsx scripts/readme-shots/run.ts [--only hero,projects,split,search] [--hold] [--keep]
// 一時ディレクトリに見本の HOME を作り、偽の claude で動かしたサーバを 4177 以外のポートで起こして、Playwright で撮る。
// 出力は docs/images/ の hero.gif、projects.png、split.gif、search.png。
import fs from 'node:fs';
import path from 'node:path';
import { LIVE, PAST, PROJECTS } from './data.mjs';
import { api, type Env, prepare, REPO, requireBuilt, requireTools, startServer, teardown, waitHealthy } from './env.ts';
import { shoot } from './shots.ts';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const only = (() => { const i = args.indexOf('--only'); return i >= 0 ? new Set(args[i + 1]!.split(',')) : null; })();

type SessionRow = { id: string; providerSessionId: string };

async function populate(e: Env): Promise<{ projectIds: Record<string, string>; live: Record<string, string> }> {
  const projectIds: Record<string, string> = {};
  for (const p of PROJECTS) {
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
  for (const [i, s] of PAST.entries()) {
    if (!s.state) continue;
    await api(e, 'PUT', `/sessions/${ids.get(e.pastIds[i]!)}/state`, { status: s.state, ...(s.note ? { note: s.note } : {}) });
  }
  const live: Record<string, string> = {};
  for (const [key, sc] of Object.entries(LIVE)) {
    const run = await api<{ id?: string; sessionId?: string }>(e, 'POST', '/runs', { projectId: projectIds[sc.project], name: sc.name });
    live[key] = run.sessionId ?? run.id ?? '';
  }
  return { projectIds, live };
}

async function main(): Promise<void> {
  requireBuilt();
  const tools = requireTools();
  const e = await prepare(tools);
  console.log(`撮影用の環境: ${e.root}（ポート ${e.port}）`);
  let code = 0;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => { void teardown(e, tools, flag('--keep')).finally(() => process.exit(130)); });
  }
  try {
    startServer(e);
    await waitHealthy(e);
    const ctx = await populate(e);
    if (flag('--hold')) {
      console.log(`開く: ${e.base}/?t=${e.token}\nCtrl+C で止めます。`);
      await new Promise(() => {});
    }
    fs.mkdirSync(path.join(REPO, 'docs/images'), { recursive: true });
    await shoot(e, ctx, tools, only);
  } catch (err) {
    console.error(err);
    code = 1;
  } finally {
    await teardown(e, tools, flag('--keep'));
  }
  process.exit(code);
}

void main();
