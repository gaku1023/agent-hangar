import { describe, expect, it } from 'vitest';
import { configKey, decodeHeaderText, decodeJoinToken, encodeFileKeyPath, encodeHeaderText, encodeJoinToken, isAllowedJoinUrl, isHeaderSafe, isSafeRelPath, isValidFileKey, MAX_KEY_BYTES, splitFileKey, type JoinToken, MAX_ID_CHARS, MAX_JOIN_TOKEN_CHARS, MAX_JOIN_URL_CHARS, MAX_REL_PATH_CHARS, SHARED_TABLES, TABLE_PK, transcriptKey } from './cloud.ts';

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
    expect(configKey('dev1', 'skills/x/SKILL.md')).toBe('config/dev1/skills/x/SKILL.md');
  });
  it('設定の鍵も端末ごとに分ける。分けないと 2 台目が 1 台目の設定を潰す', () => {
    expect(configKey('dev1', 'CLAUDE.md')).toBe('config/dev1/CLAUDE.md');
    expect(configKey('dev2', 'CLAUDE.md')).toBe('config/dev2/CLAUDE.md');
    expect(configKey('dev1', 'CLAUDE.md')).not.toBe(configKey('dev2', 'CLAUDE.md'));
    expect(splitFileKey(configKey('dev1', 'skills/x/SKILL.md'))).toEqual({ prefix: 'config', rel: 'dev1/skills/x/SKILL.md' });
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
      expect(() => configKey('dev1', p)).toThrow('パス');
    }
    for (const bad of ['', '.', '..', 'a/b', '/a', 'a b', 'a\u0000', '-a', 'a'.repeat(MAX_ID_CHARS + 1)]) {
      expect(() => configKey(bad, 'CLAUDE.md')).toThrow('ID');
    }
    expect(configKey('dev1', 'skills/x/SKILL.md')).toBe('config/dev1/skills/x/SKILL.md');
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

describe('折り返された参加トークン', () => {
  const t: JoinToken = { url: 'https://hangar.example.workers.dev', secret: 'S3CRET-0123456789-abcdefghij' };
  const token = encodeJoinToken(t);
  it('途中に改行や空白が入っていても読める', () => {
    // 1Password やメールに貼ると折り返しが入る。空白の個数で成否が変わってはいけない。
    for (const n of [1, 2, 3, 4, 5]) {
      const wrapped = token.slice(0, 20) + '\n'.repeat(n) + token.slice(20);
      expect(decodeJoinToken(wrapped)).toEqual(t);
      expect(decodeJoinToken(token.slice(0, 20) + ' '.repeat(n) + token.slice(20))).toEqual(t);
    }
    // 80 字ごとに折り返した形も読める。
    expect(decodeJoinToken(token.replace(/(.{20})/g, '$1\r\n'))).toEqual(t);
    expect(decodeJoinToken('  ' + token + '\n')).toEqual(t);
  });
  it('空白だけでは別のトークンにならない', () => {
    expect(decodeJoinToken(token.replace(/(.{7})/g, '$1 \t\n'))).toEqual(decodeJoinToken(token));
    expect(() => decodeJoinToken('   \n\t  ')).toThrow('参加トークン');
  });
  it('長さの上限は空白を取り除く前に見る', () => {
    expect(() => decodeJoinToken(' '.repeat(MAX_JOIN_TOKEN_CHARS + 1))).toThrow('参加トークンが長すぎます');
  });
});

describe('見出しに載せる文字列の符号化', () => {
  // HTTP の見出しの値は ByteString しか運べない。
  // 非 ASCII を渡すと Node の fetch は送る前に TypeError を投げるので、Worker 側では直せない。
  const cases = [
    'projects/-x/u1.jsonl',
    'projects/-Users-satog-作業/メモ 1.jsonl',
    'skills/日本語 メモ/SKILL.md',
    'a%2Fb',
    'a%',
    '100% でき/た.md',
    'emoji/🐕.md',
    "quote'and\"and`.md",
    'tab\tと改行\nと復帰\r.md',
    'ぜんぶ'.repeat(50),
  ];

  it('往復して元に戻る', () => {
    for (const s of cases) {
      const wire = encodeHeaderText(s);
      expect(wire, s).not.toBeNull();
      expect(decodeHeaderText(wire!), s).toBe(s);
    }
  });

  it('符号化した結果は見出しに載せられる ASCII だけになる', () => {
    for (const s of cases) {
      const wire = encodeHeaderText(s)!;
      expect(isHeaderSafe(wire), wire).toBe(true);
      // 実物の見出しに載せられることを undici の検査そのもので確かめる。
      expect(() => new Headers({ 'x-hangar-path': wire })).not.toThrow();
    }
    // 符号化しないと落ちる。これが直そうとしている現象である。
    expect(() => new Headers({ 'x-hangar-path': 'メモ' })).toThrow(TypeError);
  });

  it('スラッシュは読みやすさのために残し、百分率は必ず符号化する', () => {
    expect(encodeHeaderText('a/b/c.md')).toBe('a/b/c.md');
    expect(encodeHeaderText('a b')).toBe('a%20b');
    expect(encodeHeaderText('a%2Fb')).toBe('a%252Fb');
    expect(decodeHeaderText('a%252Fb')).toBe('a%2Fb');
  });

  it('形が壊れていれば null にする（例外を投げない）', () => {
    expect(decodeHeaderText('%')).toBeNull();
    expect(decodeHeaderText('%zz')).toBeNull();
    expect(decodeHeaderText('%E3%81')).toBeNull();
    expect(encodeHeaderText('\ud800')).toBeNull(); // 単独のサロゲート
  });

  it('isHeaderSafe は制御文字と非 ASCII を断る', () => {
    expect(isHeaderSafe('a/b c%20d')).toBe(true);
    expect(isHeaderSafe('')).toBe(true);
    expect(isHeaderSafe('メモ')).toBe(false);
    expect(isHeaderSafe('a\nb')).toBe(false);
    expect(isHeaderSafe('a\u0000b')).toBe(false);
    expect(isHeaderSafe('a\u007fb')).toBe(false);
  });
});

describe('R2 の鍵の形', () => {
  it('接頭辞とその先の相対パスに割る', () => {
    expect(splitFileKey('transcripts/dev-a/u1.jsonl.gz')).toEqual({ prefix: 'transcripts', rel: 'dev-a/u1.jsonl.gz' });
    expect(splitFileKey('config/skills/日本語 メモ/SKILL.md')).toEqual({ prefix: 'config', rel: 'skills/日本語 メモ/SKILL.md' });
  });

  it('日本語と空白を通し、脱出と空の断片を断る', () => {
    // 利用者の `~/.claude` の名前は選べないので、ASCII に限ると日本語のスキルが端末側で止まる。
    for (const ok of ['config/skills/日本語 メモ/SKILL.md', 'config/memory/🐕.md', 'transcripts/dev-a/u1.jsonl.gz', 'config/a%b.md']) {
      expect(isValidFileKey(ok), ok).toBe(true);
    }
    for (const ng of ['', 'other/u1', 'transcripts', 'transcripts/', '/transcripts/a', 'transcripts/../etc', 'transcripts/./a', 'transcripts//a', 'transcripts/a\u0000b', 'config/' + 'あ'.repeat(400)]) {
      expect(isValidFileKey(ng), ng).toBe(false);
    }
  });

  it('長さはバイトで測る（R2 の上限に当てて 500 を出さない）', () => {
    expect(isValidFileKey('config/' + 'a'.repeat(500))).toBe(true);
    expect(isValidFileKey('config/' + 'a'.repeat(513))).toBe(false); // 相対パスの字数の上限
    expect(new TextEncoder().encode('config/' + 'あ'.repeat(400)).length).toBeGreaterThan(MAX_KEY_BYTES);
  });

  it('URL に載せるときは断片ごとに符号化して / を残す', () => {
    expect(encodeFileKeyPath('transcripts/dev-a/u1.jsonl.gz')).toBe('transcripts/dev-a/u1.jsonl.gz');
    expect(encodeFileKeyPath('config/skills/日本語 メモ/SKILL.md')).toBe('config/skills/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%E3%83%A1%E3%83%A2/SKILL.md');
    expect(encodeFileKeyPath('config/a%b.md')).toBe('config/a%25b.md');
    // 受け取る側が断片ごとに復号すれば元に戻る。
    for (const key of ['config/skills/日本語 メモ/SKILL.md', 'config/a%b.md', 'config/? #.md']) {
      expect(encodeFileKeyPath(key).split('/').map(decodeURIComponent).join('/')).toBe(key);
    }
    // URL に置いても壊れない。
    expect(new URL(`https://h/files/${encodeFileKeyPath('config/skills/日本語 メモ/SKILL.md')}`).pathname)
      .toBe('/files/config/skills/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%E3%83%A1%E3%83%A2/SKILL.md');
  });
});
