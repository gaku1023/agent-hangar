import { describe, expect, it } from 'vitest';
import { claudeTmpDirs, emailSpans, leaks, redactAgents, redactAuth, redactDeep, redactRegistry, redactStatusline, redactText, redactTranscriptLine, replacements, type Secrets } from './redact.ts';

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
  claudeTmp: ['/private/tmp/claude-4242', '/tmp/claude-4242'],
  contextLines: ['Fixture rule: say fixture-forbidden-word never'],
};
const P = replacements(S);

describe('replacements と redactDeep', () => {
  it('一時ディレクトリ、その置き場の名前、ホームを決まった値に置き換える。鍵も置き換える', () => {
    const v = {
      cwd: '/private/var/folders/zz/abc/T/hangar-fixture-Q1/work',
      transcript_path: '/Users/someone/.claude-alt/projects/-private-var-folders-zz-abc-T-hangar-fixture-Q1-work/x.jsonl',
      backups: { '/private/var/folders/zz/abc/T/hangar-fixture-Q1/work/notes.txt': { v: 1 } },
      n: 3,
    };
    expect(redactDeep(v, P)).toEqual({
      cwd: '/tmp/hangar-fixture/work',
      transcript_path: '/Users/me/.claude/projects/-tmp-hangar-fixture-work/x.jsonl',
      backups: { '/tmp/hangar-fixture/work/notes.txt': { v: 1 } },
      n: 3,
    });
  });
  it('設定の置き場は、ホームの下にあっても、ホームより先に /Users/me/.claude へ置き換える', () => {
    expect(redactDeep({ p: '/Users/someone/.claude-alt/sessions/1.json', q: '/Users/someone/work' }, P)).toEqual({ p: '/Users/me/.claude/sessions/1.json', q: '/Users/me/work' });
  });
  it('一時ディレクトリの置き場そのもの（実体も、その名前の形も）を /tmp にする', () => {
    expect(redactDeep({ p: '/private/var/folders/zz/abc/T/other', q: '/var/folders/zz/abc/T/other', m: '-private-var-folders-zz-abc-T-other' }, P)).toEqual({ p: '/tmp/other', q: '/tmp/other', m: '-tmp-other' });
  });
  it('一時ディレクトリの置き場の、実体でない側の名前の形（-var-folders-…）も -tmp にする', () => {
    expect(redactDeep({ m: '-var-folders-zz-abc-T-other' }, P)).toEqual({ m: '-tmp-other' });
  });
  it('設定の置き場の、置き場の名前の形（英数字以外を - にしたもの）も -Users-me--claude にする', () => {
    expect(redactDeep({ m: '-Users-someone--claude-alt/projects/x' }, P)).toEqual({ m: '-Users-me--claude/projects/x' });
  });
});

describe('Claude Code の一時の置き場', () => {
  it('uid ごとの置き場（実体も、その名前の形も）を /tmp/claude-fixture にする', () => {
    const v = { a: '/private/tmp/claude-4242/-tmp-x/tasks/1.output', b: '/tmp/claude-4242/y', m: '-private-tmp-claude-4242-x', n: '-tmp-claude-4242-x' };
    expect(redactDeep(v, P)).toEqual({ a: '/tmp/claude-fixture/-tmp-x/tasks/1.output', b: '/tmp/claude-fixture/y', m: '-tmp-claude-fixture-x', n: '-tmp-claude-fixture-x' });
  });
  it('置き場が無いとき（uid が分からない機械）は何も当てない。claudeTmpDirs は uid から 2 つの置き場を作る', () => {
    expect(redactDeep({ a: '/tmp/claude-4242/y' }, replacements({ ...S, claudeTmp: [] }))).toEqual({ a: '/tmp/claude-4242/y' });
    expect(claudeTmpDirs(4242)).toEqual(['/private/tmp/claude-4242', '/tmp/claude-4242']);
    expect(claudeTmpDirs(undefined)).toEqual([]);
  });
});

describe('メールアドレスらしい文字列', () => {
  it('置き換えの組のほかのアドレスも、値も鍵も user@example.com にする。user@example.com はそのまま', () => {
    expect(redactDeep({ a: 'x other@corp.example y noreply@vendor.example', 'k@mail.example': 'user@example.com' }, P)).toEqual({ a: 'x user@example.com y user@example.com', 'user@example.com': 'user@example.com' });
  });
  it('ふつうのアドレスと <noreply@vendor.example> の形はいまどおり拾う', () => {
    expect(redactText('mail other@corp.example now', [])).toBe('mail user@example.com now');
    expect(redactText('Co-Authored-By: X <noreply@vendor.example>', [])).toBe('Co-Authored-By: X <user@example.com>');
    expect(leaks('Co-Authored-By: X <noreply@vendor.example>', S)).toEqual(['メールアドレスらしい文字列']);
  });
  it('@ の無い長い連なりでも、どの長さでも速く終わる（2 乗に増えない）', () => {
    const shapes = ['a'.repeat(100_000), 'a.'.repeat(50_000), 'a@'.repeat(50_000), `a@${'b'.repeat(100_000)}`, `${'a'.repeat(100_000)}@b`];
    for (const text of shapes) {
      const t0 = performance.now();
      redactText(text, []);
      leaks(text, S);
      expect(performance.now() - t0).toBeLessThan(200);
    }
  });
  it('拾う範囲は、もとの正規表現（左から順に、重ならずに拾う）と同じ', () => {
    const OLD = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
    const old = (t: string): [number, string][] => [...t.matchAll(OLD)].map((m) => [m.index, m[0]]);
    const now = (t: string): [number, string][] => emailSpans(t).map(({ start, end }) => [start, t.slice(start, end)]);
    for (const t of ['a@b.com_x@c.com', 'someone@corp.example.x@y.com', 'x<noreply@vendor.example>y', 'Author:\nother@corp.example', 'a@b@c.de', '@x.com a@.com b@c.d e@f.gh.i']) expect(now(t)).toEqual(old(t));
    // 小さな字の集まりからの作り物の文字列で、どれも同じになることを確かめる（種を決めた疑似乱数）。
    const chars = 'ab1.-_%+@ \n';
    let seed = 12345;
    const rand = (n: number): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 16) % n; };
    for (let i = 0; i < 3000; i++) {
      const t = Array.from({ length: rand(24) }, () => chars[rand(chars.length)]).join('').replace(/b/g, () => (rand(2) === 0 ? 'b' : 'com'));
      expect(now(t)).toEqual(old(t));
    }
  });
});

describe('redactTranscriptLine の system-reminder、考え', () => {
  const R = '<system-reminder>(redacted)</system-reminder>';
  it('どの欄の文字列でも、system-reminder の塊を中身だけ (redacted) にする。複数でも、閉じが無くても', () => {
    const rec = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'a <system-reminder>\nsecret</system-reminder> b <system-reminder>x</system-reminder> c' }, { type: 'text', text: 'head <system-reminder>never closed' }] } };
    expect(redactTranscriptLine(rec, P)).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: `a ${R} b ${R} c` }, { type: 'text', text: `head ${R}` }] } });
  });
  it('thinking の thinking と signature、redacted_thinking の data を (redacted) にする', () => {
    const rec = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret', signature: 'sig' }, { type: 'redacted_thinking', data: 'opaque' }, { type: 'text', text: 'kept' }] } };
    expect(redactTranscriptLine(rec, P)).toEqual({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '(redacted)', signature: '(redacted)' }, { type: 'redacted_thinking', data: '(redacted)' }, { type: 'text', text: 'kept' }] } });
  });
});

describe('redactTranscriptLine', () => {
  it('積んだ指示のほかの添付は、種類だけを残す', () => {
    expect(redactTranscriptLine({ type: 'attachment', attachment: { type: 'skill_listing', content: 'a private skill' }, cwd: S.tmpReal }, P)).toEqual({ type: 'attachment', attachment: { type: 'skill_listing' }, cwd: '/tmp/hangar-fixture' });
    const queued = { type: 'attachment', attachment: { type: 'queued_command', prompt: 'next', commandMode: 'prompt' } };
    expect(redactTranscriptLine(queued, P)).toEqual(queued);
  });
  it('利用者の発言でない user の行（isMeta）は、本文を伏せる', () => {
    expect(redactTranscriptLine({ type: 'user', isMeta: true, message: { role: 'user', content: 'Contents of /Users/someone/CLAUDE.md' } }, P)).toEqual({ type: 'user', isMeta: true, message: { role: 'user', content: '(redacted)' } });
  });
});

describe('redactTranscriptLine の cost-state', () => {
  it('費用（全体とモデルごと）と累計の時間を決まった値にする。トークンの数、行の数、始めた時刻は残す', () => {
    const rec = {
      type: 'cost-state', sessionId: 's', totalCostUSD: 0.42, totalAPIDuration: 30123, totalAPIDurationWithoutRetries: 29876, totalToolDuration: 20456,
      totalLinesAdded: 3, totalLinesRemoved: 1, totalDuration: 61234, startTime: 1_760_000_000_000,
      modelUsage: { 'model-a': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, costUSD: 0.4 }, 'model-b': { inputTokens: 1, costUSD: 0.02 } },
      hasUnknownModelCost: false,
    };
    expect(redactTranscriptLine(rec, P)).toEqual({
      type: 'cost-state', sessionId: 's', totalCostUSD: 0.01, totalAPIDuration: 1000, totalAPIDurationWithoutRetries: 1000, totalToolDuration: 1000,
      totalLinesAdded: 3, totalLinesRemoved: 1, totalDuration: 1000, startTime: 1_760_000_000_000,
      modelUsage: { 'model-a': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, costUSD: 0.01 }, 'model-b': { inputTokens: 1, costUSD: 0.01 } },
      hasUnknownModelCost: false,
    });
  });
  it('数でない値や無い鍵は触らない。cost-state でない行の同じ名前の鍵も触らない', () => {
    expect(redactTranscriptLine({ type: 'cost-state', totalCostUSD: null, modelUsage: { m: { costUSD: 'x' } }, totalDuration: '5' }, P)).toEqual({ type: 'cost-state', totalCostUSD: null, modelUsage: { m: { costUSD: 'x' } }, totalDuration: '5' });
    expect(redactTranscriptLine({ type: 'cost-state', sessionId: 's' }, P)).toEqual({ type: 'cost-state', sessionId: 's' });
    expect(redactTranscriptLine({ type: 'system', totalCostUSD: 0.42, totalDuration: 5 }, P)).toEqual({ type: 'system', totalCostUSD: 0.42, totalDuration: 5 });
  });
});

describe('redactStatusline', () => {
  it('使用率、戻る時刻、費用を決まった値にする。ミリ秒の戻る時刻はミリ秒のまま', () => {
    const raw = { session_id: 's', cost: { total_cost_usd: 0.37, total_lines_added: 4 }, rate_limits: { five_hour: { used_percentage: 47, resets_at: 1_760_000_000 }, seven_day: { used_percentage: 7, resets_at: 1_760_500_000_000 } }, cwd: S.tmpReal };
    expect(redactStatusline(raw, P)).toEqual({ session_id: 's', cost: { total_cost_usd: 0.01, total_lines_added: 4 }, rate_limits: { five_hour: { used_percentage: 12, resets_at: 1_800_000_000 }, seven_day: { used_percentage: 3, resets_at: 1_800_500_000_000 } }, cwd: '/tmp/hangar-fixture' });
  });
  it('費用の累計の時間（total_duration_ms、total_api_duration_ms）を決まった時間にする。行の数は残す。数でない値は触らない', () => {
    const raw = { cost: { total_cost_usd: 0.37, total_duration_ms: 81234, total_api_duration_ms: 40321, total_lines_added: 2, total_lines_removed: 1 } };
    expect(redactStatusline(raw, P)).toEqual({ cost: { total_cost_usd: 0.01, total_duration_ms: 1000, total_api_duration_ms: 1000, total_lines_added: 2, total_lines_removed: 1 } });
    expect(redactStatusline({ cost: { total_duration_ms: 'x' } }, P)).toEqual({ cost: { total_duration_ms: 'x' } });
  });
});

describe('redactRegistry、redactAuth、redactAgents', () => {
  it('登録の pidDomain とパスを伏せる', () => {
    expect(redactRegistry({ pid: 1, sessionId: 's', cwd: `${S.tmpReal}/work`, pidDomain: 'abc', tmux: `${S.tmpReal}/tmux.sock,1,0` }, P)).toEqual({ pid: 1, sessionId: 's', cwd: '/tmp/hangar-fixture/work', pidDomain: 'fixture', tmux: '/tmp/hangar-fixture/tmux.sock,1,0' });
  });
  it('auth status のメールアドレス、組織、プラン、置き場を伏せる', () => {
    expect(redactAuth({ loggedIn: true, email: S.email, orgName: S.orgName, orgId: S.orgId, subscriptionType: 'enterprise', configDirectory: '/Users/someone/.claude-alt' }, P)).toEqual({ loggedIn: true, email: 'user@example.com', orgName: 'Example Org', orgId: '00000000-0000-4000-8000-000000000000', subscriptionType: 'max', configDirectory: '/Users/me/.claude' });
  });
  it('auth status の置き場は、チルダの形で出ても決まった値にする', () => {
    expect(redactAuth({ loggedIn: true, configDirectory: '~/.claude-alt', projectsDirectory: '~/.claude-alt/projects' }, P)).toEqual({ loggedIn: true, configDirectory: '/Users/me/.claude', projectsDirectory: '/Users/me/.claude/projects' });
  });
  it('agents はその会話の行だけを残す', () => {
    expect(redactAgents([{ sessionId: 'a', cwd: S.tmpReal }, { sessionId: 'b', cwd: '/Users/someone/x' }], 'a', P)).toEqual([{ sessionId: 'a', cwd: '/tmp/hangar-fixture' }]);
    expect(redactAgents('x', 'a', P)).toEqual([]);
  });
});

describe('leaks', () => {
  it('Claude Code の一時の置き場（実体も、名前の形も）が残っていれば見つける。置き換えの値は見ない', () => {
    expect(leaks('x /private/tmp/claude-4242/y', S)).toEqual(['Claude Code の一時の置き場']);
    expect(leaks('x /tmp/claude-4242/y', S)).toEqual(['Claude Code の一時の置き場']);
    expect(leaks('-private-tmp-claude-4242-x', S)).toEqual(['Claude Code の一時の置き場']);
    expect(leaks('/tmp/claude-fixture/y -tmp-claude-fixture-x', S)).toEqual([]);
  });
  it('ホスト名は、完全な形に加えて、最初の . の前の短い形も見つける。語の一部は数えない', () => {
    expect(leaks('on someones-mac.local now', S)).toEqual(['ホスト名']);
    expect(leaks('on someones-mac now', S)).toEqual(['ホスト名']);
    expect(leaks('on (SomeOnes-Mac).', S)).toEqual(['ホスト名']);
    expect(leaks('xsomeones-mac and someones-macx and 1someones-mac2', S)).toEqual([]);
    // 短い形が 3 文字より短いときは見ない。
    expect(leaks('ab', { ...S, host: 'ab.local' })).toEqual([]);
    expect(leaks('fixture-host', S)).toEqual([]);
  });
  it('伏せたはずの値と、置き換えの値でないメールアドレスを見つける', () => {
    expect(leaks('ok /tmp/hangar-fixture user@example.com', S)).toEqual([]);
    expect(leaks('at /Users/someone/x and someone@corp.example', S)).toEqual(['ホーム', 'メールアドレス', 'ユーザー名', 'メールアドレスらしい文字列']);
    expect(leaks('other@mail.example', S)).toEqual(['メールアドレスらしい文字列']);
  });
  it('設定の置き場の名前（.claude でないとき）が残っていれば見つける。.claude のときは見ない', () => {
    expect(leaks('x/.claude-alt/y', S)).toEqual(['設定の置き場の名前']);
    expect(leaks('x/.claude/y', { ...S, claudeDir: '/Users/someone/.claude' })).toEqual([]);
  });
  it('利用者の CLAUDE.md の行が含まれていれば、値を出さずに種類だけ返す', () => {
    expect(leaks(`before ${(S.contextLines[0] ?? '')} after`, S)).toEqual(['利用者の CLAUDE.md の行']);
    expect(leaks('nothing here', S)).toEqual([]);
    expect(leaks((S.contextLines[0] ?? ''), { ...S, contextLines: [] })).toEqual([]);
  });
  it('ユーザー名は大文字小文字を区別しない', () => {
    expect(leaks('Owner: SomeOne', S)).toEqual(['ユーザー名']);
    expect(leaks('NoSomeOne', S)).toEqual([]);
  });
  it('ユーザー名は、前後が英数字でない所に現れたときだけ数える。語の一部は数えない', () => {
    expect(leaks('someone', S)).toEqual(['ユーザー名']);
    expect(leaks('owner: someone.', S)).toEqual(['ユーザー名']);
    expect(leaks('noone and someonelse and 1someone and nosomeone', S)).toEqual([]);
  });
});
