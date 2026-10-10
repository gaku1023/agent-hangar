import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parseAuthStatus } from '../src/config/accountAuth.ts';
import { ensureShellScript, shellScriptPath } from '../src/config/shellHook.ts';
import { openDb } from '../src/db/open.ts';
import { IndexerService } from '../src/indexer/service.ts';
import { agentsJsonDrifts, authStatusDrifts, BUILTIN_SUBCOMMANDS, claudeVersionOf, parseHelp, subcommandsFromHelp } from '../src/provider/claude-code/compat/cli.ts';
import { registryDrifts } from '../src/provider/claude-code/compat/registry.ts';
import { statuslineDrifts } from '../src/provider/claude-code/compat/statusline.ts';
import { transcriptDrifts } from '../src/provider/claude-code/compat/transcript.ts';
import { VERIFIED_CLAUDE_VERSION } from '../src/provider/claude-code/compat/version.ts';
import { mangleCwd } from '../src/provider/claude-code/discover.ts';
import { readRegistry } from '../src/provider/claude-code/registry.ts';
import { parseJobs } from '../src/runs/procs.ts';
import { readEvents, subagentIds } from '../src/transcript/read.ts';
import { parseStatusline } from '../src/usage/statusline.ts';
import { PLACEHOLDER, SCENARIO } from './capture/scenario.ts';
import { claudeFixtures, fixtureSubagents, newestClaudeFixture, readFixtureJsonl, readFixtureText } from './claudeFixtures.ts';

// 採った見本（packages/server/test/fixtures/claude/<版>/）の試験。
// すべての版の見本について、ずれが 0 件であることと、主な読み取りが筋書き（capture/scenario.ts）どおりに取れることを確かめる。
// 落ちたら、その値を知っている集合に足すか、読み方を変えるかを決める。足すだけで済むか分からなければ、値と版を利用者に報告して止まる。

const fixtures = claudeFixtures();
const tmps: string[] = [];
const tmpDir = (prefix: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

it('採った見本が 1 つ以上ある', () => {
  expect(fixtures.length).toBeGreaterThan(0);
});

for (const f of fixtures) {
  describe(`Claude Code ${f.version} の見本`, () => {
    it('version.txt の版が置き場の名前と同じ', () => {
      expect(claudeVersionOf(readFixtureText(f, 'version.txt'))).toBe(f.version);
    });
    it('トランスクリプトのどの行もずれが無い。利用者と Claude の行は版を持つ', () => {
      for (const name of ['transcript.jsonl', ...fixtureSubagents(f)]) {
        const recs = readFixtureJsonl(f, name);
        expect(recs.flatMap((r) => transcriptDrifts(r)), name).toEqual([]);
        for (const r of recs as { type?: string; version?: string }[]) {
          if (r.type === 'user' || r.type === 'assistant') expect(r.version, name).toBe(f.version);
        }
      }
    });
    it('レジストリのどの写しもずれが無く、作業中と休みを通る。最後の写しを読める', () => {
      const recs = readFixtureJsonl(f, 'registry.jsonl');
      expect(recs.flatMap((r) => registryDrifts(r))).toEqual([]);
      const statuses = (recs as { status?: string }[]).map((r) => r.status);
      expect(statuses).toContain('busy');
      expect(statuses).toContain('idle');
      const dir = tmpDir('hangar-fx-reg-');
      fs.mkdirSync(path.join(dir, 'sessions'));
      const last = recs.at(-1) as { pid: number };
      fs.writeFileSync(path.join(dir, 'sessions', `${last.pid}.json`), JSON.stringify(last));
      expect(readRegistry(dir, () => false)).toEqual([expect.objectContaining({ sessionId: f.sessionId, name: SCENARIO.name, cwd: PLACEHOLDER.work })]);
    });
    it('statusline のどの JSON もずれが無く、モデルとコンテキストの大きさを読める。戻る時刻はミリ秒で読める', () => {
      const recs = readFixtureJsonl(f, 'statusline.jsonl');
      expect(recs.flatMap((r) => statuslineDrifts(r))).toEqual([]);
      const parsed = recs.map((r) => parseStatusline(r)!);
      expect(parsed.every((p) => p.providerSessionId === f.sessionId && p.model !== null)).toBe(true);
      expect(parsed.some((p) => p.contextSize !== null && p.contextSize > 0)).toBe(true);
      // 戻る時刻が 1 つも読めないと、下のミリ秒の確かめが素通りする。
      expect(parsed.some((p) => p.rateLimits?.fiveHour?.resetsAt != null)).toBe(true);
      for (const p of parsed) {
        for (const w of [p.rateLimits?.fiveHour, p.rateLimits?.sevenDay]) if (w && w.resetsAt !== null) expect(w.resetsAt).toBeGreaterThan(1e12);
      }
    });
    it('使用量の欄（費用、累計の時間、使用率）と、アカウントの欄は、決まった値に伏せてある', () => {
      // 版によって無い欄は飛ばす。あるのに決まった値でなければ、伏せ残しである。
      const num = (v: unknown): v is number => typeof v === 'number';
      for (const r of readFixtureJsonl(f, 'statusline.jsonl') as { cost?: Record<string, unknown>; rate_limits?: Record<string, Record<string, unknown>> }[]) {
        const cost = r.cost ?? {};
        if (num(cost.total_cost_usd)) expect(cost.total_cost_usd, 'statusline の total_cost_usd').toBe(PLACEHOLDER.costUsd);
        for (const k of ['total_duration_ms', 'total_api_duration_ms']) if (num(cost[k])) expect(cost[k], `statusline の ${k}`).toBe(PLACEHOLDER.durationMs);
        for (const [window, w] of Object.entries(r.rate_limits ?? {})) {
          if (num(w?.used_percentage)) expect(w.used_percentage, `statusline の ${window} の used_percentage`).toBe(PLACEHOLDER.usedPercent[window] ?? 1);
        }
      }
      for (const name of ['transcript.jsonl', ...fixtureSubagents(f)]) {
        for (const r of readFixtureJsonl(f, name) as { type?: string; totalCostUSD?: unknown; modelUsage?: Record<string, { costUSD?: unknown }> }[]) {
          if (r.type !== 'cost-state') continue;
          if (num(r.totalCostUSD)) expect(r.totalCostUSD, `${name} の totalCostUSD`).toBe(PLACEHOLDER.costUsd);
          for (const [model, u] of Object.entries(r.modelUsage ?? {})) if (num(u?.costUSD)) expect(u.costUSD, `${name} の ${model} の costUSD`).toBe(PLACEHOLDER.costUsd);
          const rec = r as Record<string, unknown>;
          for (const k of ['totalAPIDuration', 'totalAPIDurationWithoutRetries', 'totalToolDuration', 'totalDuration']) if (num(rec[k])) expect(rec[k], `${name} の ${k}`).toBe(PLACEHOLDER.durationMs);
        }
      }
      const auth = JSON.parse(readFixtureText(f, 'auth-status.json')) as Record<string, unknown>;
      const expected: Record<string, string> = { email: PLACEHOLDER.email, orgName: PLACEHOLDER.orgName, orgId: PLACEHOLDER.orgId, subscriptionType: PLACEHOLDER.subscriptionType };
      for (const [k, v] of Object.entries(expected)) if (typeof auth[k] === 'string') expect(auth[k], `auth-status.json の ${k}`).toBe(v);
    });
    it('auth status と agents の JSON にずれが無く、読める', () => {
      const auth = readFixtureText(f, 'auth-status.json');
      expect(authStatusDrifts(auth)).toEqual([]);
      expect(parseAuthStatus(auth, 0)).toMatchObject({ loggedIn: true, email: PLACEHOLDER.email });
      const agents = readFixtureText(f, 'agents.json');
      expect(agentsJsonDrifts(agents)).toEqual([]);
      // 対話のセッションだけなので、バックグラウンドの行は無い。
      expect(parseJobs(agents)).toEqual([]);
      expect(JSON.parse(agents)).toEqual([expect.objectContaining({ sessionId: f.sessionId, kind: 'interactive' })]);
    });
    it('--help からサブコマンドを読み、シェルの包みに書き込む', () => {
      const help = parseHelp(readFixtureText(f, 'help.txt'));
      expect(help).not.toBeNull();
      expect(help!.subcommands.length).toBeGreaterThan(5);
      const home = tmpDir('hangar-fx-shell-');
      ensureShellScript(home, { url: 'http://127.0.0.1:4177', tokenFile: path.join(home, 'token'), tmuxPath: null, subcommands: subcommandsFromHelp(readFixtureText(f, 'help.txt')).subcommands });
      expect(fs.readFileSync(shellScriptPath(home), 'utf8')).toContain(`    ${help!.subcommands.join('|')}) command claude "$@"; return ;;`);
    });
    it('索引から、筋書きどおりのターン、積んだ指示、道具、サブエージェント、題名、使用量、ターンの終わりが取れる', async () => {
      const claudeDir = tmpDir('hangar-fx-claude-');
      const proj = path.join(claudeDir, 'projects', mangleCwd(PLACEHOLDER.work));
      fs.mkdirSync(path.join(proj, f.sessionId, 'subagents'), { recursive: true });
      fs.copyFileSync(path.join(f.dir, 'transcript.jsonl'), path.join(proj, `${f.sessionId}.jsonl`));
      for (const name of fixtureSubagents(f)) fs.copyFileSync(path.join(f.dir, name), path.join(proj, f.sessionId, name));
      const db = openDb(':memory:');
      try {
        await new IndexerService({ db, deviceId: 'd', claudeDir, isRunning: () => false }).fullScan();
        const s = db.prepare('select id, custom_title from sessions where provider_session_id = ?').get(f.sessionId) as { id: string; custom_title: string | null };
        expect(s.custom_title).toBe(SCENARIO.name);
        const stats = db.prepare('select turns, input_tokens, output_tokens from session_stats where session_id = ?').get(s.id) as { turns: number; input_tokens: number; output_tokens: number };
        expect(stats.turns).toBe(2);
        expect(stats.input_tokens).toBeGreaterThan(0);
        expect(stats.output_tokens).toBeGreaterThan(0);
        const events = readEvents(db, s.id, { limit: 2000 }).events;
        expect(events.flatMap((e) => (e.kind === 'user' ? [e.text] : []))).toEqual([SCENARIO.first, SCENARIO.queued]);
        const tools = new Set(events.flatMap((e) => (e.kind === 'tool_call' ? [e.name] : [])));
        for (const t of ['Write', 'Bash', 'Agent']) expect(tools, t).toContain(t);
        expect(['TodoWrite', 'TaskCreate'].some((t) => tools.has(t))).toBe(true);
        expect(events.some((e) => e.kind === 'system' && e.subtype === 'turn_duration')).toBe(true);
        expect(subagentIds(db, s.id).length).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    });
  });
}

// 組み込みの一覧は最も新しい版に合わせる。古い見本とは違ってよいので、最も新しい見本でだけ確かめる。
it('最も新しい見本の --help のサブコマンドは、組み込みの一覧と同じ', () => {
  const f = newestClaudeFixture()!;
  expect(subcommandsFromHelp(readFixtureText(f, 'help.txt'))).toEqual({ subcommands: [...BUILTIN_SUBCOMMANDS], drifts: [] });
});

it('確かめた版は最も新しい見本の版で、README にも書いてある', () => {
  expect(VERIFIED_CLAUDE_VERSION).toBe(newestClaudeFixture()!.version);
  const readme = fs.readFileSync(fileURLToPath(new URL('../../../README.md', import.meta.url)), 'utf8');
  expect(readme).toContain(`確かめた Claude Code の版は \`${VERIFIED_CLAUDE_VERSION}\` です`);
});

it('見本に、伏せたはずの値（手元のパス、一時ディレクトリ、メールアドレス）が残っていない', () => {
  const PRIVATE: [string, RegExp][] = [
    ['ホームのパス', /\/(?:Users|home)\/(?!me\b)[^/\s"\\]+/],
    ['一時ディレクトリのパス', /\/var\/folders\//],
    ['Claude Code の一時の置き場', /\/(?:private\/)?tmp\/claude-\d+/],
    ['メールアドレス', /[A-Za-z0-9._%+-]+@(?!example\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ];
  for (const f of fixtures) {
    const names = fs.readdirSync(f.dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
    for (const file of names) {
      const text = fs.readFileSync(file, 'utf8');
      for (const [label, re] of PRIVATE) expect(re.test(text), `${path.relative(f.dir, file)} に${label}`).toBe(false);
    }
  }
});
