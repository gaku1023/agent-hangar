import { describe, expect, it } from 'vitest';
import { configKey, decodeJoinToken, encodeJoinToken, isAllowedJoinUrl, isSafeRelPath, type JoinToken, MAX_ID_CHARS, MAX_JOIN_TOKEN_CHARS, MAX_JOIN_URL_CHARS, MAX_REL_PATH_CHARS, SHARED_TABLES, TABLE_PK, transcriptKey } from './cloud.ts';

describe('参加トークン', () => {
  it('URL と秘密を base64url の JSON で往復する', () => {
    const t = { url: 'https://hangar.example.workers.dev', secret: 'abc+/=xyz' };
    const s = encodeJoinToken(t);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeJoinToken(s)).toEqual(t);
  });
  it('壊れた文字列と欠けた項目は Error', () => {
    expect(() => decodeJoinToken('!!!')).toThrow();
    expect(() => decodeJoinToken(encodeJoinToken({ url: 'x', secret: '' } as never))).toThrow('参加トークン');
    expect(() => decodeJoinToken(btoa('{"url":1}'))).toThrow('参加トークン');
  });
});

describe('鍵と表', () => {
  it('本文の鍵は端末 ID とセッション UUID を含み、サブエージェントは下に置く', () => {
    expect(transcriptKey('dev1', 'u1', null)).toBe('transcripts/dev1/u1.jsonl.gz');
    expect(transcriptKey('dev1', 'u1', 'abc')).toBe('transcripts/dev1/u1/subagents/agent-abc.jsonl.gz');
    expect(configKey('skills/x/SKILL.md')).toBe('config/skills/x/SKILL.md');
  });
  it('共有テーブルの主キーは session_summaries と project_memos だけが違う', () => {
    expect(SHARED_TABLES).toHaveLength(12);
    expect(TABLE_PK.session_summaries).toBe('session_id');
    expect(TABLE_PK.project_memos).toBe('project_id');
    expect(TABLE_PK.runs).toBe('id');
  });
});

describe('参加トークンの宛先の検査', () => {
  const wrap = (url: string): string => encodeJoinToken({ url, secret: 'S3CRET-0123456789' } as JoinToken);
  it('https 以外のスキームを断る', () => {
    for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'http://evil.example.com', 'ftp://x.example.com', 'data:text/html,x']) {
      expect(() => decodeJoinToken(wrap(u))).toThrow('参加トークン');
    }
  });
  it('URL として読めない文字列を断る', () => {
    for (const u of ['not a url at all', 'x', '//evil.example.com', 'https://']) {
      expect(() => decodeJoinToken(wrap(u))).toThrow('参加トークン');
    }
  });
  it('開発とテスト用の loopback の http だけは通す', () => {
    for (const u of ['http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:8787']) {
      expect(decodeJoinToken(wrap(u)).url).toBe(u);
    }
    expect(isAllowedJoinUrl('https://hangar.example.workers.dev')).toBe(true);
    expect(isAllowedJoinUrl('http://127.0.0.1:8787')).toBe(true);
    expect(isAllowedJoinUrl('http://evil.example.com')).toBe(false);
  });
  it('ユーザ情報とパスと問い合わせと素片のついた URL を断る', () => {
    for (const u of ['https://user:pass@x.workers.dev', 'https://user@x.workers.dev', 'https://x.workers.dev/join', 'https://x.workers.dev/?a=1', 'https://x.workers.dev/#f']) {
      expect(() => decodeJoinToken(wrap(u))).toThrow('参加トークン');
    }
    // 素の origin は、末尾のスラッシュの有無にかかわらず通る。
    expect(decodeJoinToken(wrap('https://x.workers.dev')).url).toBe('https://x.workers.dev');
    expect(decodeJoinToken(wrap('https://x.workers.dev/')).url).toBe('https://x.workers.dev/');
  });
  it('長すぎるトークンと長すぎる URL を断る', () => {
    expect(() => decodeJoinToken('a'.repeat(MAX_JOIN_TOKEN_CHARS + 1))).toThrow('参加トークン');
    expect(() => decodeJoinToken(wrap('https://' + 'a'.repeat(MAX_JOIN_URL_CHARS) + '.workers.dev'))).toThrow('参加トークン');
  });
  it('断るときに秘密の断片を例外に載せない', () => {
    const secret = 'S3CRET-do-not-leak-me-0123456789';
    for (const u of ['javascript:alert(1)', 'https://user:pass@x.workers.dev', 'not a url']) {
      let caught: unknown;
      try { decodeJoinToken(encodeJoinToken({ url: u, secret } as JoinToken)); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(Error);
      const err = caught as Error;
      expect(err.message).not.toContain(secret);
      expect(err.message).not.toContain('S3CRET');
      expect(String(err.stack)).not.toContain('S3CRET');
      // 入力そのものも載せない。
      expect(err.message).not.toContain(u);
    }
  });
});

describe('鍵の組み立ての検査', () => {
  it('config の相対パスは .. と先頭のスラッシュと空の断片と制御文字を断る', () => {
    for (const p of ['', '.', '..', '../../etc/passwd', '/etc/passwd', 'a//b', 'a/./b', 'a/../../b', 'skills/x/', 'a\u0000b', 'a\nb', 'a'.repeat(MAX_REL_PATH_CHARS + 1)]) {
      expect(() => configKey(p)).toThrow('パス');
    }
    expect(configKey('skills/x/SKILL.md')).toBe('config/skills/x/SKILL.md');
    expect(isSafeRelPath('skills/x/SKILL.md')).toBe(true);
    expect(isSafeRelPath('../x')).toBe(false);
  });
  it('端末 ID とセッション ID とサブエージェント ID の形を検査する', () => {
    for (const bad of ['', '.', '..', 'a/b', '/a', 'a b', 'a\u0000', '-a', 'a'.repeat(MAX_ID_CHARS + 1)]) {
      expect(() => transcriptKey(bad, 'u1', null)).toThrow('ID');
      expect(() => transcriptKey('dev1', bad, null)).toThrow('ID');
      expect(() => transcriptKey('dev1', 'u1', bad)).toThrow('ID');
    }
    // 実際に使う形（uuidv7 の端末 ID、36 字のセッション UUID、英数字のサブエージェント ID）は通る。
    expect(transcriptKey('0199b0d1-2b3c-7def-8000-0123456789ab', '2f1c9a10-0000-4000-8000-0123456789ab', null))
      .toBe('transcripts/0199b0d1-2b3c-7def-8000-0123456789ab/2f1c9a10-0000-4000-8000-0123456789ab.jsonl.gz');
    expect(transcriptKey('dev1', 'u1', 'abc123')).toBe('transcripts/dev1/u1/subagents/agent-abc123.jsonl.gz');
  });
  it('スラッシュ入りのセッション ID でサブエージェントの鍵と衝突させられない', () => {
    expect(() => transcriptKey('d', 'u/subagents/agent-x', null)).toThrow('ID');
  });
});
