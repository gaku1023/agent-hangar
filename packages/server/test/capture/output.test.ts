import { describe, expect, it } from 'vitest';
import { buildFiles, findLeaks, formatLeaks, jsonl, scenarioKept, type Leak, type Raw } from './output.ts';
import type { Secrets } from './redact.ts';
import { SCENARIO } from './scenario.ts';

// 値はどれも作り物である。
const CTX1 = 'Fixture rule: say fixture-forbidden-word never';
const CTX2 = 'Fixture habit: always mention fixture-secret-habit twice';
const S: Secrets = {
  tmp: '/var/folders/zz/abc/T/hangar-fixture-Q1',
  tmpReal: '/private/var/folders/zz/abc/T/hangar-fixture-Q1',
  tmpRoot: '/var/folders/zz/abc/T',
  tmpRootReal: '/private/var/folders/zz/abc/T',
  home: '/Users/someone',
  claudeDir: '/Users/someone/.claude-alt',
  user: 'someone',
  host: 'someones-mac.local',
  email: 'someone@corp.example',
  orgName: 'Corp Example',
  orgId: '11111111-2222-4333-8444-555555555555',
  contextLines: [CTX1, CTX2],
};
const WORK = `${S.tmpReal}/work`;
const OTHER_MAIL = 'other@corp.example';
const VENDOR_MAIL = 'noreply@vendor.example';
const THINKING = 'I recall the rule and the habit';

const reminder = (...inner: string[]): string => `<system-reminder>\n${inner.join('\n')}\n</system-reminder>`;
const context = (): string => reminder(`Contents of ${S.claudeDir}/CLAUDE.md:`, CTX1, CTX2, `Contact ${OTHER_MAIL}`, `Co-Authored-By: X <${VENDOR_MAIL}>`);
const get = (f: Record<string, string>, k: string): string => f[k] ?? '';
const L = (rec: unknown): string => JSON.stringify(rec);

const transcript = [
  // 文脈の塊が、user の本文の文字列の中にある
  L({ type: 'user', cwd: WORK, message: { role: 'user', content: `${context()}\n${SCENARIO.first}` } }),
  // 塊の text の中にある
  L({ type: 'user', cwd: WORK, message: { role: 'user', content: [{ type: 'text', text: context() }, { type: 'text', text: SCENARIO.first }] } }),
  L({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'thinking', thinking: `${THINKING} ${CTX1}`, signature: 'fixture-signature' },
    { type: 'redacted_thinking', data: 'fixture-opaque-data' },
    { type: 'text', text: 'ok' },
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 20 && ls' } },
  ] } }),
  // tool_result の中にある
  L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `${context()}\nnotes.txt` }] } }),
  L({ type: 'attachment', attachment: { type: 'queued_command', prompt: SCENARIO.queued, commandMode: 'prompt' } }),
].join('\n') + '\n';
const subagentLines = [
  L({ type: 'user', isSidechain: true, message: { role: 'user', content: `${context()}\nrun ls` } }),
  L({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'thinking', thinking: THINKING, signature: 'fixture-signature' }, { type: 'text', text: '3' }] } }),
].join('\n') + '\n';

const raw = (over: Partial<Raw> = {}): Raw => ({
  transcript,
  subagents: { 'agent-abc123.jsonl': subagentLines },
  registry: [{ pid: 1, sessionId: 'sid', status: 'busy', cwd: WORK, pidDomain: 'abc' }, { pid: 1, sessionId: 'sid', status: 'idle', cwd: WORK, pidDomain: 'abc' }],
  statusline: [{ session_id: 'sid', cwd: WORK, cost: { total_cost_usd: 0.4 }, rate_limits: { five_hour: { used_percentage: 40, resets_at: 1_760_000_000 } } }],
  agents: [{ sessionId: 'sid', cwd: WORK }, { sessionId: 'other', cwd: '/Users/someone/x' }],
  auth: { loggedIn: true, email: S.email, orgName: S.orgName, orgId: S.orgId, subscriptionType: 'enterprise', configDirectory: S.claudeDir },
  help: 'Usage: claude [options] [command]\n\nCommands:\n  agents  list\n',
  versionText: '9.9.9 (Claude Code)\n',
  version: '9.9.9',
  sessionId: 'sid',
  capturedAt: '2026-10-09',
  ...over,
});

describe('buildFiles', () => {
  it('書き出すファイルの名前をそろえる', () => {
    expect(Object.keys(buildFiles(raw(), S)).sort()).toEqual(['agents.json', 'auth-status.json', 'help.txt', 'meta.json', 'registry.jsonl', 'statusline.jsonl', 'subagents/agent-abc123.jsonl', 'transcript.jsonl', 'version.txt']);
  });
  it('文脈の塊、別のメールアドレス、考え、CLAUDE.md の行を、どの形の置き場でも残さない。伏せ残しは 0 件', () => {
    const files = buildFiles(raw(), S);
    expect(findLeaks(files, S)).toEqual([]);
    const all = Object.values(files).join('\n');
    for (const v of [OTHER_MAIL, VENDOR_MAIL, CTX1, CTX2, THINKING, 'fixture-signature', 'fixture-opaque-data', 'someone']) expect(all).not.toContain(v);
    expect(get(files, 'transcript.jsonl')).toContain('<system-reminder>(redacted)</system-reminder>');
    expect(get(files, 'subagents/agent-abc123.jsonl')).toContain('<system-reminder>(redacted)</system-reminder>');
  });
  it('1 つ目の指示と積んだ指示は残る。塊の外の本文は変えない', () => {
    const t = get(buildFiles(raw(), S), 'transcript.jsonl');
    expect(t).toContain(SCENARIO.first);
    expect(t).toContain(SCENARIO.queued);
    expect(t).toContain('sleep 20 && ls');
    const recs = t.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { message?: { content: unknown } });
    expect(recs[0]?.message?.content).toBe(`<system-reminder>(redacted)</system-reminder>\n${SCENARIO.first}`);
  });
  it('考えの塊は、種類の形を残して中身を (redacted) にする', () => {
    const recs = get(buildFiles(raw(), S), 'transcript.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { message?: { content: unknown[] } });
    expect(recs[2]?.message?.content.slice(0, 2)).toEqual([
      { type: 'thinking', thinking: '(redacted)', signature: '(redacted)' },
      { type: 'redacted_thinking', data: '(redacted)' },
    ]);
  });
  it('agents はその会話の行だけを残し、パスを伏せる', () => {
    expect(JSON.parse(get(buildFiles(raw(), S), 'agents.json'))).toEqual([{ sessionId: 'sid', cwd: '/tmp/hangar-fixture/work' }]);
  });
  it('CLAUDE.md の行が塊の外（assistant の text）に残ったら、そのファイル、行、パス、種類を返す。値は出さない', () => {
    const bad = transcript + L({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `As the rule says: ${CTX1}` }] } }) + '\n';
    const found = findLeaks(buildFiles(raw({ transcript: bad }), S), S);
    expect(found).toEqual([{ file: 'transcript.jsonl', line: 6, path: '$.message.content[0].text', kind: '利用者の CLAUDE.md の行' }]);
    expect(formatLeaks(found)).toBe('- transcript.jsonl:6 $.message.content[0].text 利用者の CLAUDE.md の行');
    expect(JSON.stringify(found)).not.toContain('fixture-forbidden-word');
  });
  it('塊の外の、行頭、タブの直後、制御文字の直後のアドレスも伏せ、伏せた値を伏せ残しと数え直さない', () => {
    const outside = transcript
      + L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: `Author:\n${OTHER_MAIL}` }] } }) + '\n'
      + L({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `email:\t${S.email ?? ''} and \u0001${VENDOR_MAIL}` }] } }) + '\n';
    const files = buildFiles(raw({ transcript: outside }), S);
    expect(findLeaks(files, S)).toEqual([]);
    const t = get(files, 'transcript.jsonl');
    for (const v of [OTHER_MAIL, VENDOR_MAIL, 'someone']) expect(t).not.toContain(v);
    expect(t).toContain('Author:\\nuser@example.com');
    expect(t).toContain('email:\\tuser@example.com');
  });
  it('CLAUDE.md の行が、伏せで形を変えて（ホームのパスを含む行）塊の外に残っても見つける', () => {
    const line = 'Keep drafts in /Users/someone/notes for later';
    const bad = transcript + L({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Noted: ${line}` }] } }) + '\n';
    const s2: Secrets = { ...S, contextLines: [...S.contextLines, line] };
    expect(findLeaks(buildFiles(raw({ transcript: bad }), s2), s2)).toEqual([{ file: 'transcript.jsonl', line: 6, path: '$.message.content[0].text', kind: '利用者の CLAUDE.md の行' }]);
  });
  it('壊れた行は、ファイル名と行番号だけを言って投げる（行の中身を出さない）', () => {
    const broken = `${transcript}\n{"secret-ish fixture-broken-value\n`;
    expect(() => buildFiles(raw({ transcript: broken }), S)).toThrow(/^transcript\.jsonl の 7 行目を JSON として読めませんでした$/);
    expect(() => buildFiles(raw({ subagents: { 'agent-abc123.jsonl': '{"x": fixture-broken-value' } }), S)).toThrow(/^subagents\/agent-abc123\.jsonl の 1 行目を JSON として読めませんでした$/);
    expect(() => jsonl('{"a":1}\n\nnot json fixture-broken-value\n', 'statusline.jsonl')).toThrow(/^statusline\.jsonl の 3 行目を JSON として読めませんでした$/);
  });
});

describe('scenarioKept', () => {
  it('伏せた後の transcript に 1 つ目の指示と積んだ指示が残っていれば空', () => {
    expect(scenarioKept(buildFiles(raw(), S))).toEqual([]);
  });
  it('伏せで指示が崩れたら、値を出さずにどちらが無いかを言う', () => {
    // ホスト名がたまたま指示の文の一部と同じだと、置き換えで指示が崩れる。
    expect(scenarioKept(buildFiles(raw(), { ...S, host: 'notes.txt' }))).toEqual(['伏せた後の transcript に 1 つ目の指示がありません']);
    expect(scenarioKept(buildFiles(raw(), { ...S, host: 'general-purpose' }))).toEqual(['伏せた後の transcript に積んだ指示がありません']);
    expect(scenarioKept({})).toEqual(['伏せた後の transcript に 1 つ目の指示がありません', '伏せた後の transcript に積んだ指示がありません']);
  });
  it('JSON の中の文字列として探す（エスケープした形でも見つける）', () => {
    const first = `${SCENARIO.first} "quoted"`;
    const files = { 'transcript.jsonl': `${L({ message: { content: `x\n${first}` } })}\n${L({ prompt: SCENARIO.queued })}\n` };
    expect(scenarioKept(files, { first, queued: SCENARIO.queued })).toEqual([]);
  });
});

describe('findLeaks と formatLeaks', () => {
  it('行番号、JSON のパス、鍵であること、種類を返し、値をパスに出さない', () => {
    const files = {
      'a.jsonl': `${L({ ok: 'fine' })}\n${L({ snap: { backups: { '/Users/someone/x': 'u@corp.example' }, list: ['ok', { note: 'at /Users/someone/y' }] } })}\n`,
      'help.txt': 'ok\nsee /Users/someone/z\n',
      'auth-status.json': JSON.stringify({ configDirectory: '/Users/someone/w' }, null, 2) + '\n',
    };
    const found = findLeaks(files, S);
    const expected: Leak[] = [
      { file: 'a.jsonl', line: 2, path: '$.snap.backups{key}', kind: 'ホーム' },
      { file: 'a.jsonl', line: 2, path: '$.snap.backups{key}', kind: 'ユーザー名' },
      { file: 'a.jsonl', line: 2, path: '$.snap.backups.{key}', kind: 'メールアドレスらしい文字列' },
      { file: 'a.jsonl', line: 2, path: '$.snap.list[1].note', kind: 'ホーム' },
      { file: 'a.jsonl', line: 2, path: '$.snap.list[1].note', kind: 'ユーザー名' },
      { file: 'help.txt', line: 2, path: '-', kind: 'ホーム' },
      { file: 'help.txt', line: 2, path: '-', kind: 'ユーザー名' },
      { file: 'auth-status.json', line: null, path: '$.configDirectory', kind: 'ホーム' },
      { file: 'auth-status.json', line: null, path: '$.configDirectory', kind: 'ユーザー名' },
    ];
    expect(found).toEqual(expected);
    const shown = formatLeaks(found);
    for (const v of ['someone', 'corp.example', '/Users']) expect(shown).not.toContain(v);
  });
  it('JSON として読めない行は、行番号とパス - にする', () => {
    expect(findLeaks({ 'x.jsonl': '{"a":\n' }, { ...S, contextLines: [] })).toEqual([]);
    expect(findLeaks({ 'x.jsonl': 'broken /Users/someone/q\n' }, S).map((l) => [l.line, l.path])).toEqual([[1, '-'], [1, '-']]);
  });
  it('件数が多いときは先頭の 30 件と残りの件数', () => {
    const many: Leak[] = Array.from({ length: 35 }, (_, i) => ({ file: 'f', line: i + 1, path: '-', kind: 'ホーム' }));
    const lines = formatLeaks(many).split('\n');
    expect(lines).toHaveLength(31);
    expect(lines[30]).toBe('- ほか 5 件');
  });
});
