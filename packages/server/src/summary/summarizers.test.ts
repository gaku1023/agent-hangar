import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveSessionDto, SummaryEngine, UsageDto } from '@agent-hangar/shared';
import { openDb } from '../db/open.ts';
import { IndexerService } from '../indexer/service.ts';
import { claudeTranscriptSource } from '../provider/claude-code/transcript/source.ts';
import { NO_COMPAT } from '../provider/claude-code/compat/types.ts';
import type { SpawnText } from '../provider/claude-code/summary/claude.ts';
import { CANNED_INPUT } from './input.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { SummaryJob } from './job.ts';
import { RUN_ENDED_SUMMARY_OPTS, SummarizerSet } from './summarizers.ts';
import type { Summarizer } from './types.ts';

describe('要約の契機', () => {
  let claudeDir: string;
  beforeEach(() => { claudeDir = copyFixtureClaudeDir(); });
  afterEach(() => { fs.rmSync(claudeDir, { recursive: true, force: true }); });

  it('run の終了はレジストリが生きていると言っても要約を受け付ける', async () => {
    // tmux を落とした直後でも、~/.claude/sessions を 500 ミリ秒周期で読むキャッシュは
    // 必ず「生きている」と出る。run の終了を知っている側は、その判定を当てにしない。
    const db = openDb(':memory:');
    try {
      await new IndexerService({ db, deviceId: 'd', transcript: claudeTranscriptSource({ claudeDir }), isRunning: () => false }).fullScan();
      const id = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
      const live: LiveSessionDto[] = [{ sessionId: SESSION_ALPHA, status: 'idle', name: null, nameSource: null, cwd: '/w', pid: 1 }];
      const summarizer: Summarizer = { id: 'lmstudio', available: async () => true, summarize: async () => ({ title: 'T', oneLiner: 'O', body: 'B', state: 'done', nextSteps: [] }) };
      const job = new SummaryJob({ db, deviceId: 'd', summarizers: () => [summarizer], live: () => live, hub: { broadcast: () => {} }, language: () => 'ja' });
      // セッションを開いたときの契機は、レジストリが生きていると言う間は受け付けない。
      expect(job.enqueue(id)).toBe(false);
      // run の終了の契機は受け付ける。こちらは run が終わったことを知っている。
      expect(job.enqueue(id, RUN_ENDED_SUMMARY_OPTS)).toBe(true);
      await job.idle();
      expect((db.prepare('select source from session_summaries where session_id = ?').get(id) as { source: string }).source).toBe('post_hoc');
      // 飛ばすのはレジストリの判定だけである。土台でなくなった後は、もう受け付けない。
      expect(job.enqueue(id, RUN_ENDED_SUMMARY_OPTS)).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe('要約器の列', () => {
  const setup = () => {
    const settings = { summaryEngine: 'openai' as SummaryEngine, summaryClaudeModel: 'haiku', lmStudioUrl: 'http://127.0.0.1:1', lmStudioModel: null as string | null, summaryApiKey: null as string | null, summaryFallback: true, summaryHourlyCap: 3 };
    const spawn = vi.fn<SpawnText>(async () => ({ code: 0, stdout: JSON.stringify({ structured_output: { title: 'T', one_liner: 'O', body: 'B', state: 'done', next_steps: [] } }), stderr: '' }));
    const set = new SummarizerSet({ settings: () => settings, claudeBin: () => '/nope/claude', usage: () => ({}) as UsageDto, compat: NO_COMPAT, spawn });
    return { settings, set, spawn };
  };

  it('使わない設定では要約器を 1 つも並べない', () => {
    const { settings, set } = setup();
    settings.summaryEngine = 'off';
    expect(set.list()).toEqual([]);
  });

  it('Claude を選べば Claude だけを並べる。切り替えのスイッチは見ない', () => {
    const { settings, set } = setup();
    settings.summaryEngine = 'claude';
    expect(set.list().map((s) => s.id)).toEqual(['claude-headless']);
    settings.summaryFallback = false;
    expect(set.list().map((s) => s.id)).toEqual(['claude-headless']);
  });

  it('OpenAI 互換を選べば先頭に置き、切り替えを許しているときだけ Claude を後ろに足す', () => {
    const { settings, set } = setup();
    expect(set.list().map((s) => s.id)).toEqual(['lmstudio', 'claude-headless']);
    settings.summaryFallback = false;
    expect(set.list().map((s) => s.id)).toEqual(['lmstudio']);
  });

  it('Claude の要約器は、設定のモデルで claude -p を呼ぶ。作り直さずに、変えたモデルが次の呼び出しから効く', async () => {
    const { settings, set, spawn } = setup();
    settings.summaryEngine = 'claude';
    const s = set.list()[0]!;
    expect((await s.summarize(CANNED_INPUT)).model).toBe('haiku');
    expect(spawn.mock.calls[0]![1].slice(0, 3)).toEqual(['-p', '--model', 'haiku']);
    settings.summaryClaudeModel = 'sonnet';
    expect(set.list()[0]).toBe(s);
    expect((await s.summarize(CANNED_INPUT)).model).toBe('sonnet');
    expect(spawn.mock.calls[1]![1].slice(0, 3)).toEqual(['-p', '--model', 'sonnet']);
  });

  it('Claude の要約器は 1 度だけ作る。毎回作り直すと 1 時間の窓が空になる', () => {
    const { set } = setup();
    const first = set.list()[1];
    expect(set.list()[1]).toBe(first);
    // claude の場所か上限が変わったときだけ、作り直す。
    set.rebuildClaude();
    expect(set.list()[1]).not.toBe(first);
  });
});
