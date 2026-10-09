import { describe, expect, it } from 'vitest';
import { leaks, redactAgents, redactAuth, redactDeep, redactRegistry, redactStatusline, redactTranscriptLine, replacements, type Secrets } from './redact.ts';

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

describe('redactStatusline', () => {
  it('使用率、戻る時刻、費用を決まった値にする。ミリ秒の戻る時刻はミリ秒のまま', () => {
    const raw = { session_id: 's', cost: { total_cost_usd: 0.37, total_duration_ms: 5 }, rate_limits: { five_hour: { used_percentage: 47, resets_at: 1_760_000_000 }, seven_day: { used_percentage: 7, resets_at: 1_760_500_000_000 } }, cwd: S.tmpReal };
    expect(redactStatusline(raw, P)).toEqual({ session_id: 's', cost: { total_cost_usd: 0.01, total_duration_ms: 5 }, rate_limits: { five_hour: { used_percentage: 12, resets_at: 1_800_000_000 }, seven_day: { used_percentage: 3, resets_at: 1_800_500_000_000 } }, cwd: '/tmp/hangar-fixture' });
  });
});

describe('redactRegistry、redactAuth、redactAgents', () => {
  it('登録の pidDomain とパスを伏せる', () => {
    expect(redactRegistry({ pid: 1, sessionId: 's', cwd: `${S.tmpReal}/work`, pidDomain: 'abc', tmux: `${S.tmpReal}/tmux.sock,1,0` }, P)).toEqual({ pid: 1, sessionId: 's', cwd: '/tmp/hangar-fixture/work', pidDomain: 'fixture', tmux: '/tmp/hangar-fixture/tmux.sock,1,0' });
  });
  it('auth status のメールアドレス、組織、プラン、置き場を伏せる', () => {
    expect(redactAuth({ loggedIn: true, email: S.email, orgName: S.orgName, orgId: S.orgId, subscriptionType: 'enterprise', configDirectory: '/Users/someone/.claude-alt' }, P)).toEqual({ loggedIn: true, email: 'user@example.com', orgName: 'Example Org', orgId: '00000000-0000-4000-8000-000000000000', subscriptionType: 'max', configDirectory: '/Users/me/.claude' });
  });
  it('agents はその会話の行だけを残す', () => {
    expect(redactAgents([{ sessionId: 'a', cwd: S.tmpReal }, { sessionId: 'b', cwd: '/Users/someone/x' }], 'a', P)).toEqual([{ sessionId: 'a', cwd: '/tmp/hangar-fixture' }]);
    expect(redactAgents('x', 'a', P)).toEqual([]);
  });
});

describe('leaks', () => {
  it('伏せたはずの値と、置き換えの値でないメールアドレスを見つける', () => {
    expect(leaks('ok /tmp/hangar-fixture user@example.com', S)).toEqual([]);
    expect(leaks('at /Users/someone/x and someone@corp.example', S)).toEqual(['ホーム', 'メールアドレス', 'ユーザー名', 'メールアドレスらしい文字列']);
    expect(leaks('other@mail.example', S)).toEqual(['メールアドレスらしい文字列']);
  });
  it('ユーザー名は、前後が英数字でない所に現れたときだけ数える。語の一部は数えない', () => {
    expect(leaks('someone', S)).toEqual(['ユーザー名']);
    expect(leaks('owner: someone.', S)).toEqual(['ユーザー名']);
    expect(leaks('noone and someonelse and 1someone and nosomeone', S)).toEqual([]);
  });
});
