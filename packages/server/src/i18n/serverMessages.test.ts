import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { t } from '@agent-hangar/shared';
import { addManualArtifact } from '../artifacts/queries.ts';
import { linkProblem, linkProblemMessage } from '../provider/claude-code/config/accountLinks.ts';
import { AccountStore } from '../config/accounts.ts';
import { readRetention } from '../provider/claude-code/config/retention.ts';
import { openInEditor } from '../external/open.ts';
import { checkDirName, makeProjectDir } from '../projects/create.ts';
import { listPromptCommands } from '../provider/claude-code/prompt/commands.ts';
import { compressEvents } from '../summary/input.ts';
import { SummaryJob } from '../summary/job.ts';
import { SUMMARY_SYSTEM_PROMPT, summarySystemPrompt, SummarizerError, type Summarizer } from '../summary/types.ts';
import { errorText, msg, render } from './message.ts';

/**
 * 経路や道具より下の層の文が、日本語でも英語でも出ることを、領域ごとに代表で見る。
 * 日本語の文そのものは、各領域の既存の試験が見ている。ここは、同じ失敗や結果を英語で出せることを見る。
 */

const JAPANESE = /[぀-ヿ一-鿿]/;
const caught = (fn: () => unknown): unknown => { try { fn(); } catch (e) { return e; } throw new Error('投げなかった'); };

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-messages-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('アカウント', () => {
  it('保存の層の失敗は、引数を保ったまま英語で出せる', () => {
    const store = new AccountStore({ home: dir, primaryDir: path.join(dir, '.claude'), homeDir: dir });
    const e = caught(() => store.setCurrent('no-such'));
    expect(errorText('ja', e)).toBe('アカウントが見つかりません');
    expect(errorText('en', e)).toBe('Account not found');
    const long = caught(() => store.update('primary', { name: 'x'.repeat(41) }));
    expect(errorText('ja', long)).toBe('アカウントの名前は 40 字までです');
    expect(errorText('en', long)).toBe('Account name must be 40 characters or fewer');
  });

  it('リンクの問題は、並びをその言語の区切りでつなぐ', () => {
    expect(linkProblemMessage([])).toBeNull();
    expect(linkProblem(['skills', 'projects'])).toBe('置き場の skills、projects が共有のリンクではありません。中身を確認して、要らなければ削除してください');
    expect(render('en', linkProblemMessage(['skills', 'projects'])!)).toBe('These items in the config directory are not shared links: skills, projects. Check their contents and delete them if they are not needed');
  });
});

describe('プロジェクト', () => {
  it('名前の検査と、既にあるフォルダ', () => {
    expect(errorText('en', caught(() => checkDirName('a/b')))).toBe('Name must be at least one character that can be used as a directory name, and cannot contain /');
    fs.mkdirSync(path.join(dir, 'taken'));
    const e = caught(() => makeProjectDir(dir, 'taken', false));
    expect(errorText('ja', e)).toMatch(/taken は既にあります$/);
    expect(errorText('en', e)).toMatch(/taken already exists$/);
  });

  it('入れ子の理由も、外側の文と同じ言語で出る', () => {
    const e = caught(() => makeProjectDir(dir, 'fresh', true, () => { throw new SummarizerError('lmstudio', msg('summary.lmstudio.noModel')); }));
    expect(errorText('ja', e)).toBe('git init に失敗しました: LM Studio にモデルがありません');
    expect(errorText('en', e)).toBe('git init failed: LM Studio has no model');
  });
});

describe('設定のファイルと外部の道具', () => {
  it('保持期間を書けない理由', () => {
    const o = { claudeDir: path.join(dir, 'nowhere'), managedDir: null };
    expect(readRetention(o).unwritableReason).toBe('設定の置き場が見つからないので書き換えません');
    expect(readRetention({ ...o, language: () => 'en' }).unwritableReason).toBe('The settings directory was not found, so it will not be changed');
  });

  it('エディタを開けない理由は、設定の欄の名前ごと英語になる', async () => {
    const e = await openInEditor({ codePath: null, target: '/x' }).catch((x: unknown) => x);
    expect(errorText('ja', e)).toBe('VS Code の code コマンドが見つかりません。設定の「code のパス」を入力してください');
    expect(errorText('en', e)).toBe('The code command of VS Code was not found. Enter the "code path" in Settings');
  });

  it('アーティファクトの URL の検査', () => {
    const e = caught(() => addManualArtifact(null as never, 'd', 'p', 'not a url'));
    expect(errorText('ja', e)).toBe('URL の形式が正しくありません');
    expect(errorText('en', e)).toBe('The URL format is not valid');
  });
});

describe('初期プロンプトの候補', () => {
  it('組み込みのコマンドの説明と引数の手がかり', () => {
    const builtin = (language?: 'ja' | 'en') => listPromptCommands({ claudeDir: dir, projectPath: null, language }).filter((c) => c.source === 'builtin');
    expect(builtin().find((c) => c.name === 'review')).toMatchObject({ description: 'プルリクエストを審査する', argumentHint: '[PR 番号]' });
    expect(builtin('en').find((c) => c.name === 'review')).toMatchObject({ description: 'Review a pull request', argumentHint: '[PR number]' });
    expect(builtin('en').find((c) => c.name === 'code-review')!.argumentHint).toBe('[low|medium|high]');
    for (const c of builtin('en')) expect(JAPANESE.test(JSON.stringify(c)), c.name).toBe(false);
    expect(builtin('en').map((c) => c.name)).toEqual(builtin('ja').map((c) => c.name));
  });
});

describe('要約', () => {
  it('要約器への指示は、言語ごとに 1 つの文で、行の数が同じである', () => {
    expect(summarySystemPrompt()).toBe(SUMMARY_SYSTEM_PROMPT);
    expect(SUMMARY_SYSTEM_PROMPT).toContain('日本語で、指定の JSON だけを返してください。');
    const en = summarySystemPrompt('en');
    expect(JAPANESE.test(en)).toBe(false);
    expect(en).toContain('Reply in English, with only the specified JSON.');
    expect(en.split('\n').length).toBe(SUMMARY_SYSTEM_PROMPT.split('\n').length);
    for (const name of ['title', 'one_liner', 'body', 'next_steps', 'in_progress', 'done', 'blocked', 'abandoned', 'proposed_status', 'paused', 'none', 'proposed_note', 'proposed_return_in_days', '(1 to 14)']) expect(en, name).toContain(name);
  });

  it('実行中の印の言い方は、指示と入力の先頭でそろっている', () => {
    // 指示は「先頭にこの文があれば」と言うので、入力に足す文と食い違うと判定が効かない。
    expect(t('ja', 'summary.input.running')).toBe('このセッションは現在も実行中です。');
    expect(SUMMARY_SYSTEM_PROMPT).toContain('「このセッションは現在も実行中」');
    expect(t('en', 'summary.input.running')).toBe('This session is still running.');
    expect(summarySystemPrompt('en')).toContain('"This session is still running"');
  });

  it('省いた行の印', () => {
    const events = Array.from({ length: 10 }, (_, i) => ({ kind: 'user' as const, text: 'x'.repeat(100) + i }));
    expect(compressEvents(events as never, { totalMax: 500 })).toContain('件を省略 ...]');
    expect(compressEvents(events as never, { totalMax: 500, language: 'en' })).toMatch(/\[\.\.\. \d+ items omitted \.\.\.\]/);
  });

  it('使えない要約器と失敗した要約器の文', async () => {
    const off: Summarizer = { id: 'lmstudio', available: async () => false, summarize: async () => { throw new Error('unused'); } };
    const broken: Summarizer = { id: 'claude-headless', available: async () => true, summarize: async () => { throw new SummarizerError('claude-headless', msg('summary.claude.exited', { code: 2, detail: 'boom' })); } };
    const job = (language: () => 'ja' | 'en' = () => 'ja') => new SummaryJob({ db: null as never, deviceId: 'd', summarizers: () => [off, broken], live: () => [], hub: { broadcast: () => {} }, language });
    expect(await job().test()).toEqual({ ok: false, tried: [{ id: 'lmstudio', message: '使えません（接続できないか、上限に達しています）' }, { id: 'claude-headless', message: 'claude が 2 で終了しました: boom' }] });
    expect(await job(() => 'en').test()).toEqual({ ok: false, tried: [{ id: 'lmstudio', message: 'Not available (cannot connect, or the limit has been reached)' }, { id: 'claude-headless', message: 'claude exited with 2: boom' }] });
  });
});
